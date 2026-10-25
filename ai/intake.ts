// The intake pipeline (P4.16): one ingest() from already-captured input to everything the Review
// screen needs: Evidence, candidates, ChangeProposals, and Signals. Nothing is applied here. Applying
// happens only when the owner confirms (applyProposal / the confirm RPC), and a signal only through
// its own state.
//
// Boundary: this is the interpretation step behind the adapters. Capture, original-file storage,
// source ids, XLSX reading, CSV/Zoho parsing, and URL fetching belong to the adapters lane; ingest
// accepts what they hand over (bytes, text, SheetContent, optional caller-supplied evidence ids and
// source refs) and falls back to content-hash ids only when none are given. Same input in, same ids
// out, so a re-import proposes the same things (and applying them twice is a no-op).
//
// Rules for bundles (docs/TECHNICAL_PLAN.md sections 5-6A):
//  - An email/chat with attachments: each PDF/XLSX attachment is its own candidate and carries the
//    kind, reference, and amount. The message body is a covering note and the source of signals.
//  - A message with no attachment becomes a commitment candidate only when its own extraction is an
//    invoice/bill/PO with a reference and amount found in the body text (a reference that appears only
//    inside a URL never counts).
//  - Link children are deduped by URL (payment > invoice > other). A message's invoice/payment URL
//    fills the attachment candidate's field only when the attachment does not state one.
//  - Unreadable, oversized, or unsupported files become Evidence plus a review proposal that says what
//    to upload; never a zero-amount candidate.
//  - Text in any input is data. It reaches the model only through the extraction schemas.

import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  CandidateFields, ChangeProposal, Field, IntakeCandidate, PartyCandidate,
} from "../schema/intake";
import type { Evidence, Records, Signal, SourceRef } from "../schema/records";
import { extractDocument, MAX_SOURCE_CHARS, NO_CACHED_EXTRACTION, reviewCandidate } from "./extract/document";
import { parseEmail, parsePaste, parseWhatsApp, type LinkKind, type MessageBundle } from "./extract/message";
import { extractPdfText, type PdfText } from "./extract/pdf";
import { classifySheet, documentToCandidate, tableToCandidates, type ColumnMapping, type SheetContent } from "./extract/sheet";
import { extractSignals } from "./extract/signals";
import type { SourceSegment } from "./normalize";
import { propose } from "./reconcile/match";
import { nameSimilarity, nameTokens, resolveParty } from "./reconcile/parties";

// ---------------------------------------------------------------------------
// Contract

// Ids and provenance an adapter already assigned. Every field is optional; content hashes fill the gaps.
export type InputSource = {
  evidenceId?: string;
  sourceRef?: SourceRef;
  receivedAt?: string;           // ISO; when the item reached the business
};

export type Attachment = {
  fileName: string;
  bytes: Uint8Array;
  sheets?: SheetContent[];       // an XLSX attachment already read by the adapters lane
  source?: InputSource;
};

export type IntakeInput =
  | { kind: "pdf"; bytes: Uint8Array; fileName?: string; source?: InputSource }
  | { kind: "email"; raw: string; attachments?: Attachment[]; source?: InputSource }
  | { kind: "whatsapp"; raw: string; attachments?: Attachment[]; source?: InputSource }
  | { kind: "paste"; text: string; receivedAt: string; source?: InputSource }
  | {
    kind: "sheet"; sheets: SheetContent[]; source?: InputSource;
    currency?: string; dayFirst?: boolean; columnMapping?: ColumnMapping; headerRow?: number;
  };

export type IntakeContext = {
  records: Records;                       // the store as the owner sees it now; never mutated
  storeRevision: number;                  // pinned onto every proposal
  business: { name: string; aliases?: string[] };
  mode: "live" | "cache_only";
  now: string;                            // ISO instant; the clock is passed in
  timeZone?: string;                      // business time zone for relative dates
  client?: Anthropic;                     // live mode
  cacheDir?: string;                      // see extractDocument / extractSignals
};

export type IntakeNote = { scope: string; text: string };   // scope: a candidate, signal, proposal, or evidence id

export type IntakeResult = {
  evidence: Evidence[];                   // parents, attachments, and link children, deduped
  candidates: IntakeCandidate[];
  proposals: ChangeProposal[];            // one per candidate, all "proposed"
  signals: Signal[];                      // all "proposed"
  notes: IntakeNote[];
};

