// Ask Neri's CFO voice (P4.21): Claude phrases a Decision; code owns the verdict, the recommendation, the
// conviction, and every figure. Design: docs/design/08-claude-layer.md ("Ask Neri: a CFO, not a menu").
//
//  - voice(decision, ctx) returns a CfoAnswer. Claude returns only a CfoVoice; code assembles everything else
//    (verdict, conviction, question, proposal, citations, scenarioId, missingData) from the Decision.
//  - Checks on the model's words: number_check (amounts, dates, percentages, day and sample counts) against
//    Decision.allowed; no menus (options, "you could", lists, more than one fallback); the headline leads with
//    the verdict's stance and the recommendation's key fact; no claim that anything was sent or paid.
//  - One attempt, one retry with feedback, then a deterministic code-built voice. A cache hit that fails the
//    checks counts as a miss. Cached per Decision (key = prompt + model + business + the facts block).
//  - need_info, decline, and proposed never call the model: they use the code-built voice.
// Nothing here can send, pay, apply, or move money; a proposal is passed through for the owner to confirm.

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import type { CfoAnswer, CfoVoice, Decision, NumberFact } from "../../schema/ask";
import type { Profile } from "../../schema/profile";
import { callStructured, factsBlock, fmtDate, prompt, sha, type Turn } from "../brief";
import { ASK_CACHE_DIR, cacheKey, LIVE_CACHE_DIR, readCache, writeCache } from "../cache";
import { CFO_VOICE_MODEL, CFO_VOICE_PROMPT_VERSION } from "../config";
import { fmtMoney } from "../money";
import { amountMatches, checkText, extractAmounts, extractDates } from "../number_check";

export type VoiceContext = {
  profile: Pick<Profile, "vocabulary">;
  business: { name: string };
  mode: "live" | "cache_only";
  client?: Anthropic;     // live mode; defaults to a client configured from ANTHROPIC_API_KEY
  // Read and write directory. Default: reads LIVE_CACHE_DIR (gitignored) then the committed demo cache
  // (ASK_CACHE_DIR); live results are written to LIVE_CACHE_DIR, never to the fixtures.
  cacheDir?: string;
  model?: string;
  // Id of the persisted proposed Signal or Rule (verdict "proposed"); the caller persists the proposal, then
  // passes its id. Default: a PLACEHOLDER id derived from the proposal (not a persisted record): always pass the real id.
  proposalId?: string;
};

// Verdicts whose words are always built by code (no model call).
const CODE_BUILT = new Set<Decision["verdict"]>(["need_info", "decline", "proposed"]);

// ---------------------------------------------------------------------------
// Formatting for code-built text and the facts block

const money = (d: Decision, minor: number) => fmtMoney(minor, d.currency);
const date = (d: Decision, iso: string) => fmtDate(iso, d.asOf);
const numberText = (n: NumberFact) => (n.unit === "pct" ? `${n.value}%` : n.unit === "days" ? `${n.value} days` : String(n.value));
const stripEnd = (s: string) => s.trim().replace(/[.!?\s]+$/, "");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// "Ask Harbor for 40%" -> "ask Harbor for 40%"; "USD" and "ID" stay as written.
const lcFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

type Rec = NonNullable<Decision["recommendation"]>;

// "Ask Harbor for 40% up front by Dec 1": adds the act-by date unless the action already names a date
// (one by-date in the sentence, never "by Dec 10 by Dec 12").
function actionBy(d: Decision, action: string, byDate?: string): string {
  const a = stripEnd(action);
  if (!byDate) return a;
  return /\bby\s+[A-Z][a-z]{2}\s+\d/.test(a) ? a : `${a} by ${date(d, byDate)}`;
}

function factLines(d: Decision): string[] {
  const lines = d.headlineFacts.map((f) => {
    const parts = [f.amount !== undefined ? money(d, f.amount) : undefined, f.date !== undefined ? `on ${date(d, f.date)}` : undefined];
    return `${f.label}: ${parts.filter(Boolean).join(" ")}`;
  });
  for (const n of d.numbers) lines.push(`${n.label}: ${numberText(n)}`);
  return lines;
}

