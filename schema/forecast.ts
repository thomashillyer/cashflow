// Engine and Claude-layer outputs. Source: docs/design/05-forecast-engine.md,
// 07-warnings-and-ranking.md, 08-claude-layer.md, and docs/TECHNICAL_PLAN.md section 7.

import type { CashEvent, Lever, Records } from "./records";
import type { Profile } from "./profile";

export type ForecastRun = {
  id: string;
  asOf: string;
  inputsHash: string;          // hash of records + profile + scenario + asOf + rates
  scenarioId: string;
  fxRates: Record<string, number>;
  openingBalance: number;
  safetyLine: number;
  days: { date: string; inflow: number; outflow: number; closing: number; eventIds: string[] }[];
  weeks: {
    start: string;             // Monday
    inflow: number; outflow: number; closing: number;
    minClosing: number;        // daily minimum inside the week
    pipelineClosing: number;   // closing + probability-weighted possible deals
    eventIds: string[];
  }[];
  lowPoint: { week: string; date: string; amount: number };
  firstBelowSafety?: string;   // date
  firstNegative?: string;      // date
  weeksBelowSafety: string[];
  freeCash: { week: string; amount: number; weeksFree: number }[];
  warnings: string[];          // data quality: stale source, unresolved reviews, missing facts
  events: CashEvent[];         // fully dated, with basis and overriddenBy
};

// Warnings (person 5).
export type Candidate = {
  warning: string; lever?: Lever; evidenceRefs: string[]; neededBy: string;
  cashEffect?: number;                                  // precomputed by the engine (deal_affordability); rank then skips simulate()
  upfront?: { share: number; currentShare: number };   // deal_affordability: suggested vs current upfront share, 0..1
};
export type Check = (run: ForecastRun, records: Records, profile: Profile) => Candidate[];

// Every user-facing Claude response.
export type Answer = {
  text: string;                // plain English, profile vocabulary
  citations: string[];         // record ids
  scenarioId?: string;         // when a what-if was simulated
  missingData?: string;        // set instead of guessing
};
