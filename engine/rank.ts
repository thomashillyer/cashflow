// Turn warning Candidates into ranked WorkItems: "three things to do today" plus the full money list.
// Source: docs/design/07-warnings-and-ranking.md.
//
//   score = value × 1 / (1 + d / urgencyScaleDays) × confidence × relationship   (urgencyScaleDays: profile engine, default 7)
//
// value comes from re-simulating each lever (or dollars saved for a discount), never from Claude.
// title/why here are code-built fallbacks; the Claude layer may rewrite them from the same numbers.

import type { Candidate, ForecastRun } from "../schema/forecast";
import type { Profile } from "../schema/profile";
import type { CashEvent, Commitment, Lever, Records, WorkItem } from "../schema/records";
import { diffDays } from "./dates";
import { engineSettings } from "./settings";
import { pendingEventsByCommitment, receivableShares, sumBase } from "./warnings";

// The orchestrator binds the engine's simulate(records, profile, baseOverrides, levers, asOf, fxRates)
// to the base run, so ranking stays pure and testable.
export type SimulateLevers = (levers: Lever[]) => { lowPointDelta: number };

export type Brief = {
  today: WorkItem[];   // at most three open lever items above profile.thresholds.rankFloor; never padded
  all: WorkItem[];     // everything, best first
};

// Whole units of the profile's base currency, from minor units.
function moneyFormatter(currency: string) {
  const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 });
  const minorDigits = new Intl.NumberFormat("en-US", { style: "currency", currency })
    .resolvedOptions().maximumFractionDigits ?? 2;
  return (minor: number) => fmt.format(Math.abs(minor) / 10 ** minorDigits);
}

const pct = (share: number) => `${Math.round(share * 100)}%`;

// Warnings about the whole business rather than one party, commitment, or signal.
const SUBJECTLESS = new Set(["idle_balance_over"]);

// Stable per subject, check, and lever kind, so done/dismissed state survives reruns.
export function workItemId(c: Candidate): string {
  if (c.lever) {
    const leg = "legIndex" in c.lever && c.lever.legIndex !== undefined ? `-${c.lever.legIndex}` : "";
    return `wi-${c.warning}-${c.lever.kind}-${c.lever.commitmentId}${leg}`;
  }
  return SUBJECTLESS.has(c.warning) ? `wi-${c.warning}` : `wi-${c.warning}-${c.evidenceRefs[0] ?? "all"}`;
}

function relationship(partyId: string | undefined, records: Records, profile: Profile): number {
  const party = partyId ? records.parties.find((p) => p.id === partyId) : undefined;
  return (party?.tags ?? []).reduce((m, tag) => m * (profile.thresholds.relationshipPenalty[tag] ?? 1), 1);
}

function describe(
  c: Candidate, value: number, commitment: Commitment | undefined, run: ForecastRun, records: Records,
  money: (minor: number) => string, leg?: CashEvent,
): { title: string; why: string } {
  const partyOf = (id?: string) => records.parties.find((p) => p.id === id)?.name ?? "this party";
  // A lever on one leg of a multi-leg commitment names that leg, so two legs never read the same.
  const ref = (commitment?.reference ?? commitment?.id ?? "") + (leg ? ` (${money(leg.amountBase)} due ${leg.date})` : "");
  const named = records.parties.find((p) => p.id === commitment?.partyId)?.name;
  const lever = c.lever;

  switch (lever?.kind) {
    case "chase":
      return { title: named ? `Chase ${named} about ${ref}` : `Chase payment of ${ref}`,
        why: `Collecting it by ${lever.assumeDate} raises your low point by ${money(value)}.` };
    case "defer":
      return { title: named ? `Ask ${named} to move ${ref} by ${lever.days} days` : `Move ${ref} by ${lever.days} days`,
        why: `If ${named ? "they agree" : "it can wait"}, your low point rises by ${money(value)}.` };
    case "pay_early":
      return { title: `Pay ${ref} early to keep the discount`,
        why: `Paying by ${c.neededBy} saves ${money(value)}.` };
    case "ask_advance":
      if (c.upfront) {
        return { title: `Ask ${named ?? "the customer"} for ${pct(c.upfront.share)} upfront on ${ref}`,
          why: `At ${pct(c.upfront.currentShare)} upfront this order takes cash below your safety line; `
            + `${pct(c.upfront.share)} keeps it above and raises your low point by ${money(value)}.` };
      }
      return { title: `Change the terms on ${ref}`, why: `Your low point rises by ${money(value)}.` };
    case "split":
      return { title: `Change the terms on ${ref}`, why: `Your low point rises by ${money(value)}.` };
  }

  if (c.warning === "deal_affordability") {
    // Explain-only: a possible deal (no dollar figure, see warnings.ts) or one no upfront share can fix.
    if (c.upfront && c.upfront.share < 1) {
      return { title: `If you take ${ref}, ask ${named ?? "the customer"} for ${pct(c.upfront.share)} upfront`,
        why: `At ${pct(c.upfront.currentShare)} upfront this quote would take cash below your safety line; `
          + `${pct(c.upfront.share)} keeps it above.` };
    }
    return { title: `${ref} would take cash below your safety line`,
      why: "Even paid fully upfront, cash stays below the line. Review the supplier terms before signing." };
  }

  if (c.warning === "idle_balance_over") {
    const w = run.freeCash.find((f) => f.week === c.neededBy);
    return { title: "Cash is sitting above your safety line",
      why: w ? `About ${money(w.amount)} stays free for ${w.weeksFree} weeks from ${w.week}.` : "" };
  }
  if (c.warning === "ar_concentration_risk") {
    const partyId = c.evidenceRefs[0]!;
    const { total, byParty } = receivableShares(run, records);
    const share = total > 0 ? Math.round(((byParty.get(partyId)?.amount ?? 0) / total) * 100) : 0;
    return { title: `${partyOf(partyId)} holds ${share}% of the money owed to you`,
      why: "Consider a deposit or tighter terms on their next order." };
  }
  if (c.warning === "payment_slip") {
    const signal = records.signals.find((s) => s.id === c.evidenceRefs[0]);
    const moved = records.commitments.find((x) => x.id === signal?.commitmentId);
    const newDate = signal?.claim.kind === "date_change" ? signal.claim.newDate : "";
    return { title: `${partyOf(moved?.partyId)} moved ${moved?.reference ?? moved?.id ?? ""} to ${newDate}`,
      why: "The forecast and today's list have been updated." };
  }
  return { title: c.warning, why: "" };
}

