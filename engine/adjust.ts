// Step 4 of a run: applied signals, then scenario overrides, then levers, then stress. A what-if always wins.
// Every applied id lands in event.overriddenBy. Pure.

import type { CashEvent, Commitment, Lever, Override, Records, Scenario } from "../schema/records";
import type { Profile } from "../schema/profile";
import { addDays, diffDays } from "./dates";
import { money, toBase } from "./expand";

export const STRESS_DELAY_DAYS = 7;

type Ctx = { records: Records; profile: Profile; asOf: string; fx: Record<string, number>; commitments: Commitment[]; warnings: string[] };

function matches(e: CashEvent, o: Override): boolean {
  return e.commitmentId === o.target.commitmentId && (o.target.legIndex === undefined || o.target.legIndex === e.legIndex);
}

function tag(e: CashEvent, id: string, note: string): CashEvent {
  return { ...e, overriddenBy: [...(e.overriddenBy ?? []), id], basis: `${e.basis}; ${note}` };
}

function setAmount(e: CashEvent, amount: number, ctx: Ctx): CashEvent {
  return { ...e, amount, amountBase: toBase(amount, e.currency, ctx.profile, ctx.fx) ?? e.amountBase };
}

function applyOverride(events: CashEvent[], o: Override, ctx: Ctx): CashEvent[] {
  const hit = events.filter((e) => matches(e, o));
  if (hit.length === 0) return events;
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
      out = { ...out, date: addDays(out.date, o.change.shiftDays) };
      notes.push(`shifted ${o.change.shiftDays > 0 ? "+" : ""}${o.change.shiftDays} days`);
    }
    if (newAmounts.has(e.id)) {
      out = setAmount(out, newAmounts.get(e.id)!, ctx);
      notes.push(`amount -> ${money(out.amount)}`);
    }
    return tag(out, o.id, `${o.origin} override ${o.id}: ${notes.join(", ")}`);
  });
}

function leverOverrides(l: Lever, events: CashEvent[], ctx: Ctx): Override[] {
  const id = `lever-${l.kind}-${l.commitmentId}`;
  const target = { commitmentId: l.commitmentId };
  switch (l.kind) {
    case "chase":
      return [{ id, target, change: { date: l.assumeDate }, origin: "lever" }];
    case "defer":
      return [{ id, target, change: { shiftDays: l.days }, origin: "lever" }];
    case "pay_early": {
      const c = ctx.commitments.find((x) => x.id === l.commitmentId);
      const out = events.filter((e) => e.commitmentId === l.commitmentId && e.direction === "out");
      const ov: Override[] = [{ id, target, change: { date: ctx.asOf }, origin: "lever" }];
      if (c?.discount && ctx.asOf <= c.discount.byDate && out.length) {
        const total = out.reduce((a, e) => a + e.amount, 0);
        ov.push({ id: `${id}-discount`, target, change: { amount: Math.round(total * (1 - c.discount.pct / 100)) }, origin: "lever" });
      }
      return ov;
    }
    case "ask_advance":
      return []; // splits events, so adjust() handles it in applyAdvance
    case "split":
      ctx.warnings.push(`lever split on ${l.commitmentId} is not modeled yet; events unchanged`);
      return [];
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
        const delta = diffDays(c.newDate, first.date);
        out = applyOverride(out, { id: s.id, target: { commitmentId: s.commitmentId }, change: { shiftDays: delta }, origin: "signal" }, ctx);
      }
    }
  }

  for (const o of scenario.overrides) out = applyOverride(out, o, ctx);

  for (const l of scenario.levers ?? []) {
    if (l.kind === "ask_advance") {
      out = applyAdvance(out, l, ctx);
      continue;
    }
    for (const o of leverOverrides(l, out, ctx)) out = applyOverride(out, o, ctx);
  }

  if (scenario.kind === "stress") {
    const funding = new Set(ctx.commitments.filter((c) => c.funding).map((c) => c.id));
    out = out
      .filter((e) => !(e.commitmentId && funding.has(e.commitmentId) && e.status === "likely"))
      .map((e) =>
        e.direction === "in" && e.status !== "actual" && !(e.commitmentId && funding.has(e.commitmentId))
          ? tag({ ...e, date: addDays(e.date, STRESS_DELAY_DAYS) }, "stress", `stress: receipt delayed ${STRESS_DELAY_DAYS} days`)
          : e,
      );
  }
  return out;
}
