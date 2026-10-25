// One call from records to "three things to do today": forecast the base scenario, run the warning
// checks, and rank them with each lever's dollar effect from simulate(). Pure, like the rest of engine/.

import type { ForecastRun } from "../schema/forecast";
import type { Profile } from "../schema/profile";
import type { Override, Records, WorkItem } from "../schema/records";
import { forecast } from "./forecast";
import { rank, type Brief } from "./rank";
import { simulate } from "./simulate";
import { dealAffordability, runChecks } from "./warnings";

export type BriefInput = {
  records: Records;
  profile: Profile;
  asOf: string;
  fxRates: Record<string, number>;
  baseOverrides?: Override[];               // the owner's saved overrides
  prior?: Pick<WorkItem, "id" | "state">[];  // saved work-item states, so done items stay done
};

export function buildBrief({ records, profile, asOf, fxRates, baseOverrides = [], prior = [] }: BriefInput):
  { run: ForecastRun; brief: Brief } {
  const run = forecast(records, profile, { id: "base", kind: "base", overrides: baseOverrides }, asOf, fxRates);
  const candidates = [...runChecks(run, records, profile), ...dealAffordability(run, records, profile, baseOverrides)];
  const brief = rank(candidates, run, records, profile,
    (levers) => simulate(records, profile, baseOverrides, levers, asOf, fxRates), prior);
  return { run, brief };
}