export function rank(
  candidates: Candidate[],
  run: ForecastRun,
  records: Records,
  profile: Profile,
  simulate: SimulateLevers,
  prior: Pick<WorkItem, "id" | "state">[] = [],
): Brief {
  const pending = pendingEventsByCommitment(run);
  const { urgencyScaleDays: urgency, statusConfidence: statusConf } = engineSettings(profile);
  const money = moneyFormatter(profile.baseCurrency);
  const priorState = new Map(prior.map((p) => [p.id, p.state]));
  const byId = new Map<string, WorkItem>();

  for (const c of candidates) {
    const subjectId = c.lever?.commitmentId ?? c.evidenceRefs[0];
    const commitment = records.commitments.find((x) => x.id === subjectId);
    // The leg the lever acts on, when it names one (engine levers move a single leg).
    const legIndex = c.lever && "legIndex" in c.lever ? c.lever.legIndex : undefined;
    const events = (c.lever ? pending.get(c.lever.commitmentId) ?? [] : [])
      .filter((e) => legIndex === undefined || e.legIndex === legIndex);

    let value = 0;
    if (c.cashEffect !== undefined) {
      value = c.cashEffect;
    } else if (c.lever?.kind === "pay_early") {
      value = Math.round((sumBase(events.filter((e) => e.direction === "out")) * (commitment?.discount?.pct ?? 0)) / 100);
    } else if (c.lever) {
      value = simulate([c.lever]).lowPointDelta;
    }
    if (c.lever && value <= 0) continue;

    // A deal's confidence is its status's, as the engine assigns it: a possible deal has no main-line events,
    // and a likely deal's lag-shrunk later legs would understate a decision taken before signing.
    const confidence = c.upfront && commitment
      ? (commitment.status === "possible" ? commitment.probability ?? statusConf.possible : statusConf[commitment.status])
      : events.length ? Math.min(...events.map((e) => e.confidence)) : 1;
    const rel = c.lever ? relationship(commitment?.partyId, records, profile) : 1;
    const d = Math.max(0, diffDays(c.neededBy, run.asOf));
    const score = Math.round((value / (1 + d / urgency)) * confidence * rel);

    const id = workItemId(c);
    const drafts = c.lever && c.lever.kind !== "pay_early";
    const item: WorkItem = {
      id,
      warning: c.warning,
      ...describe(c, value, commitment, run, records, money, legIndex !== undefined ? events[0] : undefined),
      ...(c.lever ? { lever: c.lever } : {}),
      cashEffect: value,
      neededBy: c.neededBy,
      confidence,
      score,
      evidenceRefs: c.evidenceRefs,
      actions: drafts ? [{ kind: "draft_email" }, { kind: "mark_done" }] : [{ kind: "mark_done" }],
      state: priorState.get(id) ?? "open",
    };
    const existing = byId.get(id);
    if (!existing || existing.score < item.score) byId.set(id, item);
  }

  const all = [...byId.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const today = all
    .filter((w) => w.state === "open" && w.lever && w.score >= profile.thresholds.rankFloor)
    .slice(0, 3);
  return { today, all };
}
