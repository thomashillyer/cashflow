// Step 1-3 of a run: commitments -> dated CashEvents (pattern legs, anchors, lag, recurring, linked costs).
// Pure: no I/O, no clock. Docs: docs/design/05-forecast-engine.md, docs/TECHNICAL_PLAN.md section 6.

import type { CashEvent, Commitment, Direction, Records, Settlement, Signal } from "../schema/records";
import type { Anchor, PaymentPattern, Profile } from "../schema/profile";
import { addDays, addMonthsClamped, dateRange, diffDays, dowOf, endOfMonth } from "./dates";
import { partyLag, type Lag } from "./lag";
import { ENGINE_DEFAULTS, engineSettings, type EngineSettings } from "./settings";
import { Notes } from "./review";
import type { ReviewReason } from "../schema/forecast";

export type Expanded = { events: CashEvent[]; commitments: Commitment[]; warnings: string[]; reasons: ReviewReason[] };

type Leg = PaymentPattern["legs"][number];

// Event confidence by status, the anchors and commitment types that get the party's lag, and the other expansion
// tunables come from engineSettings(profile) (engine/settings.ts). Kept for importers: the default status confidence.
export const STATUS_CONFIDENCE = ENGINE_DEFAULTS.statusConfidence;

// Display only; assumes a 2-decimal currency. Never used in arithmetic.
export function money(n: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n / 100);
}

export function toBase(amount: number, currency: string, profile: Profile, fx: Record<string, number>): number | undefined {
  if (currency === profile.baseCurrency) return amount;
  const rate = fx[currency];
  return rate === undefined ? undefined : Math.round(amount * rate);
}

export function defaultDirection(c: Commitment): Direction {
  if (c.direction) return c.direction;
  if (c.type === "invoice" || c.type === "sales_deal") return "in";
  return "out";
}

// An unknown patternId falls back to the type default (see unknownPattern, which warns and notes it in basis).
function pickPattern(c: Commitment, profile: Profile): PaymentPattern | undefined {
  const named = c.patternId ? profile.paymentPatterns.find((p) => p.id === c.patternId) : undefined;
  return named ?? profile.paymentPatterns.find((p) => p.appliesTo === c.type && p.isDefault);
}

function unknownPattern(c: Commitment, profile: Profile): boolean {
  return !!c.patternId && !profile.paymentPatterns.some((p) => p.id === c.patternId);
}

