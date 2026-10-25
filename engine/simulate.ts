// simulate(): base plus levers, rerun. Every recommendation's dollar effect comes from here, never from Claude.

import { createHash } from "node:crypto";
import type { Lever, Override, Records, Scenario } from "../schema/records";
import type { Profile } from "../schema/profile";
import type { ForecastRun } from "../schema/forecast";
import { forecast } from "./forecast";

export type Simulation = {
  run: ForecastRun;
  base: ForecastRun;
  lowPointDelta: number; // new low point - base low point
  freeCashDelta: number; // change in free cash available now (first week of the run)
};

export function simulate(
  records: Records,
  profile: Profile,
  baseOverrides: Override[],
  levers: Lever[],
  asOf: string,
  fxRates: Record<string, number>,
): Simulation {
  const baseScenario: Scenario = { id: "base", kind: "base", overrides: baseOverrides };
  const id = `whatif-${createHash("sha256").update(JSON.stringify(levers)).digest("hex").slice(0, 10)}`;
  const whatIf: Scenario = { id, kind: "what_if", overrides: baseOverrides, levers };
  const base = forecast(records, profile, baseScenario, asOf, fxRates);
  const run = forecast(records, profile, whatIf, asOf, fxRates);
  return {
    run,
    base,
    lowPointDelta: run.lowPoint.amount - base.lowPoint.amount,
    freeCashDelta: (run.freeCash[0]?.amount ?? 0) - (base.freeCash[0]?.amount ?? 0),
  };
}
