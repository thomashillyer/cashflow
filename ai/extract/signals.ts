// Layer 1, signal extraction (P4.7, docs/design/06-signals.md): read a message for payment promises and
// date changes and turn it into a proposed Signal. Claude reads; code computes. Everything the model
// returns is checked here: quotes are located in the message, relative dates are resolved in code against
// the message's receivedAt, and the commitment match is plain code.
//
// Pipeline per message: triage (code) -> cached or live structured-output call -> toSignal (code).
// Message text is data. It goes only into <message>/<conversation> tags and the extraction schema; no
// output field can express settlement, payment, or any action. A Signal starts "proposed", always, and
// changes nothing until the owner confirms it.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import type { Commitment, Records, Signal, SignalClaim } from "../../schema/records";
import { cacheKey, DEFAULT_CACHE_DIR, LIVE_CACHE_DIR, readCache, writeCache } from "../cache";
import { EXTRACTION_MODEL, SIGNAL_PROMPT_VERSION, anthropicOptions } from "../config";
import { locateQuote, parseAmount, parseDate } from "../normalize";
import { humanizeId } from "../labels";
import { resolveParty, type PartyHint } from "../reconcile/parties";
import type { BundleMessage, MessageBundle } from "./message";

// ---------------------------------------------------------------------------
// Model output schema

const Quoted = z.object({ value: z.string(), quote: z.string() }).nullable();
type Quoted = z.infer<typeof Quoted>;

export const SignalExtraction = z.object({
  claim: z.enum(["date_change", "amount_change", "cancel", "new_commitment", "plan", "none"]),
  reference: Quoted,
  partyName: Quoted,
  amountMentioned: Quoted,
  newDatePhrase: Quoted,
  newAmount: Quoted,
  dependsOn: z.string().nullable(),
  containsInstructions: z.boolean(),
  confidence: z.number(),
});
export type SignalExtraction = z.infer<typeof SignalExtraction>;

// ---------------------------------------------------------------------------
// Triage (code, no model): a message with no payment, date, amount, or order words cannot be a signal.

const MONTH_WORDS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec";
const WEEKDAY_WORDS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri";
const TRIAGE_RE = new RegExp(
  [
    String.raw`\b(?:pay|pays|paying|paid|payment|payments|payable|invoice|invoices|inv|bill|po|p\.o|order|orders|deposit|balance|owe|owed|refund)\b`,
    String.raw`\b(?:delay|delayed|delays|late|overdue|due|wire|wired|transfer|transferred|ship|shipped|shipping|shipment|deliver|delivery|cancel|cancelled|canceled)\b`,
    String.raw`\b(?:today|tomorrow|tonight|next|week|weeks|month|months|early|mid|end of)\b`,
    String.raw`\b(?:${MONTH_WORDS}|${WEEKDAY_WORDS})\b`,
    String.raw`[$€£]\s?\d`,
    String.raw`\b\d[\d,.]*\s?(?:k|usd|cad|eur|gbp|dollars)\b`,
    String.raw`\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b`,
    String.raw`\b\d{1,2}(?:st|nd|rd|th)\b`,
  ].join("|"),
  "i",
);

// True when the text mentions payment, dates, amounts, or orders. A cheap pre-filter, deliberately loose.
export function passesTriage(text: string): boolean {
  return TRIAGE_RE.test(text);
}

// ---------------------------------------------------------------------------
// Relative dates, resolved in code. All math is UTC on calendar dates.

export type ResolvedDate = {
  date?: string;             // YYYY-MM-DD
  vague?: string;            // set when `date` is only a suggestion; the phrase as written
  requiresOwnerDate?: true;  // the owner must confirm or replace the suggested date
};

const DAY_MS = 86_400_000;
const toMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => fromMs(toMs(iso) + n * DAY_MS);
const weekdayOf = (iso: string) => new Date(toMs(iso)).getUTCDay(); // 0 = Sunday
const lastDayOfMonth = (y: number, m: number) => fromMs(Date.UTC(y, m, 0));
const isoDate = (y: number, m: number, d: number): string | undefined => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return fromMs(dt.getTime());
};

