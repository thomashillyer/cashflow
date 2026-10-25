// Step 4 of a run: applied signals, then scenario overrides, then levers, then stress. A what-if always wins.
// Every applied id lands in event.overriddenBy. Pure.

import type { CashEvent, Commitment, Lever, Override, Records, Scenario } from "../schema/records";
import type { Profile } from "../schema/profile";
import { addDays, diffDays } from "./dates";
import { DAILY_SALES_ID, defaultDirection, money, toBase } from "./expand";
import type { Notes } from "./review";
import { ENGINE_DEFAULTS, engineSettings } from "./settings";

// Defaults of profile.thresholds.stressDelayDays / splitIntervalDays; code reads engineSettings(profile).
export const DEFAULT_STRESS_DELAY_DAYS = ENGINE_DEFAULTS.stressDelayDays;
export const DEFAULT_SPLIT_INTERVAL_DAYS = ENGINE_DEFAULTS.splitIntervalDays;

// Lever overrides can pin one event: after a split, several installments share the pattern's legIndex, so a later
// chase/defer/pay_early must not hit them all. Internal only; the shared Override record is unchanged.
type LeverOverride = Override & { eventId?: string };

type Ctx = { records: Records; profile: Profile; asOf: string; fx: Record<string, number>; commitments: Commitment[]; warnings: Notes };

// A deal's virtual linked costs (id `deal~pattern`) follow it when it is excluded, so cancelling a deal drops its supplier payments too.
function matches(e: CashEvent, o: LeverOverride): boolean {
  if (o.eventId !== undefined) return e.id === o.eventId;
  const id = o.target.commitmentId;
  const own = e.commitmentId === id && (o.target.legIndex === undefined || o.target.legIndex === e.legIndex);
  const child = o.change.exclude === true && o.target.legIndex === undefined && !!e.commitmentId?.startsWith(`${id}~`);
  return own || child;
}

function tag(e: CashEvent, id: string, note: string): CashEvent {
  return { ...e, overriddenBy: [...(e.overriddenBy ?? []), id], basis: `${e.basis}; ${note}` };
}

function setAmount(e: CashEvent, amount: number, ctx: Ctx): CashEvent {
  return { ...e, amount, amountBase: toBase(amount, e.currency, ctx.profile, ctx.fx) ?? e.amountBase };
}

function applyOverride(events: CashEvent[], o: LeverOverride, ctx: Ctx): CashEvent[] {
  const hit = events.filter((e) => matches(e, o));
  if (hit.length === 0) {
    // An owner override or applied signal that matches nothing means the owner's statement is not in the forecast.
    // Lever no-ops are what-if feedback and are warned where the lever is built.
    if (o.origin === "owner" || o.origin === "signal") {
      const leg = o.target.legIndex !== undefined ? ` leg ${o.target.legIndex}` : "";
      ctx.warnings.review("override_unmatched", `${o.origin} override ${o.id} on ${o.target.commitmentId}${leg} matches no forecast event; nothing changed (needs review)`, [o.id, o.target.commitmentId]);
    }
    return events;
  }
  if (o.change.exclude) {
    return events.filter((e) => !matches(e, o));
  }
  // An amount without a legIndex is a new total: spread over matched legs by current size, remainder on the last.
  const total = hit.reduce((a, e) => a + e.amount, 0);
  const newAmounts = new Map<string, number>();
  if (o.change.amount !== undefined) {
    let left = o.change.amount;
    hit.forEach((e, i) => {
      const a = i === hit.length - 1 ? left : Math.floor((o.change.amount! * e.amount) / (total || 1));
      newAmounts.set(e.id, a);
      left -= a;
    });
  }
  return events.map((e) => {
    if (!matches(e, o)) return e;
    let out = e;
    const notes: string[] = [];
    if (o.change.date) {
      out = { ...out, date: o.change.date };
      notes.push(`date -> ${o.change.date}`);
    }
    if (o.change.shiftDays) {
      // An overdue payment is assumed payable now, so a shift on it counts from asOf, not from the old due date.
      // (A plain `date` override is the owner's explicit choice and is kept as given.)
      const from = out.direction === "out" && out.date < ctx.asOf ? ctx.asOf : out.date;
      out = { ...out, date: addDays(from, o.change.shiftDays) };
      notes.push(`shifted ${o.change.shiftDays > 0 ? "+" : ""}${o.change.shiftDays} days`);
    }
    if (newAmounts.has(e.id)) {
      out = setAmount(out, newAmounts.get(e.id)!, ctx);
      notes.push(`amount -> ${money(out.amount, out.currency)}`);
    }
    return tag(out, o.id, `${o.origin} override ${o.id}: ${notes.join(", ")}`);
  });
}