// Add intake Evidence to the records the store holds (by id; existing rows win). Persons 3/5 persist
// Evidence in the same transaction as the confirmed proposal; this is the pure form of that step.
export function mergeEvidence(records: Records, evidence: Evidence[]): Records {
  const have = new Set(records.evidence.map((e) => e.id));
  return { ...records, evidence: [...records.evidence, ...evidence.filter((e) => !have.has(e.id))] };
}

// ---------------------------------------------------------------------------
// Helpers

const MAX_ATTACHMENTS = 10;
const MAX_SHEETS = 4;
const EVIDENCE_TEXT_MAX = MAX_SOURCE_CHARS; // the most extraction reads, so every quoted span is stored
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const bounded = (text: string) => (text.length > EVIDENCE_TEXT_MAX ? text.slice(0, EVIDENCE_TEXT_MAX) : text);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
const foundValue = <T>(f: Field<T> | undefined): T | undefined => (f && f.state === "found" ? f.value : undefined);

const URL_RE = /https?:\/\/[^\s<>"'()[\]]+/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const normRef = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

const LINK_STRENGTH: Record<LinkKind, number> = { payment: 3, invoice: 2, other: 1 };

function isPdf(bytes: Uint8Array, fileName: string): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-") || /\.pdf$/i.test(fileName);
}

const MIME: Record<string, string> = {
  pdf: "application/pdf", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel", csv: "text/csv", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
};
const extOf = (name: string) => name.toLowerCase().split(".").pop() ?? "";

class Collector {
  readonly evidence = new Map<string, Evidence>();
  readonly candidates: IntakeCandidate[] = [];
  readonly notes: IntakeNote[] = [];
  readonly signals: Signal[] = [];
  // Message bodies whose candidate is a conversational update, with the signals read from the same body.
  readonly messageLinks: { candidateId: string; signals: Signal[] }[] = [];

  addEvidence(...items: Evidence[]) {
    for (const e of items) if (!this.evidence.has(e.id)) this.evidence.set(e.id, e);
  }
  addCandidate(c: IntakeCandidate) {
    if (!this.candidates.some((x) => x.id === c.id)) this.candidates.push(c);
  }
  note(scope: string, text: string) {
    if (!this.notes.some((n) => n.scope === scope && n.text === text)) this.notes.push({ scope, text });
  }
}

// ---------------------------------------------------------------------------
// Counterparty resolution

// Which existing party this document is with. Certain only on a confirmed identity: a known email
// domain printed on the document or its message, or a name that is the same legal name once suffixes
// like "LLC"/"Co." are dropped and is unique among the parties. Anything else stays a candidate for review.
function withCounterparty(
  c: IntakeCandidate, records: Records, texts: string[], extraEmails: string[],
): IntakeCandidate {
  if (c.partyId) return c;
  if (c.kind !== "invoice" && c.kind !== "bill" && c.kind !== "purchase_order" && c.kind !== "payment_evidence") return c;
  const direction = c.direction ?? (c.kind === "invoice" ? "in" : c.kind === "bill" ? "out" : undefined);
  if (!direction) return c;
  const name = foundValue(direction === "in" ? c.fields.buyerName : c.fields.sellerName);
  const parties = records.parties;
  const nameOf = (id: string) => parties.find((p) => p.id === id)?.name ?? id;

  const emails = [...new Set([...texts.flatMap((t) => t.match(EMAIL_RE) ?? []), ...extraEmails].map((e) => e.toLowerCase()))];
  const byEmail = new Set<string>();
  for (const email of emails) {
    const r = resolveParty({ email }, parties);
    if ("partyId" in r) byEmail.add(r.partyId);
  }

  let partyId: string | undefined;
  let candidates: PartyCandidate[] = [];
  if (byEmail.size === 1) {
    const id = [...byEmail][0]!;
    if (!name || nameSimilarity(name, nameOf(id)) >= 0.5) partyId = id;
    else candidates = [{ partyId: id, name, reason: `email domain matches "${nameOf(id)}" but the document names "${name}"` }];
  } else if (byEmail.size > 1) {
    candidates = [...byEmail].map((id) => ({ partyId: id, name, reason: "the document shows email domains of several known parties" }));
  } else if (name) {
    const r = resolveParty({ name }, parties);
    if ("candidates" in r) {
      const key = nameTokens(name).sort().join(" ");
      const same = key ? parties.filter((p) => nameTokens(p.name).sort().join(" ") === key) : [];
      if (same.length === 1) partyId = same[0]!.id;
      else candidates = r.candidates;
    }
  }
  if (partyId) return { ...c, partyId };
  return candidates.length ? { ...c, partyCandidates: candidates } : c;
}

