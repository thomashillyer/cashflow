// Ask Neri, step 1 (P4.19, docs/design/08-claude-layer.md "Ask Neri: a CFO, not a menu"): read the owner's
// question into an AskIntent. Claude reads; code computes. The model returns an AskIntentRaw: a kind and
// verbatim phrases, nothing computed. Every phrase is checked against the question here, then code resolves
// the party, the commitment, the amount, the date or window (relative to asOf), the synthetic draft or the
// rule, and the slots the kind still needs (`unresolved`).
//
// The question is data. It goes only into a <question> block and the intent schema; no output field can
// express an action. A question that tries to instruct the system (`containsInstructions`) never yields a
// draft or a rule. readIntent never throws: when the question cannot be read (no cached answer in demo
// mode, a failed or refused call) it returns kind "out_of_scope" with the reason in `unresolved`.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import type { AskIntent, AskIntentKind, AskIntentRaw } from "../../schema/ask";
import type { Profile } from "../../schema/profile";
import type { Commitment, CommitmentDraft, Records, Rule } from "../../schema/records";
import { INTENT_CACHE_DIR, cacheKey, LIVE_CACHE_DIR, readCache, writeCache } from "../cache";
import { fmtDate } from "../brief";
import { humanizeId } from "../labels";
import { ASK_LIVE_MODEL, INTENT_MODEL, INTENT_PROMPT_VERSION, anthropicOptions } from "../config";
import { parseAmount } from "../normalize";
import { resolveDatePhrase } from "../extract/signals";
import { nameSimilarity, resolveParty } from "../reconcile/parties";
import { normalizeRef } from "../reconcile/match";

// ---------------------------------------------------------------------------
// Model output schema

const nullableText = z.string().nullable();

export const AskIntentRawSchema = z.object({
  kind: z.enum(["afford", "fix_gap", "what_if", "status", "lookup", "tell", "out_of_scope"]),
  partyPhrase: nullableText,
  referencePhrase: nullableText,
  amountPhrase: nullableText,
  datePhrase: nullableText,
  windowPhrase: nullableText,
  commitmentType: z.enum(["invoice", "bill", "purchase_order", "sales_deal", "plan", "recurring"]).nullable(),
  direction: z.enum(["in", "out"]).nullable(),
  ruleKind: z.enum(["lag_offset", "flexibility", "preference"]).nullable(),
  ruleParamPhrase: nullableText,
  containsInstructions: z.boolean(),
}) satisfies z.ZodType<AskIntentRaw>;

const PHRASE_FIELDS = ["partyPhrase", "referencePhrase", "amountPhrase", "datePhrase", "windowPhrase", "ruleParamPhrase"] as const;

// ---------------------------------------------------------------------------
// Prompt, cache key, and the model call

const MODEL_TIMEOUT_MS = 30_000;
const MAX_QUESTION_CHARS = 2_000;

let promptText: string | undefined;
export function intentSystemPrompt(): string {
  promptText ??= readFileSync(join(import.meta.dirname, "../prompts/read_intent.md"), "utf8");
  return promptText;
}

// A question that contains a closing tag must not be able to end its own data block.
const escapeData = (text: string) => text.replace(/<(\/?)question/gi, "<\\$1question");

export const intentContent = (question: string): string => `<question>\n${escapeData(question)}\n</question>`;

// Keyed on the question with spacing and case normalized, so "can i afford ..." hits the same entry as
// "Can I afford ...". The model still receives the question as written.
export function intentCacheKey(question: string, model = INTENT_MODEL): string {
  const content = intentContent(squash(question));
  return cacheKey({
    promptVersion: INTENT_PROMPT_VERSION,
    promptHash: createHash("sha256").update(intentSystemPrompt()).digest("hex"), // editing the prompt invalidates the cache
    model,
    content,
  });
}