// Split `total` by shares; floor each leg and give the remainder to the last leg, so legs sum exactly.
function allocate(total: number, shares: number[]): number[] {
  const out = shares.map((s) => Math.floor(total * s));
  const rest = total - out.reduce((a, b) => a + b, 0);
  out[out.length - 1] = (out[out.length - 1] ?? 0) + rest;
  return out;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// First anchor date the commitment has, in the given order, with the name of the anchor used (for basis).
function firstAnchor(c: Commitment, order: ("invoice" | "due" | "order" | "delivery")[]): { name: string; date: string } | undefined {
  for (const name of order) {
    const date = c.anchors[name];
    if (date) return { name, date };
  }
  return undefined;
}

// `why` explains a missing date in the "not scheduled" warning.
function resolveAnchor(anchor: Anchor, c: Commitment, profile: Profile, leg?: Leg): { date?: string; note?: string; why?: string } {
  const a = c.anchors;
  const lt = profile.leadTimes ?? {};
  if (anchor === "month_end") {
    // Last day of the calendar month of the invoice date (else due, order, delivery). offsetDays then counts from
    // that day, so "net 30 end of month" is { anchor: "month_end", offsetDays: 30 }.
    const ref = firstAnchor(c, ["invoice", "due", "order", "delivery"]);
    return ref ? { date: endOfMonth(ref.date), note: `end of month of ${ref.name} ${ref.date}` } : { why: "needs an invoice, due, order, or delivery date" };
  }
  if (anchor === "weekday") {
    // First date on/after the reference date (invoice, else order, else due) that falls on leg.weekday (0 = Monday).
    const wd = leg?.weekday;
    if (wd === undefined || !Number.isInteger(wd) || wd < 0 || wd > 6) return { why: "weekday anchor needs a leg weekday 0-6 (0 = Monday) in the profile" };
    const ref = firstAnchor(c, ["invoice", "order", "due"]);
    if (!ref) return { why: "needs an invoice, order, or due date" };
    const date = addDays(ref.date, (wd - dowOf(ref.date) + 7) % 7);
    return { date, note: `first ${WEEKDAYS[wd]} on/after ${ref.name} ${ref.date}` };
  }
  if (a[anchor]) return { date: a[anchor] };
  if (anchor === "ship" && a.order && lt.productionDays !== undefined)
    return { date: addDays(a.order, lt.productionDays), note: `ship estimated = order + ${lt.productionDays}d production` };
  if (anchor === "delivery" && lt.transitDays !== undefined) {
    const ship = resolveAnchor("ship", c, profile);
    if (ship.date)
      return {
        date: addDays(ship.date, lt.transitDays),
        note: `delivery estimated = ship + ${lt.transitDays}d transit${ship.note ? ` (${ship.note})` : ""}`,
      };
  }
  return {};
}

type Prepared = { commitments: Commitment[]; amountSignals: Map<string, Signal> };

// Applied signals that change what commitments exist: new_commitment/plan add one, amount_change rescales one.
function prepare(records: Records): Prepared {
  const amountSignals = new Map<string, Signal>();
  const commitments = [...records.commitments];
  for (const s of records.signals) {
    if (s.state !== "applied") continue;
    if (s.claim.kind === "new_commitment" || s.claim.kind === "plan") {
      commitments.push({ ...s.claim.draft, id: `sig-${s.id}`, sourceRef: s.claim.draft.sourceRef ?? s.sourceRef });
    } else if (s.claim.kind === "amount_change" && s.commitmentId) {
      amountSignals.set(s.commitmentId, s);
    }
  }
  return { commitments, amountSignals };
}

// Linked, same-direction, same-currency invoices/bills that replace part of a commitment (PO <-> invoice overlap).
// Cross-currency links are skipped with a warning (TECHNICAL_PLAN 6.B.6: overlap only in the same currency).
type Cover = { amount: number; cutoff?: string; id: string };
function coveredByLinked(c: Commitment, byId: Map<string, Commitment>, warnings: Notes): Cover[] {
  const out: Cover[] = [];
  const label = c.reference ?? c.id;
  for (const id of c.linkedCommitmentIds ?? []) {
    const l = byId.get(id);
    if (!l || (l.type !== "invoice" && l.type !== "bill")) continue;
    if (defaultDirection(l) !== defaultDirection(c)) continue;
    if (l.settlement === "cancelled" || l.settlement === "credited") continue;
    if (l.currency !== c.currency) {
      warnings.review("linked_currency_mismatch", `${label}: linked ${l.reference ?? l.id} is in ${l.currency}, not ${c.currency}; not offset against it (check for double counting)`, [c.id, l.id]);
      continue;
    }
    out.push({ amount: l.amount, cutoff: l.anchors.due ?? l.anchors.invoice, id: l.id });
  }
  const covered = out.reduce((a, x) => a + x.amount, 0);
  if (covered > c.amount) warnings.review("linked_overallocated", `${label}: linked invoices (${money(covered, c.currency)}) exceed the amount (${money(c.amount, c.currency)}); check the allocation`, [c.id, ...out.map((x) => x.id)]);
  // Earliest-dated invoice first; undated last. Ties by id so the run is deterministic.
  const key = (x: Cover) => `${x.cutoff ?? "9999-99-99"}|${x.id}`;
  return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

// A Settlement (from the books) and a bank actual tagged with the same commitmentId are one payment when they have the
// same amount and currency and their dates are at most this many days apart (bank posting vs. booking date).
// Profile: engine.settlementMatchDays; this is its default.
export const SETTLEMENT_MATCH_DAYS = ENGINE_DEFAULTS.settlementMatchDays;

type Payments = {
  pairs: { settlement: Settlement; actual: CashEvent }[];
  settlements: Settlement[]; // unmatched, in the commitment's currency
  actuals: CashEvent[]; // unmatched tagged bank actuals, in the commitment's currency and direction
};

// What the payment rules need besides the commitment.
// countedActuals: ids of stored actuals whose cash the run counts (forecast.ts countedActualIds). Actuals left out of
// opening cash and the main line must not cancel expected money. Undefined (expand() called on its own): all count.
// lags: per-run memo of partyLag by partyId (the lag depends only on records, profile and party), so a run with
// thousands of receivables does not rescan payment history for each one.
// settings: engineSettings(profile), resolved once per run (expand() fills it in; absent means resolve from the profile).
// payments: settlements and tagged bank lines grouped by commitmentId once per run (indexPayments), so matching a
// commitment's payments does not rescan every record; absent means scan the records.
export type PaymentContext = { snapDate: string; horizonEnd: string; countedActuals?: Set<string>; byId: Map<string, Commitment>; lags?: Map<string | undefined, Lag>; settings?: EngineSettings; payments?: PaymentIndex };

// Settlements and tagged events by commitmentId, each list in record order (so matching is unchanged).
export type PaymentIndex = { settlements: Map<string, Settlement[]>; events: Map<string, CashEvent[]> };
export function indexPayments(records: Records): PaymentIndex {
  const settlements = new Map<string, Settlement[]>();
  for (const s of records.settlements) {
    const list = settlements.get(s.commitmentId);
    if (list) list.push(s);
    else settlements.set(s.commitmentId, [s]);
  }
  const events = new Map<string, CashEvent[]>();
  for (const e of records.events) {
    if (e.commitmentId === undefined) continue;
    const list = events.get(e.commitmentId);
    if (list) list.push(e);
    else events.set(e.commitmentId, [e]);
  }
  return { settlements, events };
}

// The payment identity rule (TECHNICAL_PLAN 6 opening-cash boundary: a Settlement and its bank line count once).
// Candidate pairs share amount and currency and lie within `matchDays` (profile engine.settlementMatchDays); they are matched greedily by date
// distance, then settlement id, then actual id, so each side is used at most once and the result is deterministic.
// Tagged actuals the run counts are payments on any date before the (exclusive) horizon end, including future-dated
// (scheduled) bank payments. Actuals in the other direction (refunds) are not payments toward the commitment.
export function matchPayments(c: Commitment, records: Records, horizonEnd: string, warnings: Notes | string[], countedActuals?: Set<string>, matchDays: number = SETTLEMENT_MATCH_DAYS, index?: PaymentIndex): Payments {
  // Exported for tests and callers that only want strings; inside a run it gets the Notes collector.
  const flag = (code: string, msg: string, refs: string[]) => (warnings instanceof Notes ? warnings.review(code, msg, refs) : warnings.push(msg));
  const label = c.reference ?? c.id;
  const dir = defaultDirection(c);
  const settlements: Settlement[] = [];
  for (const s of index ? (index.settlements.get(c.id) ?? []) : records.settlements) {
    if (s.commitmentId !== c.id) continue;
    if (s.currency !== c.currency) {
      flag("missing_fx", `${label}: settlement ${s.id} is in ${s.currency}, not ${c.currency}; not deducted from what is outstanding (needs review)`, [c.id, s.id]);
      continue;
    }
    settlements.push(s);
  }
  const actuals: CashEvent[] = [];
  for (const e of index ? (index.events.get(c.id) ?? []) : records.events) {
    if (e.commitmentId !== c.id || e.direction !== dir || e.date >= horizonEnd) continue;
    if (countedActuals && !countedActuals.has(e.id)) continue; // not in the run's cash, so not proof of payment here
    if (e.currency !== c.currency) {
      flag("missing_fx", `${label}: bank line ${e.id} is in ${e.currency}, not ${c.currency}; not deducted from what is outstanding (needs review)`, [c.id, e.id]);
      continue;
    }
    actuals.push(e);
  }
  const candidates: { s: Settlement; a: CashEvent; gap: number }[] = [];
  for (const s of settlements)
    for (const a of actuals) {
      const gap = Math.abs(diffDays(a.date, s.date));
      if (s.amount === a.amount && gap <= matchDays) candidates.push({ s, a, gap });
    }
  candidates.sort((x, y) => x.gap - y.gap || (x.s.id < y.s.id ? -1 : x.s.id > y.s.id ? 1 : x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0));
  const usedS = new Set<string>();
  const usedA = new Set<string>();
  const pairs: Payments["pairs"] = [];
  for (const { s, a } of candidates) {
    if (usedS.has(s.id) || usedA.has(a.id)) continue;
    usedS.add(s.id);
    usedA.add(a.id);
    pairs.push({ settlement: s, actual: a });
  }
  return { pairs, settlements: settlements.filter((s) => !usedS.has(s.id)), actuals: actuals.filter((a) => !usedA.has(a.id)) };
}

// What of a commitment is already paid, and the total it is paid out of. Payments come from matchPayments: a matched
// Settlement + bank line counts once.
// Unmatched on both sides (fees or an FX haircut change the amount, a posting delay breaks the window): the
// Settlements and bank lines are treated as the same payment(s) and the books' figure (the Settlements) counts, as
// seen in the bank; the bank-only money is not deducted again. Warned for reconciliation.
// - `outstanding` unset: paid = matched pairs + unmatched Settlements that the bank shows (an unmatched bank line
//   exists, or the Settlement is dated before the latest balance snapshot, so inside opening cash) + bank-only money
//   when there is no unmatched Settlement. An unmatched Settlement on/after the snapshot with no bank line stays
//   expected and warns. More paid than the amount warns of a possible double count.
// - `outstanding` set: amount - outstanding is what the books already reflect. Settlements come from the same books, so
//   they never reduce beyond it (excess warns). Bank lines may be newer than the books: payments are assumed reflected
//   first, and only bank-only money beyond `amount - outstanding` reduces further. The part of `amount - outstanding`
//   explained by no payment is treated as linked coverage already applied, and only the rest of the linked coverage is
//   subtracted again later.
// An applied amount_change signal states the new total; what was already paid stays paid.
function paidSoFar(
  c: Commitment,
  records: Records,
  amountSignal: Signal | undefined,
  covered: number,
  ctx: PaymentContext,
  warnings: Notes,
): { total: number; paid: number; counted: Set<string> } {
  const label = c.reference ?? c.id;
  const counted = new Set<string>();
  const pay = matchPayments(c, records, ctx.horizonEnd, warnings, ctx.countedActuals, ctx.settings?.settlementMatchDays, ctx.payments);
  const pairsSum = pay.pairs.reduce((a, p) => a + p.actual.amount, 0);
  for (const p of pay.pairs) counted.add(p.settlement.id);
  const bankIds = pay.actuals.map((e) => e.id).join(", ");
  const merged = pay.settlements.length > 0 && pay.actuals.length > 0;
  if (merged)
    warnings.review("payment_mismatch", `${label}: settlement ${pay.settlements.map((s) => s.id).join(", ")} and bank line ${bankIds} differ (amount/date); treated as one payment, counting the books' ${money(pay.settlements.reduce((a, s) => a + s.amount, 0), c.currency)} (needs reconciliation)`, [c.id, ...pay.settlements.map((s) => s.id), ...pay.actuals.map((e) => e.id)]);
  const bankOnly = merged ? 0 : pay.actuals.reduce((a, e) => a + e.amount, 0);
  let paid: number;
  let outstanding: number;
  if (c.outstanding === undefined) {
    let settled = pairsSum + bankOnly;
    for (const s of pay.settlements) {
      if (s.date >= ctx.snapDate && !merged) {
        warnings.review("unreconciled_settlement", `${label}: payment of ${money(s.amount, s.currency)} recorded on ${s.date} but not seen in the bank; still forecast as expected (needs reconciliation)`, [c.id, s.id]);
        continue;
      }
      settled += s.amount;
      counted.add(s.id);
    }
    if (settled > c.amount) {
      // One bank line can pay several invoices of the same party; name the open ones the excess would exactly cover.
      const excess = settled - c.amount;
      const also = [...ctx.byId.values()]
        .filter((o) => o.id !== c.id && o.partyId !== undefined && o.partyId === c.partyId && o.currency === c.currency && defaultDirection(o) === defaultDirection(c) && (o.outstanding ?? o.amount) === excess)
        .map((o) => o.reference ?? o.id);
      warnings.review("possible_double_count", `${label}: payments recorded (${money(settled, c.currency)}) exceed the amount (${money(c.amount, c.currency)})${also.length ? `; the extra ${money(excess, c.currency)} matches ${also.join(", ")} of the same party, which ${bankIds ? `bank line ${bankIds}` : "the payment"} may also pay` : ""}; possible double count (needs reconciliation)`, [c.id, ...pay.pairs.map((p) => p.settlement.id), ...pay.settlements.map((s) => s.id), ...pay.actuals.map((e) => e.id)]);
    } else if (bankOnly > 0)
      warnings.review("unreconciled_payment", `${label}: ${money(bankOnly, c.currency)} paid per bank line ${bankIds} with no matching settlement in the books; deducted from what is expected (needs reconciliation)`, [c.id, ...pay.actuals.map((e) => e.id)]);
    paid = Math.min(c.amount, settled);
    outstanding = c.amount - paid;
  } else {
    outstanding = c.outstanding;
    const booked = pairsSum + pay.settlements.reduce((a, s) => a + s.amount, 0);
    for (const s of pay.settlements) counted.add(s.id);
    const reduced = Math.max(0, c.amount - outstanding);
    if (booked > reduced) warnings.review("possible_double_count", `${label}: settlements (${money(booked, c.currency)}) exceed what outstanding reflects (${money(reduced, c.currency)}); possible double count (needs reconciliation)`, [c.id, ...pay.pairs.map((p) => p.settlement.id), ...pay.settlements.map((s) => s.id)]);
    const beyond = Math.min(bankOnly, Math.max(0, booked + bankOnly - reduced));
    if (beyond > 0)
      warnings.review("unreconciled_payment", `${label}: ${money(beyond, c.currency)} paid per bank line ${bankIds} is beyond what outstanding reflects; deducted from what is expected (needs reconciliation)`, [c.id, ...pay.actuals.map((e) => e.id)]);
    const preCovered = Math.min(covered, Math.max(0, reduced - booked - bankOnly));
    paid = reduced - preCovered + beyond;
  }
  if (c.settlement === "partial" && outstanding >= c.amount)
    warnings.review("settlement_status_mismatch", `${label}: marked partially paid but nothing is recorded as paid; forecasting the full ${money(c.amount, c.currency)} (needs review)`, [c.id]);
  if (c.settlement === "open" && paid > 0)
    warnings.review("settlement_status_mismatch", `${label}: marked open but ${money(paid, c.currency)} is already paid; forecasting only what remains (needs review)`, [c.id]);
  const total = amountSignal?.claim.kind === "amount_change" ? amountSignal.claim.newAmount : c.amount;
  return { total, paid: Math.min(total, paid), counted };
}

function expandCommitment(
  c: Commitment,
  records: Records,
  profile: Profile,
  fx: Record<string, number>,
  byId: Map<string, Commitment>,
  amountSignal: Signal | undefined,
  ctx: PaymentContext,
  warnings: Notes,
): CashEvent[] {
  const tun = ctx.settings ?? engineSettings(profile);
  const label = c.reference ?? c.id;
  if (c.settlement === "paid" && c.outstanding !== undefined && c.outstanding > 0)
    warnings.review("settlement_status_mismatch", `${label}: marked paid but ${money(c.outstanding, c.currency)} is still outstanding; nothing forecast (needs review)`, [c.id]);
  if (c.settlement === "paid" || c.settlement === "cancelled" || c.settlement === "credited") return [];
  if (c.type === "recurring" && !c.anchors.due) return []; // profile.recurring owns aggregate recurrences
  const covers = coveredByLinked(c, byId, warnings);
  const { total, paid, counted } = paidSoFar(c, records, amountSignal, covers.reduce((a, x) => a + x.amount, 0), ctx, warnings);
  const pattern = pickPattern(c, profile);
  const dir0 = defaultDirection(c);
  const legs: Leg[] = pattern?.legs ?? [{ share: 1, anchor: "due", offsetDays: 0, direction: dir0 }];
  const touched: string[] = amountSignal?.claim.kind === "amount_change" ? [amountSignal.id] : [];

  const legAmounts = allocate(total, legs.map((l) => l.share));
  const take = (i: number, want: number): number => {
    const t = Math.max(0, Math.min(want, legAmounts[i]!));
    legAmounts[i]! -= t;
    return t;
  };
  // 1. Paid money consumes pattern legs: explicit Settlement.legIndex first, then legs in order.
  let consume = paid;
  if (counted.size > 0) for (const s of ctx.payments ? (ctx.payments.settlements.get(c.id) ?? []) : records.settlements) {
    if (!counted.has(s.id) || s.legIndex === undefined || legAmounts[s.legIndex] === undefined) continue;
    consume -= take(s.legIndex, Math.min(s.amount, consume));
  }
  for (let i = 0; i < legAmounts.length && consume > 0; i++) consume -= take(i, consume);

  // 2. Linked invoices/bills replace the legs they invoiced. Rule: each linked invoice (earliest first) first consumes
  // the legs whose anchor date is on or before the invoice's due date (else its invoice date), since those are what it
  // billed; any remainder then consumes the other legs. Legs with no resolvable anchor date are only reached by the
  // remainder; an undated invoice is all remainder.
  // Among the billed legs the order is ambiguous (a 70% balance bill dated at shipment is "on or after" both the
  // deposit and the shipment leg), so we pick the conservative side: money out consumes the latest billed leg first
  // (the earlier payment stays in the forecast), money in consumes the earliest billed leg first (the receipt stays late).
  // The remainder pass uses the same direction-aware order.
  const legDates = legs.map((leg) => resolveAnchor(leg.anchor, c, profile).date);
  const order = legs.map((_, i) => i);
  const billedOrder = dir0 === "out" ? [...order].reverse() : order;
  for (const cover of covers) {
    let left = cover.amount;
    if (cover.cutoff) for (const i of billedOrder) if (left > 0 && legDates[i] !== undefined && legDates[i]! <= cover.cutoff) left -= take(i, left);
    for (const i of billedOrder) if (left > 0) left -= take(i, left);
  }

  const events: CashEvent[] = [];
  legs.forEach((leg, i) => {
    const amount = legAmounts[i]!;
    if (amount <= 0) return;
    const anchor = resolveAnchor(leg.anchor, c, profile, leg);
    if (!anchor.date) {
      warnings.review("missing_anchor", `${label}: no ${leg.anchor} date for leg ${i + 1}${anchor.why ? ` (${anchor.why})` : ""}; not scheduled (needs review)`, [c.id]);
      return;
    }
    let date = addDays(anchor.date, leg.offsetDays);
    let basis = `${leg.anchor} ${anchor.date}${anchor.note ? ` [${anchor.note}]` : ""}${leg.offsetDays ? ` + ${leg.offsetDays} days` : ""}`;
    if (unknownPattern(c, profile)) basis += ` [unknown pattern ${c.patternId}; used ${pattern ? `default ${pattern.id}` : "a single due-date leg"}]`;
    let conf = c.status === "possible" ? (c.probability ?? tun.statusConfidence.possible) : tun.statusConfidence[c.status];
    const overriddenBy = [...touched];
    const lagged = leg.direction === "in" && !c.funding && c.status !== "actual" && tun.lag.laggedTypes.includes(c.type) && tun.lag.laggedAnchors.includes(leg.anchor);
    if (lagged) {
      let lag = ctx.lags?.get(c.partyId);
      if (!lag) {
        lag = partyLag(records, profile, c.partyId, tun);
        ctx.lags?.set(c.partyId, lag);
      }
      date = addDays(date, lag.days);
      basis += ` ${lag.basis}`;
      conf *= lag.confidence;
      if (lag.ruleId) overriddenBy.push(lag.ruleId);
    }
    const base = toBase(amount, c.currency, profile, fx);
    if (base === undefined) {
      warnings.review("missing_fx", `${label}: no FX rate for ${c.currency}; excluded from the forecast`, [c.id]);
      return;
    }
    events.push({
      id: `evt-${c.id}-${i}`,
      commitmentId: c.id,
      legIndex: i,
      date,
      amount,
      currency: c.currency,
      amountBase: base,
      direction: leg.direction,
      status: c.status,
      confidence: conf,
      basis,
      category: c.category,
      sourceRef: c.sourceRef,
      ...(overriddenBy.length ? { overriddenBy } : {}),
    });
  });
  return events;
}

type Recurring = Profile["recurring"][number];
type Occurrence = { date: string; index: number };

const monthIdx = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;

// Occurrences of a profile recurring item inside [from, until). `phase` (the profile anchor, or a matched commitment's
// due date) sets the day of month / weekday; it is not a start, so occurrences are projected backward and forward
// from it. `index` always counts from the profile's own `r.anchor` (0 = anchor's period, negative before it), so a
// re-import that moves the commitment's due date never retargets an owner override's legIndex:
// weekly/biweekly = round(days from r.anchor / step); monthly = months from r.anchor's month; quarterly = that / 3;
// semimonthly = 2n for the phase day and 2n+1 for secondDay in month n. `startDate`/`endDate` (inclusive) bound it.
function occurrences(r: Recurring, phase: string, from: string, until: string, warnings: Notes): Occurrence[] {
  const out: Occurrence[] = [];
  const lo = r.startDate && r.startDate > from ? r.startDate : from;
  const stop = r.endDate && r.endDate < until ? addDays(r.endDate, 1) : until; // exclusive
  if (lo >= stop) return out;
  const push = (date: string, index: number) => {
    if (date >= lo && date < stop) out.push({ date, index });
  };
  const day = Number(phase.slice(8, 10));
  const monthsFromAnchor = (d: string) => monthIdx(d) - monthIdx(r.anchor);
  if (r.cadence === "weekly" || r.cadence === "biweekly") {
    const step = r.cadence === "weekly" ? 7 : 14;
    for (let n = Math.ceil(diffDays(lo, phase) / step); ; n++) {
      const d = addDays(phase, n * step);
      if (d >= stop) break;
      push(d, Math.round(diffDays(d, r.anchor) / step));
    }
  } else if (r.cadence === "monthly" || r.cadence === "quarterly") {
    const step = r.cadence === "monthly" ? 1 : 3;
    for (let n = Math.floor((monthIdx(lo) - monthIdx(phase)) / step) - 1; ; n++) {
      const d = addMonthsClamped(phase, n * step, day);
      if (d >= stop) break;
      push(d, Math.round(monthsFromAnchor(d) / step));
    }
  } else {
    if (r.secondDay === undefined) warnings.review("invalid_profile", `recurring ${r.name}: semimonthly needs secondDay; treating as monthly`, [r.id]);
    for (let n = monthIdx(lo) - monthIdx(phase) - 1; ; n++) {
      const a = addMonthsClamped(phase, n, day);
      const b = r.secondDay === undefined ? undefined : addMonthsClamped(phase, n, r.secondDay);
      if (a >= stop && (!b || b >= stop)) break;
      const m = monthsFromAnchor(a);
      push(a, r.secondDay === undefined ? m : 2 * m);
      if (b) push(b, 2 * m + 1);
    }
    out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.index - y.index));
  }
  return out;
}