// ---------------------------------------------------------------------------
// Links

type LinkInfo = { children: Evidence[]; kindByUrl: Map<string, LinkKind> };

// One Evidence child per distinct URL; where the same URL appears twice the stronger kind is kept
// (payment > invoice > other). Ids are renumbered over the deduped list so they stay stable.
function dedupeLinks(bundle: MessageBundle): LinkInfo {
  const parent = bundle.parent;
  const kindByUrl = new Map<string, LinkKind>();
  for (const l of bundle.links) {
    const have = kindByUrl.get(l.url);
    if (!have || LINK_STRENGTH[l.kind] > LINK_STRENGTH[have]) kindByUrl.set(l.url, l.kind);
  }
  const children: Evidence[] = [];
  for (const child of bundle.children) {
    if (child.channel !== "url" || !child.url || children.some((c) => c.url === child.url)) continue;
    const n = children.length + 1;
    children.push({
      ...child, id: `${parent.id}#url-${n}`,
      sourceRef: { ...child.sourceRef, record: `${parent.sourceRef.record}#url-${n}` },
    });
  }
  return { children, kindByUrl };
}

// A message's invoice/payment URL fills the candidate's field only when the document does not state one.
function withLinks(c: IntakeCandidate, links: LinkInfo): IntakeCandidate {
  if (c.kind !== "invoice" && c.kind !== "bill") return c;
  const fields: CandidateFields = { ...c.fields };
  const notes = [...c.notes];
  for (const [field, kind] of [["invoiceUrl", "invoice"], ["paymentUrl", "payment"]] as const) {
    const have = fields[field];
    if (have && have.state !== "missing") continue;
    const urls = links.children.filter((e) => e.url && links.kindByUrl.get(e.url) === kind);
    if (urls.length === 1) {
      const e = urls[0]!;
      fields[field] = { state: "found", value: e.url!, evidence: [{ evidenceId: e.id, text: e.url! }] };
    } else if (urls.length > 1) {
      notes.push(`The message has ${urls.length} different ${kind} links; none was attached to the invoice.`);
    }
  }
  return { ...c, fields, notes };
}

// ---------------------------------------------------------------------------
// Pipeline

type Env = { ctx: IntakeContext; out: Collector };

function evidenceBase(
  id: string, receivedAt: string, source: InputSource | undefined,
): Pick<Evidence, "id" | "receivedAt"> & { sourceRef?: SourceRef } {
  return { id, receivedAt: source?.receivedAt ?? receivedAt, ...(source?.sourceRef ? { sourceRef: source.sourceRef } : {}) };
}

const extractOpts = (env: Env, candidateId: string, evidenceIds: string[]) => ({
  business: env.ctx.business, candidateId, revision: 1, evidenceIds, mode: env.ctx.mode,
  ...(env.ctx.client ? { client: env.ctx.client } : {}),
  ...(env.ctx.cacheDir ? { cacheDir: env.ctx.cacheDir } : {}),
});

