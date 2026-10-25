// Every engine tunable, resolved from the profile with its default. Engine code reads tunables only through
// engineSettings(profile); nothing in engine/ hard-codes a business-dependent number.
// Docs: docs/design/02-business-profile.md ("Engine tunables").
//
// Defaults reproduce the engine's behavior before these fields existed. Values that are pure math, not business
// choices, stay as constants where they are used: "actual" confidence 1 and owner-rule lag confidence 1 (certain by
// definition), median and the 0.25/0.75 quartiles of the lag model, round-half-up of lag days, the basis-point grid
// (10000) of the affordability search, and the three items of "three things to do today" (the product promise).

import type { Anchor, Profile } from "../schema/profile";
import type { CommitmentType } from "../schema/records";

export type EngineSettings = {
  statusConfidence: { actual: 1; committed: number; likely: number; possible: number };
  dailySalesConfidence: number;
  salesHistoryDays: number;
  lag: { maxSamples: number; noHistoryConfidence: number; iqrScaleDays: number; laggedAnchors: readonly Anchor[]; laggedTypes: readonly CommitmentType[] };
  settlementMatchDays: number;
  staleFallbackDays: number;
  noSnapshotLookbackDays: number;
  deferDays: number;
  affordabilityStep: number;
  urgencyScaleDays: number;
  stressDelayDays: number;   // profile.thresholds.stressDelayDays
  splitIntervalDays: number; // profile.thresholds.splitIntervalDays
};

export const ENGINE_DEFAULTS: EngineSettings = Object.freeze({
  statusConfidence: Object.freeze({ actual: 1, committed: 0.95, likely: 0.7, possible: 0.3 }),
  dailySalesConfidence: 0.6,
  salesHistoryDays: 28,
  lag: Object.freeze({
    maxSamples: 12,
    noHistoryConfidence: 0.1,
    iqrScaleDays: 14,
    // `order` and `ship` are our own dates; these mean "wait for the customer to pay".
    laggedAnchors: Object.freeze(["due", "invoice", "delivery", "month_end"] as Anchor[]),
    laggedTypes: Object.freeze(["invoice", "sales_deal"] as CommitmentType[]),
  }),
  settlementMatchDays: 3,
  staleFallbackDays: 7,
  noSnapshotLookbackDays: 90,
  deferDays: 10,
  affordabilityStep: 0.05,
  urgencyScaleDays: 7,
  stressDelayDays: 7,
  splitIntervalDays: 30,
}) as EngineSettings;

export function engineSettings(profile: Pick<Profile, "engine" | "thresholds">): EngineSettings {
  const e = profile.engine ?? {};
  const d = ENGINE_DEFAULTS;
  const sc = e.statusConfidence ?? {};
  const lag = e.lag ?? {};
  return {
    statusConfidence: {
      actual: 1,
      committed: sc.committed ?? d.statusConfidence.committed,
      likely: sc.likely ?? d.statusConfidence.likely,
      possible: sc.possible ?? d.statusConfidence.possible,
    },
    dailySalesConfidence: e.dailySalesConfidence ?? d.dailySalesConfidence,
    salesHistoryDays: e.salesHistoryDays ?? d.salesHistoryDays,
    lag: {
      maxSamples: lag.maxSamples ?? d.lag.maxSamples,
      noHistoryConfidence: lag.noHistoryConfidence ?? d.lag.noHistoryConfidence,
      iqrScaleDays: lag.iqrScaleDays ?? d.lag.iqrScaleDays,
      laggedAnchors: lag.laggedAnchors ?? d.lag.laggedAnchors,
      laggedTypes: lag.laggedTypes ?? d.lag.laggedTypes,
    },
    settlementMatchDays: e.settlementMatchDays ?? d.settlementMatchDays,
    staleFallbackDays: e.staleFallbackDays ?? d.staleFallbackDays,
    noSnapshotLookbackDays: e.noSnapshotLookbackDays ?? d.noSnapshotLookbackDays,
    deferDays: e.deferDays ?? d.deferDays,
    affordabilityStep: e.affordabilityStep ?? d.affordabilityStep,
    urgencyScaleDays: e.urgencyScaleDays ?? d.urgencyScaleDays,
    stressDelayDays: profile.thresholds?.stressDelayDays ?? d.stressDelayDays,
    splitIntervalDays: profile.thresholds?.splitIntervalDays ?? d.splitIntervalDays,
  };
}
