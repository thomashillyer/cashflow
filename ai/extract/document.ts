// Layer 1, document understanding (P4.6): classify a document relative to the business and extract
// fields as raw strings with verbatim quotes. Claude reads; code computes. Everything the model
// returns is checked here: quotes are located in the source, amounts and dates are parsed by code,
// and the kind/direction are cross-checked against the business role.
//
// Two halves:
//  - callModel / extractDocument: one structured-output call, with a file cache in front of it.
//  - toCandidate: pure normalization of ExtractionOutput into an IntakeCandidate.
// Message and document text is data. It goes only into <document> tags and the extraction schema;
// no output field can express settlement, payment, or any action.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import type { Direction } from "../../schema/records";
import type { CandidateFields, DocumentKind, Field, IntakeCandidate } from "../../schema/intake";
import { cacheKey, DEFAULT_CACHE_DIR, readCache, writeCache } from "../cache";
import { EXTRACTION_MODEL, PROMPT_VERSION } from "../config";
import {
  fieldFrom, locateQuote, missing, parseAmount, parseDate, validateCandidate, type SourceSegment,
} from "../normalize";

// ---------------------------------------------------------------------------
// Model output schema

const RawField = z.object({ value: z.string().nullable(), quote: z.string().nullable() });
type RawField = z.infer<typeof RawField>;

export const ExtractionOutput = z.object({
  kind: z.enum(["invoice", "bill", "purchase_order", "payment_evidence", "conversational_update", "none"]),
  businessRole: z.enum(["seller", "buyer", "unknown"]),
  fields: z.object({
    sellerName: RawField,
    buyerName: RawField,
    reference: RawField,
    poReference: RawField,
    amount: RawField,
    outstanding: RawField,
    currency: RawField,
    issueDate: RawField,
    dueDate: RawField,
    terms: RawField,
    invoiceUrl: RawField,
    paymentUrl: RawField,
    statedStatus: RawField,
    paidAmount: RawField,
    paidDate: RawField,
  }),
  coversReferences: z.array(z.string()),
  containsInstructions: z.boolean(),
  confidence: z.number(),
  notes: z.array(z.string()),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutput>;

export type BusinessIdentity = { name: string; aliases?: string[] };

// ---------------------------------------------------------------------------
// Prompt and request

// Source limit from docs/TECHNICAL_PLAN.md section 5. Over it we ask for splitting rather than truncating.
export const MAX_SOURCE_CHARS = 50_000;
const MODEL_TIMEOUT_MS = 30_000;

let promptText: string | undefined;
export function systemPrompt(): string {
  promptText ??= readFileSync(join(import.meta.dirname, "../prompts/extract_document.md"), "utf8");
  return promptText;
}

// A document that contains the closing tag must not be able to end its own data block.
const escapeDocument = (text: string) => text.replace(/<\/document/gi, "<\\/document");
const attr = (v: string) => v.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!);

export function buildUserContent(segments: SourceSegment[], business: BusinessIdentity): string {
  const aliases = [...new Set(business.aliases ?? [])];
  const identity = [`name: ${business.name}`, ...(aliases.length ? [`aliases: ${aliases.join("; ")}`] : [])].join("\n");
  const docs = segments.map((s) =>
    `<document evidence_id="${attr(s.evidenceId)}"${s.page !== undefined ? ` page="${s.page}"` : ""}>\n${escapeDocument(s.text)}\n</document>`);
  return [`<business>\n${identity}\n</business>`, ...docs].join("\n\n");
}

export function extractionCacheKey(segments: SourceSegment[], business: BusinessIdentity, model = EXTRACTION_MODEL): string {
  return cacheKey({
    promptVersion: PROMPT_VERSION,
    model,
    business: { name: business.name, aliases: [...new Set(business.aliases ?? [])].sort() },
    segments: segments.map((s) => ({ evidenceId: s.evidenceId, page: s.page, text: s.text })),
  });
}

// One structured-output call. Returns the parsed output, or a reason the caller should send the
// document to review. Never throws.
export async function callModel(
  client: Anthropic, segments: SourceSegment[], business: BusinessIdentity, model: string,
): Promise<{ output: ExtractionOutput } | { problem: string }> {
  try {
    // messages.create with a structured-output format rather than messages.parse: parse() throws on
    // a refusal or a cut-off answer before stop_reason can be read, and we want to say which it was.
    const res = await client.messages.create(
      {
        model,
        max_tokens: 16000,
        // Stable text first, marked for prompt caching. `thinking` is left at the model default.
        system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: buildUserContent(segments, business) }],
        output_config: { effort: "low", format: zodOutputFormat(ExtractionOutput) },
      },
      { timeout: MODEL_TIMEOUT_MS },
    );
    if (res.stop_reason === "refusal") return { problem: "the model declined to read this document" };
    if (res.stop_reason === "max_tokens") return { problem: "the model's answer was cut off before it finished" };
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text" || block.text.trim() === "") return { problem: "the model returned no structured answer" };
    let json: unknown;
    try {
      json = JSON.parse(block.text);
    } catch {
      return { problem: "the model's answer was not valid JSON" };
    }
    const parsed = ExtractionOutput.safeParse(json);
    if (!parsed.success) return { problem: "the model's answer did not match the extraction schema" };
    return { output: parsed.data };
  } catch (err) {
    return { problem: `the extraction call failed (${err instanceof Error ? err.message : String(err)})` };
  }
}

