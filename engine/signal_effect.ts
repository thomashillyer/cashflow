// Prices a signal: what it would do to the low point if the owner applied it. Fills Signal.effect.
// Docs: docs/design/06-signals.md step 5 ("Price it"). Pure: no I/O, no clock.

import type { Override, Records, Scenario } from "../schema/records";
import type { Profile } from "../schema/profile";
import { forecast } from "./forecast";

export type SignalEffect = { lowPointDelta: number; week: string };

// Base = records as they are (a proposed signal is not applied). Applied = the same records with this signal's
// state set to "applied". lowPointDelta = applied low point - base low point; week = Monday of the applied low point.
export function signalEffect(
  records: Records,
  profile: Profile,
  baseOverrides: Override[],
  signalId: string,
  asOf: string,
  fxRates: Record<string, number>,
): SignalEffect | undefined {
  if (!records.signals.some((s) => s.id === signalId)) return undefined;
  const scenario: Scenario = { id: "base", kind: "base", overrides: baseOverrides };
  const applied: Records = { ...records, signals: records.signals.map((s) => (s.id === signalId ? { ...s, state: "applied" as const } : s)) };
  const before = forecast(records, profile, scenario, asOf, fxRates);
  const after = forecast(applied, profile, scenario, asOf, fxRates);
  return { lowPointDelta: after.lowPoint.amount - before.lowPoint.amount, week: after.lowPoint.week };
}