// A commitment whose id matches a profile recurring item overrides its amount (and its phase, when the commitment has
// anchors.due) but keeps the profile cadence, so a confirmed rent or payroll is never forecast as a one-off.
// Settlement of the matched commitment: paid/credited drops only the occurrence on its due date (the bank actual
// covers it); cancelled ends the series from its due date (needs review). An "actual" commitment's future
// occurrences are only "committed".
function expandRecurring(
  commitments: Commitment[],
  amountSignals: Map<string, Signal>,
  profile: Profile,
  fx: Record<string, number>,
  asOf: string,
  horizonEnd: string,
  warnings: Notes,
  tun: EngineSettings = engineSettings(profile),
): CashEvent[] {
  const events: CashEvent[] = [];
  const byId = new Map(commitments.map((c) => [c.id, c]));
  for (const r of profile.recurring) {
    const c = byId.get(r.id);
    const label = c?.reference ?? r.id;
    const due = c?.anchors.due;
    const sig = c ? amountSignals.get(c.id) : undefined;
    const amount = sig?.claim.kind === "amount_change" ? sig.claim.newAmount : (c?.amount ?? r.amount);
    const currency = c?.currency ?? profile.baseCurrency;
    const phase = due ?? r.anchor;
    const amountBase = toBase(amount, currency, profile, fx);
    if (amountBase === undefined) {
      warnings.review("missing_fx", `${label}: no FX rate for ${currency}; recurring ${r.name} excluded from the forecast`, [c?.id ?? r.id]);
      continue;
    }
    let until = horizonEnd;
    let skip: string | undefined;
    let note = "";
    if (c?.settlement === "cancelled") {
      const end = due ?? asOf;
      if (end < until) until = end;
      note = `; cancelled from ${end}`;
      warnings.review("recurring_cancelled", `${label}: recurring ${r.name} is cancelled from ${end}; later occurrences dropped (needs review)`, [c.id]);
    } else if (c && (c.settlement === "paid" || c.settlement === "credited") && due) {
      skip = due;
      note = `; ${due} ${c.settlement}`;
    }
    const dir = c ? defaultDirection(c) : (r.direction ?? "out");
    const status = !c || c.status === "actual" ? "committed" : c.status;
    const conf = status === "possible" ? (c?.probability ?? tun.statusConfidence.possible) : tun.statusConfidence[status];
    const via = c ? `; amount${due ? " and phase" : ""} from commitment ${label}` : "";
    const span = `${r.startDate ? `, starts ${r.startDate}` : ""}${r.endDate ? `, ends ${r.endDate}` : ""}`;
    const found = occurrences(r, phase, asOf, until, warnings).filter((o) => o.date !== skip);
    if (c && found.length === 0 && c.settlement !== "cancelled")
      warnings.review("recurring_no_occurrences", `${label}: recurring commitment yields no payments in the horizon (needs review)`, [c.id]);
    for (const { date, index } of found) {
      events.push({
        id: `evt-${r.id}-${index}`,
        commitmentId: r.id,
        legIndex: index,
        date,
        amount,
        currency,
        amountBase,
        direction: dir,
        status,
        confidence: conf,
        basis: `recurring ${r.cadence}: ${r.name}, anchored on ${phase}${span}${via}${note}`,
        category: c?.category ?? r.category,
        sourceRef: c?.sourceRef ?? { system: "profile", record: r.id },
        ...(sig ? { overriddenBy: [sig.id] } : {}),
      });
    }
  }
  return events;
}

