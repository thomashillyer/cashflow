// Ask Neri end to end (P4.22): the owner's question -> readIntent -> decide -> (persist a proposal) -> voice.
// Design: docs/design/08-claude-layer.md ("Ask Neri: a CFO, not a menu"); wiring: ai/README.md.
//
//  - askNeri never throws: any failure becomes a plain-words "I can't answer that" CfoAnswer.
//  - A "proposed" verdict (a plan or rule the owner stated) is persisted through ctx.persistProposal (the caller
//    stores a proposed owner Signal or Rule) and the answer carries its id. Nothing is applied here.
//  - what_if and afford answers carry `scenario: { label, run }`, a forecast run with the what-if (or the plan
//    added) so the app can redraw the chart. The run is computed by the engine; Claude never touches a figure.
//  - Plans (stated or hypothetical) also carry the app's shape `proposal: { kind: "plan", amount, date, note }`.
//  - via "voice": `text` (read aloud) is the headline plus the next step only.
// Nothing here can send, pay, apply, or move money.

import type Anthropic from "@anthropic-ai/sdk";
import type { CfoAnswer, Decision } from "../../schema/ask";
import type { ForecastRun } from "../../schema/forecast";
import type { Profile } from "../../schema/profile";
import type { Commitment, CommitmentDraft, Override, Records, Scenario } from "../../schema/records";
import { runAtUpfrontShare } from "../../engine/affordability";
import { forecast } from "../../engine/forecast";
import { fmtMoney } from "../money";
import { decide } from "./decide";
import { readIntent } from "./intent";
import { voice, voiceText } from "./voice";

export type AskContext = {
  records: Records;
  profile: Profile;
  asOf: string;
  fxRates: Record<string, number>;
  baseOverrides?: Override[];
  pendingReviewCount: number;
  business: { name: string };
  mode: "live" | "cache_only";
  client?: Anthropic;
  // Cache directories for the two Claude steps; default: the live cache then the committed demo caches.
  cacheDirs?: { intent?: string; voice?: string };
  liveModel?: string;     // model for a live call on a cache miss (default ASK_LIVE_MODEL)
  via?: "text" | "voice";
  // Persists a proposed owner Signal (plan) or Rule and returns its id.
  persistProposal?: (proposal: NonNullable<Decision["proposal"]>) => Promise<string>;
};

// The app's "Add to forecast" shape (amount in minor units, date YYYY-MM-DD, note = the owner's words).
export type PlanProposal = {
  kind: "plan";
  amount: number;
  date: string;
  note: string;
  direction: "in" | "out";
  currency: string;
  id?: string;                 // persisted proposed Signal id (a stated plan)
  draft?: CommitmentDraft;
};

export type AskResult = Omit<CfoAnswer, "proposal"> & {
  proposal?: CfoAnswer["proposal"] | PlanProposal;
  scenario?: { label: string; run: ForecastRun };
};

function failure(why: string): AskResult {
  const headline = "I can't answer that one right now.";
  const nextStep = "Try asking again in a moment.";
  const convictionNote = "No call here: something went wrong on my side.";
  return {
    text: [headline, why, nextStep, convictionNote].join("\n"),
    citations: [],
    headline, why, nextStep, convictionNote,
    verdict: "decline", conviction: "low", usedFallback: true, missingData: why,
  };
}

const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// The what-if run: the books with the synthetic items added, the scenario's overrides after the base overrides.
function scenarioFor(d: Decision, ctx: AskContext, question: string): AskResult["scenario"] {
  const inputs = d.scenarioInputs;
  if (!d.scenario && !inputs) return undefined;
  const records: Records = inputs?.commitments?.length ? { ...ctx.records, commitments: [...ctx.records.commitments, ...inputs.commitments] } : ctx.records;
  const profile: Profile = inputs?.recurring?.length ? { ...ctx.profile, recurring: [...ctx.profile.recurring, ...inputs.recurring] } : ctx.profile;
  const overrides = [...(ctx.baseOverrides ?? []), ...(d.scenario?.overrides ?? [])];
  let run: ForecastRun;
  if (inputs?.upfrontShare) {
    run = runAtUpfrontShare(records, profile, overrides, inputs.upfrontShare.commitmentId, ctx.asOf, ctx.fxRates, inputs.upfrontShare.share);
  } else {
    const scenario: Scenario = {
      id: d.scenario?.id ?? `ask-${d.intent}`, kind: "what_if", overrides, ...(d.scenario?.levers ? { levers: d.scenario.levers } : {}),
    };
    run = forecast(records, profile, scenario, ctx.asOf, ctx.fxRates);
  }
  const c = inputs?.commitments?.[0];
  const r = inputs?.recurring?.[0];
  const label = c ? `${fmtMoney(c.amount, c.currency)} on ${shortDate(c.anchors.due ?? c.anchors.order ?? ctx.asOf)}`
    : r ? `${fmtMoney(r.amount, ctx.profile.baseCurrency)} ${r.cadence} from ${shortDate(r.startDate ?? r.anchor)}`
    : clip(question.trim().replace(/[?.!\s]+$/, ""), 60);
  return { label, run };
}

