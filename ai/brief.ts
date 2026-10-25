// Layer 3, brief text and drafts (P4.17): Claude writes the words for "three things to do today";
// code owns every figure, the order, and the action. Design: docs/design/08-claude-layer.md.
//
//  - writeBrief: title and why for the top (max 3) work items.
//  - draftMessage: a polite text-only draft to the counterparty for one work item.
//
// Both build a compact JSON "facts" block from engine output and records, give it to the model as the
// only source, and validate everything the model returns with number_check (and a few text rules)
// before it reaches the owner. On a second failure, or with no cached answer in cache_only mode, they
// fall back to deterministic text built by code. Nothing here can send, pay, or move money: the draft
// is returned as text, and links in it are copied from the commitment, never produced by the model.
// Owner notes are data: they sit in the facts block and are never treated as instructions.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import type { ForecastRun } from "../schema/forecast";
import type { Profile } from "../schema/profile";
import type { Commitment, Lever, Party, Records, WorkItem } from "../schema/records";
import { BRIEF_CACHE_DIR, cacheKey, LIVE_CACHE_DIR, readCache, writeCache } from "./cache";
import { BRIEF_MODEL, BRIEF_PROMPT_VERSION, DRAFT_MODEL, DRAFT_PROMPT_VERSION } from "./config";
import { minorUnitDigits } from "./normalize";
import { allowedFromToolResults, checkText, type Allowed, type CheckOpts } from "./number_check";

export const MAX_BRIEF_ITEMS = 3;
const MAX_TITLE_WORDS = 8;
const MAX_WHY_CHARS = 420;
const MODEL_TIMEOUT_MS = 30_000;
const MAX_NOTES = 3;
const MAX_NOTE_CHARS = 200;
const MAX_EXPECTED = 3;

export type BriefContext = {
  run: ForecastRun;
  records: Records;
  profile: Profile;
  business: { name: string };
  mode: "live" | "cache_only";
  client?: Anthropic;     // live mode; defaults to a client configured from ANTHROPIC_API_KEY
  // Read and write directory. Default: reads LIVE_CACHE_DIR (gitignored) then the committed demo cache
  // (BRIEF_CACHE_DIR); live results are written to LIVE_CACHE_DIR, never to the fixtures.
  cacheDir?: string;
  model?: string;
};

export type Draft = {
  subject?: string;
  body: string;
  channel: "email" | "message";
  links: string[];
  usedFallback: boolean;
};

// ---------------------------------------------------------------------------
// Facts

type LeverFacts = { kind: Lever["kind"]; days?: number; assumeDate?: string; advancePct?: number; parts?: number };

export type Facts = {
  itemId: string;
  warning: string;
  lever?: LeverFacts;
  cashEffect: number;
  cashEffectMeans: "rise in the lowest cash point" | "dollars saved";
  neededBy: string;
  asOf: string;
  baseCurrency: string;
  commitment?: {
    id: string; reference?: string; type: string; direction?: string; amount: number; outstanding?: number;
    currency: string; due?: string; status: string; category?: string; discount?: { pct: number; byDate: string };
  };
  party?: { name: string; kind: string; tags: string[]; medianDaysLate?: number; ownerNotes: string[] };
  expected: { date: string; basis: string; amountBase: number }[];
  lowPoint: { week: string; date: string; amount: number };
  safetyLine: number;
  amountAfterLever?: number;  // lowest point if this item is done: base low point + cashEffect; absent for dollars saved and for items with no lever
  vocabulary: Record<string, string>;
};

// Notes are the owner's words: bounded, single-line, and never a source of allowed figures.
const cleanNote = (n: string) => n.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS);

// Engine basis strings can embed the owner's own words (a rule's fromNote, in quotes). Those are data from
// outside the engine: drop them so they cannot carry text or dates into the facts or the allowed set.
const cleanBasis = (b: string) => b.replace(/"[^"]*"/g, '""').slice(0, 300);

function findCommitment(item: WorkItem, records: Records): Commitment | undefined {
  const byId = new Map(records.commitments.map((c) => [c.id, c]));
  // Only through the lever: a warning without one (idle cash, concentration) is not about one document.
  return item.lever ? byId.get(item.lever.commitmentId) : undefined;
}