// Profile: engine.salesHistoryDays; this is its default. Read engineSettings(profile).salesHistoryDays in code.
export const SALES_HISTORY_DAYS = ENGINE_DEFAULTS.salesHistoryDays;
// commitmentId of the events emitted by the daily-sales revenue model.
export const DAILY_SALES_ID = "daily-sales";
// legIndex of the daily-sales event for a sale date: its day number since 1970-01-01 (UTC). Stable across runs.
export const dailySalesLegIndex = (saleDate: string): number => diffDays(saleDate, "1970-01-01");

function validWeekdayWeights(w: unknown): w is number[] {
  return Array.isArray(w) && w.length === 7 && w.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0) && w.some((x) => x > 0);
}

// Daily-sales revenue model: average daily sales from the last salesHistoryDays (profile engine.salesHistoryDays, default 28) days of actual "sales" receipts, shaped by the
// profile's weekday weights (index 0 = Monday). With `settleLagDays` (card settlement), each sale day's money lands
// that many days later. Settlement dates that already have actual sales receipts are not forecast again.
function expandDailySales(records: Records, profile: Profile, asOf: string, horizonEnd: string, fx: Record<string, number>, warnings: Notes, tun: EngineSettings = engineSettings(profile)): CashEvent[] {
  if (profile.revenueModel.kind !== "dailySales") return [];
  const weights: unknown = profile.revenueModel.weekdayWeights;
  // Exactly seven weights (Mon..Sun), each a finite number >= 0 (0 = closed that day), at least one > 0. Anything else
  // (a negative weight would forecast negative sales) skips the model with a needs-review reason.
  if (!validWeekdayWeights(weights)) {
    warnings.review("invalid_profile", "Daily-sales model needs exactly seven weekday weights, each a number >= 0 and at least one > 0; no sales forecast.", [DAILY_SALES_ID]);
    return [];
  }
  const lag = Math.max(0, Math.round(profile.revenueModel.settleLagDays ?? 0));
  const meanW = weights.reduce((a, b) => a + b, 0) / weights.length;
  const { salesHistoryDays: historyDays, dailySalesConfidence } = tun;
  const from = addDays(asOf, -historyDays);
  const history = records.events.filter((e) => e.direction === "in" && e.category === "sales" && e.date >= from && e.date < asOf);
  if (history.length === 0) {
    warnings.review("no_sales_history", `No sales receipts in the ${historyDays} days before ${asOf}; daily sales are not forecast.`);
    return [];
  }
  // Average over the days the bank data actually covers (first receipt to asOf, capped), weighting each covered day
  // by its weekday so a short history of busy days is not scaled up again. Full coverage: weight sum = salesHistoryDays.
  const first = records.events.filter((e) => e.direction === "in" && e.category === "sales" && e.date < asOf).reduce((m, e) => (e.date < m ? e.date : m), asOf);
  const days = Math.max(1, Math.min(historyDays, diffDays(asOf, first)));
  if (days < historyDays) warnings.review("short_sales_history", `Sales history covers only ${days} days before ${asOf} (want ${historyDays}); the daily-sales average is less reliable (needs review).`, history.map((e) => e.id));
  // Receipts are bank deposits, so a deposit on day d carries the sales of day d - lag: weight it by that weekday.
  // Receipts in another currency convert at the run's FX rate; one with no rate is left out of the average, warned.
  // A deposit day whose only receipts have no rate is dropped from the divisor too, so it does not drag the average down.
  let total = 0;
  const counted = new Set<string>();
  const skipped = new Set<string>();
  for (const e of history) {
    const b = toBase(e.amount, e.currency, profile, fx);
    if (b === undefined) {
      warnings.review("missing_fx", `Sales receipt ${e.id} is in ${e.currency} with no FX rate; left out of the daily-sales average (needs review).`, [e.id]);
      skipped.add(e.date);
    } else {
      total += b;
      counted.add(e.date);
    }
  }
  const weightDays = dateRange(addDays(asOf, -days), asOf)
    .filter((d) => !(skipped.has(d) && !counted.has(d)))
    .reduce((a, d) => a + weights[dowOf(addDays(d, -lag))]! / meanW, 0);
  const avg = weightDays > 0 ? total / weightDays : 0;
  const booked = new Set(records.events.filter((e) => e.direction === "in" && e.category === "sales" && e.date >= asOf).map((e) => e.date));
  const out: CashEvent[] = [];
  // Sale dates from asOf - lag, so every settlement in [asOf, horizonEnd) is covered; a settlement date that already
  // has an actual sales receipt is not forecast again.
  // legIndex is the sale date's day number (days since 1970-01-01 UTC), so an owner override on
  // { commitmentId: "daily-sales", legIndex } keeps targeting the same sale day when asOf moves (one event per sale day,
  // so it is unique within the run).
  for (const sale of dateRange(addDays(asOf, -lag), addDays(horizonEnd, -lag))) {
    const date = addDays(sale, lag);
    if (booked.has(date)) continue;
    const w = weights[dowOf(sale)]!;
    const amount = Math.round((avg * w) / meanW);
    if (amount <= 0) continue; // closed day (weight 0) or nothing to forecast: no $0 events
    const settles = lag ? `; sales of ${sale} settle ${lag} days later` : "";
    out.push({
      id: `evt-daily-sales-${date}`,
      commitmentId: DAILY_SALES_ID,
      legIndex: dailySalesLegIndex(sale),
      date,
      amount,
      currency: profile.baseCurrency,
      amountBase: amount,
      direction: "in",
      status: "likely",
      confidence: dailySalesConfidence,
      basis: `daily sales: ${money(Math.round(avg), profile.baseCurrency)} average over the last ${days} days x weekday weight ${w}/${Math.round(meanW * 100) / 100}${settles}`,
      category: "sales",
      sourceRef: { system: "profile", record: "revenueModel.dailySales" },
    });
  }
  return out;
}