// A PDF's bytes -> Evidence + one candidate. `extra` are the message evidence ids that travel with it.
async function readPdf(
  env: Env, bytes: Uint8Array, opts: {
    fileName?: string; evidenceId: string; receivedAt: string; channel: Evidence["channel"];
    parentId?: string; sourceRef: SourceRef; extraEvidenceIds?: string[]; messageEmails?: string[];
    links?: LinkInfo;
  },
): Promise<void> {
  const { evidenceId, fileName } = opts;
  const ids = [evidenceId, ...(opts.extraEvidenceIds ?? [])];
  const candidateId = `cand-${evidenceId}`;
  let pdf: PdfText;
  try {
    pdf = await extractPdfText(bytes, { evidenceId });
  } catch (err) {
    pdf = { evidenceId, status: "failed", pages: [], reason: `Could not read PDF: ${message(err)}` };
  }
  const evidence: Evidence = {
    id: evidenceId, channel: opts.channel, format: "pdf", receivedAt: opts.receivedAt,
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    ...(fileName ? { fileName } : {}), mime: "application/pdf", fileHash: sha256(bytes),
    ...(pdf.status === "ok" ? { text: bounded(pdf.pages.map((p) => p.text).join("\n")) } : {}),
    extraction: pdf.status === "ok" ? "ok" : "unreadable",
    sourceRef: opts.sourceRef,
  };
  let candidate: IntakeCandidate;
  if (pdf.status !== "ok") {
    const reason = pdf.reason ?? "This PDF could not be read. Upload a text PDF or enter the fields manually.";
    candidate = reviewCandidate({ candidateId, revision: 1, evidenceIds: ids }, "unreadable", [reason]);
  } else {
    const segments: SourceSegment[] = pdf.pages.map((p) => ({ evidenceId, page: p.page, text: p.text }));
    candidate = await extractDocument(segments, extractOpts(env, candidateId, ids));
    if (candidate.extraction !== "ok") evidence.extraction = candidate.extraction === "unreadable" ? "unreadable" : "partial";
    candidate = withCounterparty(candidate, env.ctx.records, segments.map((s) => s.text), opts.messageEmails ?? []);
    if (opts.links) candidate = withLinks(candidate, opts.links);
  }
  env.out.addEvidence(evidence);
  env.out.addCandidate(candidate);
}

// Evidence for a file we cannot read, plus a review candidate that says what to upload.
function unreadableFile(env: Env, opts: {
  evidenceId: string; fileName: string; receivedAt: string; channel: Evidence["channel"]; parentId?: string;
  sourceRef: SourceRef; ids: string[]; format: Evidence["format"]; text: string; bytes?: Uint8Array;
}) {
  env.out.addEvidence({
    id: opts.evidenceId, channel: opts.channel, format: opts.format, receivedAt: opts.receivedAt,
    ...(opts.parentId ? { parentId: opts.parentId } : {}), fileName: opts.fileName,
    ...(MIME[extOf(opts.fileName)] ? { mime: MIME[extOf(opts.fileName)]! } : {}),
    ...(opts.bytes ? { fileHash: sha256(opts.bytes) } : {}),
    extraction: "unsupported", sourceRef: opts.sourceRef,
  });
  env.out.addCandidate(reviewCandidate({ candidateId: `cand-${opts.evidenceId}`, revision: 1, evidenceIds: opts.ids }, "unreadable", [opts.text]));
}

// ---- sheets

