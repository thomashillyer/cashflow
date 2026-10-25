// Step 1-3 of a run: commitments -> dated CashEvents (pattern legs, anchors, lag, recurring, linked costs).
// Pure: no I/O, no clock. Docs: docs/design/05-forecast-engine.md, docs/TECHNICAL_PLAN.md section 6.

import type { CashEvent, Commitment, Direction, Records, Signal } from "../schema/records";
import type { Anchor, PaymentPattern, Profile } from "../schema/profile";
import { addDays, addMonthsClamped, dateRange, diffDays, dowOf, endOfMonth } from "./dates";
import { partyLag } from "./lag";

export type Expanded = { events: CashEvent[]; commitments: Commitment[]; warnings: string[] };

type Leg = PaymentPattern["legs"][number];

export const STATUS_CONFIDENCE = { actual: 1, committed: 0.95, likely: 0.7, possible: 0.3 } as const;

// Anchors that mean "wait for the customer to pay", so the party's lag applies. `order` and `ship` are our own dates.
const LAGGED_ANCHORS: Anchor[] = ["due", "invoice", "delivery", "month_end"];

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
function coveredByLinked(c: Commitment, byId: Map<string, Commitment>, warnings: string[]): Cover[] {
  const out: Cover[] = [];
  const label = c.reference ?? c.id;
  for (const id of c.linkedCommitmentIds ?? []) {
    const l = byId.get(id);
    if (!l || (l.type !== "invoice" && l.type !== "bill")) continue;
    if (defaultDirection(l) !== defaultDirection(c)) continue;
    if (l.settlement === "cancelled" || l.settlement === "credited") continue;
    if (l.currency !== c.currency) {
      warnings.push(`${label}: linked ${l.reference ?? l.id} is in ${l.currency}, not ${c.currency}; not offset against it (check for double counting)`);
      continue;
    }
    out.push({ amount: l.amount, cutoff: l.anchors.due ?? l.anchors.invoice, id: l.id });
  }
  const covered = out.reduce((a, x) => a + x.amount, 0);
  if (covered > c.amount) warnings.push(`${label}: linked invoices (${money(covered, c.currency)}) exceed the amount (${money(c.amount, c.currency)}); check the allocation`);
  // Earliest-dated invoice first; undated last. Ties by id so the run is deterministic.
  const key = (x: Cover) => `${x.cutoff ?? "9999-99-99"}|${x.id}`;
  return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

// What of a commitment is already paid, and the total it is paid out of.
// - `outstanding` unset: paid = the commitment's Settlements in its own currency. Settlements dated before the latest
//   balance snapshot are inside opening cash; ones on/after it count only when a bank actual for the commitment is in
//   records.events, otherwise the money stays expected and we warn (a Settlement and its bank line are one payment,
//   TECHNICAL_PLAN 6 opening-cash boundary).
// - `outstanding` set: amount - outstanding may already include linked invoices (an importer or older reconcile run
//   lowered it), so the part not explained by settlements is treated as linked coverage already applied, and only the
//   rest of the linked coverage is subtracted again later. paid = amount - outstanding - that pre-applied coverage.
// An applied amount_change signal states the new total; what was already paid stays paid.
function paidSoFar(
  c: Commitment,
  records: Records,
  amountSignal: Signal | undefined,
  covered: number,
  snapDate: string,
  warnings: string[],
): { total: number; paid: number; counted: Set<string> } {
  const label = c.reference ?? c.id;
  const counted = new Set<string>();
  const mine = records.settlements.filter((s) => s.commitmentId === c.id);
  let paid: number;
  let outstanding: number;
  if (c.outstanding === undefined) {
    const banked = records.events.some((e) => e.commitmentId === c.id);
    let settled = 0;
    for (const s of mine) {
      if (s.currency !== c.currency) {
        warnings.push(`${label}: settlement ${s.id} is in ${s.currency}, not ${c.currency}; not deducted from what is outstanding (needs review)`);
        continue;
      }
      if (s.date >= snapDate && !banked) {
        warnings.push(`${label}: payment of ${money(s.amount, s.currency)} recorded on ${s.date} but not seen in the bank; still forecast as expected (needs reconciliation)`);
        continue;
      }
      settled += s.amount;
      counted.add(s.id);
    }
    paid = Math.min(c.amount, settled);
    outstanding = c.amount - paid;
  } else {
    outstanding = c.outstanding;
    const settled = mine.filter((s) => s.currency === c.currency).reduce((a, s) => a + s.amount, 0);
    for (const s of mine) if (s.currency === c.currency) counted.add(s.id);
    const reduced = Math.max(0, c.amount - outstanding);
    if (settled > reduced) warnings.push(`${label}: settlements (${money(settled, c.currency)}) exceed what outstanding reflects (${money(reduced, c.currency)}); possible double count (needs reconciliation)`);
    const preCovered = Math.min(covered, Math.max(0, reduced - settled));
    paid = reduced - preCovered;
  }
  if (c.settlement === "partial" && outstanding >= c.amount)
    warnings.push(`${label}: marked partially paid but nothing is recorded as paid; forecasting the full ${money(c.amount, c.currency)} (needs review)`);
  if (c.settlement === "open" && paid > 0)
    warnings.push(`${label}: marked open but ${money(paid, c.currency)} is already paid; forecasting only what remains (needs review)`);
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
  snapDate: string,
  warnings: string[],
): CashEvent[] {
  const label = c.reference ?? c.id;
  if (c.settlement === "paid" && c.outstanding !== undefined && c.outstanding > 0)
    warnings.push(`${label}: marked paid but ${money(c.outstanding, c.currency)} is still outstanding; nothing forecast (needs review)`);
  if (c.settlement === "paid" || c.settlement === "cancelled" || c.settlement === "credited") return [];
  if (c.type === "recurring" && !c.anchors.due) return []; // profile.recurring owns aggregate recurrences
  const covers = coveredByLinked(c, byId, warnings);
  const { total, paid, counted } = paidSoFar(c, records, amountSignal, covers.reduce((a, x) => a + x.amount, 0), snapDate, warnings);
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
  for (const s of records.settlements) {
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
      warnings.push(`${label}: no ${leg.anchor} date for leg ${i + 1}${anchor.why ? ` (${anchor.why})` : ""}; not scheduled (needs review)`);
      return;
    }
    let date = addDays(anchor.date, leg.offsetDays);
    let basis = `${leg.anchor} ${anchor.date}${anchor.note ? ` [${anchor.note}]` : ""}${leg.offsetDays ? ` + ${leg.offsetDays} days` : ""}`;
    if (unknownPattern(c, profile)) basis += ` [unknown pattern ${c.patternId}; used ${pattern ? `default ${pattern.id}` : "a single due-date leg"}]`;
    let conf = c.status === "possible" ? (c.probability ?? STATUS_CONFIDENCE.possible) : STATUS_CONFIDENCE[c.status];
    const overriddenBy = [...touched];
    const lagged = leg.direction === "in" && !c.funding && c.status !== "actual" && (c.type === "invoice" || c.type === "sales_deal") && LAGGED_ANCHORS.includes(leg.anchor);
    if (lagged) {
      const lag = partyLag(records, profile, c.partyId);
      date = addDays(date, lag.days);
      basis += ` ${lag.basis}`;
      conf *= lag.confidence;
      if (lag.ruleId) overriddenBy.push(lag.ruleId);
    }
    const base = toBase(amount, c.currency, profile, fx);
    if (base === undefined) {
      warnings.push(`${label}: no FX rate for ${c.currency}; excluded from the forecast`);
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
function occurrences(r: Recurring, phase: string, from: string, until: string, warnings: string[]): Occurrence[] {
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
    if (r.secondDay === undefined) warnings.push(`recurring ${r.name}: semimonthly needs secondDay; treating as monthly`);
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
  warnings: string[],
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
      warnings.push(`${label}: no FX rate for ${currency}; recurring ${r.name} excluded from the forecast`);
      continue;
    }
    let until = horizonEnd;
    let skip: string | undefined;
    let note = "";
    if (c?.settlement === "cancelled") {
      const end = due ?? asOf;
      if (end < until) until = end;
      note = `; cancelled from ${end}`;
      warnings.push(`${label}: recurring ${r.name} is cancelled from ${end}; later occurrences dropped (needs review)`);
    } else if (c && (c.settlement === "paid" || c.settlement === "credited") && due) {
      skip = due;
      note = `; ${due} ${c.settlement}`;
    }
    const dir = c ? defaultDirection(c) : (r.direction ?? "out");
    const status = !c || c.status === "actual" ? "committed" : c.status;
    const conf = status === "possible" ? (c?.probability ?? STATUS_CONFIDENCE.possible) : STATUS_CONFIDENCE[status];
    const via = c ? `; amount${due ? " and phase" : ""} from commitment ${label}` : "";
    const span = `${r.startDate ? `, starts ${r.startDate}` : ""}${r.endDate ? `, ends ${r.endDate}` : ""}`;
    const found = occurrences(r, phase, asOf, until, warnings).filter((o) => o.date !== skip);
    if (c && found.length === 0 && c.settlement !== "cancelled")
      warnings.push(`${label}: recurring commitment yields no payments in the horizon (needs review)`);
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

export const SALES_HISTORY_DAYS = 28;
// commitmentId of the events emitted by the daily-sales revenue model.
export const DAILY_SALES_ID = "daily-sales";

// Daily-sales revenue model: average daily sales from the last 28 days of actual "sales" receipts, shaped by the
// profile's weekday weights (index 0 = Monday). With `settleLagDays` (card settlement), each sale day's money lands
// that many days later. Settlement dates that already have actual sales receipts are not forecast again.
function expandDailySales(records: Records, profile: Profile, asOf: string, horizonEnd: string, warnings: string[]): CashEvent[] {
  if (profile.revenueModel.kind !== "dailySales") return [];
  const weights = profile.revenueModel.weekdayWeights;
  const lag = Math.max(0, Math.round(profile.revenueModel.settleLagDays ?? 0));
  const meanW = weights.reduce((a, b) => a + b, 0) / (weights.length || 1);
  const from = addDays(asOf, -SALES_HISTORY_DAYS);
  const history = records.events.filter((e) => e.direction === "in" && e.category === "sales" && e.date >= from && e.date < asOf);
  if (weights.length !== 7 || meanW <= 0) {
    warnings.push("Daily-sales model needs seven positive weekday weights; no sales forecast.");
    return [];
  }
  if (history.length === 0) {
    warnings.push(`No sales receipts in the ${SALES_HISTORY_DAYS} days before ${asOf}; daily sales are not forecast.`);
    return [];
  }
  // Average over the days the bank data actually covers (first receipt to asOf, capped), weighting each covered day
  // by its weekday so a short history of busy days is not scaled up again. Full 4-week coverage: weight sum = 28.
  const first = records.events.filter((e) => e.direction === "in" && e.category === "sales" && e.date < asOf).reduce((m, e) => (e.date < m ? e.date : m), asOf);
  const days = Math.max(1, Math.min(SALES_HISTORY_DAYS, diffDays(asOf, first)));
  if (days < SALES_HISTORY_DAYS) warnings.push(`Sales history covers only ${days} days before ${asOf} (want ${SALES_HISTORY_DAYS}); the daily-sales average is less reliable (needs review).`);
  // Receipts are bank deposits, so a deposit on day d carries the sales of day d - lag: weight it by that weekday.
  const weightDays = dateRange(addDays(asOf, -days), asOf).reduce((a, d) => a + weights[dowOf(addDays(d, -lag))]! / meanW, 0);
  const total = history.reduce((a, e) => a + (toBase(e.amount, e.currency, profile, { [profile.baseCurrency]: 1 }) ?? 0), 0);
  const avg = weightDays > 0 ? total / weightDays : 0;
  const booked = new Set(records.events.filter((e) => e.direction === "in" && e.category === "sales" && e.date >= asOf).map((e) => e.date));
  const out: CashEvent[] = [];
  // Sale dates from asOf - lag, so every settlement in [asOf, horizonEnd) is covered; a settlement date that already
  // has an actual sales receipt is not forecast again.
  dateRange(addDays(asOf, -lag), addDays(horizonEnd, -lag)).forEach((sale, i) => {
    const date = addDays(sale, lag);
    if (booked.has(date)) return;
    const w = weights[dowOf(sale)]!;
    const amount = Math.round((avg * w) / meanW);
    const settles = lag ? `; sales of ${sale} settle ${lag} days later` : "";
    out.push({
      id: `evt-daily-sales-${date}`,
      commitmentId: DAILY_SALES_ID,
      legIndex: i,
      date,
      amount,
      currency: profile.baseCurrency,
      amountBase: amount,
      direction: "in",
      status: "likely",
      confidence: 0.6,
      basis: `daily sales: ${money(Math.round(avg), profile.baseCurrency)} average over the last ${days} days x weekday weight ${w}/${Math.round(meanW * 100) / 100}${settles}`,
      category: "sales",
      sourceRef: { system: "profile", record: "revenueModel.dailySales" },
    });
  });
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

export function expand(records: Records, profile: Profile, asOf: string, horizonEnd: string, fx: Record<string, number>): Expanded {
  const warnings: string[] = [];
  const { commitments, amountSignals } = prepare(records);
  const byId = new Map(commitments.map((c) => [c.id, c]));
  const events: CashEvent[] = [];
  const all: Commitment[] = [];
  for (const c of commitments) {
    all.push(c);
    const sig = amountSignals.get(c.id)?.claim;
    const dealAmount = sig?.kind === "amount_change" ? sig.newAmount : c.amount;
    for (const virt of linkedCostCommitments(c, profile, byId, dealAmount)) all.push(virt);
  }
  // Settlements dated before the latest start-of-day snapshot are already inside opening cash (same boundary as
  // forecast.ts openingBalance); without a snapshot, as-of is the boundary.
  let snapDate = "";
  for (const b of records.balances) if (b.asOf <= asOf && b.asOf > snapDate) snapDate = b.asOf;
  if (!snapDate) snapDate = asOf;
  const recurringIds = new Set(profile.recurring.map((r) => r.id));
  for (const c of all) {
    if (recurringIds.has(c.id)) continue; // overrides the profile recurring item of the same id (expandRecurring)
    const open = c.settlement !== "paid" && c.settlement !== "cancelled" && c.settlement !== "credited";
    if (open && unknownPattern(c, profile)) {
      const fallback = pickPattern(c, profile);
      warnings.push(`${c.reference ?? c.id}: unknown payment pattern ${c.patternId}; used ${fallback ? `the ${c.type} default ${fallback.id}` : "a single due-date leg"} (needs review)`);
    }
    if (open && c.type === "recurring" && !c.anchors.due)
      warnings.push(`${c.reference ?? c.id}: recurring commitment has no due date and matches no profile recurring item; not scheduled (needs review)`);
    events.push(...expandCommitment(c, records, profile, fx, byId, amountSignals.get(c.id), snapDate, warnings));
  }
  events.push(...expandRecurring(commitments, amountSignals, profile, fx, asOf, horizonEnd, warnings));
  events.push(...expandDailySales(records, profile, asOf, horizonEnd, warnings));
  return { events, commitments: all, warnings };
}