// A sales deal's `linkedCosts` become virtual outflow commitments. A cost is suppressed only when a real linked
// outflow commitment already covers it: its pattern (explicit patternId, else the profile default for its type) is the
// cost's pattern. Matching on type alone is allowed only when the deal pattern has exactly one linked cost, since
// several costs (e.g. goods and freight) can share a type. Linked invoices never suppress a cost.
// Virtual costs scale by the deal's total (after an amount_change signal), not by what the customer still owes: a
// customer deposit does not pay the supplier.
function linkedCostCommitments(deal: Commitment, profile: Profile, byId: Map<string, Commitment>, amount: number): Commitment[] {
  if (deal.settlement === "paid" || deal.settlement === "cancelled" || deal.settlement === "credited") return [];
  const linked = (deal.linkedCommitmentIds ?? []).map((id) => byId.get(id)).filter((l): l is Commitment => !!l && defaultDirection(l) === "out");
  const pattern = pickPattern(deal, profile);
  const costs = pattern?.linkedCosts ?? [];
  const out: Commitment[] = [];
  for (const lc of costs) {
    const costPattern = profile.paymentPatterns.find((p) => p.id === lc.patternId);
    if (!costPattern) continue;
    const covered = linked.some((l) => pickPattern(l, profile)?.id === lc.patternId || (costs.length === 1 && l.type === costPattern.appliesTo));
    if (covered) continue;
    out.push({
      id: `${deal.id}~${lc.patternId}`,
      type: costPattern.appliesTo,
      direction: "out",
      amount: Math.round(amount * lc.share),
      currency: deal.currency,
      anchors: deal.anchors,
      patternId: lc.patternId,
      status: deal.status,
      probability: deal.probability,
      reference: `${deal.reference ?? deal.id} cost`,
      sourceRef: deal.sourceRef,
    });
  }
  return out;
}