// The leg a chase/defer acts on: the named one, else the earliest remaining event in the lever's direction.
// Moving one leg keeps the others where they were (a deposit and a balance never collapse onto one date).
function targetLeg(l: { commitmentId: string; legIndex?: number }, dir: "in" | "out", events: CashEvent[], pred: (e: CashEvent) => boolean = () => true): CashEvent | undefined {
  const mine = events.filter((e) => e.commitmentId === l.commitmentId && e.direction === dir);
  // A named leg may be several installments after a split: take the earliest of them.
  const pool = l.legIndex !== undefined ? mine.filter((e) => e.legIndex === l.legIndex) : mine;
  return [...pool].filter(pred).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.legIndex - b.legIndex))[0];
}

// Profile rule: a recurring item flagged nonDeferrable (payroll, taxes), matched by id or by category so the same
// obligation imported from a bank file under another id is covered too. Shared by every lane that proposes a defer.
export function isNonDeferrable(profile: Profile, commitmentId: string, category?: string): boolean {
  return profile.recurring.some((r) => r.nonDeferrable === true && (r.id === commitmentId || (!!category && r.category === category)));
}

function leverOverrides(l: Lever, events: CashEvent[], ctx: Ctx): LeverOverride[] {
  const id = `lever-${l.kind}-${l.commitmentId}`;
  const noTarget = (what: string): LeverOverride[] => {
    ctx.warnings.push(`lever ${l.kind} on ${l.commitmentId}: no ${what} to act on; nothing changed`);
    return [];
  };
  switch (l.kind) {
    case "chase": {
      // A chase pulls a receipt earlier; never move one that is already at or before the assumed date.
      const e = targetLeg(l, "in", events, (x) => x.date > l.assumeDate);
      if (!e) return noTarget(`remaining receipt later than ${l.assumeDate}`);
      return [{ id, target: { commitmentId: l.commitmentId, legIndex: e.legIndex }, eventId: e.id, change: { date: l.assumeDate }, origin: "lever" }];
    }
    case "defer": {
      // Payroll, taxes and other fixed obligations are never deferred, even when asked.
      const cat = ctx.commitments.find((c) => c.id === l.commitmentId)?.category ?? events.find((e) => e.commitmentId === l.commitmentId)?.category;
      if (isNonDeferrable(ctx.profile, l.commitmentId, cat)) {
        ctx.warnings.push(`lever defer on ${l.commitmentId} skipped: marked nonDeferrable in the profile`);
        return [];
      }
      const e = targetLeg(l, "out", events);
      if (!e) return noTarget("remaining payment");
      return [{ id, target: { commitmentId: l.commitmentId, legIndex: e.legIndex }, eventId: e.id, change: { shiftDays: l.days }, origin: "lever" }];
    }
    case "pay_early": {
      const c = ctx.commitments.find((x) => x.id === l.commitmentId);
      const out = events.filter((e) => e.commitmentId === l.commitmentId && e.direction === "out");
      if (out.length === 0) return noTarget("remaining payment");
      const discounted = !!c?.discount && ctx.asOf <= c.discount.byDate;
      // One override per outflow event, so a discount never touches receipts and each leg (or installment) keeps its
      // own discounted amount. Installments sharing a legIndex get a per-leg counter so override ids stay unique.
      const seen = new Map<number, number>();
      return out.map((e) => {
        const k = seen.get(e.legIndex) ?? 0;
        seen.set(e.legIndex, k + 1);
        return {
          id: k === 0 ? `${id}-${e.legIndex}` : `${id}-${e.legIndex}-${k}`,
          target: { commitmentId: l.commitmentId, legIndex: e.legIndex },
          eventId: e.id,
          change: discounted ? { date: ctx.asOf, amount: Math.round(e.amount * (1 - c!.discount!.pct / 100)) } : { date: ctx.asOf },
          origin: "lever" as const,
        };
      });
    }
    case "ask_advance":
    case "split":
      return []; // these replace events, so adjust() handles them in applyAdvance / applySplit
  }
}