export function buildFacts(item: WorkItem, ctx: Pick<BriefContext, "run" | "records" | "profile">): Facts {
  const { run, records, profile } = ctx;
  const c = findCommitment(item, records);
  const party: Party | undefined = c?.partyId ? records.parties.find((p) => p.id === c.partyId) : undefined;
  const l = item.lever;
  const lever: LeverFacts | undefined = !l ? undefined : {
    kind: l.kind,
    ...(l.kind === "defer" ? { days: l.days } : {}),
    ...(l.kind === "chase" ? { assumeDate: l.assumeDate } : {}),
    ...(l.kind === "ask_advance" ? { advancePct: Math.round(l.share * 100) } : {}),
    ...(l.kind === "split" ? { parts: l.shares.length } : {}),
  };
  const saved = l?.kind === "pay_early";
  const expected = c
    ? run.events.filter((e) => e.commitmentId === c.id && e.date >= run.asOf).slice(0, MAX_EXPECTED)
      .map((e) => ({ date: e.date, basis: cleanBasis(e.basis), amountBase: e.amountBase }))
    : [];
  return {
    itemId: item.id,
    warning: item.warning,
    ...(lever ? { lever } : {}),
    cashEffect: item.cashEffect,
    cashEffectMeans: saved ? "dollars saved" : "rise in the lowest cash point",
    neededBy: item.neededBy,
    asOf: run.asOf,
    baseCurrency: profile.baseCurrency,
    ...(c ? {
      commitment: {
        id: c.id, ...(c.reference ? { reference: c.reference } : {}), type: c.type, ...(c.direction ? { direction: c.direction } : {}),
        amount: c.amount, ...(c.outstanding !== undefined ? { outstanding: c.outstanding } : {}), currency: c.currency,
        ...(c.anchors.due ? { due: c.anchors.due } : {}), status: c.status, ...(c.category ? { category: c.category } : {}),
        ...(c.discount ? { discount: c.discount } : {}),
      },
    } : {}),
    ...(party ? {
      party: {
        name: party.name, kind: party.kind, tags: party.tags.slice(0, 8),
        ...(party.lagStats ? { medianDaysLate: party.lagStats.medianDaysLate } : {}),
        ownerNotes: party.notes.slice(0, MAX_NOTES).map(cleanNote).filter(Boolean),
      },
    } : {}),
    expected,
    lowPoint: run.lowPoint,
    safetyLine: run.safetyLine,
    ...(l && !saved ? { amountAfterLever: run.lowPoint.amount + item.cashEffect } : {}),
    vocabulary: profile.vocabulary,
  };
}

// Figures the text may state. Owner notes are removed first: they are data from outside the engine
// and must never widen the allowed set.
export function allowedFromFacts(facts: { party?: Facts["party"] } & Record<string, unknown>): Allowed {
  const { party, ...rest } = facts;
  const safeParty = party ? { ...party, ownerNotes: [] } : undefined;
  return allowedFromToolResults([{ ...rest, ...(safeParty ? { party: safeParty } : {}) }]);
}

// What a draft to a counterparty may draw on: the document and its dates, not the owner's cash position.
export function draftFacts(f: Facts): Omit<Facts, "lowPoint" | "safetyLine" | "amountAfterLever" | "cashEffect" | "cashEffectMeans"> {
  const { lowPoint: _l, safetyLine: _s, amountAfterLever: _a, cashEffect: _c, cashEffectMeans: _m, ...rest } = f;
  return rest;
}

// ---------------------------------------------------------------------------
// Formatting for code-built text

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-12-18" -> "Dec 18"; "Jan 8, 2027" when the year differs from asOf's.
export function fmtDate(iso: string, asOf: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const base = `${MONTHS[(m ?? 1) - 1]} ${d}`;
  return iso.slice(0, 4) === asOf.slice(0, 4) ? base : `${base}, ${y}`;
}

