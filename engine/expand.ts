// Step 1-3 of a run: commitments -> dated CashEvents (pattern legs, anchors, lag, recurring, linked costs).
// Pure: no I/O, no clock. Docs: docs/design/05-forecast-engine.md, docs/TECHNICAL_PLAN.md section 6.

import type { CashEvent, Commitment, Direction, Records, Signal } from "../schema/records";
import type { Anchor, PaymentPattern, Profile } from "../schema/profile";
import { addDays, addMonthsClamped, dateRange, diffDays, dowOf, endOfMonth } from "./dates";
import { partyLag } from "./lag";

export type Expanded = { events: CashEvent[]; commitments: Commitment[]; warnings: string[] };

type Leg = PaymentPattern["legs"][number];

const STATUS_CONFIDENCE = { actual: 1, committed: 0.95, likely: 0.7, possible: 0.3 } as const;

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

function defaultDirection(c: Commitment): Direction {
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

function resolveAnchor(anchor: Anchor, c: Commitment, profile: Profile): { date?: string; note?: string } {
  const a = c.anchors;
  const lt = profile.leadTimes ?? {};
  if (anchor === "month_end") {
    const ref = a.invoice ?? a.due ?? a.order ?? a.delivery;
    return ref ? { date: endOfMonth(ref), note: `end of month of ${ref}` } : {};
  }
  if (anchor === "weekday") return {};
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

// How much of a commitment is already covered by linked, same-direction invoices/bills (PO <-> invoice overlap).
function coveredByLinked(c: Commitment, byId: Map<string, Commitment>, warnings: string[]): number {
  let covered = 0;
  for (const id of c.linkedCommitmentIds ?? []) {
    const l = byId.get(id);
    if (!l || (l.type !== "invoice" && l.type !== "bill")) continue;
    if (defaultDirection(l) !== defaultDirection(c)) continue;
    if (l.settlement === "cancelled" || l.settlement === "credited") continue;
    covered += l.amount;
  }
  if (covered > c.amount) warnings.push(`${c.reference ?? c.id}: linked invoices (${money(covered, c.currency)}) exceed the amount (${money(c.amount, c.currency)}); check the allocation`);
  return covered;
}

function expandCommitment(
  c: Commitment,
  records: Records,
  profile: Profile,
  fx: Record<string, number>,
  byId: Map<string, Commitment>,
  amountSignal: Signal | undefined,
  warnings: string[],
): CashEvent[] {
  if (c.settlement === "paid" || c.settlement === "cancelled" || c.settlement === "credited") return [];
  if (c.type === "recurring" && !c.anchors.due) return []; // profile.recurring owns aggregate recurrences
  const label = c.reference ?? c.id;
  const pattern = pickPattern(c, profile);
  const dir0 = defaultDirection(c);
  const legs: Leg[] = pattern?.legs ?? [{ share: 1, anchor: "due", offsetDays: 0, direction: dir0 }];

  let total = c.amount;
  let target = c.outstanding ?? c.amount;
  const touched: string[] = [];
  if (amountSignal?.claim.kind === "amount_change") {
    // The signal states the new total; keep what was already paid out of it.
    const paid = c.amount - (c.outstanding ?? c.amount);
    total = amountSignal.claim.newAmount;
    target = Math.max(0, total - paid);
    touched.push(amountSignal.id);
  }
  target = Math.max(0, target - coveredByLinked(c, byId, warnings));

  const legAmounts = allocate(total, legs.map((l) => l.share));
  // Settled money consumes pattern legs: explicit Settlement.legIndex first, then legs in order.
  let consume = total - target;
  for (const s of records.settlements) {
    if (s.commitmentId !== c.id || s.legIndex === undefined || legAmounts[s.legIndex] === undefined) continue;
    const take = Math.min(s.amount, consume, legAmounts[s.legIndex]!);
    legAmounts[s.legIndex]! -= take;
    consume -= take;
  }
  for (let i = 0; i < legAmounts.length && consume > 0; i++) {
    const take = Math.min(consume, legAmounts[i]!);
    legAmounts[i]! -= take;
    consume -= take;
  }

  const events: CashEvent[] = [];
  legs.forEach((leg, i) => {
    const amount = legAmounts[i]!;
    if (amount <= 0) return;
    const anchor = resolveAnchor(leg.anchor, c, profile);
    if (!anchor.date) {
      warnings.push(`${label}: no ${leg.anchor} date for leg ${i + 1}; not scheduled (needs review)`);
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

// Occurrences of a profile recurring item inside [from, until). The anchor is a phase, not a start: occurrences are
// projected backward and forward from it, so an anchor after asOf still yields the earlier ones. `index` counts from
// the anchor (0 = anchor, negative = before it; semimonthly uses 2n for the anchor's day and 2n+1 for secondDay in
// month n), so overrides keep a stable legIndex across runs. `startDate` and `endDate` (both inclusive) bound it.
function occurrences(r: Recurring, anchor: string, from: string, until: string, warnings: string[]): Occurrence[] {
  const out: Occurrence[] = [];
  const lo = r.startDate && r.startDate > from ? r.startDate : from;
  const stop = r.endDate && r.endDate < until ? addDays(r.endDate, 1) : until; // exclusive
  if (lo >= stop) return out;
  const push = (date: string, index: number) => {
    if (date >= lo && date < stop) out.push({ date, index });
  };
  const day = Number(anchor.slice(8, 10));
  const monthsFrom = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - (Number(anchor.slice(0, 4)) * 12 + Number(anchor.slice(5, 7)));
  if (r.cadence === "weekly" || r.cadence === "biweekly") {
    const step = r.cadence === "weekly" ? 7 : 14;
    for (let n = Math.ceil(diffDays(lo, anchor) / step); ; n++) {
      const d = addDays(anchor, n * step);
      if (d >= stop) break;
      push(d, n);
    }
  } else if (r.cadence === "monthly" || r.cadence === "quarterly") {
    const step = r.cadence === "monthly" ? 1 : 3;
    for (let n = Math.floor(monthsFrom(lo) / step) - 1; ; n++) {
      const d = addMonthsClamped(anchor, n * step, day);
      if (d >= stop) break;
      push(d, n);
    }
  } else {
    if (r.secondDay === undefined) warnings.push(`recurring ${r.name}: semimonthly needs secondDay; treating as monthly`);
    for (let n = monthsFrom(lo) - 1; ; n++) {
      const a = addMonthsClamped(anchor, n, day);
      const b = r.secondDay === undefined ? undefined : addMonthsClamped(anchor, n, r.secondDay);
      if (a >= stop && (!b || b >= stop)) break;
      push(a, r.secondDay === undefined ? n : 2 * n);
      if (b) push(b, 2 * n + 1);
    }
    out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.index - y.index));
  }
  return out;
}

// A commitment whose id matches a profile recurring item overrides its amount (and its anchor, when the commitment has
// anchors.due) but keeps the profile cadence, so a confirmed rent or payroll is never forecast as a one-off.
function expandRecurring(
  records: Records,
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
    const sig = c ? amountSignals.get(c.id) : undefined;
    const amount = sig?.claim.kind === "amount_change" ? sig.claim.newAmount : (c?.amount ?? r.amount);
    const currency = c?.currency ?? profile.baseCurrency;
    const anchor = c?.anchors.due ?? r.anchor;
    const amountBase = toBase(amount, currency, profile, fx);
    if (amountBase === undefined) {
      warnings.push(`${c?.reference ?? r.id}: no FX rate for ${currency}; recurring ${r.name} excluded from the forecast`);
      continue;
    }
    const dir = c ? defaultDirection(c) : (r.direction ?? "out");
    const status = c?.status ?? "committed";
    const conf = status === "possible" ? (c?.probability ?? STATUS_CONFIDENCE.possible) : STATUS_CONFIDENCE[status];
    const via = c ? `; amount${c.anchors.due ? " and anchor" : ""} from commitment ${c.reference ?? c.id}` : "";
    const span = `${r.startDate ? `, starts ${r.startDate}` : ""}${r.endDate ? `, ends ${r.endDate}` : ""}`;
    const found = occurrences(r, anchor, asOf, horizonEnd, warnings);
    if (c && found.length === 0) warnings.push(`${c.reference ?? c.id}: recurring commitment yields no payments in the horizon (needs review)`);
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
        basis: `recurring ${r.cadence}: ${r.name}, anchored on ${anchor}${span}${via}`,
        category: c?.category ?? r.category,
        sourceRef: c?.sourceRef ?? { system: "profile", record: r.id },
        ...(sig ? { overriddenBy: [sig.id] } : {}),
      });
    }
  }
  return events;
}

