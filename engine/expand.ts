// Step 1-3 of a run: commitments -> dated CashEvents (pattern legs, anchors, lag, recurring, linked costs).
// Pure: no I/O, no clock. Docs: docs/design/05-forecast-engine.md, docs/TECHNICAL_PLAN.md section 6.

import type { CashEvent, Commitment, Direction, Records, Signal } from "../schema/records";
import type { Anchor, PaymentPattern, Profile } from "../schema/profile";
import { addDays, addMonthsClamped, endOfMonth } from "./dates";
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

function pickPattern(c: Commitment, profile: Profile): PaymentPattern | undefined {
  if (c.patternId) return profile.paymentPatterns.find((p) => p.id === c.patternId);
  return profile.paymentPatterns.find((p) => p.appliesTo === c.type && p.isDefault);
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

// Occurrence dates of a profile recurring item, indexed from its anchor so overrides keep a stable legIndex.
function occurrences(r: Profile["recurring"][number], until: string, warnings: string[]): string[] {
  const out: string[] = [];
  const stop = r.endDate && r.endDate < until ? addDays(r.endDate, 1) : until; // exclusive
  const push = (d: string) => {
    if (d < stop) out.push(d);
  };
  const day = Number(r.anchor.slice(8, 10));
  if (r.cadence === "weekly" || r.cadence === "biweekly") {
    const step = r.cadence === "weekly" ? 7 : 14;
    for (let d = r.anchor; d < stop; d = addDays(d, step)) push(d);
  } else if (r.cadence === "monthly" || r.cadence === "quarterly") {
    const step = r.cadence === "monthly" ? 1 : 3;
    for (let n = 0; ; n++) {
      const d = addMonthsClamped(r.anchor, n * step, day);
      if (d >= stop) break;
      push(d);
    }
  } else {
    if (r.secondDay === undefined) warnings.push(`recurring ${r.name}: semimonthly needs secondDay; treating as monthly`);
    for (let n = 0; ; n++) {
      const a = addMonthsClamped(r.anchor, n, day);
      const b = r.secondDay === undefined ? undefined : addMonthsClamped(r.anchor, n, r.secondDay);
      const pair = [a, ...(b ? [b] : [])].sort();
      if (pair[0]! >= stop) break;
      for (const d of pair) if (d >= r.anchor) push(d);
    }
  }
  return out;
}

function expandRecurring(records: Records, profile: Profile, asOf: string, horizonEnd: string, warnings: string[]): CashEvent[] {
  const events: CashEvent[] = [];
  const have = new Set(records.commitments.map((c) => c.id));
  for (const r of profile.recurring) {
    if (have.has(r.id)) continue; // a confirmed commitment with this id owns it; don't forecast twice
    const dir = r.direction ?? "out";
    occurrences(r, horizonEnd, warnings).forEach((date, i) => {
      if (date < asOf) return;
      events.push({
        id: `evt-${r.id}-${i}`,
        commitmentId: r.id,
        legIndex: i,
        date,
        amount: r.amount,
        currency: profile.baseCurrency,
        amountBase: r.amount,
        direction: dir,
        status: "committed",
        confidence: STATUS_CONFIDENCE.committed,
        basis: `recurring ${r.cadence}: ${r.name}, from ${r.anchor}${r.endDate ? ` to ${r.endDate}` : ""}`,
        category: r.category,
        sourceRef: { system: "profile", record: r.id },
      });
    });
  }
  return events;
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
  for (const c of all) events.push(...expandCommitment(c, records, profile, fx, byId, amountSignals.get(c.id), warnings));
  events.push(...expandRecurring(records, profile, asOf, horizonEnd, warnings));
  return { events, commitments: all, warnings };
}