function readSheets(env: Env, allSheets: SheetContent[], opts: {
  receivedAt: string; source?: InputSource; channel: Evidence["channel"]; parentId?: string;
  extraEvidenceIds?: string[]; currency?: string; dayFirst?: boolean; columnMapping?: ColumnMapping; headerRow?: number;
}) {
  const sheets = allSheets.slice(0, MAX_SHEETS);
  if (allSheets.length > MAX_SHEETS) {
    env.out.note(allSheets[0]!.evidenceId, `Only the first ${MAX_SHEETS} sheets were read; import the other sheets separately.`);
  }
  const before = env.out.candidates.length;
  const reasons: string[] = [];
  for (const [sheetIndex, sheet] of sheets.entries()) {
    const evidenceId = sheet.evidenceId;
    const prefix = `cand-${evidenceId}-${sheetIndex + 1}-${slug(sheet.sheet)}`;
    const sheetOpts = {
      business: { name: env.ctx.business.name }, idPrefix: prefix,
      ...(opts.currency ? { currency: opts.currency } : {}), ...(opts.dayFirst !== undefined ? { dayFirst: opts.dayFirst } : {}),
    };
    const produced: IntakeCandidate[] = [];
    try {
      const layout = classifySheet(sheet);
      // An owner-confirmed column mapping means "this is a table", whatever header detection thought.
      const ownerSaysTable = Object.keys(opts.columnMapping ?? {}).length > 0;
      if (layout.layout === "table" || ownerSaysTable) {
        const r = tableToCandidates(sheet, {
          ...sheetOpts, ...(opts.columnMapping ? { columnMapping: opts.columnMapping } : {}), ...(opts.headerRow ? { headerRow: opts.headerRow } : {}),
        });
        produced.push(...r.candidates);
        for (const row of r.rejectedRows) env.out.note(evidenceId, `${sheet.sheet} row ${row.row}: ${row.reason}`);
        if (r.reason) reasons.push(`${sheet.sheet}: ${r.reason}`);
      } else if (layout.layout === "document") {
        produced.push(documentToCandidate(sheet, sheetOpts));
      } else {
        reasons.push(`${sheet.sheet}: ${layout.reason}`);
      }
    } catch (err) {
      reasons.push(`${sheet.sheet}: could not be read (${message(err)})`);
    }
    const base = evidenceBase(evidenceId, opts.receivedAt, opts.source);
    env.out.addEvidence({
      id: evidenceId, channel: opts.channel, format: "xlsx", receivedAt: base.receivedAt,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      extraction: produced.length ? (produced.every((c) => c.extraction === "ok") ? "ok" : "partial") : "partial",
      sourceRef: base.sourceRef ?? { system: "generic_file", record: evidenceId },
    });
    for (const c of produced) {
      const withIds = { ...c, evidenceIds: [...new Set([...c.evidenceIds, ...(opts.extraEvidenceIds ?? [])])] };
      env.out.addCandidate(withCounterparty(withIds, env.ctx.records, [], []));
    }
  }
  if (env.out.candidates.length === before) {
    const first = sheets[0]?.evidenceId ?? "sheet";
    const text = `No invoices could be read from this spreadsheet. ${reasons.join(" ")} Check the column mapping, or paste the invoice text instead.`.trim();
    env.out.note(first, text);
    env.out.addCandidate(reviewCandidate({ candidateId: `cand-${first}`, revision: 1, evidenceIds: [first, ...(opts.extraEvidenceIds ?? [])] }, "partial", [text]));
  } else {
    for (const r of reasons) env.out.note(sheets[0]?.evidenceId ?? "sheet", r);
  }
}

// ---- messages (email, chat, paste)

const headerEmails = (bundle: MessageBundle): string[] =>
  ["from", "to", "cc", "reply-to"].flatMap((h) => bundle.headers?.[h]?.match(EMAIL_RE) ?? []);

// Body text with URLs blanked out: a reference that lives only in a link path does not count.
const withoutUrls = (text: string) => text.replace(URL_RE, " ");
const mentionsRef = (text: string, ref: string) => normRef(text).includes(normRef(ref));

// A message with no attachment is a commitment candidate only when it states the document itself.
function bodyCandidate(env: Env, c: IntakeCandidate, bundle: MessageBundle): IntakeCandidate | undefined {
  const id = bundle.parent.id;
  if (c.extraction === "partial" && c.kind === "none" && c.notes.includes(NO_CACHED_EXTRACTION)) {
    env.out.note(id, "Demo mode has no saved reading of this text, so only the message's payment claims were checked.");
    return undefined;
  }
  if (c.kind === "payment_evidence") {
    const text = "This message says a payment was made, but a message is not a remittance. Upload the remittance or bank confirmation, or record the payment yourself.";
    return reviewCandidate({ candidateId: c.id, revision: c.revision, evidenceIds: c.evidenceIds }, "partial", [text]);
  }
  if (c.kind === "invoice" || c.kind === "bill" || c.kind === "purchase_order") {
    const ref = foundValue(c.fields.reference);
    const amount = foundValue(c.fields.amount);
    if (!ref || amount === undefined || !mentionsRef(withoutUrls(bundle.text), ref)) {
      const text = "This message mentions a document, but its number or amount is not written in the message text. Attach the PDF or enter it by hand.";
      return reviewCandidate({ candidateId: c.id, revision: c.revision, evidenceIds: c.evidenceIds }, "partial", [text]);
    }
  }
  return c;
}

