// Every engine tunable, resolved from the profile with its default. Engine code reads tunables only through
// engineSettings(profile); nothing in engine/ hard-codes a business-dependent number.
// Docs: docs/design/02-business-profile.md ("Engine tunables").
//
// Defaults reproduce the engine's behavior before these fields existed. Values that are pure math, not business
// choices, stay as constants where they are used: "actual" confidence 1 and owner-rule lag confidence 1 (certain by
// definition), median and the 0.25/0.75 quartiles of the lag model, round-half-up of lag days, the basis-point grid
// (10000) of the affordability search, and the three items of "three things to do today" (the product promise).

import type { Anchor, EngineTunables, Profile } from "../schema/profile";
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

const ANCHORS: readonly Anchor[] = ["order", "ship", "delivery", "invoice", "due", "month_end", "weekday"];
const TYPES: readonly CommitmentType[] = ["invoice", "bill", "recurring", "sales_deal", "purchase_order", "plan"];

type Checker = (x: unknown) => boolean;
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const days: Checker = (x) => isNum(x) && Number.isInteger(x) && x > 0;
const daysOrZero: Checker = (x) => isNum(x) && Number.isInteger(x) && x >= 0;
const unit: Checker = (x) => isNum(x) && x >= 0 && x <= 1;
const positive: Checker = (x) => isNum(x) && x > 0;
const step: Checker = (x) => isNum(x) && x > 0 && x <= 1;
const listOf = (allowed: readonly string[]): Checker => (x) =>
  Array.isArray(x) && x.length > 0 && x.every((v) => typeof v === "string" && allowed.includes(v));

// Profiles stored outside profiles/ (the DB) skip schema/profiles.test.ts, so every value is checked here: anything
// missing keeps its default silently; anything non-finite or out of range keeps its default and is reported.
function resolve(profile: Pick<Profile, "engine" | "thresholds">): { settings: EngineSettings; issues: string[] } {
  const e = (profile.engine ?? {}) as Record<string, unknown> & EngineTunables;
  const sc = (e.statusConfidence ?? {}) as Record<string, unknown>;
  const lag = (e.lag ?? {}) as Record<string, unknown>;
  const th = (profile.thresholds ?? {}) as Record<string, unknown>;
  const d = ENGINE_DEFAULTS;
  const issues: string[] = [];
  const pick = <T>(path: string, value: unknown, ok: Checker, fallback: T, rule: string): T => {
    if (value === undefined) return fallback;
    if (ok(value)) return value as T;
    issues.push(`${path} = ${JSON.stringify(value) ?? String(value)} is invalid (${rule}); using the default ${JSON.stringify(fallback)}`);
    return fallback;
  };
  const DAYS = "a whole number of days > 0";
  const UNIT = "a number from 0 to 1";
  const settings: EngineSettings = {
    statusConfidence: {
      actual: 1,
      committed: pick("engine.statusConfidence.committed", sc.committed, unit, d.statusConfidence.committed, UNIT),
      likely: pick("engine.statusConfidence.likely", sc.likely, unit, d.statusConfidence.likely, UNIT),
      possible: pick("engine.statusConfidence.possible", sc.possible, unit, d.statusConfidence.possible, UNIT),
    },
    dailySalesConfidence: pick("engine.dailySalesConfidence", e.dailySalesConfidence, unit, d.dailySalesConfidence, UNIT),
    salesHistoryDays: pick("engine.salesHistoryDays", e.salesHistoryDays, days, d.salesHistoryDays, DAYS),
    lag: {
      maxSamples: pick("engine.lag.maxSamples", lag.maxSamples, days, d.lag.maxSamples, "a whole number > 0"),
      noHistoryConfidence: pick("engine.lag.noHistoryConfidence", lag.noHistoryConfidence, unit, d.lag.noHistoryConfidence, UNIT),
      iqrScaleDays: pick("engine.lag.iqrScaleDays", lag.iqrScaleDays, positive, d.lag.iqrScaleDays, "a number > 0"),
      laggedAnchors: pick("engine.lag.laggedAnchors", lag.laggedAnchors, listOf(ANCHORS), d.lag.laggedAnchors, `a non-empty list of ${ANCHORS.join(", ")}`),
      laggedTypes: pick("engine.lag.laggedTypes", lag.laggedTypes, listOf(TYPES), d.lag.laggedTypes, `a non-empty list of ${TYPES.join(", ")}`),
    },
    settlementMatchDays: pick("engine.settlementMatchDays", e.settlementMatchDays, daysOrZero, d.settlementMatchDays, "a whole number of days >= 0"),
    staleFallbackDays: pick("engine.staleFallbackDays", e.staleFallbackDays, days, d.staleFallbackDays, DAYS),
    noSnapshotLookbackDays: pick("engine.noSnapshotLookbackDays", e.noSnapshotLookbackDays, days, d.noSnapshotLookbackDays, DAYS),
    deferDays: pick("engine.deferDays", e.deferDays, days, d.deferDays, DAYS),
    affordabilityStep: pick("engine.affordabilityStep", e.affordabilityStep, step, d.affordabilityStep, "a number in (0, 1]"),
    urgencyScaleDays: pick("engine.urgencyScaleDays", e.urgencyScaleDays, positive, d.urgencyScaleDays, "a number > 0"),
    stressDelayDays: pick("thresholds.stressDelayDays", th.stressDelayDays, days, d.stressDelayDays, DAYS),
    splitIntervalDays: pick("thresholds.splitIntervalDays", th.splitIntervalDays, days, d.splitIntervalDays, DAYS),
  };
  return { settings, issues };
}

// Every engine tunable with its default; invalid values fall back to the default (see engineSettingsIssues).
export function engineSettings(profile: Pick<Profile, "engine" | "thresholds">): EngineSettings {
  return resolve(profile).settings;
}

// One message per invalid tunable; forecast() reports each as an `invalid_profile` review reason.
export function engineSettingsIssues(profile: Pick<Profile, "engine" | "thresholds">): string[] {
  return resolve(profile).issues;
}