export const SALES_HISTORY_DAYS = 28;

// Daily-sales revenue model: average daily sales from the last 28 days of actual "sales" receipts, shaped by the
// profile's weekday weights (index 0 = Monday). Dates that already have actual sales are not forecast again.
function expandDailySales(records: Records, profile: Profile, asOf: string, horizonEnd: string, warnings: string[]): CashEvent[] {
  if (profile.revenueModel.kind !== "dailySales") return [];
  const weights = profile.revenueModel.weekdayWeights;
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
  // Divide by the days of history the bank data actually covers, so a new business is not averaged over empty days.
  const first = records.events.filter((e) => e.direction === "in" && e.category === "sales" && e.date < asOf).reduce((m, e) => (e.date < m ? e.date : m), asOf);
  const days = Math.max(1, Math.min(SALES_HISTORY_DAYS, diffDays(asOf, first)));
  if (days < SALES_HISTORY_DAYS) warnings.push(`Sales history covers only ${days} days before ${asOf} (want ${SALES_HISTORY_DAYS}); the daily-sales average is less reliable (needs review).`);
  const avg = history.reduce((a, e) => a + (toBase(e.amount, e.currency, profile, { [profile.baseCurrency]: 1 }) ?? 0), 0) / days;
  const booked = new Set(records.events.filter((e) => e.direction === "in" && e.category === "sales" && e.date >= asOf).map((e) => e.date));
  const out: CashEvent[] = [];
  dateRange(asOf, horizonEnd).forEach((date, i) => {
    if (booked.has(date)) return;
    const w = weights[dowOf(date)]!;
    const amount = Math.round((avg * w) / meanW);
    out.push({
      id: `evt-daily-sales-${date}`,
      commitmentId: "daily-sales",
      legIndex: i,
      date,
      amount,
      currency: profile.baseCurrency,
      amountBase: amount,
      direction: "in",
      status: "likely",
      confidence: 0.6,
      basis: `daily sales: ${money(Math.round(avg), profile.baseCurrency)} average over the last ${days} days x weekday weight ${w}/${Math.round(meanW * 100) / 100}`,
      category: "sales",
      sourceRef: { system: "profile", record: "revenueModel.dailySales" },
    });
  });
  return out;
}

