// One place routes get engine inputs from a stored business: the profile (without the account
// details), asOf and FX rates, and the brief for one run. All money math stays in engine/.

import type { ForecastRun } from "../schema/forecast";
import type { Profile } from "../schema/profile";
import type { Override, Records, Scenario, WorkItem } from "../schema/records";
import { buildBrief } from "../engine/brief";
import type { Brief } from "../engine/rank";
import { simulate } from "../engine/simulate";
import { fmtDate, writeBrief, type BriefContext } from "../ai/brief";
import { fmtMoney } from "../ai/money";
import type { Business, Store } from "./store";

export type AiMode = "live" | "cache_only";

export type RunInputs = { profile: Profile; asOf: string; fxRates: Record<string, number> };

export function runInputs(b: Business, now: () => Date): RunInputs {
  const { account, ...profile } = b.profile;
  return {
    profile: profile as Profile,
    // Samples run at their fixture date; real businesses at today's UTC date.
    asOf: account?.asOf ?? now().toISOString().slice(0, 10),
    fxRates: account?.fxRates ?? {},
  };
}

// The records, their revision and the owner's saved overrides for one run. Every forecast, simulate and
// brief the API serves goes through here, so saved overrides are never dropped.
export type Loaded = { records: Records; storeRevision: number; overrides: Override[] };

export async function loadForRun(store: Store, id: string): Promise<Loaded> {
  const [{ records, storeRevision }, overrides] = await Promise.all([store.load(id), store.loadOverrides(id)]);
  return { records, storeRevision, overrides };
}

// The base (or stress) scenario: the owner's saved overrides; stress adds the profile's stress rules in forecast().
export const savedScenario = (overrides: Override[], kind: "base" | "stress" = "base"): Scenario =>
  ({ id: kind, kind, overrides });

export const businessIdentity = (b: Business) => ({ name: b.name, ...(b.profile.account?.aliases?.length ? { aliases: b.profile.account.aliases } : {}) });

// Decorations the app reads on each item (preview engine shape): act vs watch, and the party.
export type AppItem = WorkItem & { kind: "act" | "watch"; partyId?: string };

function decorate(item: WorkItem, records: Records): AppItem {
  const commitmentId = item.lever?.commitmentId ?? item.evidenceRefs.find((r) => records.commitments.some((c) => c.id === r));
  const partyId = records.commitments.find((c) => c.id === commitmentId)?.partyId;
  return { ...item, kind: item.lever ? "act" : "watch", ...(partyId ? { partyId } : {}) };
}

export type BriefResult = {
  asOf: string;
  three: AppItem[];
  rest: AppItem[];
  watch: AppItem[];
  combined: { lowPointDelta: number; lowPoint: ForecastRun["lowPoint"] } | null;
  shortfall: { amount: number; title: string; why: string; partnerAction: { label: string; sample: true; disclosure: string } } | null;
  run: ForecastRun;
  storeRevision: number;
  inputsHash: string;
  usedFallback: string[];
};

export type Computed = { run: ForecastRun; brief: Brief; records: Records; overrides: Override[]; storeRevision: number; inputs: RunInputs; ctx: BriefContext };

// One engine run for the business, with saved work-item states carried over; saves the fresh
// ranking when the run changed (best effort: a failed save never blocks the brief).
export async function compute(store: Store, b: Business, mode: AiMode, now: () => Date): Promise<Computed> {
  const { records, storeRevision, overrides } = await loadForRun(store, b.id);
  const inputs = runInputs(b, now);
  const saved = await store.loadWorkItems(b.id).catch(() => ({ items: [] as WorkItem[], inputsHash: undefined }));
  const { run, brief } = buildBrief({ ...inputs, records, baseOverrides: overrides, prior: saved.items.map((i) => ({ id: i.id, state: i.state })) });
  if (saved.inputsHash !== run.inputsHash) {
    await store.saveWorkItems(b.id, brief.all, run.inputsHash).catch(() => undefined);
  }
  const ctx: BriefContext = { run, records, profile: inputs.profile, business: { name: b.name }, mode };
  return { run, brief, records, overrides, storeRevision, inputs, ctx };
}

const PARTNER_DISCLOSURE = "Sample card. If Neri lists partners, they pay a referral fee, and Neri is paid the same whichever you choose.";

export async function briefFor(store: Store, b: Business, mode: AiMode, now: () => Date): Promise<BriefResult> {
  const c = await compute(store, b, mode, now);
  const { run, brief, records, overrides, inputs } = c;
  const { items: worded, usedFallback } = await writeBrief(brief.today, c.ctx);
  const three = worded.map((i) => decorate(i, records));
  const todayIds = new Set(three.map((i) => i.id));
  const others = brief.all.filter((i) => !todayIds.has(i.id)).map((i) => decorate(i, records));
  const rest = others.filter((i) => i.kind === "act");
  const watch = others.filter((i) => i.kind === "watch");

  const levers = three.filter((i) => i.state === "open" && i.lever).map((i) => i.lever!);
  let combined: BriefResult["combined"] = null;
  let after = run.lowPoint.amount;
  let afterDate = run.lowPoint.date; // the gap and its date come from the same (simulated) run
  if (levers.length) {
    const sim = simulate(records, inputs.profile, overrides, levers, inputs.asOf, inputs.fxRates);
    after = sim.run.lowPoint.amount;
    afterDate = sim.run.lowPoint.date;
    if (levers.length > 1) combined = { lowPointDelta: sim.lowPointDelta, lowPoint: sim.run.lowPoint };
  }
  // No opening balance yet (a new business before its first import): no gap to show.
  const residual = run.firstBelowSafety && records.balances.length ? run.safetyLine - after : 0;
  const currency = inputs.profile.baseCurrency;
  const shortfall: BriefResult["shortfall"] = residual > 0
    ? {
        amount: residual,
        title: `Even with these, you'd be ${fmtMoney(residual, currency)} under your line around ${fmtDate(afterDate, inputs.asOf)}`,
        why: "If chasing and timing can't close the rest, you could look at short-term working capital. Whether to borrow is your call; Neri only shows the gap and the dates.",
        partnerAction: { label: "See sample working-capital options", sample: true, disclosure: PARTNER_DISCLOSURE },
      }
    : null;
  return {
    asOf: inputs.asOf, three, rest, watch, combined, shortfall, run,
    storeRevision: c.storeRevision, inputsHash: run.inputsHash, usedFallback,
  };
}