// Minor units to text: "$28,000", "-$5,500" (U+2212 minus), "INR 1,000,000". Integer math on the digits.
export function fmtMoney(minor: number, currency: string, base: string): string {
  const digits = minorUnitDigits(currency);
  const abs = BigInt(Math.abs(minor));
  const scale = 10n ** BigInt(digits);
  const whole = (abs / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % scale).toString().padStart(digits, "0");
  const num = digits > 0 && frac !== "0".repeat(digits) ? `${whole}.${frac}` : whole;
  const text = currency === base && base === "USD" ? `$${num}` : `${currency} ${num}`;
  return minor < 0 ? `−${text}` : text;
}

// ---------------------------------------------------------------------------
// Deterministic fallbacks (code only; no model)

const partyName = (f: Facts, fallback: string) => f.party?.name ?? fallback;
const docRef = (f: Facts) => f.commitment?.reference ?? "the open document";

export function fallbackBrief(f: Facts): { title: string; why: string } {
  const money = (n: number) => fmtMoney(n, f.baseCurrency, f.baseCurrency);
  const date = (d: string) => fmtDate(d, f.asOf);
  const cm = f.commitment;
  const cur = cm?.currency ?? f.baseCurrency;
  const owed = cm ? fmtMoney(cm.outstanding ?? cm.amount, cur, f.baseCurrency) : undefined;
  const lift = f.amountAfterLever === undefined ? "helps your lowest point"
    : `lifts your lowest point from ${money(f.lowPoint.amount)} (week of ${date(f.lowPoint.week)}) to ${money(f.amountAfterLever)}`;
  const kind = f.lever?.kind;
  switch (kind) {
    case "chase":
      return {
        title: `Chase ${partyName(f, "the customer")} on ${docRef(f)}`,
        why: owed && f.lever?.assumeDate
          ? `Collecting ${owed} by ${date(f.lever.assumeDate)} ${lift}.`
          : `Collecting this payment by ${date(f.neededBy)} ${lift}.`,
      };
    case "defer":
      return {
        title: `Ask ${partyName(f, "the supplier")} for ${f.lever?.days} more days`,
        why: `Moving the ${docRef(f)} payment back ${f.lever?.days} days ${lift}. Ask by ${date(f.neededBy)}.`,
      };
    case "ask_advance":
      return {
        title: `Ask ${partyName(f, "the customer")} for a ${f.lever?.advancePct}% advance`,
        why: `Asking for ${f.lever?.advancePct}% up front on ${docRef(f)} ${lift}. Ask by ${date(f.neededBy)}.`,
      };
    case "split":
      return {
        title: `Split the ${docRef(f)} payment`,
        why: `Paying ${docRef(f)} in ${f.lever?.parts} parts ${lift}. Decide by ${date(f.neededBy)}.`,
      };
    case "pay_early":
      return {
        title: `Pay ${docRef(f)} early for the discount`,
        why: `Paying ${partyName(f, "this supplier")} early by ${date(f.neededBy)} saves ${money(f.cashEffect)}.`,
      };
    default:
      return {
        title: `Review ${f.warning.replace(/_/g, " ")}`,
        why: `Your lowest point is ${money(f.lowPoint.amount)} in the week of ${date(f.lowPoint.week)}, against a ${money(f.safetyLine)} safety line.`,
      };
  }
}