// ---------------------------------------------------------------------------
// extractDocument: cache, then (live mode only) the model

export type ExtractDocumentOptions = {
  business: BusinessIdentity;
  candidateId: string;
  revision: number;
  evidenceIds: string[];
  mode: "live" | "cache_only";
  client?: Anthropic;      // live mode; defaults to a client configured from ANTHROPIC_API_KEY
  cacheDir?: string;
  model?: string;
  dayFirst?: boolean;      // numeric dates in these documents are day/month/year
};

export async function extractDocument(segments: SourceSegment[], opts: ExtractDocumentOptions): Promise<IntakeCandidate> {
  const model = opts.model ?? EXTRACTION_MODEL;
  const base = { candidateId: opts.candidateId, revision: opts.revision, evidenceIds: opts.evidenceIds, dayFirst: opts.dayFirst };

  const chars = segments.reduce((n, s) => n + s.text.length, 0);
  if (segments.every((s) => s.text.trim() === "")) {
    return reviewCandidate(base, "unreadable", ["No text could be read from this document. Upload a text version or enter the fields manually."]);
  }
  if (chars > MAX_SOURCE_CHARS) {
    return reviewCandidate(base, "partial", [`The document is over ${MAX_SOURCE_CHARS.toLocaleString("en-US")} characters; split it or enter the fields manually.`]);
  }

  const dir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
  const key = extractionCacheKey(segments, opts.business, model);
  const hit = readCache(dir, key);
  if (hit) {
    const parsed = ExtractionOutput.safeParse(hit.output);
    if (parsed.success) return toCandidate(parsed.data, segments, base);
    // A cache entry that no longer fits the schema is a miss.
  }
  if (opts.mode === "cache_only") {
    return reviewCandidate(base, "partial", ["no cached extraction (demo mode)"]);
  }

  const result = await callModel(opts.client ?? new Anthropic(), segments, opts.business, model);
  if ("problem" in result) {
    return reviewCandidate(base, "partial", [`Could not extract fields: ${result.problem}. Review the document manually.`]);
  }
  try {
    writeCache(dir, { key, promptVersion: PROMPT_VERSION, model, source: "live", output: result.output });
  } catch {
    // A failed cache write must not lose a good extraction.
  }
  return toCandidate(result.output, segments, base);
}

// ---------------------------------------------------------------------------
// toCandidate: raw model output -> IntakeCandidate (pure)

export type ToCandidateOptions = {
  candidateId: string;
  revision: number;
  evidenceIds: string[];
  dayFirst?: boolean;
  extractionVersion?: string;
};

const MAX_MODEL_NOTES = 5;
const MAX_NOTE_CHARS = 300;

// A "nothing usable" candidate that routes to review: kind none, every field missing.
export function reviewCandidate(
  opts: ToCandidateOptions, extraction: "partial" | "unreadable", notes: string[],
): IntakeCandidate {
  const reason = notes[0];
  return {
    id: opts.candidateId, revision: opts.revision, extractionVersion: opts.extractionVersion ?? PROMPT_VERSION,
    evidenceIds: opts.evidenceIds, kind: "none",
    fields: {
      sellerName: missing(reason), buyerName: missing(reason), reference: missing(reason), amount: missing(reason),
      currency: missing(reason), issueDate: missing(reason), dueDate: missing(reason),
    },
    confidence: 0, extraction, notes,
  };
}

// Currencies whose symbol identifies them without help.
const UNAMBIGUOUS_SYMBOLS: Record<string, string> = { "€": "EUR", "£": "GBP" };

