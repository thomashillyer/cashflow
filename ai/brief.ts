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
import { BRIEF_MODEL, BRIEF_PROMPT_VERSION, DRAFT_MODEL, DRAFT_PROMPT_VERSION, anthropicOptions } from "./config";
import { toBase } from "../engine/expand";
import { fmtDate } from "./labels";
import { fmtMoney, fmtWithBase } from "./money";

export { fmtDate };
import { allowedFromToolResults, checkText, extractDates, type Allowed, type CheckOpts } from "./number_check";

export { fmtMoney } from "./money";

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
  neededBy: string;                       // when to ask or act, never a settlement date
  neededByStatus: "upcoming" | "today" | "passed";
  asOf: string;                           // every tense in the text is relative to this date
  baseCurrency: string;
  commitment?: {
    id: string; reference?: string; type: string; direction?: string; amount: number; outstanding?: number;
    currency: string; due?: string; status: string; category?: string; discount?: { pct: number; byDate: string };
    // Computed by code from `due` and asOf; absent without a due date or once the document is settled.
    dueStatus?: "not yet due" | "due today" | `overdue by ${number} day${"" | "s"}`;
    daysOverdue?: number;
    // The owed figure (outstanding, else amount) as text in the commitment currency; when that is not the
    // base currency, followed by the converted base figure: "₹1,000,000 (about $12,000 at today's rate)".
    display: string;
    // Only when the commitment currency is not the base currency: the run's rate and the converted figure.
    converted?: { amountBase: number; rate: number };
  };
  party?: { name: string; kind: string; tags: string[]; medianDaysLate?: number; ownerNotes: string[] };
  expected: {
    date: string; basis: string; amount: number; currency: string; amountBase: number; display: string;
    converted: boolean;                   // true when `amountBase` was converted from `currency`
    againstLowPoint: "after" | "before" | "same day";  // this date against lowPoint.date
  }[];
  lowPoint: { week: string; date: string; amount: number };
  safetyLine: number;
  amountAfterLever?: number;  // lowest point if this item is done: base low point + cashEffect; absent for dollars saved and for items with no lever
  vocabulary: Record<string, string>;
};