const facts = (d: Decision, business: string, vocabulary: Record<string, string>) => ({
  businessName: business,
  verdict: d.verdict,
  intent: d.intent,
  asOf: d.asOf,
  currency: d.currency,
  ...(d.lead ? { lead: { kind: d.lead.kind, ...(d.lead.timing ? { timing: d.lead.timing } : {}), ...(d.lead.subject ? { subject: d.lead.subject } : {}), ...(d.lead.weekStart ? { weekStart: date(d, d.lead.weekStart) } : {}) } } : {}),
  headlineFacts: d.headlineFacts.map((f) => ({
    label: f.label,
    ...(f.amount !== undefined ? { amount: money(d, f.amount) } : {}),
    ...(f.date !== undefined ? { date: date(d, f.date) } : {}),
  })),
  numbers: d.numbers.map((n) => ({ label: n.label, text: numberText(n) })),
  lowPoint: d.context.baseLowPoint ? { amount: money(d, d.context.baseLowPoint.amount), date: date(d, d.context.baseLowPoint.date) } : undefined,
  safetyLine: d.context.safetyLine !== undefined ? money(d, d.context.safetyLine) : undefined,
  shortfall: d.context.shortfall !== undefined ? money(d, d.context.shortfall) : undefined,
  recommendation: d.recommendation && {
    action: d.recommendation.action,
    byDate: d.recommendation.byDate ? date(d, d.recommendation.byDate) : undefined,
    upfrontShare: d.recommendation.upfrontShare !== undefined ? `${Math.round(d.recommendation.upfrontShare * 100)}%` : undefined,
    cashEffect: d.recommendation.cashEffect !== undefined ? money(d, d.recommendation.cashEffect) : undefined,
    resultingLowPoint: d.recommendation.resultingLowPoint
      ? { amount: money(d, d.recommendation.resultingLowPoint.amount), date: date(d, d.recommendation.resultingLowPoint.date) }
      : undefined,
  },
  fallback: d.fallback && {
    action: d.fallback.action,
    cashEffect: d.fallback.cashEffect !== undefined ? money(d, d.fallback.cashEffect) : undefined,
  },
  assumptions: d.assumptions,
  conviction: d.conviction,
  convictionReasons: d.convictionReasons,
  whatWouldChange: d.whatWouldChange,
  vocabulary,
});

// ---------------------------------------------------------------------------
// The code-built voice (no model). Also the fallback when the model's words fail the checks.

const assumptionsLine = (d: Decision) => (d.assumptions.length ? `Assumptions: ${d.assumptions.map(stripEnd).join("; ")}.` : undefined);
const join = (parts: (string | undefined)[]) => parts.filter((p): p is string => !!p).join(" ");

// For afford (outbound) and what_if verdicts, headlineFacts[0] is the low point WITH the plan or what-if, while
// context.baseLowPoint is the run without it (decide.ts). State the with-plan low point first.
function withPlanLow(d: Decision): { date: string; amount: number } | undefined {
  const f = d.headlineFacts[0];
  if (d.lead?.kind === "short_before") return undefined; // already short without it: the low point is the base run
  if (!f || f.amount === undefined || f.date === undefined || !/lowest cash point/i.test(f.label)) return undefined;
  const outboundAfford = d.intent === "afford" && d.headlineFacts.some((x) => /payment$/i.test(x.label));
  if (d.intent !== "what_if" && !outboundAfford) return undefined;
  return { date: f.date, amount: f.amount };
}

