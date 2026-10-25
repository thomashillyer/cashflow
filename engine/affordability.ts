// Search helper for deal_affordability: the smallest upfront share of a deal that keeps the low point at or above
// the safety line. Docs: docs/design/05-forecast-engine.md ("Search helper: smallest upfront share").
// Pure: no I/O, no clock (asOf is an input), no randomness. Integer cents with exact remainder allocation.
//
// One definition of "share" throughout: for a share X, the deal's upfront legs (inflow legs anchored to `order`
// with offsetDays <= 0 that do not wait on the customer's lag, i.e. the deposit) total X of the deal's open inflow amount, and the remainder is spread over
// the other inflow legs in proportion to their current amounts. Leg dates never change. X = current share is
// exactly the base run.

import type { CashEvent, Commitment, Override, Records, Scenario } from "../schema/records";
import type { Profile } from "../schema/profile";
import type { ForecastRun } from "../schema/forecast";
import { forecast } from "./forecast";
import { ENGINE_DEFAULTS, engineSettings } from "./settings";
import { legGetsLag } from "./expand";

// Default of profile engine.affordabilityStep; opts.step wins over the profile.
export const DEFAULT_SHARE_STEP = ENGINE_DEFAULTS.affordabilityStep;

type Terms = {
  currentShare: number;   // the deal's upfront share today
  upfrontLegs: number[];  // legIndex values treated as upfront
  note?: string;          // set when no leg is upfront by pattern and the earliest inflow leg stands in
};

export type AffordabilityResult =
  // Taking the deal on its current terms already keeps cash at or above the safety line.
  | ({ kind: "already_ok"; share: number; run: ForecastRun; lowPoint: number } & Terms)
  // Without the deal cash is already below the safety line: the deal is not the cause, so no terms are suggested.
  | ({ kind: "not_deal_driven"; lowPointWithoutDeal: number; run: ForecastRun } & Terms)
  // Asking for `share` of the deal upfront is the smallest grid share that keeps cash at or above the line.
  | ({ kind: "ok"; share: number; run: ForecastRun; lowPoint: number } & Terms)
  // Even 100% upfront leaves the low point below the safety line: not achievable with terms alone.
  | ({ kind: "not_achievable"; bestShare: 1; run: ForecastRun; lowPoint: number } & Terms);

export type AffordabilityOptions = {
  step?: number; // grid step for the share search; default profile engine.affordabilityStep (0.05)
};

// Basis points keep the share grid exact (no 0.1 + 0.2 drift).
const BP = 10000;
const toBp = (share: number) => Math.round(share * BP);

function pattern(c: Commitment, profile: Profile) {
  if (c.patternId) return profile.paymentPatterns.find((p) => p.id === c.patternId);
  return profile.paymentPatterns.find((p) => p.appliesTo === c.type && p.isDefault);
}

// Pattern leg indexes that count as upfront: inflow legs due on or before the order date. A leg that gets the
// customer's lag (its own `lagged: true`, or order in engine.lag.laggedAnchors) lands after the order date, so it is
// not money in hand at signing and is not upfront; with the default lists no order-day leg is lagged.
function patternUpfrontLegs(deal: Commitment, profile: Profile): number[] {
  const tun = engineSettings(profile);
  return (pattern(deal, profile)?.legs ?? []).flatMap((l, i) => (l.direction === "in" && l.anchor === "order" && l.offsetDays <= 0 && !legGetsLag(l, deal, tun) ? [i] : []));
}

// Split `total` over `weights` in proportion, floor each part and put the exact remainder on the last.
function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, w) => a + w, 0);
  let left = total;
  return weights.map((w, i) => {
    const a = i === weights.length - 1 ? left : sum > 0 ? Math.floor((total * w) / sum) : 0;
    left -= a;
    return a;
  });
}

const byDate = (a: CashEvent, b: CashEvent) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.legIndex - b.legIndex);

type Setup = {
  base: ForecastRun;
  terms: Terms;
  currentBp: number;
  monotone: boolean;
  run: (overrides: Override[], id: string) => ForecastRun;
  atShare: (bp: number) => ForecastRun;
};