async function readMessage(env: Env, input: Extract<IntakeInput, { kind: "email" | "whatsapp" | "paste" }>): Promise<void> {
  const { ctx, out } = env;
  const tz = ctx.timeZone;
  const text = input.kind === "paste" ? input.text.trim() : input.raw;
  const hash = sha256(text);
  // A pasted note has no timestamp of its own, so when it was received is part of what it is.
  const idHash = input.kind === "paste" ? sha256(`${input.receivedAt}\n${text}`) : hash;
  const evidenceId = input.source?.evidenceId ?? `ev-${input.kind}-${idHash.slice(0, 16)}`;
  const pOpts = {
    evidenceId, ...(input.source?.receivedAt ? { receivedAt: input.source.receivedAt } : {}), ...(tz ? { timeZone: tz } : {}),
  };
  const parse = (o: typeof pOpts & { receivedAt?: string }): MessageBundle =>
    input.kind === "email" ? parseEmail(text, o)
      : input.kind === "whatsapp" ? parseWhatsApp(text, o)
        : parsePaste(text, { ...o, receivedAt: input.receivedAt });
  let bundle: MessageBundle;
  try {
    bundle = parse(pOpts);
  } catch {
    bundle = parse({ ...pOpts, receivedAt: ctx.now });
    out.note(evidenceId, "The message has no readable date, so the time it was received is taken as now. Check any dates it mentions.");
  }

  if (bundle.text.length > MAX_SOURCE_CHARS) {
    out.addEvidence({ ...bundle.parent, fileHash: hash, extraction: "partial" });
    out.note(evidenceId, `This message is over ${MAX_SOURCE_CHARS.toLocaleString("en-US")} characters. Split it, or paste just the part about the invoice.`);
    out.addCandidate(reviewCandidate({ candidateId: `cand-${evidenceId}`, revision: 1, evidenceIds: [evidenceId] }, "partial", ["The message is too long to read in one piece; split it or paste the relevant part."]));
    return;
  }
  const links = dedupeLinks(bundle);
  const parent: Evidence = {
    ...bundle.parent, fileHash: hash, text: bounded(bundle.text),
    ...(input.kind === "email" && bundle.headers && Object.keys(bundle.headers).length ? { format: "eml" as const } : {}),
    ...(input.source?.sourceRef ? { sourceRef: input.source.sourceRef } : {}),
  };
  bundle = { ...bundle, parent, children: links.children, links: bundle.links.filter((l, i, all) => all.findIndex((x) => x.url === l.url) === i).map((l) => ({ ...l, kind: links.kindByUrl.get(l.url) ?? l.kind })) };
  out.addEvidence(parent, ...links.children);
  const linkIds = links.children.map((e) => e.id);

  // Attachments the sender named in the headers but nobody uploaded stay as placeholders; ones that
  // were uploaded replace theirs.
  const allAttachments = input.kind === "paste" ? [] : input.attachments ?? [];
  const attachments = allAttachments.slice(0, MAX_ATTACHMENTS);
  if (allAttachments.length > MAX_ATTACHMENTS) {
    out.note(parent.id, `Only the first ${MAX_ATTACHMENTS} attachments were read; upload the rest separately.`);
  }
  const named = (bundle.headers?.["x-attachments"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const lowerNames = new Set(attachments.map((a) => a.fileName.toLowerCase()));
  const missingFiles = named.filter((n) => !lowerNames.has(n.toLowerCase()));
  for (const name of missingFiles) {
    const i = named.indexOf(name);
    const id = `${parent.id}#att-${i + 1}`;
    unreadableFile(env, {
      evidenceId: id, fileName: name, receivedAt: parent.receivedAt, channel: parent.channel, parentId: parent.id,
      sourceRef: { system: parent.sourceRef.system, record: `${parent.sourceRef.record}#att-${i + 1}:${name}` },
      ids: [id, parent.id, ...linkIds], format: "text",
      text: `The message mentions the attachment "${name}", but the file was not provided. Upload it so the invoice can be read.`,
    });
  }

  for (const att of attachments) {
    try {
      await readAttachment(env, att, parent, linkIds, links, headerEmails(bundle));
    } catch (err) {
      out.note(parent.id, `Could not read the attachment "${att.fileName}" (${message(err)}). Upload it again, or enter the fields manually.`);
    }
  }

  // The body: a covering note when there are attachments; otherwise it may itself state the document.
  const hasAttachment = attachments.length > 0 || named.length > 0;
  let bodyCandidateId: string | undefined;
  if (!hasAttachment && bundle.text.trim() !== "") {
    const ids = [parent.id, ...linkIds];
    const segments: SourceSegment[] = [{ evidenceId: parent.id, text: bundle.text }];
    const extracted = await extractDocument(segments, extractOpts(env, `cand-${parent.id}`, ids));
    let cand: IntakeCandidate | undefined = bodyCandidate(env, extracted, bundle);
    if (cand) {
      cand = withCounterparty(cand, ctx.records, [bundle.text], headerEmails(bundle));
      cand = withLinks(cand, links);
      out.addCandidate(cand);
      if (cand.kind === "conversational_update") bodyCandidateId = cand.id;
      if (cand.extraction === "partial") out.evidence.set(parent.id, { ...out.evidence.get(parent.id)!, extraction: "partial" });
    }
  }

  // Signals: claims in the message (promises, delays) for the owner to confirm. Always from the body.
  try {
    const r = await extractSignals(bundle, {
      records: ctx.records, mode: ctx.mode, ...(tz ? { timeZone: tz } : {}),
      ...(ctx.client ? { client: ctx.client } : {}), ...(ctx.cacheDir ? { cacheDir: ctx.cacheDir } : {}),
    });
    out.signals.push(...r.signals.filter((s) => !out.signals.some((x) => x.id === s.id)));
    for (const n of r.notes) {
      const m = /^Message(?: (\d+))?: ([\s\S]*)$/.exec(n);
      out.note(m ? (m[1] ? `sig-${parent.id}-${m[1]}` : `sig-${parent.id}`) : parent.id, m ? m[2]! : n);
    }
    // A claim about one commitment travels with a review item that can attach the message to it as
    // evidence, even when the document reading of the text is unavailable (demo mode) or found nothing.
    const claimed = [...new Set(r.signals.map((s) => s.commitmentId).filter((id): id is string => !!id))];
    const bodyId = `cand-${parent.id}`;
    if (!hasAttachment && !bodyCandidateId && claimed.length === 1 && !out.candidates.some((c) => c.id === bodyId)) {
      out.addCandidate({
        ...reviewCandidate({ candidateId: bodyId, revision: 1, evidenceIds: [parent.id, ...linkIds] }, "partial", []),
        kind: "conversational_update", extraction: "ok", notes: ["The message makes a claim about an invoice; the claim is a signal the owner confirms separately."],
      });
      bodyCandidateId = bodyId;
    }
    if (bodyCandidateId) out.messageLinks.push({ candidateId: bodyCandidateId, signals: r.signals });
  } catch (err) {
    out.note(parent.id, `Could not check this message for payment claims (${message(err)}).`);
  }
}

async function readAttachment(
  env: Env, att: Attachment, parent: Evidence, linkIds: string[], links: LinkInfo, emails: string[],
): Promise<void> {
  const kind = isPdf(att.bytes, att.fileName) ? "pdf" : extOf(att.fileName) === "xlsx" ? "xlsx" : "other";
  const hash = sha256(att.bytes);
  const id = att.source?.evidenceId ?? `ev-${kind === "other" ? "file" : kind}-${hash.slice(0, 16)}`;
  const sourceRef: SourceRef = att.source?.sourceRef ?? { system: parent.sourceRef.system, record: `${parent.sourceRef.record}#att:${att.fileName}` };
  const receivedAt = att.source?.receivedAt ?? parent.receivedAt;
  const ids = [parent.id, ...linkIds];
  if (kind === "pdf") {
    await readPdf(env, att.bytes, {
      fileName: att.fileName, evidenceId: id, receivedAt, channel: parent.channel, parentId: parent.id, sourceRef,
      extraEvidenceIds: ids, messageEmails: emails, links,
    });
  } else if (kind === "xlsx" && att.sheets?.length) {
    readSheets(env, att.sheets.map((s) => ({ ...s, evidenceId: id })), {
      receivedAt, channel: parent.channel, parentId: parent.id, extraEvidenceIds: ids,
      source: { ...(att.source?.sourceRef ? { sourceRef: att.source.sourceRef } : { sourceRef }), receivedAt },
    });
    const ev = env.out.evidence.get(id);
    if (ev) env.out.evidence.set(id, { ...ev, fileName: att.fileName, fileHash: hash, mime: MIME.xlsx! });
  } else {
    const what = kind === "xlsx"
      ? `The spreadsheet "${att.fileName}" was attached but its cells were not read. Upload it on the spreadsheet import screen.`
      : `"${att.fileName}" is not a PDF or spreadsheet Neri can read. Upload a text PDF, or paste the invoice details.`;
    unreadableFile(env, {
      evidenceId: id, fileName: att.fileName, receivedAt, channel: parent.channel, parentId: parent.id, sourceRef,
      ids: [id, ...ids], format: kind === "xlsx" ? "xlsx" : extOf(att.fileName) === "csv" ? "csv" : "image", text: what, bytes: att.bytes,
    });
  }
}

// ---------------------------------------------------------------------------
// ingest

export async function ingest(input: IntakeInput, ctx: IntakeContext): Promise<IntakeResult> {
  const out = new Collector();
  const env: Env = { ctx, out };
  try {
    switch (input.kind) {
      case "pdf": {
        const hash = sha256(input.bytes);
        const evidenceId = input.source?.evidenceId ?? `ev-pdf-${hash.slice(0, 16)}`;
        await readPdf(env, input.bytes, {
          ...(input.fileName ? { fileName: input.fileName } : {}), evidenceId,
          receivedAt: input.source?.receivedAt ?? ctx.now, channel: "upload",
          sourceRef: input.source?.sourceRef ?? { system: "upload", record: input.fileName ?? evidenceId },
        });
        break;
      }
      case "email": case "whatsapp": case "paste":
        await readMessage(env, input);
        break;
      case "sheet":
        readSheets(env, input.sheets, {
          receivedAt: ctx.now, channel: "upload",
          ...(input.source ? { source: input.source } : {}),
          ...(input.currency ? { currency: input.currency } : {}),
          ...(input.dayFirst !== undefined ? { dayFirst: input.dayFirst } : {}),
          ...(input.columnMapping ? { columnMapping: input.columnMapping } : {}),
          ...(input.headerRow ? { headerRow: input.headerRow } : {}),
        });
        break;
      default:
        out.note("ingest", "This kind of input is not supported. Upload a PDF or spreadsheet, or paste the text.");
    }
  } catch (err) {
    out.note("ingest", `Something went wrong reading this input (${message(err)}). Try again, or paste the text instead.`);
  }

  const proposals: ChangeProposal[] = [];
  for (const candidate of out.candidates) {
    try {
      let proposal = propose(candidate, ctx.records, { storeRevision: ctx.storeRevision, now: ctx.now });
      const link = out.messageLinks.find((m) => m.candidateId === candidate.id);
      if (link) proposal = linkMessageToCommitment(proposal, candidate, link.signals, ctx.records);
      proposals.push(proposal);
    } catch (err) {
      out.note(candidate.id, `Could not reconcile this item (${message(err)}); review it by hand.`);
    }
  }

  // Every module's notes, scoped to the thing they are about.
  for (const c of out.candidates) for (const n of c.notes) out.note(c.id, n);
  for (const p of proposals) if (p.action === "review" || p.action === "conflict") out.note(p.id, p.reasons.join(" "));

  return {
    evidence: [...out.evidence.values()],
    candidates: out.candidates,
    proposals,
    signals: out.signals,
    notes: out.notes,
  };
}

// A message whose claim is about one commitment can be attached to it as evidence once the owner
// confirms: an evidence-only "link" (no cash change). The claim itself is a Signal with its own
// confirmation. When there is nothing new to attach, it stays an empty "review" item.
function linkMessageToCommitment(
  proposal: ChangeProposal, candidate: IntakeCandidate, signals: Signal[], records: Records,
): ChangeProposal {
  if (proposal.action !== "review" || proposal.ops.length > 0) return proposal;
  const targets = [...new Set(signals.map((s) => s.commitmentId).filter((id): id is string => !!id))];
  if (targets.length !== 1) return proposal;
  const target = records.commitments.find((c) => c.id === targets[0]);
  if (!target) return proposal;
  const fresh = candidate.evidenceIds.filter((id) => !target.evidenceIds?.includes(id));
  if (!fresh.length) return { ...proposal, targetCommitmentId: target.id };
  return {
    ...proposal,
    action: "link",
    targetCommitmentId: target.id,
    ops: [{ op: "linkEvidence", commitmentId: target.id, evidenceIds: fresh }],
    reasons: [...proposal.reasons, `The message is about ${target.reference ?? target.id}; confirm to keep it with that invoice as evidence (no cash change).`].filter((r) => !r.startsWith("Message updates")),
  };
}