function planProposal(d: Decision, question: string, baseCurrency: string, id?: string): PlanProposal | undefined {
  const draft = d.proposal?.kind === "commitment" ? d.proposal.draft : undefined;
  const synthetic: Commitment | undefined = !draft && d.intent !== "tell" ? d.scenarioInputs?.commitments?.find((c) => c.type === "plan") : undefined;
  const src: CommitmentDraft | Commitment | undefined = draft ?? synthetic;
  if (!src || src.currency !== baseCurrency) return undefined; // the app adds plans in base-currency minor units
  const date = src.anchors.due ?? src.anchors.order ?? src.anchors.invoice;
  if (!date) return undefined;
  const direction = src.direction ?? "out";
  return {
    kind: "plan", amount: src.amount, date, note: question, direction, currency: src.currency,
    ...(id ? { id } : {}),
    ...(draft ? { draft } : {}),
  };
}

export async function askNeri(question: string, ctx: AskContext): Promise<AskResult> {
  try {
    const intent = await readIntent(question, {
      records: ctx.records, profile: ctx.profile, asOf: ctx.asOf, mode: ctx.mode,
      ...(ctx.client ? { client: ctx.client } : {}), ...(ctx.cacheDirs?.intent ? { cacheDir: ctx.cacheDirs.intent } : {}),
      ...(ctx.liveModel ? { liveModel: ctx.liveModel } : {}),
    });
    const decision = decide(intent, {
      records: ctx.records, profile: ctx.profile, asOf: ctx.asOf, fxRates: ctx.fxRates,
      ...(ctx.baseOverrides ? { baseOverrides: ctx.baseOverrides } : {}), pendingReviewCount: ctx.pendingReviewCount,
    });

    let proposalId: string | undefined;
    if (decision.verdict === "proposed" && decision.proposal && ctx.persistProposal) {
      proposalId = await ctx.persistProposal(decision.proposal);
    }
    const answer = await voice(decision, {
      profile: ctx.profile, business: ctx.business, mode: ctx.mode,
      ...(ctx.client ? { client: ctx.client } : {}), ...(ctx.cacheDirs?.voice ? { cacheDir: ctx.cacheDirs.voice } : {}),
      ...(ctx.liveModel ? { liveModel: ctx.liveModel } : {}),
      ...(proposalId ? { proposalId } : {}),
    });

    const out: AskResult = { ...answer };
    if (ctx.via === "voice") {
      // Spoken: the call and the one thing to do. The full fields stay for the screen.
      out.text = voiceText({ headline: answer.headline, why: "", ...(answer.nextStep ? { nextStep: answer.nextStep } : {}), convictionNote: "" });
    }
    const scenario = scenarioFor(decision, ctx, question);
    if (scenario) out.scenario = scenario;
    const plan = planProposal(decision, question, ctx.profile.baseCurrency, proposalId);
    if (plan) out.proposal = plan;
    return out;
  } catch {
    return failure("I could not finish working that out.");
  }
}

// ---------------------------------------------------------------------------
// Framework-free handler for POST /ask. The server resolves the business and loads its books, then calls this.

export type AskRequestBody = { question?: unknown; via?: unknown };

export async function handleAsk(
  body: unknown,
  ctx: Omit<AskContext, "via">,
): Promise<{ status: number; body: AskResult | { error: string } }> {
  const b = (body && typeof body === "object" ? body : {}) as AskRequestBody;
  if (typeof b.question !== "string" || b.question.trim() === "") {
    return { status: 400, body: { error: "Ask a question about your cash, for example: \"Can I afford a $40K deposit in December?\"" } };
  }
  if (b.question.length > 500) return { status: 400, body: { error: "That question is too long. Ask it in a sentence or two." } };
  if (b.via !== undefined && b.via !== "text" && b.via !== "voice") {
    return { status: 400, body: { error: "via must be \"text\" or \"voice\"." } };
  }
  return { status: 200, body: await askNeri(b.question, { ...ctx, ...(b.via ? { via: b.via } : {}) }) };
}
