// Named warning checks over a ForecastRun. Source: docs/design/07-warnings-and-ranking.md.
// Each check returns Candidates (a warning, an optional lever, evidence, and the last date the lever
// helps). Dollar effects are not computed here: rank.ts re-simulates every lever.
// All thresholds and lead times come from the profile; a check is disabled by omitting its threshold.

import type { Candidate, Check, ForecastRun } from "../schema/forecast";
import type { Profile } from "../schema/profile";
import type { CashEvent, Commitment, Direction, Records } from "../schema/records";

// Design 07 default when a payable has no confirmed `flexibility` rule. Move to the profile when the
// schema gains a field for it.
export const DEFAULT_DEFER_DAYS = 10;

const DAY_MS = 86_400_000;

function toMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

export function addDays(date: string, days: number): string {
  return new Date(toMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

// Whole calendar days from `from` to `to` (negative when `to` is earlier).
export function daysBetween(from: string, to: string): number {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}

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

// Future, not-yet-settled events of each commitment in the run, earliest first.
export function pendingEventsByCommitment(run: ForecastRun): Map<string, CashEvent[]> {
  const out = new Map<string, CashEvent[]>();
  for (const e of run.events) {
    if (!e.commitmentId || e.status === "actual" || e.status === "possible" || e.date < run.asOf) continue;
    const list = out.get(e.commitmentId) ?? [];
    list.push(e);
    out.set(e.commitmentId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.date.localeCompare(b.date) || a.legIndex - b.legIndex);
  return out;
}

export const sumBase = (events: CashEvent[]) => events.reduce((s, e) => s + e.amountBase, 0);

function isNonDeferrable(c: Commitment, profile: Profile): boolean {
  return profile.recurring.some((r) => r.id === c.id && r.nonDeferrable);
}

function flexibilityDays(c: Commitment, records: Records): number {
  for (const rule of records.rules) {
    if (rule.kind !== "flexibility" || rule.state !== "confirmed") continue;
    if (!("partyId" in rule.scope) || rule.scope.partyId !== c.partyId) continue;
    const days = rule.params.extraDays;
    if (typeof days === "number" && days > 0) return days;
  }
  return DEFAULT_DEFER_DAYS;
}

// A daily closing balance falls below the safety line: chase receivables that land after the gap,
// and defer payables that land on or before it.
export const projectedCashGap: Check = (run, records, profile) => {
  const gapDate = run.firstBelowSafety;
  if (!gapDate) return [];
  const pending = pendingEventsByCommitment(run);
  const lead = profile.actionLeadDays ?? {};
  const out: Candidate[] = [];

  for (const c of records.commitments) {
    const events = pending.get(c.id);
    if (!events?.length || !isOpen(c) || c.funding) continue;
    const dir = commitmentDirection(c);

    if (dir === "in" && c.type !== "sales_deal") {
      const due = c.anchors.due;
      const last = events[events.length - 1]!;
      if (!due || last.date <= gapDate) continue;
      // Collecting no earlier than the due date, and no earlier than the owner can reach them.
      const assumeDate = maxDate(due, addDays(run.asOf, lead.chase ?? 0));
      if (assumeDate >= last.date) continue;
      out.push({
        warning: "projected_cash_gap",
        lever: { kind: "chase", commitmentId: c.id, assumeDate },
        evidenceRefs: [c.id, ...events.map((e) => e.id)],
        neededBy: addDays(gapDate, -(lead.chase ?? 0)),
      });
    }

    if (dir === "out" && !isNonDeferrable(c, profile)) {
      const before = events.filter((e) => e.date <= gapDate);
      if (!before.length) continue;
      out.push({
        warning: "projected_cash_gap",
        lever: { kind: "defer", commitmentId: c.id, days: flexibilityDays(c, records) },
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

// Each party's share of open receivables in the run, in base currency.
export function receivableShares(run: ForecastRun, records: Records) {
  const pending = pendingEventsByCommitment(run);
  const byParty = new Map<string, { amount: number; commitmentIds: string[] }>();
  let total = 0;
  for (const c of records.commitments) {
    const events = pending.get(c.id);
    if (!events?.length || !c.partyId || !isOpen(c) || commitmentDirection(c) !== "in" || c.funding) continue;
    const amount = sumBase(events);
    total += amount;
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

// An applied signal moved a receivable later. Raises a change alert; rank re-runs on the new forecast.
export const paymentSlip: Check = (run, records) => {
  const out: Candidate[] = [];
  for (const s of records.signals) {
    if (s.state !== "applied" || s.claim.kind !== "date_change" || !s.commitmentId) continue;
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