// A sales deal's `linkedCosts` become virtual outflow commitments. A cost is suppressed only when a real linked
// outflow commitment already covers it (same patternId, or same type as the cost pattern); linked invoices never suppress it.
function linkedCostCommitments(deal: Commitment, profile: Profile, byId: Map<string, Commitment>, amount: number): Commitment[] {
  if (deal.settlement === "paid" || deal.settlement === "cancelled" || deal.settlement === "credited") return [];
  const linked = (deal.linkedCommitmentIds ?? []).map((id) => byId.get(id)).filter((l): l is Commitment => !!l);
  const pattern = pickPattern(deal, profile);
  const out: Commitment[] = [];
  for (const lc of pattern?.linkedCosts ?? []) {
    const costPattern = profile.paymentPatterns.find((p) => p.id === lc.patternId);
    if (!costPattern) continue;
    const covered = linked.some((l) => l.patternId === lc.patternId || (l.type === costPattern.appliesTo && defaultDirection(l) === "out"));
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
  const recurringIds = new Set(profile.recurring.map((r) => r.id));
  for (const c of all) {
    if (unknownPattern(c, profile)) {
      const fallback = pickPattern(c, profile);
      warnings.push(`${c.reference ?? c.id}: unknown payment pattern ${c.patternId}; used ${fallback ? `the ${c.type} default ${fallback.id}` : "a single due-date leg"} (needs review)`);
    }
    if (recurringIds.has(c.id)) continue; // overrides the profile recurring item of the same id (expandRecurring)
    const out = expandCommitment(c, records, profile, fx, byId, amountSignals.get(c.id), warnings);
    const settled = c.settlement === "paid" || c.settlement === "cancelled" || c.settlement === "credited";
    if (c.type === "recurring" && out.length === 0 && !settled)
      warnings.push(`${c.reference ?? c.id}: recurring commitment has no due date and matches no profile recurring item; not scheduled (needs review)`);
    events.push(...out);
  }
  events.push(...expandRecurring(records, commitments, amountSignals, profile, fx, asOf, horizonEnd, warnings));
  events.push(...expandDailySales(records, profile, asOf, horizonEnd, warnings));
  return { events, commitments: all, warnings };
}