// A cancelled or credited sales deal drops its receipt and virtual costs, but a real linked outflow (a supplier PO or
// bill) that is still open stays in the forecast: it is owed to the supplier regardless. The owner should know, since
// it may be cancellable too, so each such link raises a needs-review reason naming the deal and the PO.
function flagLinkedCostsAfterCancel(deal: Commitment, byId: Map<string, Commitment>, warnings: Notes): void {
  if (deal.type !== "sales_deal" || (deal.settlement !== "cancelled" && deal.settlement !== "credited")) return;
  const label = deal.reference ?? deal.id;
  for (const id of deal.linkedCommitmentIds ?? []) {
    const l = byId.get(id);
    if (!l || defaultDirection(l) !== "out") continue;
    if (l.settlement === "paid" || l.settlement === "cancelled" || l.settlement === "credited") continue;
    warnings.review(
      "linked_po_after_cancel",
      `${label}: deal is ${deal.settlement} but linked ${l.reference ?? l.id} (${money(l.outstanding ?? l.amount, l.currency)}) is still open and stays in the forecast as owed; cancel it with the supplier or confirm it (needs review)`,
      [deal.id, l.id],
    );
  }
}

// countedActuals: see PaymentContext; forecast() passes countedActualIds so uncounted bank lines never cancel a bill.
export function expand(records: Records, profile: Profile, asOf: string, horizonEnd: string, fx: Record<string, number>, countedActuals?: Set<string>): Expanded {
  const warnings = new Notes();
  const { commitments, amountSignals } = prepare(records);
  const byId = new Map(commitments.map((c) => [c.id, c]));
  const events: CashEvent[] = [];
  const all: Commitment[] = [];
  for (const c of commitments) {
    all.push(c);
    const sig = amountSignals.get(c.id)?.claim;
    const dealAmount = sig?.kind === "amount_change" ? sig.newAmount : c.amount;
    for (const virt of linkedCostCommitments(c, profile, byId, dealAmount)) all.push(virt);
    flagLinkedCostsAfterCancel(c, byId, warnings);
  }
  // Settlements dated before the latest start-of-day snapshot are already inside opening cash (same boundary as
  // forecast.ts openingBalance); without a snapshot, as-of is the boundary.
  let snapDate = "";
  for (const b of records.balances) if (b.asOf <= asOf && b.asOf > snapDate) snapDate = b.asOf;
  if (!snapDate) snapDate = asOf;
  const settings = engineSettings(profile);
  const ctx: PaymentContext = { snapDate, horizonEnd, countedActuals, byId, lags: new Map(), settings, payments: indexPayments(records) };
  const recurringIds = new Set(profile.recurring.map((r) => r.id));
  for (const c of all) {
    if (recurringIds.has(c.id)) continue; // overrides the profile recurring item of the same id (expandRecurring)
    const open = c.settlement !== "paid" && c.settlement !== "cancelled" && c.settlement !== "credited";
    if (open && unknownPattern(c, profile)) {
      const fallback = pickPattern(c, profile);
      warnings.review("unknown_pattern", `${c.reference ?? c.id}: unknown payment pattern ${c.patternId}; used ${fallback ? `the ${c.type} default ${fallback.id}` : "a single due-date leg"} (needs review)`, [c.id]);
    }
    if (open && c.type === "recurring" && !c.anchors.due)
      warnings.review("missing_anchor", `${c.reference ?? c.id}: recurring commitment has no due date and matches no profile recurring item; not scheduled (needs review)`, [c.id]);
    events.push(...expandCommitment(c, records, profile, fx, byId, amountSignals.get(c.id), ctx, warnings));
  }
  events.push(...expandRecurring(commitments, amountSignals, profile, fx, asOf, horizonEnd, warnings, settings));
  events.push(...expandDailySales(records, profile, asOf, horizonEnd, fx, warnings, settings));
  return { events, commitments: all, warnings: warnings.list, reasons: warnings.reviewReasons };
}