const knownCurrencies = (() => {
  try { return new Set(Intl.supportedValuesOf("currency")); } catch { return new Set<string>(); }
})();

const narrowSymbol = (code: string): string => {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" })
      .formatToParts(0).find((p) => p.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
};

// An ISO 4217 code as written, or a symbol resolved through a code printed elsewhere in the text.
// "$" alone never becomes USD: it could be CAD, AUD, and others.
function readCurrency(raw: string, segments: SourceSegment[]): string | undefined {
  const v = raw.trim();
  if (/^[A-Za-z]{3}$/.test(v)) {
    const code = v.toUpperCase();
    return knownCurrencies.has(code) ? code : undefined;
  }
  const direct = UNAMBIGUOUS_SYMBOLS[v];
  if (direct) return direct;
  const printed = new Set<string>();
  for (const s of segments) {
    for (const m of s.text.matchAll(/\b[A-Z]{3}\b/g)) if (knownCurrencies.has(m[0])) printed.add(m[0]);
  }
  const matches = [...printed].filter((code) => narrowSymbol(code) === v);
  return matches.length === 1 ? matches[0] : undefined;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

const NULL_FIELD: RawField = { value: null, quote: null };

export function toCandidate(
  output: ExtractionOutput, segments: SourceSegment[], opts: ToCandidateOptions,
): IntakeCandidate {
  const notes: string[] = [];
  const raw = { ...output.fields };

  // ---- kind and direction: the model's kind is cross-checked against which side the business is on
  let kind: DocumentKind = output.kind;
  const role = output.businessRole;
  if (kind === "invoice" && role === "buyer") {
    kind = "bill";
    notes.push("Reclassified as a bill: the business is the buyer on this document.");
  } else if (kind === "bill" && role === "seller") {
    kind = "invoice";
    notes.push("Reclassified as an invoice: the business is the seller on this document.");
  }
  const byRole: Direction | undefined = role === "seller" ? "in" : role === "buyer" ? "out" : undefined;
  let direction: Direction | undefined;
  if (kind === "invoice") direction = "in";
  else if (kind === "bill") direction = "out";
  else if (kind === "purchase_order" || kind === "payment_evidence") direction = byRole;
  if (role === "unknown" && (kind === "invoice" || kind === "bill" || kind === "purchase_order" || kind === "payment_evidence")) {
    notes.push("Could not tell which side of this document the business is on; check the direction.");
  }

  // ---- fields the model must not have filled in
  const everyRaw = Object.entries(raw) as [keyof ExtractionOutput["fields"], RawField][];
  const stated = everyRaw.some(([, f]) => f.value !== null && f.value.trim() !== "");
  const ignored: (keyof ExtractionOutput["fields"])[] = [];
  let covers = output.coversReferences;
  if (kind === "none") {
    for (const [name] of everyRaw) raw[name] = NULL_FIELD;
    covers = [];
    if (stated) notes.push("Ignored extracted fields: the document has no cash-relevant content.");
  } else if (output.containsInstructions && kind === "conversational_update") {
    // Text that tries to steer the assistant never contributes figures or status.
    for (const name of ["amount", "outstanding", "paidAmount", "paidDate", "statedStatus", "invoiceUrl", "paymentUrl"] as const) {
      if (raw[name].value !== null) ignored.push(name);
      raw[name] = NULL_FIELD;
    }
    covers = [];
    if (ignored.length) notes.push("Ignored amounts and status from a message that contains instructions.");
  }

  // ---- currency first: amounts are parsed with it
  const currency = fieldFrom<string>(raw.currency, segments, (v) => readCurrency(v, segments), "currency");
  const code = currency.state === "found" ? currency.value : undefined;
  const money = (r: RawField, label: string): Field<number> => {
    if (r.value === null || r.value.trim() === "") return missing(`${label} not stated`);
    if (!code) return missing(`${label} not read: currency is missing or unclear`);
    return fieldFrom<number>(r, segments, (v) => {
      const n = parseAmount(v, code);
      return n !== undefined && n >= 0 ? n : undefined;
    }, label);
  };

  const ambiguousDates: string[] = [];
  const date = (r: RawField, label: string): Field<string> =>
    fieldFrom<string>(r, segments, (v) => {
      const d = parseDate(v, { dayFirst: opts.dayFirst });
      if (d?.ambiguous) ambiguousDates.push(`${label} "${v}"`);
      return d?.date;
    }, label);
  const text = (r: RawField, label: string): Field<string> => fieldFrom<string>(r, segments, (v) => v || undefined, label);
  const url = (r: RawField, label: string): Field<string> =>
    fieldFrom<string>(r, segments, (v) => {
      const u = v.replace(/[.,;:!?)]+$/, "");
      return /^https?:\/\/\S+$/i.test(u) ? u : undefined;
    }, label);

  const fields: CandidateFields = {
    sellerName: text(raw.sellerName, "seller name"),
    buyerName: text(raw.buyerName, "buyer name"),
    reference: text(raw.reference, "reference"),
    amount: money(raw.amount, "amount"),
    currency,
    issueDate: date(raw.issueDate, "issue date"),
    dueDate: date(raw.dueDate, "due date"),
  };
  // Optional fields appear when the document stated something, found or not (a failed one explains why).
  const optional = <K extends Exclude<keyof CandidateFields, "coversReferences">>(name: K, f: CandidateFields[K], r: RawField) => {
    if (f && (f.state !== "missing" || (r.value !== null && r.value.trim() !== ""))) (fields as Record<string, unknown>)[name] = f;
  };
  optional("poReference", text(raw.poReference, "PO reference"), raw.poReference);
  optional("outstanding", money(raw.outstanding, "outstanding"), raw.outstanding);
  optional("terms", text(raw.terms, "terms"), raw.terms);
  optional("invoiceUrl", url(raw.invoiceUrl, "invoice link"), raw.invoiceUrl);
  optional("paymentUrl", url(raw.paymentUrl, "payment link"), raw.paymentUrl);
  optional("statedStatus", text(raw.statedStatus, "stated status"), raw.statedStatus);  // shown, never mapped to settlement
  optional("paidAmount", money(raw.paidAmount, "paid amount"), raw.paidAmount);
  optional("paidDate", date(raw.paidDate, "paid date"), raw.paidDate);

  if (kind === "payment_evidence" && covers.length) {
    const found = covers.flatMap((ref) => {
      const e = locateQuote(segments, ref);
      return e ? [{ ref: ref.trim(), e }] : [];
    });
    fields.coversReferences = found.length
      ? { state: "found", value: found.map((f) => f.ref), evidence: found.map((f) => f.e) }
      : missing("referenced invoice numbers not found in the source");
    if (found.length < covers.length) notes.push("Some invoice numbers the model listed are not in the source and were dropped.");
  }

  if (ambiguousDates.length) {
    notes.push(`Ambiguous date order for ${ambiguousDates.join(", ")}; kept as ${opts.dayFirst ? "day/month" : "month/day"}, please confirm.`);
  }

  // ---- extraction state
  const found = (f: Field<unknown> | undefined) => f?.state === "found";
  let extraction: IntakeCandidate["extraction"];
  if (kind === "invoice" || kind === "bill" || kind === "purchase_order") {
    extraction = found(fields.amount) && found(fields.currency) && found(fields.reference) ? "ok" : "partial";
  } else if (kind === "payment_evidence") {
    extraction = found(fields.paidAmount) && found(fields.currency) ? "ok" : "partial";
  } else {
    extraction = "ok"; // conversational_update becomes a Signal; none has nothing to extract
  }
  if (extraction === "partial") {
    for (const [name, f] of Object.entries(fields) as [string, Field<unknown>][]) {
      if (f.state === "missing" && f.reason && !/not stated$/.test(f.reason)) notes.push(`${name}: ${f.reason}`);
    }
  }

  // ---- instructions inside the document
  let confidence = clamp01(output.confidence);
  if (output.containsInstructions) {
    notes.push("The document contains text addressed to an assistant (instructions). It was ignored; review before relying on it.");
    confidence = Math.min(confidence, 0.5);
    if (extraction === "ok") extraction = "partial"; // routes to review
  }

  // ---- model notes are display text only
  for (const n of output.notes.slice(0, MAX_MODEL_NOTES)) {
    const t = n.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS);
    if (t) notes.push(t);
  }

  const candidate: IntakeCandidate = {
    id: opts.candidateId, revision: opts.revision, extractionVersion: opts.extractionVersion ?? PROMPT_VERSION,
    evidenceIds: opts.evidenceIds, kind, ...(direction ? { direction } : {}),
    fields, confidence, extraction, notes,
  };
  const issues = validateCandidate(candidate);
  if (issues.length) {
    for (const i of issues) candidate.notes.push(`Validation: ${i.field}: ${i.problem}`);
    if (candidate.extraction === "ok") candidate.extraction = "partial";
  }
  return candidate;
}