function applyAdvance(events: CashEvent[], l: Extract<Lever, { kind: "ask_advance" }>, ctx: Ctx): CashEvent[] {
  const out: CashEvent[] = [];
  const id = `lever-ask_advance-${l.commitmentId}`;
  for (const e of events) {
    if (e.commitmentId !== l.commitmentId || e.direction !== "in") {
      out.push(e);
      continue;
    }
    const now = Math.round(e.amount * l.share);
    const later = e.amount - now;
    if (now > 0) out.push(tag({ ...setAmount(e, now, ctx), id: `${e.id}-adv`, date: ctx.asOf }, id, `lever ${id}: ${Math.round(l.share * 100)}% advanced to ${ctx.asOf}`));
    if (later > 0) out.push(tag(setAmount(e, later, ctx), id, `lever ${id}: remaining ${Math.round((1 - l.share) * 100)}% stays`));
  }
  return out;
}

// Split the next remaining leg (payables: outflow, receivables: inflow) into installments by `shares`, spaced
// profile.thresholds.splitIntervalDays apart from the leg's date. Overdue payments are refused; an overdue receipt is
// only split when named by legIndex, starting one interval after asOf.
// Cents are exact: floor each installment, remainder on the last. Anything invalid warns and changes nothing.
function applySplit(events: CashEvent[], l: Extract<Lever, { kind: "split" }>, ctx: Ctx): CashEvent[] {
  const id = `lever-split-${l.commitmentId}`;
  const skip = (why: string) => {
    ctx.warnings.push(`lever split on ${l.commitmentId} skipped: ${why}; nothing changed`);
    return events;
  };
  const sum = l.shares.reduce((a, x) => a + x, 0);
  if (l.shares.length === 0 || l.shares.some((x) => !Number.isFinite(x) || x <= 0) || Math.abs(sum - 1) > 1e-9) {
    return skip(`shares must be positive and sum to 1 (got [${l.shares.join(", ")}])`);
  }
  const c = ctx.commitments.find((x) => x.id === l.commitmentId);
  const cat = c?.category ?? events.find((e) => e.commitmentId === l.commitmentId)?.category;
  // Splitting pays part of it later, which is a deferral; fixed obligations (payroll, taxes) are never deferred.
  if (isNonDeferrable(ctx.profile, l.commitmentId, cat)) return skip("marked nonDeferrable in the profile");
  const dir = c ? defaultDirection(c) : events.find((e) => e.commitmentId === l.commitmentId && e.status !== "actual")?.direction;
  if (!dir) return skip("no remaining leg");
  // With no leg named, an overdue receipt is not "next": take the earliest receipt still ahead of asOf.
  const pending = (x: CashEvent) => x.status !== "actual" && (dir === "out" || l.legIndex !== undefined || x.date >= ctx.asOf);
  const e = targetLeg(l, dir, events, pending);
  if (!e) return skip(`no remaining ${dir === "out" ? "payment" : "receipt"}`);
  // Overdue payments go through bank-cover and linked/estimated checks in the base run; a split would bypass them.
  if (dir === "out" && e.date < ctx.asOf) return skip("overdue payment; split skipped — check whether it is already paid");
  if (l.shares.length === 1) return events;

  const interval = engineSettings(ctx.profile).splitIntervalDays;
  // A named overdue receipt never becomes instant cash: its first installment lands one interval after asOf.
  const start = e.date < ctx.asOf ? addDays(ctx.asOf, interval) : e.date;
  const n = l.shares.length;
  // amount and amountBase are each allocated exactly, so the installments sum to the original in both currencies.
  let left = e.amount;
  let leftBase = e.amountBase;
  const parts = l.shares.map((share, i) => {
    const last = i === n - 1;
    const amount = last ? left : Math.floor(e.amount * share);
    const amountBase = last ? leftBase : Math.floor(e.amountBase * share);
    left -= amount;
    leftBase -= amountBase;
    const date = addDays(start, i * interval);
    return tag({ ...e, amount, amountBase, id: `${e.id}-split${i}`, date }, id, `lever ${id}: installment ${i + 1} of ${n} (${Math.round(share * 1000) / 10}%) on ${date}`);
  });
  return events.flatMap((x) => (x === e ? parts : [x]));
}