export function fallbackDraft(f: Facts, business: string): { subject?: string; body: string } {
  const date = (d: string) => fmtDate(d, f.asOf);
  const cm = f.commitment;
  const name = f.party?.name;
  const hello = name ? `Hello ${name},` : "Hello,";
  const ref = cm?.reference ?? "the open item";
  const amt = cm ? fmtMoney(cm.outstanding ?? cm.amount, cm.currency, f.baseCurrency) : undefined;
  const sign = `Thank you,\n${business}`;
  const lines: string[] = [hello, ""];
  let subject: string;
  switch (f.lever?.kind) {
    case "chase":
      subject = cm?.reference ? (amt ? `Invoice ${ref}: ${amt}` : `Invoice ${ref}`) : "Open invoice";
      lines.push(
        `I'm following up on ${cm?.reference ? `invoice ${ref}` : "an open invoice"}${amt ? ` for ${amt}` : ""}${cm?.due ? `, due ${date(cm.due)}` : ""}.` +
        ` Could you let me know when we can expect payment?` +
        (f.lever.assumeDate ? ` Receiving it by ${date(f.lever.assumeDate)} would help us a great deal.` : ""),
        "", "If anything is holding it up, please tell me and I will help sort it out.");
      break;
    case "defer":
      subject = `Payment timing for ${ref}`;
      lines.push(
        `We would like to ask whether you could allow ${f.lever.days} more days on ${ref}${amt ? ` (${amt})` : ""}` +
        `${cm?.due ? `, currently due ${date(cm.due)}` : ""}.`,
        "", "We value working with you and would be grateful for the flexibility. Please let me know what is possible.");
      break;
    case "ask_advance":
      subject = `Advance on ${ref}`;
      lines.push(
        `Ahead of ${ref}${amt ? ` (${amt})` : ""}, we would like to ask whether you could pay ${f.lever.advancePct}% in advance.`,
        "", "Please let me know whether that works for you, or what you would suggest instead.");
      break;
    case "pay_early":
      subject = `Early payment on ${ref}`;
      lines.push(
        `We are looking at paying ${ref}${amt ? ` (${amt})` : ""} early` +
        `${cm?.discount ? `, ahead of ${date(cm.discount.byDate)}` : ""}. Could you confirm the early-payment terms that apply?`);
      break;
    default:
      subject = `About ${ref}`;
      lines.push(`I'd like to talk about the timing of payment on ${ref}${amt ? ` (${amt})` : ""}. Could you let me know a good time to talk?`);
  }
  lines.push("", sign);
  return { subject, body: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Model calls

const BriefOutput = z.object({
  items: z.array(z.object({ id: z.string(), title: z.string(), why: z.string() })),
});
type BriefOutput = z.infer<typeof BriefOutput>;

const BriefItemOutput = z.object({ title: z.string(), why: z.string() });

const DraftOutput = z.object({ subject: z.string().nullable(), body: z.string() });
type DraftOutput = z.infer<typeof DraftOutput>;

const promptCache = new Map<string, string>();
const prompt = (file: string): string => {
  let t = promptCache.get(file);
  if (t === undefined) {
    t = readFileSync(join(import.meta.dirname, "prompts", file), "utf8");
    promptCache.set(file, t);
  }
  return t;
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Turn = { role: "user" | "assistant"; content: string };

// One structured-output call. Never throws; a problem string says why there is no output.
async function callStructured<T>(
  client: Anthropic | undefined, model: string, system: string, turns: Turn[], schema: z.ZodType<T>, effort: "low" | "medium",
): Promise<{ output: T } | { problem: string }> {
  try {
    client ??= new Anthropic(); // configured from ANTHROPIC_API_KEY
    const res = await client.messages.create(
      {
        model,
        max_tokens: 4000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: turns,
        output_config: { effort, format: zodOutputFormat(schema as never) },
      },
      { timeout: MODEL_TIMEOUT_MS, maxRetries: 1 },
    );
    if (res.stop_reason === "refusal") return { problem: "the model declined" };
    if (res.stop_reason === "max_tokens") return { problem: "the model's answer was cut off" };
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text" || block.text.trim() === "") return { problem: "the model returned no answer" };
    let json: unknown;
    try { json = JSON.parse(block.text); } catch { return { problem: "the model's answer was not valid JSON" }; }
    const parsed = schema.safeParse(json);
    return parsed.success ? { output: parsed.data } : { problem: "the model's answer did not match the schema" };
  } catch (err) {
    return { problem: `the call failed (${err instanceof Error ? err.message : String(err)})` };
  }
}

// `</facts` inside any string must not close the data block.
const factsBlock = (facts: unknown) => `<facts>\n${JSON.stringify(facts, null, 1).replace(/<\/facts/gi, "<\\/facts")}\n</facts>`;

const cacheDirs = (ctx: BriefContext) => ({
  writeDir: ctx.cacheDir ?? LIVE_CACHE_DIR,
  readDirs: ctx.cacheDir ? [ctx.cacheDir] : [LIVE_CACHE_DIR, BRIEF_CACHE_DIR],
});

function cachedOutput<T>(ctx: BriefContext, key: string, schema: z.ZodType<T>): T | undefined {
  for (const dir of cacheDirs(ctx).readDirs) {
    const hit = readCache(dir, key);
    if (!hit) continue;
    const parsed = schema.safeParse(hit.output);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function storeOutput(ctx: BriefContext, key: string, promptVersion: string, model: string, output: unknown): void {
  try {
    writeCache(cacheDirs(ctx).writeDir, { key, promptVersion, model, source: "live", output });
  } catch {
    // A failed cache write must not lose a good answer.
  }
}

// ---------------------------------------------------------------------------
// Validation

const checkOpts = (f: Facts): CheckOpts => ({ currency: f.baseCurrency, asOf: f.asOf });
const LINKISH_RE = /https?:|ftp:|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|ly|me|app|biz|info|xyz|link|pay|example|test)\b|@/i;
const BANK_RE = /\b(?:iban|swift|routing|account\s+(?:number|no)|sort code|wire|wired|bank details)\b/i;

// Links, addresses, and bank details come from the commitment or the owner, never from the model. A run of
// six or more digits is an account number unless it is part of the document's own reference.
function hygieneProblem(text: string, f: Facts): string | undefined {
  if (LINKISH_RE.test(text)) return "contains a link or address (links are added by code)";
  if (BANK_RE.test(text)) return "mentions bank or wire details";
  const ref = f.commitment?.reference;
  const rest = (ref ? text.split(ref).join(" ") : text).replace(/\d{4}-\d{2}-\d{2}/g, " ");
  if (/\d{6,}/.test(rest)) return "contains a long number";
  return undefined;
}

// Day counts, percentages, and week counts are figures too: number_check reads only money and dates, so
// they are matched against the lever and the engine's own basis text here.
function countProblems(text: string, f: Facts): string[] {
  const nums = (s: string) => [...s.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const basis = f.expected.flatMap((e) => nums(e.basis));
  const allowed: Record<"day" | "pct" | "week", Set<number>> = {
    day: new Set([...(f.lever?.days !== undefined ? [f.lever.days] : []), ...(f.party?.medianDaysLate !== undefined ? [Math.abs(f.party.medianDaysLate)] : []), ...basis]),
    pct: new Set([...(f.lever?.advancePct !== undefined ? [f.lever.advancePct] : []), ...(f.commitment?.discount ? [f.commitment.discount.pct] : [])]),
    week: new Set(),
  };
  const out: string[] = [];
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:more\s+|extra\s+|additional\s+|business\s+|calendar\s+|working\s+)?(%|percent\b|per\s?cent\b|days?\b|weeks?\b)/gi)) {
    const unit = m[2]!.toLowerCase();
    const kind = unit.startsWith("day") ? "day" : unit.startsWith("week") ? "week" : "pct";
    if (!allowed[kind].has(Number(m[1]))) out.push(`"${m[0]}" is not in the facts`);
  }
  return out;
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const citationsFor = (item: WorkItem, f: Facts) => [...new Set([...(item.evidenceRefs ?? []), f.commitment?.id ?? item.id])];

// A problem string, or undefined when the title and why are acceptable.
export function checkBriefText(title: string, why: string, item: WorkItem, f: Facts): string | undefined {
  if (!title.trim() || !why.trim()) return "empty title or why";
  if (wordCount(title) > MAX_TITLE_WORDS) return `title is longer than ${MAX_TITLE_WORDS} words`;
  if (why.length > MAX_WHY_CHARS) return "why is too long";
  const text = `${title}\n${why}`;
  const hygiene = hygieneProblem(text, f);
  if (hygiene) return hygiene;
  const r = checkText(text, citationsFor(item, f), allowedFromFacts(f), checkOpts(f));
  const parts = [
    ...r.unmatched.map((u) => `${u.kind} "${u.raw}" is not in the facts`),
    ...r.problems, ...countProblems(text, f),
  ];
  return parts.length ? parts.join("; ") : undefined;
}

// Phrases that claim something was sent or paid. Drafts are text for the owner to send; they never say it was.
const CLAIM_RE = /\bsent\b|\b(?:we|i)(?:'ve| have)?\s+(?:already\s+|just\s+)?(?:paid|wired|transferred)\b|\b(?:have|has|had|already|just|am|are|was|were)\s+(?:been\s+)?(?:paid|wired|transferred|submitted|processed)\b|\bi(?:'ve| have)\s+paid\b|\bon its way\b|\bpayment\s+(?:is|was)\s+(?:made|processed|complete)/i;

export function checkDraftText(subject: string | undefined, body: string, item: WorkItem, f: Facts): string | undefined {
  if (!body.trim()) return "empty body";
  const all = `${subject ?? ""}\n${body}`;
  const hygiene = hygieneProblem(all, f);
  if (hygiene) return hygiene;
  if (CLAIM_RE.test(all)) return "claims something was sent or paid";
  // A message to a counterparty may state only what is on the document: never our own cash position
  // (low point, safety line) or the lever's effect on it.
  const r = checkText(all, citationsFor(item, f), allowedFromFacts(draftFacts(f)), checkOpts(f));
  const parts = [...r.unmatched.map((u) => `${u.kind} "${u.raw}" is not in the facts`), ...r.problems, ...countProblems(all, f)];
  return parts.length ? parts.join("; ") : undefined;
}

const feedback = (problems: string[]) =>
  `Your previous answer failed validation:\n${problems.map((p) => `- ${p}`).join("\n")}\n` +
  "Use only the amounts and dates in the facts, keep titles to 8 words, include no links, and claim nothing was sent or paid. " +
  "If a figure is not in the facts, leave it out. Return the corrected answer in the same format.";

// ---------------------------------------------------------------------------
// Cache keys: prompt text + version, model, run inputs, and the facts block (everything that shapes the answer).

// One entry per item, so a change to one ranked item (or a different top three) never invalidates the others.
export function briefCacheKey(
  item: WorkItem, ctx: Pick<BriefContext, "run" | "records" | "profile" | "model">,
): string {
  return cacheKey({
    promptVersion: BRIEF_PROMPT_VERSION, promptHash: sha(prompt("write_brief.md")), model: ctx.model ?? BRIEF_MODEL,
    inputsHash: ctx.run.inputsHash, facts: buildFacts(item, ctx),
  });
}

const draftPayload = (item: WorkItem, ctx: Pick<BriefContext, "run" | "records" | "profile" | "business">) =>
  ({ businessName: ctx.business.name, ...draftFacts(buildFacts(item, ctx)) });

export function draftCacheKey(
  item: WorkItem, ctx: Pick<BriefContext, "run" | "records" | "profile" | "business" | "model">,
): string {
  return cacheKey({
    promptVersion: DRAFT_PROMPT_VERSION, promptHash: sha(prompt("draft_message.md")), model: ctx.model ?? DRAFT_MODEL,
    inputsHash: ctx.run.inputsHash, payload: draftPayload(item, ctx),
  });
}

// ---------------------------------------------------------------------------
// writeBrief

export async function writeBrief(
  items: WorkItem[], ctx: BriefContext,
): Promise<{ items: WorkItem[]; usedFallback: string[] }> {
  const top = items.slice(0, MAX_BRIEF_ITEMS); // never padded; order is the ranker's
  if (top.length === 0) return { items: [], usedFallback: [] };
  const model = ctx.model ?? BRIEF_MODEL;
  const facts = top.map((i) => buildFacts(i, ctx));
  const system = prompt("write_brief.md");
  const user = factsBlock(facts);
  const keys = top.map((i) => briefCacheKey(i, { ...ctx, model }));

  // Per item: accepted text, or undefined while still unresolved.
  const accepted = new Map<string, { title: string; why: string }>();
  const evaluate = (out: BriefOutput): string[] => {
    const problems: string[] = [];
    for (const [idx, item] of top.entries()) {
      if (accepted.has(item.id)) continue;
      const got = out.items.find((x) => x.id === item.id);
      if (!got) { problems.push(`${item.id}: missing from the answer`); continue; }
      const problem = checkBriefText(got.title, got.why, item, facts[idx]!);
      if (problem) problems.push(`${item.id}: ${problem}`);
      else accepted.set(item.id, { title: got.title.trim(), why: got.why.trim() });
    }
    return problems;
  };

  for (const [idx, item] of top.entries()) {
    const hit = cachedOutput(ctx, keys[idx]!, BriefItemOutput);
    if (hit) evaluate({ items: [{ id: item.id, ...hit }] });
  }
  let problems: string[] = [];

  // A miss or a failing cache entry goes to the model in live mode: one attempt, then one retry with feedback.
  if (accepted.size < top.length && ctx.mode === "live") {
    const turns: Turn[] = [{ role: "user", content: user }];
    for (let attempt = 1; attempt <= 2 && accepted.size < top.length; attempt++) {
      const res = await callStructured(ctx.client, model, system, turns, BriefOutput, "medium");
      if ("problem" in res) { problems = [res.problem]; continue; }
      const before = new Set(accepted.keys());
      problems = evaluate(res.output);
      for (const [idx, item] of top.entries()) {
        if (accepted.has(item.id) && !before.has(item.id)) storeOutput(ctx, keys[idx]!, BRIEF_PROMPT_VERSION, model, accepted.get(item.id));
      }
      if (accepted.size < top.length) {
        turns.push({ role: "assistant", content: JSON.stringify(res.output) }, { role: "user", content: feedback(problems) });
      }
    }
  }

  const usedFallback: string[] = [];
  const out = top.map((item, idx) => {
    let text = accepted.get(item.id);
    if (!text) { text = fallbackBrief(facts[idx]!); usedFallback.push(item.id); }
    // Only words change. cashEffect, score, neededBy, lever, and the order are the engine's.
    return { ...item, title: text.title, why: text.why };
  });
  return { items: out, usedFallback };
}

// ---------------------------------------------------------------------------
// draftMessage

const channelFor = (item: WorkItem): Draft["channel"] =>
  item.actions.some((a) => a.kind === "draft_message") && !item.actions.some((a) => a.kind === "draft_email") ? "message" : "email";

// The commitment's own links, copied as they are. A chase may point at the invoice and its pay link
// (never evidence of payment); other drafts only reference the document.
export function linksFor(item: WorkItem, records: Records): { label: string; url: string }[] {
  const c = findCommitment(item, records);
  if (!c) return [];
  const out: { label: string; url: string }[] = [];
  if (c.invoiceUrl) out.push({ label: "Invoice", url: c.invoiceUrl });
  if (c.paymentUrl && item.lever?.kind === "chase" && c.paymentUrl !== c.invoiceUrl) out.push({ label: "Pay online", url: c.paymentUrl });
  return out;
}

export async function draftMessage(item: WorkItem, ctx: BriefContext): Promise<Draft> {
  const model = ctx.model ?? DRAFT_MODEL;
  const facts = buildFacts(item, ctx);
  const system = prompt("draft_message.md");
  const payload = draftPayload(item, ctx);
  const key = draftCacheKey(item, { ...ctx, model });
  const links = linksFor(item, ctx.records);
  const channel = channelFor(item);

  const finish = (d: { subject?: string | null; body: string }, usedFallback: boolean): Draft => {
    const body = links.length ? `${d.body.trimEnd()}\n\n${links.map((l) => `${l.label}: ${l.url}`).join("\n")}` : d.body;
    return {
      ...(channel === "email" && d.subject ? { subject: d.subject } : {}),
      body, channel, links: links.map((l) => l.url), usedFallback,
    };
  };
  const accept = (o: DraftOutput): string | undefined => checkDraftText(o.subject ?? undefined, o.body, item, facts);

  const hit = cachedOutput(ctx, key, DraftOutput);
  if (hit && !accept(hit)) return finish(hit, false);

  if (ctx.mode === "live") {
    const turns: Turn[] = [{ role: "user", content: factsBlock(payload) }];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await callStructured(ctx.client, model, system, turns, DraftOutput, "medium");
      if ("problem" in res) continue;
      const problem = accept(res.output);
      if (!problem) {
        storeOutput(ctx, key, DRAFT_PROMPT_VERSION, model, res.output);
        return finish(res.output, false);
      }
      turns.push({ role: "assistant", content: JSON.stringify(res.output) }, { role: "user", content: feedback([problem]) });
    }
  }
  return finish(fallbackDraft(facts, ctx.business.name), true);
}