function setup(records: Records, profile: Profile, baseOverrides: Override[], dealId: string, asOf: string, fxRates: Record<string, number>): Setup {
  const deal = records.commitments.find((c) => c.id === dealId);
  if (!deal) throw new Error(`smallestUpfrontShare: no commitment ${dealId}`);

  // "Can I afford to take this order?": a possible deal (and its linked costs) is evaluated as if it were likely,
  // so it lands on the main line. The caller's records are not mutated.
  const asTaken: Records =
    deal.status === "possible"
      ? { ...records, commitments: records.commitments.map((c) => (c.id === dealId ? { ...c, status: "likely" as const } : c)) }
      : records;
  const run = (overrides: Override[], id: string): ForecastRun => {
    const scenario: Scenario = { id, kind: id === "base" ? "base" : "what_if", overrides };
    return forecast(asTaken, profile, scenario, asOf, fxRates);
  };

  const base = run(baseOverrides, "base");

  // The deal's open inflow legs as the base run sees them (after settlements, signals, and base overrides).
  const legs = base.events.filter((e) => e.commitmentId === dealId && e.direction === "in" && e.status !== "actual").sort(byDate);
  const total = legs.reduce((a, e) => a + e.amount, 0);
  const byPattern = new Set(patternUpfrontLegs(deal, profile));
  let upfront = legs.filter((e) => byPattern.has(e.legIndex));
  let note: string | undefined;
  if (upfront.length === 0 && legs.length > 0) {
    upfront = [legs[0]!];
    note = `no deposit leg in the deal's payment pattern; the earliest receipt (leg ${legs[0]!.legIndex}, ${legs[0]!.date}) is treated as the upfront leg`;
  }
  const rest = legs.filter((e) => !upfront.includes(e));
  const currentU = upfront.reduce((a, e) => a + e.amount, 0);
  const currentBp = total > 0 ? Math.round((currentU * BP) / total) : 0;
  const terms: Terms = { currentShare: currentBp / BP, upfrontLegs: upfront.map((e) => e.legIndex), ...(note ? { note } : {}) };

  // Grid share X: upfront legs total X of the deal, the rest spread over the other legs by their current amounts.
  // X = current share keeps the current upfront amount exactly, so that grid point is the base run.
  const atShare = (bp: number): ForecastRun => {
    if (bp === currentBp) return base;
    const u = rest.length === 0 ? total : Math.round((total * bp) / BP);
    const amounts = [...allocate(u, upfront.map((e) => e.amount)), ...allocate(total - u, rest.map((e) => e.amount))];
    const overrides: Override[] = [...upfront, ...rest].map((e, i) => ({
      id: `afford-${dealId}-${bp}-${e.legIndex}`,
      target: { commitmentId: dealId, legIndex: e.legIndex },
      change: { amount: amounts[i]! },
      origin: "lever",
    }));
    return run([...baseOverrides, ...overrides], `afford-${dealId}-${bp}`);
  };
  // Moving money from later legs onto earlier ones never lowers any closing balance, so when every upfront leg is
  // dated on or before every other leg the low point is non-decreasing in share.
  const monotone = upfront.every((u) => rest.every((r) => u.date <= r.date));
  return { base, terms, currentBp, monotone, run, atShare };
}

// The forecast with the deal taken at upfront share X (on the same definition the search uses).
export function runAtUpfrontShare(
  records: Records,
  profile: Profile,
  baseOverrides: Override[],
  dealId: string,
  asOf: string,
  fxRates: Record<string, number>,
  share: number,
): ForecastRun {
  return setup(records, profile, baseOverrides, dealId, asOf, fxRates).atShare(toBp(share));
}

export function smallestUpfrontShare(
  records: Records,
  profile: Profile,
  baseOverrides: Override[],
  dealId: string,
  asOf: string,
  fxRates: Record<string, number>,
  opts: AffordabilityOptions = {},
): AffordabilityResult {
  const step = opts.step ?? engineSettings(profile).affordabilityStep;
  const stepBp = toBp(step);
  if (!(stepBp > 0 && stepBp <= BP)) throw new Error(`smallestUpfrontShare: step must be in (0, 1], got ${step}`);
  const { base, terms, currentBp, monotone, run, atShare } = setup(records, profile, baseOverrides, dealId, asOf, fxRates);

  if (base.lowPoint.amount >= base.safetyLine) {
    return { kind: "already_ok", share: terms.currentShare, run: base, lowPoint: base.lowPoint.amount, ...terms };
  }

  // Is the deal the cause? Excluding it also drops its virtual linked costs (`${dealId}~pattern`).
  const withoutId = `afford-${dealId}-without`;
  const without = run([...baseOverrides, { id: withoutId, target: { commitmentId: dealId }, change: { exclude: true }, origin: "lever" }], withoutId);
  if (without.lowPoint.amount < without.safetyLine) {
    return { kind: "not_deal_driven", lowPointWithoutDeal: without.lowPoint.amount, run: without, ...terms };
  }

  // Grid: current, current + step, ..., capped at 1.0 (always included).
  const grid: number[] = [];
  for (let s = currentBp; s < BP; s += stepBp) grid.push(s);
  grid.push(BP);
  const memo = new Map<number, ForecastRun>();
  const at = (i: number): ForecastRun => {
    const s = grid[i]!;
    if (!memo.has(s)) memo.set(s, atShare(s));
    return memo.get(s)!;
  };
  const passes = (r: ForecastRun) => r.lowPoint.amount >= r.safetyLine;

  const last = grid.length - 1;
  if (!passes(at(last))) {
    const r = at(last);
    return { kind: "not_achievable", bestShare: 1, run: r, lowPoint: r.lowPoint.amount, ...terms };
  }

  // Binary search is exact when the low point is monotone in share; otherwise fall back to a linear scan.
  let found: number;
  if (monotone) {
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (passes(at(mid))) hi = mid;
      else lo = mid + 1;
    }
    found = lo;
  } else {
    found = grid.findIndex((_, i) => passes(at(i)));
  }
  const r = at(found);
  return { kind: "ok", share: grid[found]! / BP, run: r, lowPoint: r.lowPoint.amount, ...terms };
}
