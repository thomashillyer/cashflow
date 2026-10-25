// Named warning checks over a ForecastRun. Source: docs/design/07-warnings-and-ranking.md.
// Each check returns Candidates (a warning, an optional lever, evidence, and the last date the lever
// helps). Dollar effects are not computed here: rank.ts re-simulates every lever.
// All thresholds and lead times come from the profile; a check is disabled by omitting its threshold.

import type { Candidate, Check, ForecastRun } from "../schema/forecast";
import type { Profile } from "../schema/profile";
import type { CashEvent, Commitment, Direction, Records } from "../schema/records";
import { addDays } from "./dates";

// Design 07 default when a payable has no confirmed `flexibility` rule. Move to the profile when the
// schema gains a field for it.
export const DEFAULT_DEFER_DAYS = 10;

const minDate = (a: string, b: string) => (a < b ? a : b);
const maxDate = (a: string, b: string) => (a > b ? a : b);

export function commitmentDirection(c: Commitment): Direction | undefined {
  if (c.direction) return c.direction;
  if (c.type === "invoice") return "in";
  if (c.type === "bill" || c.type === "recurring") return "out";
  return undefined;
}

export function isOpen(c: Commitment): boolean {
  return c.settlement !== "paid" && c.settlement !== "cancelled" && c.settlement !== "credited";
}