// One structured-output call. Returns the parsed output or a reason; never throws.
export async function callIntentModel(
  client: Anthropic | undefined, content: string, model: string,
): Promise<{ output: AskIntentRaw } | { problem: string }> {
  try {
    client ??= new Anthropic(anthropicOptions()); // configured from ANTHROPIC_API_KEY
    const res = await client.messages.create(
      {
        model,
        max_tokens: 16000, // headroom for default-on thinking, as in document.ts
        system: [{ type: "text", text: intentSystemPrompt(), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content }],
        output_config: { effort: "low", format: zodOutputFormat(AskIntentRawSchema) },
      },
      { timeout: MODEL_TIMEOUT_MS, maxRetries: 1 },
    );
    if (res.stop_reason === "refusal") return { problem: "the model declined to read this question" };
    if (res.stop_reason === "max_tokens") return { problem: "the model's answer was cut off before it finished" };
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text" || block.text.trim() === "") return { problem: "the model returned no structured answer" };
    let json: unknown;
    try {
      json = JSON.parse(block.text);
    } catch {
      return { problem: "the model's answer was not valid JSON" };
    }
    const parsed = AskIntentRawSchema.safeParse(json);
    if (!parsed.success) return { problem: "the model's answer did not match the intent schema" };
    return { output: parsed.data };
  } catch (err) {
    // The owner sees the problem text (it becomes the decline reason); the SDK's error stays in the log.
    console.error(`[ask] intent call failed: ${err instanceof Error ? err.message : String(err)}`);
    return { problem: "the model couldn't be reached" };
  }
}

// ---------------------------------------------------------------------------
// Calendar helpers (UTC on calendar dates)

const DAY_MS = 86_400_000;
const toMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => fromMs(toMs(iso) + n * DAY_MS);
const isoDate = (y: number, m: number, d: number): string | undefined => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return fromMs(dt.getTime());
};
const lastDayOfMonth = (y: number, m: number) => fromMs(Date.UTC(y, m, 0));
const maxIso = (a: string, b: string) => (a > b ? a : b);

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9,
  october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE = Object.keys(MONTHS).join("|");
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, sixty: 60, ninety: 90,
};
const NUM_RE = `\\d+|${Object.keys(NUMBER_WORDS).join("|")}`;
const toNumber = (w: string) => (/^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w]);

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
// Lower-cased, trimmed of trailing punctuation, with leading filler prepositions removed.
function phraseCore(phrase: string): { text: string; startish: boolean } {
  let p = squash(phrase).replace(/[.,;!?]+$/, "");
  let startish = false;
  for (;;) {
    const next = p.replace(/^(?:in|during|for|over|within|through|throughout|by|on|until|before|after|from|starting|starts|beginning|since|the|my)\s+/, "");
    if (next === p) break;
    if (/^(?:from|starting|starts|beginning|since)\s/.test(p)) startish = true;
    p = next;
  }
  return { text: p, startish };
}

// ---------------------------------------------------------------------------
// Dates and windows

export type ResolveCtx = { asOf: string; timeZone: string };

export type ResolvedAskDate = { date: string; vague?: string };

// Dates the shared resolver does not read: a bare month ("in December": the end of that month, or its
// start for a start phrase ("from March") and for something that repeats), "this/next month", and a day of
// the month ("on the 11th": its next occurrence on or after asOf). Everything else is resolveDatePhrase.
// A date already past is clamped to asOf. Returns undefined for a phrase it cannot read.
export function resolveAskDate(phrase: string, ctx: ResolveCtx, opts: { startOfPeriod?: boolean } = {}): ResolvedAskDate | undefined {
  const { text, startish } = phraseCore(phrase);
  const start = startish || opts.startOfPeriod === true;
  const [ty, tm] = [Number(ctx.asOf.slice(0, 4)), Number(ctx.asOf.slice(5, 7))];

  let m = new RegExp(`^(?:(this|next) )?(?:(${MONTH_RE})|(month))(?: (\\d{4}))?$`).exec(text);
  if (m) {
    let month: number;
    let year: number;
    if (m[2]) {
      month = MONTHS[m[2]]!;
      year = m[4] ? Number(m[4]) : month >= tm ? ty : ty + 1;
    } else {
      month = tm + (m[1] === "next" ? 1 : 0);
      year = ty + (month > 12 ? 1 : 0);
      month = month > 12 ? month - 12 : month;
    }
    const d = start ? isoDate(year, month, 1)! : lastDayOfMonth(year, month);
    return { date: maxIso(d, ctx.asOf), vague: phrase.trim() };
  }

  m = /^(\d{1,2})(?:st|nd|rd|th)(?: of (?:the |this )?month)?$/.exec(text);
  if (m) {
    const day = Number(m[1]);
    for (let i = 0; i < 14; i++) {
      const mm = tm - 1 + i;
      const d = isoDate(ty + Math.floor(mm / 12), (mm % 12) + 1, day);
      if (d && d >= ctx.asOf) return { date: d };
    }
    return undefined;
  }

  // The shared resolver reads asOf as the day a message arrived; noon UTC is that calendar date in any
  // business time zone from UTC-11 to UTC+11.
  const at = `${ctx.asOf}T12:00:00Z`;
  // The phrase as written first ("in 3 weeks" needs its "in"), then without its leading preposition.
  let r = resolveDatePhrase(phrase, at, ctx.timeZone);
  if (!r.date) r = resolveDatePhrase(text, at, ctx.timeZone);
  if (!r.date) return undefined;
  return { date: r.date, ...(r.vague ? { vague: phrase.trim() } : {}) };
}

