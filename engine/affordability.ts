// Search helper for deal_affordability: the smallest upfront share of a deal that keeps the low point at or above
// the safety line. Docs: docs/design/05-forecast-engine.md ("Search helper: smallest upfront share").
// Pure: no I/O, no clock (asOf is an input), no randomness. All money math is integer cents inside forecast().

import type { Commitment, Override, Records } from "../schema/records";
import type { Profile } from "../schema/profile";
import type { ForecastRun } from "../schema/forecast";
import { forecast } from "./forecast";
import { simulate } from "./simulate";

export const DEFAULT_SHARE_STEP = 0.05;

export type AffordabilityResult =
  // Taking the deal on its current terms already keeps cash at or above the safety line.
  | { kind: "already_ok"; share: number; run: ForecastRun; lowPoint: number }
  // Asking for `share` of the deal upfront (cash arriving at asOf) is the smallest grid share that works.
  | { kind: "ok"; share: number; run: ForecastRun; lowPoint: number }
  // Even 100% upfront leaves the low point below the safety line: not achievable with terms alone.
  | { kind: "not_achievable"; bestShare: 1; run: ForecastRun; lowPoint: number };

export type AffordabilityOptions = {
  step?: number; // grid step for the share search, default 0.05
};

// Basis points keep the share grid exact (no 0.1 + 0.2 drift).
const BP = 10000;
const toBp = (share: number) => Math.round(share * BP);

function pattern(c: Commitment, profile: Profile) {
  if (c.patternId) return profile.paymentPatterns.find((p) => p.id === c.patternId);
  return profile.paymentPatterns.find((p) => p.appliesTo === c.type && p.isDefault);
}

// The deal's current upfront share: inflow legs due on or before the order date (its deposit), 0 if none.
export function currentUpfrontShare(deal: Commitment, profile: Profile): number {
  const legs = pattern(deal, profile)?.legs ?? [];
  const bp = legs.filter((l) => l.direction === "in" && l.anchor === "order" && l.offsetDays <= 0).reduce((a, l) => a + toBp(l.share), 0);
  return Math.min(BP, bp) / BP;
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
  const deal = records.commitments.find((c) => c.id === dealId);
  if (!deal) throw new Error(`smallestUpfrontShare: no commitment ${dealId}`);
  const stepBp = toBp(opts.step ?? DEFAULT_SHARE_STEP);
  if (!(stepBp > 0 && stepBp <= BP)) throw new Error(`smallestUpfrontShare: step must be in (0, 1], got ${opts.step}`);

  // "Can I afford to take this order?": a possible deal (and its linked costs) is evaluated as if it were likely,
  // so it lands on the main line. The caller's records are not mutated.
  const asTaken: Records =
    deal.status === "possible"
      ? { ...records, commitments: records.commitments.map((c) => (c.id === dealId ? { ...c, status: "likely" as const } : c)) }
      : records;

  const currentBp = toBp(currentUpfrontShare(deal, profile));
  const base = forecast(asTaken, profile, { id: "base", kind: "base", overrides: baseOverrides }, asOf, fxRates);
  if (base.lowPoint.amount >= base.safetyLine) {
    return { kind: "already_ok", share: currentBp / BP, run: base, lowPoint: base.lowPoint.amount };
  }

  // Grid: current, current + step, ..., capped at 1.0 (always included).
  const grid: number[] = [];
  for (let s = currentBp; s < BP; s += stepBp) grid.push(s);
  grid.push(BP);

  const memo = new Map<number, ForecastRun>();
  const at = (i: number): ForecastRun => {
    const s = grid[i]!;
    let run = memo.get(s);
    if (!run) {
      run = simulate(asTaken, profile, baseOverrides, [{ kind: "ask_advance", commitmentId: dealId, share: s / BP }], asOf, fxRates).run;
      memo.set(s, run);
    }
    return run;
  };
  const passes = (r: ForecastRun) => r.lowPoint.amount >= r.safetyLine;

  // Advancing more of a receipt to asOf only moves cash earlier, so the low point is non-decreasing in share:
  // binary search for the first passing grid point.
  const last = grid.length - 1;
  if (!passes(at(last))) {
    const r = at(last);
    return { kind: "not_achievable", bestShare: 1, run: r, lowPoint: r.lowPoint.amount };
  }
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (passes(at(mid))) hi = mid;
    else lo = mid + 1;
  }
  const run = at(lo);
  return { kind: "ok", share: grid[lo]! / BP, run, lowPoint: run.lowPoint.amount };
}