function lowPointLine(d: Decision): string | undefined {
  const b = d.context.baseLowPoint;
  const w = withPlanLow(d);
  const line = d.context.safetyLine !== undefined ? `, against a safety line of ${money(d, d.context.safetyLine)}` : "";
  if (w) {
    const base = b && (b.amount !== w.amount || b.date !== w.date) ? ` Without it, your lowest point is ${money(d, b.amount)} on ${date(d, b.date)}.` : "";
    return `With this, your lowest cash point is ${money(d, w.amount)} on ${date(d, w.date)}${line}.${base}`;
  }
  if (!b) return undefined;
  const short = d.context.shortfall !== undefined && d.context.shortfall > 0 ? ` That is ${money(d, d.context.shortfall)} short.` : "";
  return `Your lowest cash point is ${money(d, b.amount)} on ${date(d, b.date)}${line}.${short}`;
}

function effectLine(d: Decision, r: Rec): string | undefined {
  if (r.resultingLowPoint) return `Doing this moves your lowest point to ${money(d, r.resultingLowPoint.amount)} on ${date(d, r.resultingLowPoint.date)}.`;
  if (r.cashEffect !== undefined) return `Doing this lifts your lowest point by ${money(d, r.cashEffect)}.`;
  return undefined;
}

function fallbackLine(d: Decision): string | undefined {
  const f = d.fallback;
  if (!f) return undefined;
  const effect = f.cashEffect !== undefined ? `, which lifts your lowest point by ${money(d, f.cashEffect)} on its own` : "";
  return `If that doesn't work, ${lcFirst(stripEnd(f.action))}${effect}.`;
}

const convictionNote = (d: Decision) => {
  const reasons = d.convictionReasons.map(stripEnd).filter(Boolean);
  return `${cap(d.conviction)} confidence: ${reasons.length ? reasons.join("; ") : "no weak spots found in the data behind this"}.`;
};

// The headline that answers the question asked before it gives the move (d.lead), or undefined.
function leadHeadline(d: Decision, r: Rec | undefined): string | undefined {
  const l = d.lead;
  const f0 = d.headlineFacts[0];
  if (!l) return undefined;
  if (l.kind === "can_pay" && l.pay) {
    const p = l.pay;
    const when = `${l.subject ?? p.name} on ${date(d, p.date)}`;
    const line = money(d, d.context.safetyLine ?? 0);
    if (p.answer === "no") return `No: ${when} takes you to ${money(d, p.closing)}, ${money(d, p.shortfall)} under your ${line} line.`;
    if (p.answer === "tight") return `Yes, but it's tight: after ${when} you have ${money(d, p.closing)}, ${money(d, p.shortfall)} under your ${line} line.`;
    return `Yes: after ${when} you still have ${money(d, p.closing)}.`;
  }
  if (l.kind === "short_before" && d.context.shortfall !== undefined) {
    const low = d.context.baseLowPoint;
    const head = `Not yet: you're already ${money(d, d.context.shortfall)} below your safety line${low ? ` on ${date(d, low.date)}` : ""} without it.`;
    return r ? `${head} First, ${lcFirst(actionBy(d, r.action, r.byDate))}.` : head;
  }
  if (l.kind === "effect" && l.subject && f0?.amount !== undefined && f0.date !== undefined) {
    const b = d.context.baseLowPoint;
    const move = !b || f0.amount === b.amount ? "stays at" : f0.amount < b.amount ? "falls to" : "rises to";
    return `If ${l.subject}, your lowest point ${move} ${money(d, f0.amount)} on ${date(d, f0.date)}.`;
  }
  if (l.kind === "timing" && l.timing && l.subject) {
    const { days, samples, rule } = l.timing;
    const n = Math.abs(days);
    const span = days === 0 ? "on the due date" : `${n} day${n === 1 ? "" : "s"} ${days > 0 ? "late" : "early"}`;
    if (rule) return `Per your rule, ${l.subject} pays ${span}.`;
    if (samples === 0) return `I have no payment history for ${l.subject}; the forecast assumes it pays ${span}.`;
    return `${l.subject} usually pays ${days === 0 ? span : `about ${span}`}, based on ${samples} payment${samples === 1 ? "" : "s"}.`;
  }
  if (l.kind === "tightest" && l.weekStart && f0?.amount !== undefined && f0.date !== undefined) {
    return `Your tightest week starts ${date(d, l.weekStart)}: cash bottoms out at ${money(d, f0.amount)} on ${date(d, f0.date)}.`;
  }
  return undefined;
}

