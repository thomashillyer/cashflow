// The brief/draft fixture for cascade_trade (fixtures/cascade_trade/brief/): a ForecastRun, the records
// behind three work items, and the work items themselves. Shared by the cache scripts and ai/brief.test.ts
// so the cache keys line up exactly.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ForecastRun } from "../schema/forecast";
import type { Profile } from "../schema/profile";
import type { Records, WorkItem } from "../schema/records";

export const BRIEF_DIR = join(import.meta.dirname, "../fixtures/cascade_trade/brief");
export const BRIEF_BUSINESS = { name: "Cascade Trade Co." };

const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

export function loadBriefFixture() {
  return {
    run: read<ForecastRun>(join(BRIEF_DIR, "forecast_run.json")),
    records: read<Records>(join(BRIEF_DIR, "records.json")),
    items: read<WorkItem[]>(join(BRIEF_DIR, "work_items.json")),
    profile: read<Profile>(join(import.meta.dirname, "../profiles/trading.json")),
    business: BRIEF_BUSINESS,
  };
}