// Whole days from `from` to `to` (UTC calendar dates).
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

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
  const base = profile.baseCurrency;
  const expected: Facts["expected"] = c
    ? run.events.filter((e) => e.commitmentId === c.id && e.date >= run.asOf).slice(0, MAX_EXPECTED)
      .map((e) => ({
        date: e.date, basis: cleanBasis(e.basis), amount: e.amount, currency: e.currency, amountBase: e.amountBase,
        display: fmtWithBase(e.amount, e.currency, base, e.amountBase), converted: e.currency !== base,
        againstLowPoint: e.date > run.lowPoint.date ? "after" : e.date < run.lowPoint.date ? "before" : "same day",
      }))
    : [];
  const owed = c ? c.outstanding ?? c.amount : 0;
  const owedBase = c && c.currency !== base ? toBase(owed, c.currency, profile, run.fxRates) : undefined;
  const open = !c?.settlement || c.settlement === "open" || c.settlement === "partial";
  const sinceDue = c?.anchors.due && open ? daysBetween(c.anchors.due, run.asOf) : undefined;
  return {
    itemId: item.id,
    warning: item.warning,
    ...(lever ? { lever } : {}),
    cashEffect: item.cashEffect,
    cashEffectMeans: saved ? "dollars saved" : "rise in the lowest cash point",
    neededBy: item.neededBy,
    neededByStatus: item.neededBy > run.asOf ? "upcoming" : item.neededBy === run.asOf ? "today" : "passed",
    asOf: run.asOf,
    baseCurrency: base,
    ...(c ? {
      commitment: {
        id: c.id, ...(c.reference ? { reference: c.reference } : {}), type: c.type, ...(c.direction ? { direction: c.direction } : {}),
        amount: c.amount, ...(c.outstanding !== undefined ? { outstanding: c.outstanding } : {}), currency: c.currency,
        ...(c.anchors.due ? { due: c.anchors.due } : {}), status: c.status, ...(c.category ? { category: c.category } : {}),
        ...(c.discount ? { discount: c.discount } : {}),
        ...(sinceDue === undefined ? {} : sinceDue <= 0
          ? { dueStatus: sinceDue === 0 ? "due today" as const : "not yet due" as const }
          : { dueStatus: `overdue by ${sinceDue} day${sinceDue === 1 ? "" : "s"}` as const, daysOverdue: sinceDue }),
        display: fmtWithBase(owed, c.currency, base, owedBase),
        ...(owedBase !== undefined ? { converted: { amountBase: owedBase, rate: run.fxRates[c.currency]! } } : {}),
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
// A chase asks for payment by `payBy` and carries no other date the counterparty could read as a grace
// period: not the engine's assumed date, not our expected-payment dates, not the owner's needed-by.
//   - not yet due (or due today): payBy is the due date, or an earlier assumed date;
//   - overdue: payBy is the assumed date, when there is one.
export type DraftFacts = Omit<Facts, "lowPoint" | "safetyLine" | "amountAfterLever" | "cashEffect" | "cashEffectMeans" | "neededBy" | "neededByStatus" | "lever" | "commitment" | "expected"> & {
  lever?: Omit<LeverFacts, "assumeDate"> & { assumeDate?: string };
  neededBy?: string;
  neededByStatus?: Facts["neededByStatus"];
  commitment?: Omit<NonNullable<Facts["commitment"]>, "converted">;
  expected: Omit<Facts["expected"][number], "amountBase" | "converted" | "againstLowPoint">[];
  payBy?: string;
};

export function payByFor(f: Facts): string | undefined {
  const cm = f.commitment;
  const assume = f.lever?.assumeDate;
  const notYetDue = cm?.dueStatus === "not yet due" || cm?.dueStatus === "due today";
  if (!notYetDue) return assume && assume >= f.asOf ? assume : undefined;
  return assume && cm?.due && assume < cm.due ? assume : cm?.due;
}

// To the counterparty the figures are the document's own: no converted base-currency figure, and no
// comparison with the owner's lowest point.
export function draftFacts(f: Facts): DraftFacts {
  const { lowPoint: _l, safetyLine: _s, amountAfterLever: _a, cashEffect: _c, cashEffectMeans: _m, commitment, ...rest } = f;
  const own = commitment ? (() => {
    const { converted: _v, ...c } = commitment;
    return { ...c, display: fmtMoney(c.outstanding ?? c.amount, c.currency) };
  })() : undefined;
  const expected = f.expected.map(({ amountBase: _b, converted: _v, againstLowPoint: _g, ...e }) => ({ ...e, display: fmtMoney(e.amount, e.currency) }));
  const out = { ...rest, ...(own ? { commitment: own } : {}), expected };
  if (f.lever?.kind !== "chase") return out;
  const { neededBy: _n, neededByStatus: _ns, lever, ...others } = out;
  const { assumeDate: _d, ...leverRest } = lever!;
  const payBy = payByFor(f);
  return { ...others, lever: leverRest, expected: [], ...(payBy ? { payBy } : {}) };
}

// ---------------------------------------------------------------------------
// Formatting for code-built text

// ---------------------------------------------------------------------------
// Deterministic fallbacks (code only; no model)
//
// Wording rules, shared with the prompts: tense follows the document's `dueStatus` against asOf (an invoice
// not yet due "is due Dec 10", never "was due"); the expected payment sits "after your lowest point", not
// "after your lowest week"; `neededBy` is when to ask or act ("Ask by Dec 12"), never a settlement date;
// a foreign-currency figure is stated in its own currency with the converted figure marked as converted.

const partyName = (f: Facts, fallback: string) => f.party?.name ?? fallback;
const docRef = (f: Facts) => f.commitment?.reference ?? "the open document";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const AGAINST_LOW_POINT = { after: "after your lowest point", before: "before your lowest point", "same day": "on the day of your lowest point" };

// "INV-1187 for $28,000 is due Dec 10." / "... is due today." / "... is overdue by 5 days (due Dec 10)."
function docLine(f: Facts): string {
  const cm = f.commitment;
  if (!cm) return "";
  const ref = cap(docRef(f));
  const what = cm.reference ? `${ref} for ${cm.display}` : `${ref} (${cm.display})`;
  switch (cm.dueStatus) {
    case undefined: return `${what}.`;
    case "due today": return `${what} is due today.`;
    case "not yet due": return `${what} is due ${fmtDate(cm.due!, f.asOf)}.`;
    default: return `${what} is ${cm.dueStatus} (due ${fmtDate(cm.due!, f.asOf)}).`;
  }
}

// "Payment is expected Dec 26, after your lowest point."
function expectedLine(f: Facts): string {
  const e = f.expected[0];
  if (!e) return "";
  return `Payment is expected ${e.date === f.asOf ? "today" : fmtDate(e.date, f.asOf)}, ${AGAINST_LOW_POINT[e.againstLowPoint]}.`;
}

// neededBy is when to ask or act. Returns a sentence; "Ask by Dec 12." / "Ask today."
function actBy(f: Facts, verb: "Ask" | "Act"): string {
  if (f.neededByStatus === "today") return `${verb} today.`;
  if (f.neededByStatus === "passed") return `${verb} now; this was needed by ${fmtDate(f.neededBy, f.asOf)}.`;
  return `${verb} by ${fmtDate(f.neededBy, f.asOf)}.`;
}

export function fallbackBrief(f: Facts): { title: string; why: string } {
  const money = (n: number) => fmtMoney(n, f.baseCurrency);
  const date = (d: string) => fmtDate(d, f.asOf);
  const cm = f.commitment;
  const lift = f.amountAfterLever === undefined ? "helps your lowest point"
    : `lifts your lowest point from ${money(f.lowPoint.amount)} (week of ${date(f.lowPoint.week)}) to ${money(f.amountAfterLever)}`;
  const kind = f.lever?.kind;
  const join = (...parts: string[]) => parts.filter(Boolean).join(" ");
  switch (kind) {
    case "chase": {
      const assume = f.lever?.assumeDate ?? f.neededBy;
      return {
        title: `Chase ${partyName(f, "the customer")} on ${docRef(f)}`,
        why: join(docLine(f), expectedLine(f), `Collecting ${cm ? "it" : "this payment"} by ${date(assume)} ${lift}.`,
          assume === f.neededBy ? "" : actBy(f, "Ask")),
      };
    }
    case "defer":
      return {
        // Name the document, so two open bills from one supplier never read the same; the why gives the days.
        title: cm?.reference
          ? `Ask ${partyName(f, "the supplier")} to move ${cm.reference}`
          : `Ask ${partyName(f, "the supplier")} for ${f.lever?.days} more days`,
        why: join(docLine(f), `Moving the ${docRef(f)} payment back ${f.lever?.days} days ${lift}.`, actBy(f, "Ask")),
      };
    case "ask_advance":
      return {
        title: `Ask ${partyName(f, "the customer")} for a ${f.lever?.advancePct}% advance`,
        why: join(docLine(f), `Asking for ${f.lever?.advancePct}% up front on ${docRef(f)} ${lift}.`, actBy(f, "Ask")),
      };
    case "split":
      return {
        title: `Split the ${docRef(f)} payment`,
        why: join(docLine(f), `Paying ${docRef(f)} in ${f.lever?.parts} parts ${lift}.`, actBy(f, "Act")),
      };
    case "pay_early":
      return {
        title: `Pay ${docRef(f)} early for the discount`,
        why: join(`Paying ${partyName(f, "this supplier")} early saves ${money(f.cashEffect)}.`, actBy(f, "Act")),
      };
    default:
      return {
        title: `Review ${f.warning.replace(/_/g, " ")}`,
        why: `Your lowest point is ${money(f.lowPoint.amount)} in the week of ${date(f.lowPoint.week)}, against a ${money(f.safetyLine)} safety line.`,
      };
  }
}

export function fallbackDraft(f: Facts, business: string): { subject?: string; body: string } {
  const date = (d: string) => (d === f.asOf ? "today" : fmtDate(d, f.asOf));
  const cm = f.commitment;
  const name = f.party?.name;
  const hello = name ? `Hello ${name},` : "Hello,";
  const ref = cm?.reference ?? "the open item";
  // To the counterparty, the amount is the document's own: no converted figure.
  const amt = cm ? fmtMoney(cm.outstanding ?? cm.amount, cm.currency) : undefined;
  const sign = `Thank you,\n${business}`;
  const lines: string[] = [hello, ""];
  let subject: string;
  switch (f.lever?.kind) {
    case "chase": {
      subject = cm?.reference ? (amt ? `Invoice ${ref}: ${amt}` : `Invoice ${ref}`) : "Open invoice";
      const due = cm?.due && cm.dueStatus
        ? `, which ${cm.dueStatus === "due today" ? "is due today" : cm.dueStatus === "not yet due" ? `is due ${date(cm.due)}` : `was due ${date(cm.due)}`}`
        : cm?.due ? `, due ${date(cm.due)}` : "";
      const payBy = payByFor(f);
      lines.push(
        `I'm following up on ${cm?.reference ? `invoice ${ref}` : "an open invoice"}${amt ? ` for ${amt}` : ""}${due}.` +
        ` Could you let me know when we can expect payment?` +
        (payBy ? ` Payment ${payBy === f.asOf ? "today" : `by ${date(payBy)}`} would help us a great deal.` : ""),
        "", "If anything is holding it up, please tell me and I will help sort it out.");
      break;
    }
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
export const prompt = (file: string): string => {
  let t = promptCache.get(file);
  if (t === undefined) {
    t = readFileSync(join(import.meta.dirname, "prompts", file), "utf8");
    promptCache.set(file, t);
  }
  return t;
};
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export type Turn = { role: "user" | "assistant"; content: string };

// One structured-output call. Never throws; a problem string says why there is no output.
export async function callStructured<T>(
  client: Anthropic | undefined, model: string, system: string, turns: Turn[], schema: z.ZodType<T>, effort: "low" | "medium",
): Promise<{ output: T } | { problem: string }> {
  try {
    client ??= new Anthropic(anthropicOptions()); // configured from ANTHROPIC_API_KEY
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
export const factsBlock = (facts: unknown) => `<facts>\n${JSON.stringify(facts, null, 1).replace(/<\/facts/gi, "<\\/facts")}\n</facts>`;

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
    day: new Set([...(f.lever?.days !== undefined ? [f.lever.days] : []), ...(f.party?.medianDaysLate !== undefined ? [Math.abs(f.party.medianDaysLate)] : []),
      ...(f.commitment?.daysOverdue !== undefined ? [f.commitment.daysOverdue] : []), ...basis]),
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

// Tense and phrasing rules (P4.18). Tense is relative to asOf, through the code-computed dueStatus: nothing
// that is not yet due "was due", nothing that is overdue "is due". neededBy is when to ask or act, not a
// settlement date. The expected date sits "after your lowest point"; a week is not a point in time.
const PAST_DUE_RE = /\b(?:was|were)\s+due\b|\b(?:is|are)\s+(?:now\s+)?(?:overdue|past\s+due)\b/i;
const FUTURE_DUE_RE = /\bnot\s+yet\s+due\b|\b(?:is|are)\s+due\b/i;
const SETTLED_BY_RE = /\bsettle[ds]?\s+by\b|\bsettlement\s+by\b/i;
const LOWEST_WEEK_RE = /\b(?:after|before)\s+(?:your|the)\s+lowest\s+week\b/i;

function tenseProblem(text: string, f: Facts): string | undefined {
  const overdue = f.commitment?.daysOverdue !== undefined;
  if (!overdue && PAST_DUE_RE.test(text)) return `says something was due or overdue, but as of ${f.asOf} nothing is (use "is due" for a date that has not passed)`;
  if (overdue && FUTURE_DUE_RE.test(text)) return `says the document is due, but it is ${f.commitment!.dueStatus} as of ${f.asOf}`;
  return undefined;
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
    ...[tenseProblem(text, f)].filter((x): x is string => !!x),
    ...(SETTLED_BY_RE.test(text) ? ['"settled by" is wrong: neededBy is when to ask or act (write "ask by" or "act by")'] : []),
    ...(LOWEST_WEEK_RE.test(text) ? ['write "after your lowest point", not "after your lowest week"'] : []),
  ];
  return parts.length ? parts.join("; ") : undefined;
}

// Phrases that claim something was sent or paid. Drafts are text for the owner to send; they never say it was.
const CLAIM_RE = /\bsent\b|\b(?:we|i)(?:'ve| have)?\s+(?:already\s+|just\s+)?(?:paid|wired|transferred)\b|\b(?:have|has|had|already|just|am|are|was|were)\s+(?:been\s+)?(?:paid|wired|transferred|submitted|processed)\b|\bi(?:'ve| have)\s+paid\b|\bon its way\b|\bpayment\s+(?:is|was)\s+(?:made|processed|complete)/i;

// A chase for an invoice that is not yet due asks for payment by the due date or earlier. A later date
// would read as a grace period.
function chaseDateProblem(text: string, f: Facts): string | undefined {
  const due = f.commitment?.due;
  if (f.lever?.kind !== "chase" || !due || (f.commitment?.dueStatus !== "not yet due" && f.commitment?.dueStatus !== "due today")) return undefined;
  const late = extractDates(text, { asOf: f.asOf }).find((d) => d.date > due);
  return late ? `"${late.raw}" is after the due date; an invoice that is not yet due is chased for the due date or earlier` : undefined;
}

export function checkDraftText(subject: string | undefined, body: string, item: WorkItem, f: Facts): string | undefined {
  if (!body.trim()) return "empty body";
  const all = `${subject ?? ""}\n${body}`;
  const hygiene = hygieneProblem(all, f);
  if (hygiene) return hygiene;
  if (CLAIM_RE.test(all)) return "claims something was sent or paid";
  // A message to a counterparty may state only what is on the document: never our own cash position
  // (low point, safety line) or the lever's effect on it.
  const r = checkText(all, citationsFor(item, f), allowedFromFacts(draftFacts(f)), checkOpts(f));
  const parts = [...r.unmatched.map((u) => `${u.kind} "${u.raw}" is not in the facts`), ...r.problems, ...countProblems(all, f),
    ...[tenseProblem(all, f), chaseDateProblem(all, f)].filter((x): x is string => !!x)];
  return parts.length ? parts.join("; ") : undefined;
}

const feedback = (problems: string[]) =>
  `Your previous answer failed validation:\n${problems.map((p) => `- ${p}`).join("\n")}\n` +
  "Use only the amounts and dates in the facts, keep titles to 8 words, include no links, and claim nothing was sent or paid. " +
  "Keep tenses relative to asOf, write neededBy as \"ask by\" or \"act by\", and name the currency as the facts do. " +
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
