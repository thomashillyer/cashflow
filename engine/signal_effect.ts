// Prices a signal: what it would do to the low point if the owner applied it. Fills Signal.effect.
// Docs: docs/design/06-signals.md step 5 ("Price it"). Pure: no I/O, no clock.

import type { Override, Records, Scenario, Signal } from "../schema/records";
import type { Profile } from "../schema/profile";
import { forecast } from "./forecast";

export type SignalEffect = { lowPointDelta: number; week: string };

// Claims that act on an existing commitment; without a matched commitmentId (ambiguous match) they cannot be priced.
const NEEDS_COMMITMENT: Signal["claim"]["kind"][] = ["date_change", "amount_change", "cancel"];

// Both sides are built from copies: before = this signal "proposed", after = this signal "applied"; every other
// signal stays as it is. So the effect is the same whatever state the signal is in now.
// lowPointDelta = after low point - before low point; week = Monday of the after run's low point.
// Undefined when the signal is unknown, or its claim needs a matched commitment and none is set.
export function signalEffect(
  records: Records,
  profile: Profile,
  baseOverrides: Override[],
  signalId: string,
  asOf: string,
  fxRates: Record<string, number>,
): SignalEffect | undefined {
  const sig = records.signals.find((s) => s.id === signalId);
  if (!sig) return undefined;
  if (NEEDS_COMMITMENT.includes(sig.claim.kind) && !sig.commitmentId) return undefined;
  const scenario: Scenario = { id: "base", kind: "base", overrides: baseOverrides };
  const withState = (state: Signal["state"]): Records => ({ ...records, signals: records.signals.map((s) => (s.id === signalId ? { ...s, state } : s)) });
  const before = forecast(withState("proposed"), profile, scenario, asOf, fxRates);
  const after = forecast(withState("applied"), profile, scenario, asOf, fxRates);
  return { lowPointDelta: after.lowPoint.amount - before.lowPoint.amount, week: after.lowPoint.week };
}