// A span of time ("this month", "next six weeks", "December"), clamped to start no earlier than asOf.
// Returns undefined for a phrase that names no span ("my tightest week").
export function resolveAskWindow(phrase: string, ctx: ResolveCtx): { from: string; to: string } | undefined {
  const { text } = phraseCore(phrase);
  const [ty, tm] = [Number(ctx.asOf.slice(0, 4)), Number(ctx.asOf.slice(5, 7))];
  const clip = (from: string, to: string) => (to < ctx.asOf ? undefined : { from: maxIso(from, ctx.asOf), to });
  const month = (y: number, mo: number) => {
    const yy = y + Math.floor((mo - 1) / 12);
    const mm = ((mo - 1) % 12) + 1;
    return clip(isoDate(yy, mm, 1)!, lastDayOfMonth(yy, mm));
  };

  let m = new RegExp(`^(?:(this|next|current) )?(?:(${MONTH_RE})|(month))(?: (\\d{4}))?$`).exec(text);
  if (m) {
    if (m[2]) {
      const mo = MONTHS[m[2]]!;
      return month(m[4] ? Number(m[4]) : mo >= tm ? ty : ty + 1, mo);
    }
    return month(ty, tm + (m[1] === "next" ? 1 : 0));
  }
  const weekday = new Date(toMs(ctx.asOf)).getUTCDay(); // 0 = Sunday
  const toSunday = (weekday + 6) % 7; // days since Monday
  if (/^(?:this|current) week$/.test(text)) return { from: ctx.asOf, to: addDays(ctx.asOf, 6 - toSunday) };
  if (text === "next week") return { from: addDays(ctx.asOf, 7 - toSunday), to: addDays(ctx.asOf, 13 - toSunday) };

  m = new RegExp(`^(?:next|coming|following|upcoming)(?: (${NUM_RE}))? (day|days|week|weeks|month|months)$`).exec(text);
  if (m) {
    const n = m[1] ? toNumber(m[1])! : 1;
    const unit = m[2]!;
    if (unit.startsWith("day")) return { from: ctx.asOf, to: addDays(ctx.asOf, n) };
    if (unit.startsWith("week")) return { from: ctx.asOf, to: addDays(ctx.asOf, 7 * n) };
    const end = tm - 1 + n;
    return { from: ctx.asOf, to: isoDate(ty + Math.floor(end / 12), (end % 12) + 1, Number(ctx.asOf.slice(8, 10))) ?? lastDayOfMonth(ty + Math.floor(end / 12), (end % 12) + 1) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Amounts

const SYMBOL_CURRENCY: Record<string, string> = { "€": "EUR", "£": "GBP", "₹": "INR" };
const DOLLAR_FAMILY = new Set(["USD", "CAD", "AUD", "NZD", "SGD", "HKD", "MXN"]);
const MULTIPLIER: Record<string, number> = {
  k: 1_000, grand: 1_000, thousand: 1_000, m: 1_000_000, mm: 1_000_000, mil: 1_000_000, million: 1_000_000, lakh: 100_000,
};
const KNOWN_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

export type ReadAmount = { amount: number; currency: string; currencyAssumed: boolean };

// "$40K", "about 6 grand a month", "₹200,000", "USD 12,500" -> integer minor units. A phrase with no
// currency marker takes the base currency (currencyAssumed). Returns undefined for anything it cannot read.
export function readAmountPhrase(phrase: string, baseCurrency: string): ReadAmount | undefined {
  let currency: string | undefined;
  const code = [...phrase.matchAll(/\b[A-Z]{3}\b/g)].map((x) => x[0]).find((c) => KNOWN_CURRENCIES.has(c));
  if (code) currency = code;
  else if (phrase.includes("$")) currency = DOLLAR_FAMILY.has(baseCurrency) ? baseCurrency : "USD";
  else {
    const sym = Object.keys(SYMBOL_CURRENCY).find((s) => phrase.includes(s));
    if (sym) currency = SYMBOL_CURRENCY[sym];
  }
  const m = /(\d[\d,.]*\d|\d)\s*(thousand|million|grand|lakh|mm|mil|k|m)?(?![a-z])/i.exec(phrase);
  if (!m) return undefined;
  const cur = currency ?? baseCurrency;
  const minor = parseAmount(m[1]!, cur);
  if (minor === undefined || minor <= 0) return undefined;
  const amount = minor * (m[2] ? MULTIPLIER[m[2].toLowerCase()]! : 1);
  if (!Number.isSafeInteger(amount)) return undefined;
  return { amount, currency: cur, currencyAssumed: currency === undefined };
}

// ---------------------------------------------------------------------------
// Parties and commitments

// Generic nouns that name a role, not the party ("the Harbor folks", "Jaipur's invoice").
const FILLER_WORDS = /\b(?:folks|guys|people|team|crowd|order|orders|invoice|invoices|bill|bills|customer|supplier|vendor|client)\b/gi;

type PartyResult = { partyId: string } | { problem: string };

function findParty(phrase: string, parties: Records["parties"]): PartyResult {
  const name = phrase.replace(/['’]s\b/g, "").replace(FILLER_WORDS, " ").replace(/\s+/g, " ").trim();
  if (!name) return { problem: `Which customer or supplier is "${phrase}"?` };
  const confirmed = resolveParty({ name }, parties);
  // resolveParty never confirms by name alone; an unambiguous strong name match is accepted here because
  // the owner typed the name themselves (a message sender would not be).
  const scored = parties
    .map((p) => ({ p, score: Math.max(nameSimilarity(name, p.name), ...(p.aliases ?? []).map((a) => nameSimilarity(name, a))) }))
    .filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  if ("partyId" in confirmed) return { partyId: confirmed.partyId };
  const top = scored[0];
  if (!top) return { problem: `I don't have a customer or supplier called "${phrase}". Which one do you mean?` };
  const tied = scored.filter((s) => s.score === top.score);
  if (top.score >= 0.8 && tied.length === 1) return { partyId: top.p.id };
  return { problem: `Which one do you mean: ${scored.slice(0, 4).map((s) => s.p.name).join(", ")}?` };
}

const isOpen = (c: Commitment) =>
  (c.settlement === undefined || c.settlement === "open" || c.settlement === "partial") && (c.outstanding ?? c.amount) > 0;

// A document number in a phrase: a token with a digit ("INV-1187", "PO 2291").
const REF_TOKEN = /[A-Za-z]{1,6}[- ]?\d[\w-]*|\d[\w-]*\d/g;

// ---------------------------------------------------------------------------
// Relative delays ("two weeks later than expected", "a fortnight late", "late by 10 days")

const DELAY_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
};
const DELAY_UNIT_DAYS: Record<string, number> = { day: 1, week: 7, fortnight: 14, month: 30 };
const DELAY_QTY = `(\\d+|${Object.keys(DELAY_NUMBERS).join("|")})`;
const DELAY_UNIT = "(day|week|fortnight|month)s?";
const LATE_WORDS = "(late|later|delayed|behind|early|earlier|sooner|ahead)";
const delaySign = (w: string) => (/^(?:early|earlier|sooner|ahead)$/.test(w) ? -1 : 1);

// A relative delay as a signed number of days: + for late, - for early. Returns undefined when the phrase
// is not a relative delay ("in early January", "in 3 weeks", "December"). Pure; the caller applies the shift.
export function parseRelativeDelay(phrase: string): number | undefined {
  const t = squash(phrase).replace(/-/g, " ").replace(/[.,;!?]+$/, "");
  const qty = (w: string) => (/^\d+$/.test(w) ? Number(w) : DELAY_NUMBERS[w]);
  // "late by 10 days", "delayed by two weeks", "early by a week"
  let m = new RegExp(`\\b(late|delayed|early)\\s+by\\s+${DELAY_QTY}\\s+${DELAY_UNIT}\\b`).exec(t);
  if (m) return delaySign(m[1]!) * qty(m[2]!)! * DELAY_UNIT_DAYS[m[3]!]!;
  // "two weeks later than expected", "10 days late", "a week early", "a fortnight late"
  m = new RegExp(`\\b${DELAY_QTY}\\s+${DELAY_UNIT}\\s+${LATE_WORDS}\\b`).exec(t);
  if (m) return delaySign(m[3]!) * qty(m[1]!)! * DELAY_UNIT_DAYS[m[2]!]!;
  m = new RegExp(`\\bfortnight\\s+${LATE_WORDS}\\b`).exec(t);
  if (m) return delaySign(m[1]!) * 14;
  return undefined;
}

// ---------------------------------------------------------------------------
// Rules

const parseDayCount = (phrase: string): { days: number; early: boolean } | undefined => {
  const m = new RegExp(`\\b(${NUM_RE}|\\d+(?:\\.\\d+)?)\\s*(?:-\\s*)?(?:more |extra |additional )?(day|days|week|weeks)\\b`, "i").exec(phrase);
  if (!m) return undefined;
  const n = /^\d+(?:\.\d+)?$/.test(m[1]!) ? Number(m[1]) : NUMBER_WORDS[m[1]!.toLowerCase()];
  if (n === undefined) return undefined;
  const days = n * (m[2]!.toLowerCase().startsWith("week") ? 7 : 1);
  if (!Number.isInteger(days) || days < 1) return undefined;
  return { days, early: /\b(?:early|earlier|ahead|sooner|before)\b/i.test(phrase) };
};

// ---------------------------------------------------------------------------
// Drafts

export const DRAFT_CADENCE_PREFIX = "cadence:";
type Cadence = "weekly" | "biweekly" | "semimonthly" | "monthly" | "quarterly";

// The id the decision step gives a synthetic commitment or recurring item built from this question.
export const askDraftId = (question: string): string => `ask-draft-${createHash("sha256").update(question).digest("hex").slice(0, 12)}`;

// A recurring draft carries its cadence in `category` ("cadence:monthly"); the decision engine turns the
// draft into a profile `recurring` item. Returns undefined for any other draft.
export function draftCadence(draft: CommitmentDraft): Cadence | undefined {
  const c = draft.category?.startsWith(DRAFT_CADENCE_PREFIX) ? draft.category.slice(DRAFT_CADENCE_PREFIX.length) : undefined;
  return draft.type === "recurring" && c && ["weekly", "biweekly", "semimonthly", "monthly", "quarterly"].includes(c) ? (c as Cadence) : undefined;
}

// The cadence the owner wrote ("$6K a month", "every two weeks"), or undefined when none is stated.
function statedCadence(question: string): Cadence | undefined {
  const q = squash(question);
  if (/\b(?:twice a month|semi-?monthly)\b/.test(q)) return "semimonthly";
  if (/\b(?:bi-?weekly|fortnightly|every (?:two|2) weeks)\b/.test(q)) return "biweekly";
  if (/\b(?:quarterly|(?:a|per|each|every) quarter)\b/.test(q)) return "quarterly";
  if (/\b(?:weekly|(?:a|per|each|every) week)\b/.test(q)) return "weekly";
  if (/\b(?:monthly|(?:a|per|each|every) month)\b/.test(q)) return "monthly";
  return undefined;
}

// ---------------------------------------------------------------------------
// resolveIntent: AskIntentRaw -> AskIntent (pure)

export type ResolveIntentContext = {
  records: Records;
  profile: Profile;
  asOf: string;                // YYYY-MM-DD; "today" for every relative phrase
  timeZone?: string;           // business time zone for relative dates; default America/Los_Angeles
};

const DEFAULT_TZ = "America/Los_Angeles";
const DEFAULT_DAYS_OUT = 30; // an afford or plan with no date: 30 days out (docs/design/08-claude-layer.md, Required slots)
const NEW_TYPES = new Set(["plan", "recurring"]);

export function resolveIntent(question: string, raw: AskIntentRaw, ctx: ResolveIntentContext): AskIntent {
  const { records, profile, asOf } = ctx;
  const rc: ResolveCtx = { asOf, timeZone: ctx.timeZone ?? DEFAULT_TZ };
  const intent: AskIntent = { kind: raw.kind, question, raw, unresolved: [] };
  if (raw.kind === "out_of_scope") return intent;

  const need = (q: string) => { if (!intent.unresolved.includes(q)) intent.unresolved.push(q); };
  // An instruction in the question never becomes a draft or a rule.
  const instructed = raw.containsInstructions;
  if (instructed && raw.kind === "tell") intent.kind = "out_of_scope"; // nothing but the instruction remains
  if (intent.kind === "out_of_scope") return intent;
  const kind: AskIntentKind = intent.kind;

  // ---- party
  let partyId: string | undefined;
  if (raw.partyPhrase) {
    const r = findParty(raw.partyPhrase, records.parties);
    if ("partyId" in r) partyId = r.partyId; else need(r.problem);
  }
  const partyUnknown = raw.partyPhrase !== null && partyId === undefined;
  const party = partyId ? records.parties.find((p) => p.id === partyId) : undefined;

  // ---- an existing commitment the question names
  const refToken = raw.referencePhrase ? raw.referencePhrase.match(REF_TOKEN)?.find((t) => /\d/.test(t)) : undefined;
  const wantsExisting =
    (kind === "afford" || kind === "what_if" || kind === "lookup" || kind === "fix_gap") &&
    (refToken !== undefined ||
      ((kind === "afford" || kind === "what_if") && raw.amountPhrase === null && !NEW_TYPES.has(raw.commitmentType ?? "") &&
        (partyId !== undefined || raw.referencePhrase !== null || raw.commitmentType !== null)));
  let commitmentId: string | undefined;
  let matches: Commitment[] = [];
  if (wantsExisting && !partyUnknown) {
    let pool = records.commitments.filter(isOpen);
    if (refToken) {
      const hits = pool.filter((c) => c.reference !== undefined && normalizeRef(c.reference) === normalizeRef(refToken));
      if (hits.length === 0) need(`I can't find ${refToken} among your open invoices, bills, and orders. Which one do you mean?`);
      pool = partyId ? hits.filter((c) => c.partyId === partyId) : hits;
      if (partyId && hits.length && pool.length === 0) need(`${refToken} belongs to a different customer or supplier than the one you named. Which one do you mean?`);
      matches = pool;
    } else if (partyId) {
      pool = pool.filter((c) => c.partyId === partyId);
      const typed = raw.commitmentType ? pool.filter((c) => c.type === raw.commitmentType) : pool;
      matches = typed;
    }
    if (matches.length === 1) commitmentId = matches[0]!.id;
  }
  const matched = commitmentId ? records.commitments.find((c) => c.id === commitmentId) : undefined;
  if (!partyId && matched?.partyId && !partyUnknown) partyId = matched.partyId;
  if (partyId) intent.partyId = partyId;
  if (commitmentId) intent.commitmentId = commitmentId;

  // ---- amount
  const amount = raw.amountPhrase ? readAmountPhrase(raw.amountPhrase, profile.baseCurrency) : undefined;
  if (raw.amountPhrase && !amount) need(`I couldn't read the amount "${raw.amountPhrase}". How much is it?`);

  // ---- window, then date
  // fix_gap and status read a named period ("December") from either phrase; it is a window, not a date.
  const periodKind = kind === "fix_gap" || kind === "status";
  // A what_if that moves payment by a relative delay is a shift, not a date or a window: the model carries the
  // words in datePhrase (or windowPhrase) and code reads the number of days.
  let shiftDays: number | undefined;
  if (kind === "what_if") {
    for (const p of [raw.datePhrase, raw.windowPhrase]) {
      const d = p ? parseRelativeDelay(p) : undefined;
      if (d !== undefined && d !== 0) { shiftDays = d; break; }
    }
    if (shiftDays !== undefined) intent.shiftDays = shiftDays;
  }
  const windowSource = shiftDays !== undefined ? null : raw.windowPhrase ?? (periodKind && raw.datePhrase && resolveAskWindow(raw.datePhrase, rc) ? raw.datePhrase : null);
  if (windowSource) {
    const horizonEnd = addDays(asOf, profile.horizonWeeks * 7 - 1);
    intent.window = resolveAskWindow(windowSource, rc) ?? { from: asOf, to: horizonEnd }; // "my tightest week": the whole horizon
  }
  const datePhrase = shiftDays !== undefined || windowSource === raw.datePhrase ? null : raw.datePhrase;
  const startOfPeriod = raw.commitmentType === "recurring";
  const resolved = datePhrase ? resolveAskDate(datePhrase, rc, { startOfPeriod }) : undefined;
  if (resolved) {
    intent.date = resolved.date;
    if (resolved.vague) intent.dateVague = resolved.vague;
  }

  // ---- tell (rule)
  const isRule = kind === "tell" && raw.ruleKind !== null && !instructed;
  if (isRule) {
    if (!partyId && !partyUnknown) need("Which customer or supplier is this about?");
    const phrase = raw.ruleParamPhrase ?? "";
    let params: Record<string, unknown> | undefined;
    if (raw.ruleKind === "lag_offset") {
      const d = parseDayCount(phrase);
      if (d) params = { offsetDays: d.early ? -d.days : d.days };
      else need("How many days late (or early) do they usually pay?");
    } else if (raw.ruleKind === "flexibility") {
      const d = parseDayCount(phrase);
      if (d) params = { extraDays: d.days };
      else need("How many extra days do they give you?");
    } else {
      const tags = Object.keys(profile.thresholds.relationshipPenalty);
      const tag = tags.find((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(phrase));
      if (tag) params = { tag };
      else need(`How should I mark them: ${tags.join(", ")}?`);
    }
    if (partyId && params) {
      const rule: Omit<Rule, "id" | "state"> = { scope: { partyId }, kind: raw.ruleKind!, params, fromNote: question };
      intent.rule = rule;
    }
  }

  // ---- synthetic draft (afford, what_if, tell plan) when no existing commitment is named
  const draftKind = kind === "afford" || kind === "what_if" || (kind === "tell" && !isRule);
  if (draftKind && !instructed && !commitmentId && amount) {
    const type = raw.commitmentType;
    const direction =
      type === "sales_deal" ? "in"
        : type === "plan" ? "out" // an outbound plan; a model slip must never turn a payment into an inflow
        : type === "recurring" ? raw.direction ?? "out"
          : raw.direction ?? (party?.kind === "customer" ? "in" : party?.kind === "supplier" ? "out" : "out");
    const date = intent.date ?? addDays(asOf, DEFAULT_DAYS_OUT);
    const base = {
      ...(partyId ? { partyId } : {}),
      amount: amount.amount,
      currency: amount.currency,
      status: "likely" as const,
      sourceRef: { system: "owner", record: askDraftId(question) },
    };
    let draft: CommitmentDraft;
    if (type === "recurring") {
      draft = { ...base, type: "recurring", direction, category: `${DRAFT_CADENCE_PREFIX}${statedCadence(question) ?? "monthly"}`, anchors: { due: date } };
    } else if (direction === "in" && (type === "sales_deal" || type === null)) {
      draft = { ...base, type: "sales_deal", direction: "in", anchors: { order: date } };
    } else {
      // A deposit, a purchase, or any other hypothetical payment: an outbound plan due on the date.
      draft = { ...base, type: "plan", direction, anchors: { due: date } };
    }
    intent.draft = draft;
    if (!intent.date) intent.date = date;
  }

  // ---- required slots (docs/design/08-claude-layer.md)
  // A date the owner wrote but we cannot read is asked about, never replaced by the default silently.
  if ((kind === "afford" || kind === "tell") && raw.datePhrase && !resolved && !windowSource) {
    need(`I couldn't read the date "${raw.datePhrase}". When would it happen?`);
  }
  if (kind === "afford" && !intent.draft && !commitmentId) {
    if (matches.length > 1) need(`Which one do you mean: ${matches.map((c) => c.reference ?? humanizeId(c.id)).join(", ")}?`);
    else if (!raw.amountPhrase && !partyUnknown) need("How much is it?");
    else if (instructed) need("I set aside the instruction in that message. Ask the question again without it.");
  }
  if (kind === "what_if") {
    if (!commitmentId && !intent.draft && matches.length > 1 && shiftDays === undefined) need(`Which one do you mean: ${matches.map((c) => c.reference ?? humanizeId(c.id)).join(", ")}?`);
    if (!partyId && !commitmentId && !intent.draft && !partyUnknown) {
      need(raw.amountPhrase && !amount ? "How much is it?" : "Which customer, supplier, or order does this apply to?");
    }
    if (!intent.date && shiftDays === undefined) need(raw.datePhrase ? `I couldn't read the date "${raw.datePhrase}". When would it happen?` : "When would this happen?");
  }
  if (kind === "lookup" && refToken && !commitmentId && matches.length > 1) need(`Which one do you mean: ${matches.map((c) => c.reference ?? humanizeId(c.id)).join(", ")}?`);
  if (kind === "lookup" && !partyId && !commitmentId && !partyUnknown) need("Which customer or supplier?");
  if (kind === "tell" && !isRule && !instructed && !intent.draft && !partyUnknown && !raw.amountPhrase) need("How much is it?");

  return intent;
}

// What code assumed on the owner's behalf for this intent, in plain words for `Decision.assumptions`.
// Derived from the question's own phrases, so it is the same on every call.
export function intentAssumptions(intent: AskIntent, ctx: { profile: Profile; asOf: string }): string[] {
  const out: string[] = [];
  const { raw, draft } = intent;
  if (draft && raw.amountPhrase) {
    const a = readAmountPhrase(raw.amountPhrase, ctx.profile.baseCurrency);
    if (a?.currencyAssumed) out.push(`assumed ${a.currency} for "${raw.amountPhrase}"`);
  }
  if (intent.date && intent.dateVague) out.push(`assumed ${fmtDate(intent.date, ctx.asOf)} for "${intent.dateVague}"`);
  else if (draft && intent.date && !raw.datePhrase) out.push(`no date given; assumed ${fmtDate(intent.date, ctx.asOf)}, ${DEFAULT_DAYS_OUT} days out`);
  if (draft && draft.currency !== ctx.profile.baseCurrency) out.push(`amount stated in ${draft.currency}, not ${ctx.profile.baseCurrency}; converted at the run's rate`);
  if (draft?.type === "sales_deal") out.push("linked costs unknown");
  if (draft?.type === "recurring" && !statedCadence(intent.question)) out.push("assumed monthly");
  return out;
}

// ---------------------------------------------------------------------------
// readIntent: sanitize, cache, then (live mode only) the model

export type ReadIntentContext = ResolveIntentContext & {
  mode: "live" | "cache_only";
  client?: Anthropic;          // live mode; defaults to a client configured from ANTHROPIC_API_KEY
  // Read and write directory. Default: reads LIVE_CACHE_DIR (gitignored) then the committed demo cache
  // (INTENT_CACHE_DIR); live results are written to LIVE_CACHE_DIR, never to the fixtures.
  cacheDir?: string;
  model?: string;              // the recorded model the cache lookup is keyed on (default INTENT_MODEL)
  liveModel?: string;          // the model a live call on a miss uses (default ASK_LIVE_MODEL); its answer is stored under its own key
};

// A phrase the model reports must be words the owner wrote.
export function sanitizeRaw(raw: AskIntentRaw, question: string): AskIntentRaw {
  const q = squash(question);
  const out = { ...raw };
  for (const f of PHRASE_FIELDS) {
    const v = out[f];
    if (v !== null && (v.trim() === "" || !q.includes(squash(v)))) out[f] = null;
  }
  return out;
}

const NULL_RAW: AskIntentRaw = {
  kind: "out_of_scope", partyPhrase: null, referencePhrase: null, amountPhrase: null, datePhrase: null, windowPhrase: null,
  commitmentType: null, direction: null, ruleKind: null, ruleParamPhrase: null, containsInstructions: false,
};

// The intent when the question could not be read at all: nothing is resolved, and `unresolved` says why.
const unreadable = (question: string, why: string): AskIntent => ({ kind: "out_of_scope", question, raw: NULL_RAW, unresolved: [why] });

export async function readIntent(question: string, ctx: ReadIntentContext): Promise<AskIntent> {
  try {
    if (typeof question !== "string" || question.trim() === "") return unreadable(String(question ?? ""), "Ask a question about your cash.");
    if (question.length > MAX_QUESTION_CHARS) return unreadable(question, "That question is too long. Ask it in a sentence or two.");
    const model = ctx.model ?? INTENT_MODEL;
    const content = intentContent(question);
    const liveModel = ctx.liveModel ?? ASK_LIVE_MODEL;
    const key = intentCacheKey(question, model);
    const liveKey = intentCacheKey(question, liveModel); // where a live answer is stored; read back too
    const writeDir = ctx.cacheDir ?? LIVE_CACHE_DIR;
    const readDirs = ctx.cacheDir ? [ctx.cacheDir] : [LIVE_CACHE_DIR, INTENT_CACHE_DIR];

    let raw: AskIntentRaw | undefined;
    for (const k of new Set([key, liveKey])) {
      for (const dir of readDirs) {
        const hit = readCache(dir, k);
        const parsed = hit ? AskIntentRawSchema.safeParse(hit.output) : undefined;
        if (parsed?.success) { raw = parsed.data; break; }
        // A cache entry that no longer fits the schema is a miss.
      }
      if (raw) break;
    }
    if (!raw) {
      if (ctx.mode === "cache_only") return unreadable(question, "I can't read that question right now (demo mode has no saved answer for it). Try one of the example questions.");
      const result = await callIntentModel(ctx.client, content, liveModel);
      if ("problem" in result) return unreadable(question, `I couldn't read that question: ${result.problem}. Try asking it again.`);
      raw = result.output;
      try {
        writeCache(writeDir, { key: liveKey, promptVersion: INTENT_PROMPT_VERSION, model: liveModel, source: "live", output: raw });
      } catch {
        // A failed cache write must not lose a good reading.
      }
    }
    return resolveIntent(question, sanitizeRaw(raw, question), ctx);
  } catch (err) {
    console.error(`[ask] readIntent failed: ${err instanceof Error ? err.message : String(err)}`);
    return unreadable(String(question), "I couldn't read that question. Try asking it again.");
  }
}