export function adjust(events: CashEvent[], scenario: Scenario, ctx: Ctx): CashEvent[] {
  let out = events;

  // Applied signals (date_change, cancel); amount_change and new commitments were handled at expansion.
  for (const s of ctx.records.signals) {
    if (s.state !== "applied" || !s.commitmentId) continue;
    const c = s.claim;
    if (c.kind === "cancel") {
      out = applyOverride(out, { id: s.id, target: { commitmentId: s.commitmentId }, change: { exclude: true }, origin: "signal" }, ctx);
    } else if (c.kind === "date_change") {
      const legs = out.filter((e) => e.commitmentId === s.commitmentId && (c.legIndex === undefined || e.legIndex === c.legIndex));
      if (legs.length <= 1 || c.legIndex !== undefined) {
        out = applyOverride(out, { id: s.id, target: { commitmentId: s.commitmentId, legIndex: c.legIndex }, change: { date: c.newDate }, origin: "signal" }, ctx);
      } else {
        // No leg named: move the whole schedule by the first leg's shift so later legs keep their spacing.
        const first = [...legs].sort((a, b) => (a.date < b.date ? -1 : 1))[0]!;
        if (first.date < ctx.asOf) {
          // The new date answers the overdue leg; later legs keep their own dates.
          out = applyOverride(out, { id: s.id, target: { commitmentId: s.commitmentId, legIndex: first.legIndex }, change: { date: c.newDate }, origin: "signal" }, ctx);
        } else {
          const delta = diffDays(c.newDate, first.date);
          out = applyOverride(out, { id: s.id, target: { commitmentId: s.commitmentId }, change: { shiftDays: delta }, origin: "signal" }, ctx);
        }
      }
    }
  }

  for (const o of scenario.overrides) out = applyOverride(out, o, ctx);

  for (const l of scenario.levers ?? []) {
    if (l.kind === "ask_advance") {
      out = applyAdvance(out, l, ctx);
      continue;
    }
    if (l.kind === "split") {
      out = applySplit(out, l, ctx);
      continue;
    }
    for (const o of leverOverrides(l, out, ctx)) out = applyOverride(out, o, ctx);
  }

  if (scenario.kind === "stress") {
    const delay = engineSettings(ctx.profile).stressDelayDays;
    const funding = new Set(ctx.commitments.filter((c) => c.funding).map((c) => c.id));
    // Only unsettled customer receipts still ahead of asOf are delayed. Overdue receipts stay overdue (shifting them
    // could pull them back into the horizon and make stress look better than base), and card/POS daily sales are
    // settlements, not customer credit risk.
    const delayed = (e: CashEvent) =>
      e.direction === "in" &&
      e.status !== "actual" &&
      e.date >= ctx.asOf &&
      e.commitmentId !== DAILY_SALES_ID &&
      !(e.commitmentId && funding.has(e.commitmentId));
    out = out
      .filter((e) => !(e.commitmentId && funding.has(e.commitmentId) && e.status === "likely"))
      .map((e) => (delayed(e) ? tag({ ...e, date: addDays(e.date, delay) }, "stress", `stress: receipt delayed ${delay} days`) : e));
  }
  return out;
}