// The calendar date of an instant in the business time zone.
function localDate(instant: string, timeZone: string): string | undefined {
  const t = Date.parse(instant);
  if (!Number.isFinite(t)) return undefined;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  } catch {
    return undefined;
  }
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9,
  october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12,
};
const WEEKDAY_RE = Object.keys(WEEKDAYS).join("|");
const MONTH_RE = Object.keys(MONTHS).join("|");

// Where in a month each vague part-of-month phrase is suggested to land.
const PART_OF_MONTH: Record<string, number | "end"> = { early: 5, beginning: 5, start: 5, mid: 15, middle: 15, late: 25, end: "end" };

// Conventions: "next <weekday>" is the first such weekday strictly after the message date (Friday, from a
// Wednesday, is this week's Friday); "this <weekday>" and a bare weekday allow today. A part-of-month phrase
// already past is clamped to the message date. Phrases it cannot read ("the 15th", "11/3", "next month")
// return {} and produce no signal rather than a guess.
export function resolveDatePhrase(phrase: string, receivedAt: string, timeZone: string): ResolvedDate {
  const today = localDate(receivedAt, timeZone);
  if (!today) return {};
  const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];

  let p = phrase.trim().toLowerCase()
    .replace(/(?<=[a-z])-(?=[a-z])/g, " ")      // "mid-January"
    .replace(/[.,;!?]+$/, "").replace(/\s+/g, " ");
  for (;;) { // leading filler
    const next = p.replace(/^(?:on|by|around|about|roughly|probably|maybe|sometime|the|coming)\s+/, "");
    if (next === p) break;
    p = next;
  }

  if (p === "today") return { date: today };
  if (p === "tomorrow") return { date: addDays(today, 1) };

  let m = new RegExp(`^next (${WEEKDAY_RE})$`).exec(p);
  if (m) return { date: addDays(today, ((WEEKDAYS[m[1]!]! - weekdayOf(today) + 7) % 7) || 7) };
  m = new RegExp(`^(?:this )?(${WEEKDAY_RE})$`).exec(p);
  if (m) return { date: addDays(today, (WEEKDAYS[m[1]!]! - weekdayOf(today) + 7) % 7) };

  m = /^in (\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) (day|days|week|weeks)$/.exec(p);
  if (m) {
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : NUMBER_WORDS[m[1]!]!;
    return { date: addDays(today, m[2]!.startsWith("week") ? n * 7 : n) };
  }

  if (p === "next week") {
    return { date: addDays(today, ((1 - weekdayOf(today) + 7) % 7) || 7), vague: phrase.trim(), requiresOwnerDate: true };
  }
  if (/^(?:end of (?:the |this )?month|month end)$/.test(p)) return { date: lastDayOfMonth(ty, tm) };

  // "early January", "mid-March", "late next month", "end of December 2027": a suggestion only.
  m = new RegExp(`^(early|beginning of|start of|mid|middle of|late|end of) (?:(${MONTH_RE})|(this|next) month)(?: (\\d{4}))?$`).exec(p);
  if (m) {
    const part = PART_OF_MONTH[m[1]!.split(" ")[0]!]!;
    let month: number;
    let year: number;
    if (m[2]) {
      month = MONTHS[m[2]]!;
      year = m[4] ? Number(m[4]) : month >= tm ? ty : ty + 1;
    } else {
      month = tm + (m[3] === "next" ? 1 : 0);
      year = ty + (month > 12 ? 1 : 0);
      month = month > 12 ? month - 12 : month;
    }
    const suggested = part === "end" ? lastDayOfMonth(year, month) : isoDate(year, month, part)!;
    return { date: suggested < today ? today : suggested, vague: phrase.trim(), requiresOwnerDate: true };
  }

  // Absolute dates. Anything with a year goes through the shared parser.
  const explicit = parseDate(p);
  // "3/12/2026" could be March 12 or December 3: a guess the owner must confirm.
  if (explicit) return explicit.ambiguous ? { date: explicit.date, vague: phrase.trim(), requiresOwnerDate: true } : { date: explicit.date };
  const clean = p.replace(/(\d)(?:st|nd|rd|th)\b/g, "$1").replace(/,/g, "");
  let month: number | undefined;
  let day: number | undefined;
  m = new RegExp(`^(${MONTH_RE})\\.? (\\d{1,2})$`).exec(clean);
  if (m) { month = MONTHS[m[1]!]; day = Number(m[2]); }
  else if ((m = new RegExp(`^(\\d{1,2})(?: of)? (${MONTH_RE})\\.?$`).exec(clean))) { month = MONTHS[m[2]!]; day = Number(m[1]); }
  if (month && day) {
    // No year given: the next occurrence on or after the message date.
    for (let y = ty; y <= ty + 4; y++) {
      const d = isoDate(y, month, day);
      if (d && d >= today) return { date: d };
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Prompt and request

const MODEL_TIMEOUT_MS = 30_000;

let promptText: string | undefined;
export function signalSystemPrompt(): string {
  promptText ??= readFileSync(join(import.meta.dirname, "../prompts/extract_signal.md"), "utf8");
  return promptText;
}

// A message that contains a closing tag must not be able to end its own data block.
const escapeData = (text: string) => text.replace(/<(\/?)(message|conversation|context)/gi, "<\\$1$2");
const oneLine = (v: string) => v.replace(/\s+/g, " ").trim();

export type MessageInput = {
  channel: string;
  receivedAt: string;
  sender?: string;
  subject?: string;
  text: string;                 // the message under analysis
  conversation?: string;        // surrounding chat, context only
};

export function buildSignalContent(m: MessageInput): string {
  const ctx = [
    `channel: ${m.channel}`, `received_at: ${m.receivedAt}`,
    ...(m.sender ? [`sender: ${escapeData(oneLine(m.sender))}`] : []),
    ...(m.subject ? [`subject: ${escapeData(oneLine(m.subject))}`] : []),
  ].join("\n");
  return [
    `<context>\n${ctx}\n</context>`,
    ...(m.conversation ? [`<conversation>\n${escapeData(m.conversation)}\n</conversation>`] : []),
    `<message>\n${escapeData(m.text)}\n</message>`,
  ].join("\n\n");
}

export function signalCacheKey(content: string, model = EXTRACTION_MODEL): string {
  return cacheKey({
    promptVersion: SIGNAL_PROMPT_VERSION,
    promptHash: createHash("sha256").update(signalSystemPrompt()).digest("hex"), // editing the prompt invalidates the cache
    model,
    content,
  });
}

// One structured-output call. Returns the parsed output or a reason; never throws.
export async function callSignalModel(
  client: Anthropic | undefined, content: string, model: string,
): Promise<{ output: SignalExtraction } | { problem: string }> {
  try {
    client ??= new Anthropic(anthropicOptions()); // configured from ANTHROPIC_API_KEY
    const res = await client.messages.create(
      {
        model,
        max_tokens: 16000, // headroom for default-on thinking, as in document.ts
        system: [{ type: "text", text: signalSystemPrompt(), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content }],
        output_config: { effort: "low", format: zodOutputFormat(SignalExtraction) },
      },
      { timeout: MODEL_TIMEOUT_MS, maxRetries: 1 },
    );
    if (res.stop_reason === "refusal") return { problem: "the model declined to read this message" };
    if (res.stop_reason === "max_tokens") return { problem: "the model's answer was cut off before it finished" };
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text" || block.text.trim() === "") return { problem: "the model returned no structured answer" };
    let json: unknown;
    try {
      json = JSON.parse(block.text);
    } catch {
      return { problem: "the model's answer was not valid JSON" };
    }
    const parsed = SignalExtraction.safeParse(json);
    if (!parsed.success) return { problem: "the model's answer did not match the signal schema" };
    return { output: parsed.data };
  } catch (err) {
    return { problem: `the extraction call failed (${err instanceof Error ? err.message : String(err)})` };
  }
}

// ---------------------------------------------------------------------------
// toSignal: model output -> Signal (pure)

export type ToSignalContext = {
  records: Records;
  receivedAt: string;               // ISO instant the message arrived
  channel: Signal["channel"];
  evidenceId: string;               // the message's Evidence id, becomes sourceRef.record
  signalId: string;
  timeZone: string;                 // business time zone, for relative dates
  message?: BundleMessage;          // the chat message under analysis (chat exports)
};

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const normRef = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const isOpen = (c: Commitment) => c.settlement === undefined || c.settlement === "open" || c.settlement === "partial";
// `ref` written out as a whole token (not inside a longer id like "2-INV-1187").
const mentions = (text: string, ref: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9-])${ref.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i").test(text);
const PHONE_RE = /^\+?[\d\s().-]{7,}$/;

// The confirmed party a message came from (email domain or phone on the party), or undefined. A similar
// name alone is not confirmation (docs/design/06-signals.md step 1).
export function resolveSender(bundle: MessageBundle, msg: BundleMessage | undefined, records: Records): string | undefined {
  const sender: PartyHint | undefined = bundle.sender
    ? { email: bundle.sender.email, phone: bundle.sender.phone, name: bundle.sender.name }
    : msg ? (PHONE_RE.test(msg.sender) ? { phone: msg.sender } : { name: msg.sender }) : undefined;
  if (!sender) return undefined;
  const r = resolveParty(sender, records.parties);
  return "partyId" in r ? r.partyId : undefined;
}

// The value must be supported by its own quote, or a real quote could vouch for a different value.
const supported = (q: Quoted): q is NonNullable<Quoted> =>
  q !== null && q.value.trim() !== "" && squash(q.quote).includes(squash(q.value));

export function toSignal(
  extraction: SignalExtraction, bundle: MessageBundle, ctx: ToSignalContext,
): { signal?: Signal; notes: string[] } {
  const notes: string[] = [];

  // A message that tries to steer the assistant never contributes anything.
  if (extraction.containsInstructions) {
    return { notes: ["The message contains text addressed to an assistant (instructions). It was ignored; review it yourself."] };
  }
  if (extraction.claim === "none") return { notes: ["No payment claim found in this message."] };
  if (extraction.claim === "new_commitment" || extraction.claim === "plan") {
    return { notes: [`The message announces a ${extraction.claim === "plan" ? "plan" : "new commitment"}; enter the details yourself, no signal was created.`] };
  }

  // ---- locate quotes in the message
  const msg = ctx.message;
  const locate = (q: Quoted | undefined, messageOnly = false): { start: number; end: number } | undefined => {
    if (!q) return undefined;
    if (msg) {
      const r = locateQuote([{ evidenceId: ctx.evidenceId, text: bundle.text.slice(msg.start, msg.end) }], q.quote);
      if (r?.excerpt) return { start: r.excerpt.start + msg.start, end: r.excerpt.end + msg.start };
      if (messageOnly) return undefined;
    }
    const r = locateQuote([{ evidenceId: ctx.evidenceId, text: bundle.text }], q.quote);
    return r?.excerpt;
  };
  const usable = (q: Quoted, label: string, messageOnly = false): NonNullable<Quoted> | undefined => {
    if (q === null) return undefined;
    if (!supported(q) || !locate(q, messageOnly)) {
      notes.push(`Ignored the ${label} "${q.value}": it is not in the message text it was quoted from.`);
      return undefined;
    }
    return q;
  };
  // A reference read out of a URL ("2-INV-1187" in a portal path) is not an invoice number the sender wrote.
  const inLink = (span: { start: number; end: number }) => bundle.links.some((l) => span.start < l.end && span.end > l.start);
  let reference = usable(extraction.reference, "reference");
  const refSpan = reference ? locate(reference) : undefined;
  if (reference && refSpan && inLink(refSpan)) {
    notes.push(`Ignored the reference "${reference.value}": it comes from a link, not the message text.`);
    reference = undefined;
  }
  const amountMentioned = usable(extraction.amountMentioned, "amount");
  const newDate = usable(extraction.newDatePhrase, "date", true);
  const newAmount = usable(extraction.newAmount, "new amount", true);

  // ---- who sent it
  let partyId = resolveSender(bundle, msg, ctx.records);
  const senderConfirmed = partyId !== undefined || ctx.channel === "owner"; // the owner's own notes are trusted
  if (!partyId) notes.push("The sender is not a confirmed known party; matched by reference only.");

  // ---- match a commitment, in code
  const open = ctx.records.commitments.filter(isOpen);
  const pool = partyId ? open.filter((c) => c.partyId === partyId) : open;
  // The message text with link spans blanked out, so only words the sender wrote are searched.
  const blanked = [...bundle.links].reduce((t, l) => t.slice(0, l.start) + " ".repeat(l.end - l.start) + t.slice(l.end), bundle.text);
  const visibleText = msg ? blanked.slice(msg.start, msg.end) : blanked;
  const basis = (c: Commitment) => c.outstanding ?? c.amount;
  let commitmentId: string | undefined;
  let candidates: { commitmentId: string; reasons: string[] }[] = [];

  let exact = reference ? pool.filter((c) => c.reference !== undefined && normRef(c.reference) === normRef(reference!.value)) : [];
  if (!exact.length) {
    // No usable reference from the model: an invoice number written out in the message text itself still counts.
    const mentioned = pool.filter((c) => c.reference !== undefined && normRef(c.reference).length >= 3 && mentions(visibleText, c.reference));
    if (mentioned.length === 1) exact = mentioned;
  }
  if (exact.length === 1) {
    commitmentId = exact[0]!.id;
  } else if (exact.length > 1) {
    candidates = exact.map((c) => ({ commitmentId: c.id, reasons: [`reference ${reference!.value} matches more than one open commitment`] }));
  } else {
    if (reference) notes.push(`Reference ${reference.value} is not among ${partyId ? "this party's" : "the"} open commitments.`);
    if (partyId && amountMentioned) {
      const hits = pool.filter((c) => {
        const n = parseAmount(amountMentioned.value, c.currency);
        return n !== undefined && basis(c) > 0 && Math.abs(n - basis(c)) <= basis(c) * 0.02;
      });
      candidates = hits.map((c) => ({ commitmentId: c.id, reasons: [`same party; amount ${amountMentioned.value} is within 2% of ${c.reference ?? humanizeId(c.id)}`] }));
    }
    // Tier 3 is for messages that name no invoice; a stated reference that matches nothing is not fixed by guessing.
    if (!candidates.length && partyId && pool.length && !reference) {
      candidates = pool.map((c) => ({
        commitmentId: c.id,
        reasons: [pool.length === 1 ? "same party; their only open commitment" : `same party; one of ${pool.length} open commitments`],
      }));
    }
  }
  if (commitmentId === undefined && candidates.length) notes.push("Could not tell which commitment this is about; the owner must pick one.");
  if (commitmentId === undefined && !candidates.length) notes.push("No open commitment matches this message.");
  const matched = commitmentId ? ctx.records.commitments.find((c) => c.id === commitmentId) : undefined;
  if (!partyId) partyId = matched?.partyId;

  // ---- the claim
  let claim: SignalClaim;
  let confidence = clamp01(extraction.confidence);
  let primary: Quoted;
  if (!senderConfirmed) {
    notes.push("The sender is not a confirmed party; the owner must confirm this before relying on it.");
    confidence = Math.min(confidence, 0.5);
  }
  if (extraction.dependsOn && extraction.dependsOn.trim()) {
    notes.push(`The promise is conditional: ${oneLine(extraction.dependsOn).slice(0, 200)}`);
    confidence = Math.min(confidence, 0.5);
  }
  if (extraction.claim === "date_change") {
    if (!newDate) return { notes: [...notes, "The message gives no readable new date."] };
    const r = resolveDatePhrase(newDate.value, ctx.receivedAt, ctx.timeZone);
    if (!r.date) return { notes: [...notes, `Could not read the date "${newDate.value}".`] };
    if (r.vague) {
      notes.push("owner must confirm the date");
      confidence = Math.min(confidence, 0.5);
    }
    // Restating the date the books already have (a reminder's "due Dec 10") is not a change.
    if (matched && !r.vague && matched.anchors.due === r.date) {
      return { notes: [...notes, `The date ${r.date} is already the due date of ${matched.reference ?? matched.id}; it is not a change.`] };
    }
    claim = { kind: "date_change", newDate: r.date };
    primary = newDate;
  } else if (extraction.claim === "amount_change") {
    const currencies = [...new Set((matched ? [matched] : candidates.map((c) => ctx.records.commitments.find((x) => x.id === c.commitmentId)!)).map((c) => c.currency))];
    if (!newAmount) return { notes: [...notes, "The message gives no readable new amount."] };
    if (currencies.length !== 1) return { notes: [...notes, "Cannot read the new amount: the currency is unknown until a commitment is chosen."] };
    const n = parseAmount(newAmount.value, currencies[0]!);
    if (n === undefined || n < 0) return { notes: [...notes, `Could not read the amount "${newAmount.value}".`] };
    claim = { kind: "amount_change", newAmount: n };
    primary = newAmount;
  } else {
    claim = { kind: "cancel" };
    primary = null;
  }

  // ---- cite the words behind it
  // The excerpt must be the analysed message's own words, not an earlier message of the chat.
  const inMessage = (s: { start: number; end: number } | undefined) => (s && (!msg || (s.start >= msg.start && s.end <= msg.end)) ? s : undefined);
  const span = [primary, reference, amountMentioned, extraction.partyName].map((q) => inMessage(locate(q))).find((s) => s);
  if (!span) return { notes: [...notes, "No quote from the message could be located, so no signal was created."] };

  const signal: Signal = {
    id: ctx.signalId,
    channel: ctx.channel,
    receivedAt: ctx.receivedAt,
    ...(partyId ? { partyId } : {}),
    ...(commitmentId ? { commitmentId } : {}),
    ...(commitmentId === undefined && candidates.length ? { matchCandidates: candidates } : {}),
    claim,
    confidence,
    state: "proposed",
    sourceRef: {
      system: ctx.channel,
      record: ctx.evidenceId,
      excerpt: { start: span.start, end: span.end, text: bundle.text.slice(span.start, span.end) },
    },
  };
  return { signal, notes };
}

// ---------------------------------------------------------------------------
// extractSignals: triage, cache, then (live mode only) the model, per message

export type ExtractSignalsOptions = {
  records: Records;
  mode: "live" | "cache_only";
  timeZone?: string;           // business time zone; default America/Los_Angeles
  channel?: Signal["channel"]; // default: the bundle's channel, or "owner" for anything else
  client?: Anthropic;          // live mode; defaults to a client configured from ANTHROPIC_API_KEY
  // Read and write directory. Default: reads LIVE_CACHE_DIR (gitignored) then the committed demo cache
  // (DEFAULT_CACHE_DIR); live results are written to LIVE_CACHE_DIR, never to the fixtures.
  cacheDir?: string;
  model?: string;
};

const DEFAULT_TZ = "America/Los_Angeles";
const CHANNELS = new Set<Signal["channel"]>(["email", "whatsapp", "crm", "owner"]);

export type MessageUnit = { message?: BundleMessage; text: string; receivedAt: string; content: string; id: string; label: string };

// The messages of a bundle that pass triage, each with the exact model input built for it.
export function messageUnits(bundle: MessageBundle, channel: Signal["channel"]): MessageUnit[] {
  const evidenceId = bundle.parent.id;
  const chat = bundle.messages && bundle.messages.length > 0 ? bundle.messages : undefined;
  const raw = chat
    ? chat.map((m, i) => ({ message: m, text: m.text, receivedAt: m.at, sender: m.sender as string | undefined, id: `sig-${evidenceId}-${i + 1}`, label: `Message ${i + 1}` }))
    : [{
      message: undefined, text: bundle.text, receivedAt: bundle.parent.receivedAt, id: `sig-${evidenceId}`, label: "Message",
      sender: (bundle.sender?.email ?? bundle.sender?.phone ?? bundle.sender?.name) as string | undefined,
    }];
  return raw
    .filter((u) => passesTriage(`${bundle.subject ?? ""}\n${u.text}`)) // nothing about payment, dates, or orders: no model call
    .map((u) => ({
      message: u.message, text: u.text, receivedAt: u.receivedAt, id: u.id, label: u.label,
      content: buildSignalContent({
        channel, receivedAt: u.receivedAt, sender: u.sender, subject: bundle.subject, text: u.text,
        conversation: chat && chat.length > 1 ? bundle.text : undefined,
      }),
    }));
}

const bundleChannel = (bundle: MessageBundle, override?: Signal["channel"]): Signal["channel"] =>
  override ?? (CHANNELS.has(bundle.parent.channel as Signal["channel"]) ? bundle.parent.channel as Signal["channel"] : "owner");

export async function extractSignals(
  bundle: MessageBundle, opts: ExtractSignalsOptions,
): Promise<{ signals: Signal[]; notes: string[] }> {
  const model = opts.model ?? EXTRACTION_MODEL;
  const timeZone = opts.timeZone ?? DEFAULT_TZ;
  const evidenceId = bundle.parent.id;
  const channel = bundleChannel(bundle, opts.channel);

  const writeDir = opts.cacheDir ?? LIVE_CACHE_DIR;
  const readDirs = opts.cacheDir ? [opts.cacheDir] : [LIVE_CACHE_DIR, DEFAULT_CACHE_DIR];
  const signals: Signal[] = [];
  const notes: string[] = [];

  for (const u of messageUnits(bundle, channel)) {
    const { content, label } = u;
    // Inbound streams (email, CRM) are read only from confirmed parties, and nothing else is sent to the model.
    // Chats and notes the owner supplied themselves are read; their signals are capped when the sender is unconfirmed.
    if ((channel === "email" || channel === "crm") && !resolveSender(bundle, u.message, opts.records)) {
      notes.push(`${label}: ignored, the sender is not a known party.`);
      continue;
    }
    const key = signalCacheKey(content, model);
    let output: SignalExtraction | undefined;
    for (const dir of readDirs) {
      const hit = readCache(dir, key);
      const parsed = hit ? SignalExtraction.safeParse(hit.output) : undefined;
      if (parsed?.success) { output = parsed.data; break; }
      // A cache entry that no longer fits the schema is a miss.
    }
    if (!output) {
      if (opts.mode === "cache_only") { notes.push(`${label}: no cached extraction (demo mode).`); continue; }
      const result = await callSignalModel(opts.client, content, model);
      if ("problem" in result) { notes.push(`${label}: could not extract a signal: ${result.problem}.`); continue; }
      output = result.output;
      try {
        writeCache(writeDir, { key, promptVersion: SIGNAL_PROMPT_VERSION, model, source: "live", output });
      } catch {
        // A failed cache write must not lose a good extraction.
      }
    }

    const r = toSignal(output, bundle, {
      records: opts.records, receivedAt: u.receivedAt, channel, evidenceId, signalId: u.id, timeZone, message: u.message,
    });
    if (r.signal) signals.push(r.signal);
    for (const n of r.notes) notes.push(`${label}: ${n}`);
  }
  return { signals, notes };
}