// Not-yet-settled events of each commitment in the run, earliest first. Includes overdue events,
// which keep their past date (design 05 honesty rules).
export function pendingEventsByCommitment(run: ForecastRun): Map<string, CashEvent[]> {
  const out = new Map<string, CashEvent[]>();
  for (const e of run.events) {
    if (!e.commitmentId || e.status === "actual" || e.status === "possible") continue;
    const list = out.get(e.commitmentId) ?? [];
    list.push(e);
    out.set(e.commitmentId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.date.localeCompare(b.date) || a.legIndex - b.legIndex);
  return out;
}

export const sumBase = (events: CashEvent[]) => events.reduce((s, e) => s + e.amountBase, 0);

// Receivables a customer owes on an invoice-like document (not deals, plans, or funding).
function isReceivable(c: Commitment): boolean {
  return commitmentDirection(c) === "in" && c.type !== "sales_deal" && c.type !== "plan" && !c.funding;
}

// Profile recurring items marked nonDeferrable, or any commitment in one of their categories
// (payroll detected from the bank file has its own id).
function isNonDeferrable(c: Commitment, profile: Profile): boolean {
  return profile.recurring.some((r) => r.nonDeferrable && (r.id === c.id || (!!c.category && r.category === c.category)));
}

// A party-specific confirmed flexibility rule wins over an all-parties one.
function flexibilityRule(c: Commitment, records: Records) {
  const confirmed = records.rules.filter((r) => r.kind === "flexibility" && r.state === "confirmed"
    && typeof r.params.extraDays === "number" && r.params.extraDays > 0);
  return confirmed.find((r) => "partyId" in r.scope && r.scope.partyId === c.partyId)
    ?? confirmed.find((r) => "all" in r.scope);
}

// A daily closing balance falls below the safety line: chase receivables that are overdue or land
// after the gap, and defer payables that land on or before the gap or the low point.
export const projectedCashGap: Check = (run, records, profile) => {
  const gapDate = run.firstBelowSafety;
  if (!gapDate) return [];
  const pending = pendingEventsByCommitment(run);
  const lead = profile.actionLeadDays ?? {};
  const deferUntil = maxDate(gapDate, run.lowPoint.date);
  const out: Candidate[] = [];

  for (const c of records.commitments) {
    const events = pending.get(c.id);
    if (!events?.length || !isOpen(c) || c.funding) continue;
    const dir = commitmentDirection(c);

    if (isReceivable(c)) {
      const reach = addDays(run.asOf, lead.chase ?? 0);
      const last = events[events.length - 1]!;
      const overdue = last.date < run.asOf;
      // Overdue: collect as soon as the owner can reach them. Otherwise no earlier than the due date.
      let assumeDate: string;
      if (overdue) assumeDate = reach;
      else if (c.anchors.due && last.date > gapDate) assumeDate = maxDate(c.anchors.due, reach);
      else continue;
      if (!overdue && assumeDate >= last.date) continue;
      out.push({
        warning: "projected_cash_gap",
        lever: { kind: "chase", commitmentId: c.id, assumeDate },
        evidenceRefs: [c.id, ...events.map((e) => e.id)],
        neededBy: addDays(gapDate, -(lead.chase ?? 0)),
      });
    }

    if (dir === "out" && !isNonDeferrable(c, profile)) {
      const before = events.filter((e) => e.date >= run.asOf && e.date <= deferUntil);
      if (!before.length) continue;
      const rule = flexibilityRule(c, records);
      // The base run already applied this flexibility; deferring again would double-count it.
      if (rule && before.some((e) => e.overriddenBy?.includes(rule.id))) continue;
      out.push({
        warning: "projected_cash_gap",
        lever: { kind: "defer", commitmentId: c.id, days: (rule?.params.extraDays as number) ?? DEFAULT_DEFER_DAYS },
        evidenceRefs: [c.id, ...before.map((e) => e.id)],
        neededBy: addDays(minDate(before[0]!.date, gapDate), -(lead.defer ?? 0)),
      });
    }
  }
  return out;
};

// A bill offers an early-payment discount and free cash covers it through the discount date.
// `discount.pct` is a percentage (2 for "2/10").
export const earlyPayDiscount: Check = (run, records) => {
  const pending = pendingEventsByCommitment(run);
  const out: Candidate[] = [];
  for (const c of records.commitments) {
    const events = pending.get(c.id);
    if (!c.discount || !events?.length || !isOpen(c) || commitmentDirection(c) !== "out") continue;
    const { byDate } = c.discount;
    if (byDate < run.asOf || events[0]!.date <= byDate) continue;
    const week = [...run.freeCash].reverse().find((w) => w.week <= byDate);
    if (!week || week.amount < sumBase(events)) continue;
    out.push({
      warning: "early_pay_discount",
      lever: { kind: "pay_early", commitmentId: c.id },
      evidenceRefs: [c.id, ...events.map((e) => e.id)],
      neededBy: byDate,
    });
  }
  return out;
};

// Free cash stays above the threshold for at least `minWeeks`. Explain only; no lever.
export const idleBalanceOver: Check = (run, _records, profile) => {
  const t = profile.thresholds.idleBalanceOver;
  if (!t) return [];
  const week = run.freeCash.find((w) => w.amount > t.amount && w.weeksFree >= t.minWeeks);
  if (!week) return [];
  const eventIds = run.weeks.find((w) => w.start === week.week)?.eventIds ?? [];
  return [{ warning: "idle_balance_over", evidenceRefs: eventIds, neededBy: week.week }];
};

// Each party's share of open receivables in the run, in base currency. Receivables with no party
// count toward the total.
export function receivableShares(run: ForecastRun, records: Records) {
  const pending = pendingEventsByCommitment(run);
  const byParty = new Map<string, { amount: number; commitmentIds: string[] }>();
  let total = 0;
  for (const c of records.commitments) {
    const events = pending.get(c.id);
    if (!events?.length || !isOpen(c) || !isReceivable(c)) continue;
    const amount = sumBase(events);
    total += amount;
    if (!c.partyId) continue;
    const entry = byParty.get(c.partyId) ?? { amount: 0, commitmentIds: [] };
    entry.amount += amount;
    entry.commitmentIds.push(c.id);
    byParty.set(c.partyId, entry);
  }
  return { total, byParty };
}

// One party holds more than `arConcentrationPct` percent of open receivables.
export const arConcentrationRisk: Check = (run, records, profile) => {
  const pct = profile.thresholds.arConcentrationPct;
  if (pct === undefined) return [];
  const { total, byParty } = receivableShares(run, records);
  if (total <= 0) return [];
  const out: Candidate[] = [];
  for (const [partyId, { amount, commitmentIds }] of byParty) {
    if ((amount / total) * 100 <= pct) continue;
    out.push({ warning: "ar_concentration_risk", evidenceRefs: [partyId, ...commitmentIds], neededBy: run.asOf });
  }
  return out;
};

// An applied signal moved a receivable later than its due date. Raises a change alert; rank re-runs
// on the new forecast.
export const paymentSlip: Check = (run, records) => {
  const out: Candidate[] = [];
  for (const s of records.signals) {
    if (s.state !== "applied" || s.claim.kind !== "date_change" || !s.commitmentId) continue;
    const due = records.commitments.find((c) => c.id === s.commitmentId)?.anchors.due;
    if (due && s.claim.newDate <= due) continue;
    const moved = run.events.some((e) => e.commitmentId === s.commitmentId && e.direction === "in"
      && e.overriddenBy?.includes(s.id));
    if (moved) out.push({ warning: "payment_slip", evidenceRefs: [s.id, s.commitmentId], neededBy: run.asOf });
  }
  return out;
};

export const checks: Check[] = [projectedCashGap, earlyPayDiscount, idleBalanceOver, arConcentrationRisk, paymentSlip];

export function runChecks(run: ForecastRun, records: Records, profile: Profile): Candidate[] {
  return checks.flatMap((check) => check(run, records, profile));
}