export function fallbackVoice(d: Decision): CfoVoice {
  const r = d.recommendation;
  const base = { convictionNote: convictionNote(d), whatWouldChange: d.whatWouldChange };
  switch (d.verdict) {
    case "need_info":
      return {
        headline: d.question ? stripEnd(d.question) + "?" : "I need one more detail to give you a straight answer.",
        why: join([d.missingData ? `${stripEnd(d.missingData)}.` : "Without it I would be guessing.", assumptionsLine(d)]),
        nextStep: "Answer that and I will give you the call.",
        convictionNote: "No call yet: I am waiting on your answer.",
      };
    case "decline": {
      const lines = factLines(d);
      return {
        headline: "I can't answer that one.",
        why: join([d.missingData ? `${stripEnd(d.missingData)}.` : "It is outside what I can advise on.",
          lines.length ? `What I can tell you: ${lines.join("; ")}.` : undefined]),
        convictionNote: "No call on this one.", // also an unreadable question, so no "won't advise" claim
      };
    }
    case "proposed": {
      const lines = factLines(d);
      return {
        headline: "I have drafted this as a proposal for you to confirm.",
        why: join(["Nothing changes in your forecast until you confirm it.", lines.length ? `${lines.join("; ")}.` : undefined, assumptionsLine(d)]),
        nextStep: d.proposal?.kind === "rule" ? "Confirm it to apply this rule to your forecast." : "Confirm it to add it to your forecast.",
        convictionNote: "No call to make here: nothing happens until you confirm it.",
      };
    }
    case "yes_if":
    case "act_now": {
      const step = r ? `${cap(actionBy(d, r.action, r.byDate))}.` : undefined;
      const headline = leadHeadline(d, r) ?? (!r ? (d.verdict === "yes_if" ? "Yes, if you make the change below." : "Act now.")
        : d.verdict === "yes_if" ? `Yes, if you ${lcFirst(actionBy(d, r.action, r.byDate))}.`
        : `Act now: ${lcFirst(actionBy(d, r.action, r.byDate))}.`);
      return { headline, why: join([lowPointLine(d), r && effectLine(d, r), fallbackLine(d), assumptionsLine(d)]), nextStep: step, ...base };
    }
    case "yes":
      return {
        headline: d.context.safetyLine !== undefined
          ? `Yes, you can do this and stay above your ${money(d, d.context.safetyLine)} safety line.`
          : "Yes, you can do this.",
        why: join([lowPointLine(d), fallbackLine(d), assumptionsLine(d)]),
        ...base,
      };
    case "no":
      return {
        headline: "No, not as things stand.",
        why: join([lowPointLine(d), r && effectLine(d, r), fallbackLine(d), assumptionsLine(d)]),
        ...base,
      };
    case "on_track":
      return { headline: leadHeadline(d, undefined) ?? "You're on track.", why: join([lowPointLine(d), assumptionsLine(d)]), ...base };
    case "info": {
      const lh = leadHeadline(d, undefined);
      if (lh) {
        const lines = d.headlineFacts.map((f) => `${f.label}: ${[f.amount !== undefined ? money(d, f.amount) : undefined, f.date !== undefined ? `on ${date(d, f.date)}` : undefined].filter(Boolean).join(" ")}`);
        return { headline: lh, why: join([lines.length ? `${lines.join("; ")}.` : undefined, assumptionsLine(d)]), ...base };
      }
      const [first, ...rest] = factLines(d);
      return {
        headline: first ? `${first}.` : "Here is what your books show.",
        why: join([rest.length ? `${rest.join("; ")}.` : "That comes straight from your books.", assumptionsLine(d)]),
        ...base,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Assembling the CfoAnswer (code)

// `text` is the voice fields joined in order, so number_check covers every word the owner reads.
export const voiceText = (v: CfoVoice): string =>
  [v.headline, v.why, v.nextStep, v.convictionNote, v.whatWouldChange].filter((p): p is string => !!p && p.trim() !== "").join("\n");

const clean = (v: CfoVoice): CfoVoice => ({
  headline: v.headline.trim(),
  why: v.why.trim(),
  ...(v.nextStep?.trim() ? { nextStep: v.nextStep.trim() } : {}),
  convictionNote: v.convictionNote.trim(),
  ...(v.whatWouldChange?.trim() ? { whatWouldChange: v.whatWouldChange.trim() } : {}),
});

function assemble(d: Decision, v: CfoVoice, usedFallback: boolean, ctx: Pick<VoiceContext, "proposalId">): CfoAnswer {
  const proposal = d.proposal
    ? { ...d.proposal, id: ctx.proposalId ?? `ask-proposal-${cacheKey(d.proposal).slice(0, 16)}` }
    : undefined;
  return {
    text: voiceText(v),
    citations: d.citations,
    ...(d.scenarioId !== undefined ? { scenarioId: d.scenarioId } : {}),
    ...(d.missingData !== undefined ? { missingData: d.missingData } : {}),
    ...v,
    verdict: d.verdict,
    conviction: d.conviction,
    ...(d.question !== undefined ? { question: d.question } : {}),
    ...(proposal ? { proposal } : {}),
    usedFallback,
  };
}

// ---------------------------------------------------------------------------
// Checks on the model's words

// Menus: options, alternatives, "you could", "or you might", bulleted or numbered choices.
const MENU_RE = /\boptions?\b|\balternativ(?:e|ely|es)\b|\byou\s+(?:could|might|may\s+want\s+to|can\s+also|may\s+also)\b|\bor\s+you\s+(?:might|could|can)\b|\bconsider(?:ing)?\b|\bone\s+(?:way|approach|choice)\b|\bother\s+(?:ways|choices|approaches)\b|\bon\s+the\s+other\s+hand\b|\beither\b[^.]*\bor\b/i;
const LIST_RE = /^\s*(?:[-*•–]|\d+[.)]|\(\d+\))\s+\S/m;
// Fallback phrasing: "If they refuse, ...", "failing that", "plan B", "backup". At most one, and only when the Decision has one.
const FALLBACK_RE = /\bif\s+(?:that|this|it)\s+(?:doesn't|does\s+not|didn't|did\s+not|fails|won't|don't)(?:\s+work)?\b|\bif\s+(?:they|he|she)\s+(?:refuses?|declines?|says?\s+no|won't|can't|cannot|doesn't|does\s+not|do\s+not|don't|will\s+not|is\s+unable|isn't\s+able)\b|\bfailing\s+that\b|\bplan\s+b\b|\b(?:back-?up|fall-?back)\b|\bfall\s+back\b/gi;
// Claims that Neri (or anyone) already sent, paid, or applied something, or will. Neri only suggests.
const CLAIM_RE = /\b(?:i|we)(?:'ve|\s+have)?\s+(?:already\s+|just\s+)?(?:sent|paid|wired|transferred|submitted|applied|approved|scheduled|booked)\b|\b(?:i|we)(?:'ll|\s+will)\s+(?:send|pay|wire|transfer|apply|submit)\b|\bon\s+its\s+way\b|\balready\s+sent\b/i;
const ADVICE_RE = /\b(?:take\s+out\s+a\s+(?:bank\s+)?(?:loan|line\s+of\s+credit)|borrow(?:ing)?\s+(?:money|against|from)|(?:a|the)\s+(?:bank\s+)?loan\s+(?:would|could|to)|line\s+of\s+credit|invest(?:ing)?\s+(?:in|the|your)|put\s+(?:the\s+|your\s+)?cash\s+into|financing\s+(?:option|product|plan)|credit\s+card)\b/i;
// A named party's refusal ("If Harbor and Hearth refuses, ...") is also a fallback. Case-sensitive: the name is capitalized.
const NAMED_FALLBACK_RE = /\b[Ii]f\s+[A-Z][\w'&.-]*(?:\s+(?:and\s+|&\s+)?[A-Z][\w'&.-]*){0,3}\s+(?:refuses?|declines?|says?\s+no|won't|can't|cannot)\b/g;

const STANCE: Partial<Record<Decision["verdict"], { re: RegExp; word: string }>> = {
  yes: { re: /\byes\b/i, word: "Yes" },
  no: { re: /\bno\b/i, word: "No" },
  yes_if: { re: /\bif\b/i, word: "if (as in \"Yes, if ...\")" },
  act_now: { re: /\b(?:now|today)\b/i, word: "now" },
};

const MAX_HEADLINE_WORDS = 40;
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

// The recommendation's key fact must appear in the headline: its act-by date, up-front percentage, or cash
// effect (any one). A recommendation with none of these has nothing to require.
function keyFactProblem(headline: string, d: Decision): string | undefined {
  const r = d.recommendation;
  if (!r) return undefined;
  const keys: string[] = [];
  const checks: boolean[] = [];
  if (r.byDate) {
    keys.push(date(d, r.byDate));
    checks.push(extractDates(headline, { asOf: d.asOf }).some((x) => (x.alts ?? [x.date]).includes(r.byDate!)));
  }
  if (r.upfrontShare !== undefined) {
    const pct = Math.round(r.upfrontShare * 100);
    keys.push(`${pct}%`);
    checks.push(new RegExp(`(?<![\\d.])${pct}\\s?%`).test(headline));
  }
  if (r.cashEffect !== undefined) {
    keys.push(money(d, r.cashEffect));
    checks.push(extractAmounts(headline, { currency: d.currency }).some((a) => amountMatches(a, [r.cashEffect!], headline)));
  }
  return keys.length && !checks.some(Boolean)
    ? `the headline must contain the recommendation's key fact (${keys.join(", or ")})`
    : undefined;
}

// The headline must answer the question asked (d.lead) before anything else.
function leadProblem(headline: string, d: Decision): string | undefined {
  const l = d.lead;
  if (!l) return undefined;
  const has = (amount: number | undefined) =>
    amount !== undefined && extractAmounts(headline, { currency: d.currency }).some((a) => amountMatches(a, [amount], headline));
  if (l.kind === "can_pay" && l.pay) {
    const want = l.pay.answer === "no" ? /^\W*no\b/i : /^\W*yes\b/i;
    if (!want.test(headline)) return `the question was whether they can make it: the headline must open with "${l.pay.answer === "no" ? "No" : "Yes"}" and state ${money(d, l.pay.closing)} after the payment on ${date(d, l.pay.date)}`;
    if (!has(l.pay.closing)) return `the headline must state the cash after the payment (${money(d, l.pay.closing)})`;
  }
  if (l.kind === "short_before") {
    if (!/^\W*(?:not\s+yet|no)\b/i.test(headline)) return 'the question was whether they can afford it: the headline must open with "Not yet" (or "No"), because cash is already below the safety line without it';
    if (d.context.shortfall !== undefined && !has(d.context.shortfall)) return `the headline must say how far below the safety line cash already is (${money(d, d.context.shortfall)}) without it`;
  }
  if (l.kind === "effect" && !has(d.headlineFacts[0]?.amount)) {
    return `the headline must lead with the effect of the what-if: where the lowest point lands (${d.headlineFacts[0]?.amount !== undefined ? money(d, d.headlineFacts[0].amount) : "see headlineFacts"})`;
  }
  if (l.kind === "timing" && l.timing) {
    const n = Math.abs(l.timing.days);
    const ok = l.timing.days === 0 ? /\bdue\s+date\b|\bon\s+time\b/i.test(headline) : new RegExp(`(?<![\\d.])${n}\\s+days?\\b`, "i").test(headline);
    if (!ok) return `the headline must answer when they pay: state the typical lag (${l.timing.days === 0 ? "on the due date" : `${n} day${n === 1 ? "" : "s"} ${l.timing.days > 0 ? "late" : "early"}`}), then the open amount in the next sentence`;
  }
  if (l.kind === "tightest") {
    if (!has(d.headlineFacts[0]?.amount)) return "the headline must name the tightest week and the cash amount at its lowest point";
    if (l.weekStart && !extractDates(headline, { asOf: d.asOf }).some((x) => (x.alts ?? [x.date]).some((y) => y === l.weekStart || y === d.headlineFacts[0]?.date))) {
      return `the headline must name the tightest week (it starts ${date(d, l.weekStart)}) or its date`;
    }
  }
  return undefined;
}

// Everything wrong with the model's words, as plain sentences (they become the retry feedback).
export function checkVoice(v: CfoVoice, d: Decision): string[] {
  const problems: string[] = [];
  const text = voiceText(v);
  if (!v.headline.trim() || !v.why.trim() || !v.convictionNote.trim()) problems.push("headline, why, and convictionNote must not be empty");
  if (wordCount(v.headline) > MAX_HEADLINE_WORDS) problems.push(`the headline must be one short sentence (at most ${MAX_HEADLINE_WORDS} words)`);

  // The up-front share the headline states as a percent is always allowed, even if the builder left it out of numbers.
  const share = d.recommendation?.upfrontShare;
  const allowed = share === undefined ? d.allowed
    : { ...d.allowed, numbers: [...(d.allowed.numbers ?? []), { label: "up-front share", value: Math.round(share * 100), unit: "pct" as const }] };
  const r = checkText(text, d.citations, allowed, { currency: d.currency, asOf: d.asOf });
  for (const u of r.unmatched) problems.push(`${u.kind} "${u.raw}" is not in the facts`);
  for (const p of r.problems) problems.push(p);

  const menu = MENU_RE.exec(text);
  if (menu) problems.push(`menu language ("${menu[0].trim()}"): make the call and give one recommendation, never a list of options`);
  if (LIST_RE.test(text)) problems.push("no bulleted or numbered lists: write plain sentences");
  const fallbacks = (text.match(FALLBACK_RE)?.length ?? 0) + (text.match(NAMED_FALLBACK_RE)?.length ?? 0);
  if (fallbacks > (d.fallback ? 1 : 0)) {
    problems.push(d.fallback ? "at most one fallback, stated once" : "there is no fallback in the facts: do not invent one");
  }

  const lead = leadProblem(v.headline, d);
  if (lead) problems.push(lead);
  const stance = d.lead ? undefined : STANCE[d.verdict];
  if (stance && !stance.re.test(v.headline)) problems.push(`the headline must lead with the call: it should say "${stance.word}"`);
  if (v.whatWouldChange?.trim() && !d.whatWouldChange) problems.push("the facts name nothing that would change the call: leave whatWouldChange null");
  const key = d.lead?.kind === "effect" || d.lead?.kind === "tightest" ? undefined : keyFactProblem(v.headline, d);
  if (key) problems.push(key);

  const level = new RegExp(`\\b${d.conviction}\\s+confidence\\b`, "i");
  const others = (["high", "medium", "low"] as const).filter((l) => l !== d.conviction).some((l) => new RegExp(`\\b${l}\\s+confidence\\b`, "i").test(v.convictionNote));
  if (!level.test(v.convictionNote) || others) problems.push(`convictionNote must state "${cap(d.conviction)} confidence" (the level in the facts), and no other level`);

  if (CLAIM_RE.test(text)) problems.push("claims something was sent, paid, or applied; Neri only suggests, the owner acts");
  if (ADVICE_RE.test(text)) problems.push("no loan or investment advice");
  return problems;
}

const retryFeedback = (problems: string[]) =>
  `Your previous answer failed validation:\n${problems.map((p) => `- ${p}`).join("\n")}\n` +
  "Open with the call (the verdict and the one recommendation), use only the figures in the facts, give at most the one fallback in the facts, " +
  "no options or lists, state the confidence level from the facts, and claim nothing was sent or paid. Return the corrected answer in the same format.";

// ---------------------------------------------------------------------------
// Model call and cache

// Structured-output schema. Optional fields are nullable (as in ai/brief.ts); code maps null to absent.
const VoiceOutput = z.object({
  headline: z.string(),
  why: z.string(),
  nextStep: z.string().nullable(),
  convictionNote: z.string(),
  whatWouldChange: z.string().nullable(),
});
type VoiceOutput = z.infer<typeof VoiceOutput>;

const fromOutput = (o: VoiceOutput): CfoVoice => ({
  headline: o.headline, why: o.why, nextStep: o.nextStep ?? undefined, convictionNote: o.convictionNote,
  whatWouldChange: o.whatWouldChange ?? undefined,
});

// One entry per Decision: the prompt (text and version), model, business, and the facts block.
export function voiceCacheKey(d: Decision, ctx: Pick<VoiceContext, "profile" | "business" | "model">): string {
  return cacheKey({
    promptVersion: CFO_VOICE_PROMPT_VERSION, promptHash: sha(prompt("cfo_voice.md")), model: ctx.model ?? CFO_VOICE_MODEL,
    facts: facts(d, ctx.business.name, ctx.profile.vocabulary),
  });
}

const cacheDirs = (ctx: VoiceContext) => ({
  writeDir: ctx.cacheDir ?? LIVE_CACHE_DIR,
  readDirs: ctx.cacheDir ? [ctx.cacheDir] : [LIVE_CACHE_DIR, ASK_CACHE_DIR],
});

// Cached voices that fail the checks are skipped, so a stale or hand-edited entry never reaches the owner.
function cachedVoice(ctx: VoiceContext, key: string, d: Decision): CfoVoice | undefined {
  for (const dir of cacheDirs(ctx).readDirs) {
    const hit = readCache(dir, key);
    const parsed = hit ? VoiceOutput.safeParse(hit.output) : undefined;
    if (parsed?.success && checkVoice(fromOutput(parsed.data), d).length === 0) return fromOutput(parsed.data);
  }
  return undefined;
}

function storeVoice(ctx: VoiceContext, key: string, model: string, output: VoiceOutput): void {
  try {
    writeCache(cacheDirs(ctx).writeDir, { key, promptVersion: CFO_VOICE_PROMPT_VERSION, model, source: "live", output });
  } catch {
    // A failed cache write must not lose a good answer.
  }
}

// ---------------------------------------------------------------------------
// voice

// Never throws. need_info, decline, and proposed use the code-built voice (usedFallback is true: the words
// are code's, not the model's). Other verdicts: cached voice, else (live) one attempt and one retry with
// feedback, else the code-built voice.
export async function voice(decision: Decision, ctx: VoiceContext): Promise<CfoAnswer> {
  if (CODE_BUILT.has(decision.verdict)) return assemble(decision, clean(fallbackVoice(decision)), true, ctx);

  const model = ctx.model ?? CFO_VOICE_MODEL;
  const key = voiceCacheKey(decision, ctx);
  const hit = cachedVoice(ctx, key, decision);
  if (hit) return assemble(decision, clean(hit), false, ctx);

  if (ctx.mode === "live") {
    const turns: Turn[] = [{ role: "user", content: factsBlock(facts(decision, ctx.business.name, ctx.profile.vocabulary)) }];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await callStructured(ctx.client, model, prompt("cfo_voice.md"), turns, VoiceOutput, "low");
      const problems = "problem" in res ? [res.problem] : checkVoice(fromOutput(res.output), decision);
      if (!("problem" in res) && problems.length === 0) {
        storeVoice(ctx, key, model, res.output);
        return assemble(decision, clean(fromOutput(res.output)), false, ctx);
      }
      if ("problem" in res) break; // the call itself failed (timeout, refusal, outage): no second paid attempt
      turns.push({ role: "assistant", content: JSON.stringify(res.output) }, { role: "user", content: retryFeedback(problems) });
    }
  }
  return assemble(decision, clean(fallbackVoice(decision)), true, ctx);
}
