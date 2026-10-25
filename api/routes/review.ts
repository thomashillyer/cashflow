// Import -> Review -> confirm (ai/README.md): POST /import/:adapter, GET /review, GET /review/proposals,
// POST /review/:id/confirm|dismiss, POST /signals/:id/apply|dismiss. Importing never applies anything;
// cash changes only when the owner confirms a proposal or applies a signal.

import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ChangeProposal, CommitmentFieldChange } from "../../schema/intake";
import type { Commitment, Override, Records, Rule, Signal } from "../../schema/records";
import { forecast } from "../../engine/forecast";
import { ingest, type IntakeInput, type IntakeNote } from "../../ai/intake";
import { ApplyError, applyProposal, type ApplyErrorCode } from "../../ai/reconcile/apply";
import { propose } from "../../ai/reconcile/match";
import { fmtDate } from "../../ai/brief";
import { fmtMoney } from "../../ai/money";
import { enrichEvidence, prepareFileImport, type PreparedImport } from "../../adapters/prepare";
import type { Deps } from "../app";
import { attachOriginals } from "../originals";
import { inferWhatsAppDateOrder, normalizeChat } from "../../adapters/whatsapp/export";
import { businessIdentity, loadForRun, runInputs, savedScenario } from "../engine";
import { storeFor, businessOf, HttpError, isIsoDate } from "../http";
import type { Business, DecisionWrite, Store } from "../store";
import { importBank } from "./bank";

// ApplyError.code -> HTTP status (ai/README.md). Record<> makes tsc fail when a code is added.
export const APPLY_ERROR_STATUS: Record<ApplyErrorCode, number> = {
  STALE_REVIEW: 409, NOT_PROPOSED: 409, OVER_ALLOCATED: 409, NOTHING_TO_APPLY: 422, UNKNOWN_TARGET: 404,
};

const APPLY_ERROR_MESSAGE: Record<ApplyErrorCode, string> = {
  STALE_REVIEW: "Your books changed since you opened this. Review it again.",
  NOT_PROPOSED: "This item was already decided.",
  OVER_ALLOCATED: "Those invoices add up to more than the order. Pick how much goes to this order.",
  NOTHING_TO_APPLY: "Pick a value or a matching invoice first, then confirm.",
  UNKNOWN_TARGET: "The invoice this points at isn't in your books any more.",
};

const STALE_MESSAGE = "Your books changed since you opened this. Review it again.";
const IDEMPOTENCY_CONFLICT_MESSAGE = "This request was already used for a different change. Refresh and try again.";

// Stable JSON (sorted keys) so the same body hashes the same however the client ordered it.
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, normalize(x)]));
  return v;
}
const requestHash = (route: string, id: string, body: unknown) =>
  createHash("sha256").update(JSON.stringify([route, id, normalize(body ?? {})])).digest("hex");

// The Idempotency-Key header, or a random key when the client sends none: still atomic and race-safe, just no replay.
function idempotencyKey(req: FastifyRequest): { key: string; supplied: boolean } {
  const h = req.headers["idempotency-key"];
  const v = (Array.isArray(h) ? h[0] : h)?.trim();
  if (v && v.length <= 200) return { key: v, supplied: true };
  return { key: randomUUID(), supplied: false };
}

type Decision = Omit<DecisionWrite, "idempotencyKey" | "requestHash">;
type Outcome = { replay: boolean; body: Record<string, unknown> };

// A replay of an already-decided request must win over "already decided" / "stale" checks.
async function priorDecision(store: Store, businessId: string, key: { key: string; supplied: boolean }, hash: string): Promise<Outcome | null> {
  if (!key.supplied) return null;
  const prior = await store.lookupDecision(businessId, key.key, hash);
  if (!prior) return null;
  if (prior.kind === "conflict") throw new HttpError(409, "IDEMPOTENCY_CONFLICT", IDEMPOTENCY_CONFLICT_MESSAGE);
  return { replay: true, body: prior.response };
}

async function commit(store: Store, businessId: string, key: string, hash: string, d: Decision, staleMessage: string): Promise<Outcome> {
  const r = await store.commitDecision(businessId, { ...d, idempotencyKey: key, requestHash: hash });
  if (r.kind === "stale") throw new HttpError(409, "STALE_REVIEW", staleMessage, { revision: r.storeRevision, retryable: true });
  if (r.kind === "conflict") throw new HttpError(409, "IDEMPOTENCY_CONFLICT", IDEMPOTENCY_CONFLICT_MESSAGE);
  return { replay: r.kind === "replay", body: r.response };
}

const MAX_NOTES = 500;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// After any write that moves the revision, rebuild each still-pending proposal against the new records.
export async function refreshPending(store: Store, businessId: string, records: Records, storeRevision: number, now: string): Promise<void> {
  const [proposals, candidates] = await Promise.all([store.listProposals(businessId), store.listCandidates(businessId)]);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const next: ChangeProposal[] = [];
  for (const p of proposals) {
    const c = p.candidateId ? byId.get(p.candidateId) : undefined;
    if (p.state !== "proposed" || !c) continue;
    next.push(propose(c, records, { storeRevision, now }));
  }
  if (next.length) await store.saveProposals(businessId, next);
}

// Evidence has no sender field; its record id is a sender only when it is an address or a phone number
// (not a file name or message id). Otherwise "" and the app leaves "from" out.
function senderOf(record: string | undefined): string {
  return record && /^[^\s@]+@[^\s@]+$|^\+?\d[\d\s().-]{6,}$/.test(record) ? record : "";
}

function signalItem(b: Business, records: Records, overrides: Override[], s: Signal, deps: Deps) {
  const c = records.commitments.find((x) => x.id === s.commitmentId);
  if (!c) return null;
  const { profile, asOf, fxRates } = runInputs(b, deps.now);
  const scenario = savedScenario(overrides);
  const withState = (state: Signal["state"]): Records => ({ ...records, signals: records.signals.map((x) => (x.id === s.id ? { ...x, state } : x)) });
  const before = forecast(withState("proposed"), profile, scenario, asOf, fxRates);
  const after = forecast(withState("applied"), profile, scenario, asOf, fxRates);
  const from = before.events.find((e) => e.commitmentId === c.id && e.status !== "actual")?.date ?? c.anchors.due ?? null;
  const ev = records.evidence.find((e) => e.id === s.sourceRef.record || e.sourceRef.record === s.sourceRef.record);
  const excerpt = s.sourceRef.excerpt?.text ?? "";
  const notes = (b.profile.account?.intakeNotes ?? []).filter((n) => n.scope === s.id).map((n) => n.text);
  return {
    signal: { ...s, effect: { lowPointDelta: after.lowPoint.amount - before.lowPoint.amount, week: after.lowPoint.week } },
    // Message text is data: shown as text, never interpreted.
    message: { id: s.sourceRef.record, channel: s.channel, from: senderOf(ev?.sourceRef.record), receivedAt: s.receivedAt, body: ev?.text ?? excerpt, excerpt },
    commitment: c,
    party: records.parties.find((p) => p.id === (s.partyId ?? c.partyId)) ?? null,
    from,
    to: s.claim.kind === "date_change" ? s.claim.newDate : from,
    before: before.lowPoint,
    after: after.lowPoint,
    needsDate: notes.includes("owner must confirm the date"),
    notes,
  };
}

// ownerEdits from the request: allowlisted fields, integer minor units, ISO dates, `from` from the stored commitment.
function validOwnerEdits(body: unknown, target: Commitment): CommitmentFieldChange[] {
  if (!Array.isArray(body)) throw new HttpError(400, "INVALID_ARGUMENT", "Edits must be a list.");
  return body.map((raw: { field?: unknown; to?: unknown }) => {
    const { field, to } = raw ?? {};
    const bad = () => new HttpError(400, "INVALID_ARGUMENT", `Cannot change ${String(field)} to that value.`, { fieldIssues: [{ field: String(field), issue: "not allowed" }] });
    if (field === "amount" || field === "outstanding") {
      if (typeof to !== "number" || !Number.isSafeInteger(to) || to < 0) throw bad();
      return { field, from: target[field], to };
    }
    if (field === "currency") {
      if (typeof to !== "string" || !/^[A-Z]{3}$/.test(to)) throw bad();
      return { field, from: target.currency, to };
    }
    if (field === "anchors.invoice" || field === "anchors.due" || field === "anchors.order" || field === "anchors.ship" || field === "anchors.delivery") {
      if (!isIsoDate(to)) throw bad();
      return { field, from: target.anchors[field.slice(8) as keyof Commitment["anchors"]], to };
    }
    throw bad();
  });
}

type Prepared = { input: IntakeInput; prepared?: Extract<PreparedImport, { ok: true; repeat: false }> } | { repeat: Extract<PreparedImport, { repeat: true }> };

// Request body -> IntakeInput. Spreadsheets and WhatsApp exports are read by the adapters lane
// (adapters/prepare.ts); the rest is passed through as before.
async function toInput(adapter: string, body: Record<string, unknown>, now: string, records: Records, business: { name: string }, currency: string | undefined): Promise<Prepared> {
  const text = typeof body.text === "string" ? body.text : undefined;
  const fileName = typeof body.fileName === "string" ? body.fileName.slice(0, 200) : undefined;
  const bytes = () => {
    if (typeof body.base64 !== "string") throw new HttpError(400, "INVALID_ARGUMENT", "Attach the file (base64) or paste the text.", { fieldIssues: [{ field: "base64", issue: "missing" }] });
    const buf = Buffer.from(body.base64, "base64");
    if (buf.length === 0) throw new HttpError(400, "INVALID_ARGUMENT", "That file is empty. Export it again and upload it.");
    if (buf.length > MAX_UPLOAD_BYTES) throw new HttpError(413, "TOO_LARGE", "That file is over 10 MB. Export a shorter date range and upload it again.");
    return new Uint8Array(buf);
  };
  const raw = () => text ?? Buffer.from(bytes()).toString("utf8");
  let kind = adapter;
  if (adapter === "upload") {
    const ext = (fileName ?? "").toLowerCase().split(".").pop();
    kind = ext === "pdf" ? "pdf" : ext === "eml" ? "email" : ext === "csv" || ext === "xlsx" ? "sheet" : ext === "zip" ? "whatsapp" : ext === "txt" || ext === undefined ? "paste" : `.${ext}`;
  }
  const sheetOptions = () => ({
    currency: typeof body.currency === "string" && /^[A-Za-z]{3}$/.test(body.currency) ? body.currency.toUpperCase() : currency,
    ...(typeof body.dayFirst === "boolean" ? { dayFirst: body.dayFirst } : {}),
    ...(isColumnMapping(body.columnMapping) ? { columnMapping: body.columnMapping } : {}),
    ...(typeof body.headerRow === "number" && Number.isInteger(body.headerRow) && body.headerRow >= 1 ? { headerRow: body.headerRow } : {}),
  });
  const fromFile = async (k: "sheet" | "whatsapp", name: string, data: Uint8Array): Promise<Prepared> => {
    const opts = sheetOptions();
    const retry = ["columnMapping", "headerRow", "dayFirst", "currency"].some((f) => body[f] !== undefined);
    const p = await prepareFileImport({
      kind: k, fileName: name, bytes: data, receivedAt: now, records, business, retry,
      ...(opts.currency ? { currency: opts.currency } : {}), ...(opts.dayFirst !== undefined ? { dayFirst: opts.dayFirst } : {}),
      ...(opts.columnMapping ? { columnMapping: opts.columnMapping } : {}), ...(opts.headerRow ? { headerRow: opts.headerRow } : {}),
    });
    if (!p.ok) throw new HttpError(422, "UNREADABLE", `${p.message} ${p.nextStep}`);
    return p.repeat ? { repeat: p } : { input: p.input, prepared: p };
  };
  switch (kind) {
    case "pdf": return { input: { kind: "pdf", bytes: bytes(), ...(fileName ? { fileName } : {}) } };
    case "email": return { input: { kind: "email", raw: raw() } };
    case "sheet": {
      // A pasted table (text) is read as CSV.
      const data = text !== undefined ? new TextEncoder().encode(text) : bytes();
      return fromFile("sheet", fileName ?? "pasted.csv", data);
    }
    case "whatsapp":
      if (typeof body.base64 === "string" || (text === undefined && /\.(zip|txt)$/i.test(fileName ?? ""))) return fromFile("whatsapp", fileName ?? "chat.txt", bytes());
      {
        const chat = normalizeChat(raw());
        const order = body.dateOrder === "MDY" || body.dateOrder === "DMY" ? body.dateOrder : inferWhatsAppDateOrder(chat).order;
        return { input: { kind: "whatsapp", raw: chat, ...(order ? { dateOrder: order } : {}) } };
      }
    case "paste": {
      const t = raw();
      if (!t.trim()) throw new HttpError(400, "INVALID_ARGUMENT", "Paste the message text first.", { fieldIssues: [{ field: "text", issue: "empty" }] });
      return { input: { kind: "paste", text: t, receivedAt: typeof body.receivedAt === "string" && !Number.isNaN(Date.parse(body.receivedAt)) ? body.receivedAt : now } };
    }
    default:
      throw new HttpError(415, "UNSUPPORTED", "Neri reads CSV and Excel (.xlsx) spreadsheets, PDFs, emails (.eml), WhatsApp exports and pasted text here. Export your file as one of those, or paste the details.");
  }
}

const COLUMN_KEYS = ["reference", "party", "amount", "currency", "issueDate", "dueDate", "outstanding"];
function isColumnMapping(v: unknown): v is Record<string, number> {
  return typeof v === "object" && v !== null && !Array.isArray(v) &&
    Object.entries(v).every(([k, n]) => COLUMN_KEYS.includes(k) && typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 50);
}

export const reviewRoutes = (deps: Deps) => async (app: FastifyInstance) => {
  const nowIso = () => deps.now().toISOString();

  app.post("/import/:adapter", async (req) => {
    const b = businessOf(req);
    // On the public demo the samples are shared: an upload would publish the file to every visitor, signed in or not.
    if (b.isSynthetic && deps.demoMode) throw new HttpError(403, "FORBIDDEN", "The sample already has its documents. Set up your business to upload your own files.");
    const { adapter } = req.params as { adapter: string };
    // Bank statements are history and a balance, not documents to interpret (api/routes/bank.ts).
    if (adapter === "bank") return importBank(storeFor(req), b, (req.body ?? {}) as Record<string, unknown>, nowIso());
    const { records, storeRevision } = await storeFor(req).load(b.id);
    const prep = await toInput(adapter, (req.body ?? {}) as Record<string, unknown>, nowIso(), records, businessIdentity(b), b.profile.baseCurrency);
    if ("repeat" in prep) {
      // Same bytes as a file already imported: nothing to ingest, so nothing can change. One exception: if the
      // first import could not save the original, this upload is a chance to save it (the put is idempotent).
      const had = records.evidence.find((e) => e.id === prep.repeat.evidenceId);
      if (had && !had.storageKey) {
        const again = await attachOriginals({ blobs: deps.blobs, businessId: b.id, body: req.body, input: { kind: "paste", text: "", receivedAt: nowIso() } }, { evidence: [had], notes: [] as IntakeNote[] });
        if (again.evidence[0]?.storageKey) await deps.store.saveIntake(b.id, { evidence: again.evidence, candidates: [], proposals: [], signals: [] });
      }
      return {
        evidence: [], candidates: [], proposals: [], signals: [], notes: [], storeRevision, repeat: true,
        repeatOf: prep.repeat.evidenceId, diagnostics: prep.repeat.diagnostics, preview: { candidates: 0, proposals: {}, signals: 0 },
      };
    }
    const input = prep.input;
    const ingested = await ingest(input, {
      records, storeRevision, business: businessIdentity(b), mode: deps.aiMode, now: nowIso(),
      ...(b.profile.account?.timezone ? { timeZone: b.profile.account.timezone } : {}),
    });
    // Keep the original behind each source (api/originals.ts); a failure to store never fails the import.
    const result = await attachOriginals({ blobs: deps.blobs, businessId: b.id, body: req.body, input },
      { ...ingested, evidence: enrichEvidence(ingested.evidence, prep.prepared?.fileEvidence) });
    // Same input gives the same ids: never reopen a decided proposal, never reset a decided signal.
    const existing = new Map((await storeFor(req).listProposals(b.id)).map((p) => [p.id, p]));
    const proposals = result.proposals.filter((p) => existing.get(p.id)?.state !== "confirmed" && existing.get(p.id)?.state !== "dismissed");
    const known = new Set(records.signals.map((s) => s.id));
    const signals = result.signals.filter((s) => !known.has(s.id));
    // Evidence last: it carries the file hash that makes a later upload a repeat, so a failure partway
    // through must leave the file importable again.
    await storeFor(req).saveIntake(b.id, { evidence: [], candidates: result.candidates, proposals, signals });
    await storeFor(req).saveIntake(b.id, { evidence: result.evidence, candidates: [], proposals: [], signals: [] });
    if (result.notes.length) {
      const acc = b.profile.account ?? {};
      const seen = new Set((acc.intakeNotes ?? []).map((n) => `${n.scope}\u0000${n.text}`));
      const add: IntakeNote[] = result.notes.filter((n) => !seen.has(`${n.scope}\u0000${n.text}`));
      await storeFor(req).saveProfile(b.id, { ...b.profile, account: { ...acc, intakeNotes: [...(acc.intakeNotes ?? []), ...add].slice(-MAX_NOTES) } });
    }
    const byAction: Record<string, number> = {};
    for (const p of result.proposals) byAction[p.action] = (byAction[p.action] ?? 0) + 1;
    return {
      ...result, storeRevision, ...(prep.prepared ? { diagnostics: prep.prepared.diagnostics } : {}),
      preview: { candidates: result.candidates.length, proposals: byAction, signals: result.signals.length },
    };
  });

  // The app's Review list: proposed signals with the words, the invoice, and the priced effect.
  app.get("/review", async (req) => {
    const b = businessOf(req);
    const { records, overrides } = await loadForRun(storeFor(req), b.id);
    return records.signals.filter((s) => s.state === "proposed").map((s) => signalItem(b, records, overrides, s, deps)).filter((x) => x !== null);
  });

  // Everything pending from imports: change proposals with their candidate fields, evidence and notes,
  // plus every proposed signal (including ambiguous ones that need the owner to pick an invoice).
  app.get("/review/proposals", async (req) => {
    const b = businessOf(req);
    const [{ records, storeRevision }, proposals, candidates] = await Promise.all([
      storeFor(req).load(b.id), storeFor(req).listProposals(b.id), storeFor(req).listCandidates(b.id),
    ]);
    const notes = b.profile.account?.intakeNotes ?? [];
    const notesFor = (...ids: (string | undefined)[]) => notes.filter((n) => ids.includes(n.scope)).map((n) => n.text);
    return {
      storeRevision,
      proposals: proposals.filter((p) => p.state === "proposed").map((p) => {
        const candidate = candidates.find((c) => c.id === p.candidateId) ?? null;
        return {
          proposal: p,
          candidate,
          evidence: records.evidence.filter((e) => p.evidenceIds.includes(e.id)),
          target: records.commitments.find((c) => c.id === p.targetCommitmentId) ?? null,
          notes: notesFor(p.id, p.candidateId, ...p.evidenceIds),
        };
      }),
      signals: records.signals.filter((s) => s.state === "proposed").map((s) => ({ signal: s, notes: notesFor(s.id) })),
    };
  });

  // Body: { expectedRevision?, commitmentId? (pick one of matchCandidates), ownerEdits? }.
  app.post("/review/:id/confirm", async (req) => {
    const b = businessOf(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { expectedRevision?: unknown; commitmentId?: unknown; ownerEdits?: unknown };
    const key = idempotencyKey(req);
    const hash = requestHash("confirm", id, body);
    const prior = await priorDecision(storeFor(req), b.id, key, hash);
    if (prior) return prior.body;
    const [{ records, storeRevision }, proposals] = await Promise.all([storeFor(req).load(b.id), storeFor(req).listProposals(b.id)]);
    let proposal = proposals.find((p) => p.id === id);
    if (!proposal) throw new HttpError(404, "NOT_FOUND", "That item is no longer in Review.");
    if (proposal.state !== "proposed") throw new HttpError(409, "NOT_PROPOSED", `This item was already ${proposal.state}.`, { revision: storeRevision });
    const expected = typeof body.expectedRevision === "number" ? body.expectedRevision : storeRevision;
    if (expected !== storeRevision || proposal.expectedStoreRevision !== storeRevision) {
      throw new HttpError(409, "STALE_REVIEW", STALE_MESSAGE, { revision: storeRevision, retryable: true });
    }
    if (typeof body.commitmentId === "string") {
      const pick = body.commitmentId;
      if (!proposal.matchCandidates?.some((m) => m.commitmentId === pick)) throw new HttpError(400, "INVALID_ARGUMENT", "Pick one of the invoices offered.");
      proposal = { ...proposal, action: "link", targetCommitmentId: pick, ops: [...proposal.ops, { op: "linkEvidence", commitmentId: pick, evidenceIds: proposal.evidenceIds }] };
    }
    if (body.ownerEdits !== undefined) {
      const target = records.commitments.find((c) => c.id === proposal!.targetCommitmentId);
      if (!target) throw new HttpError(404, "UNKNOWN_TARGET", APPLY_ERROR_MESSAGE.UNKNOWN_TARGET);
      proposal = { ...proposal, ownerEdits: validOwnerEdits(body.ownerEdits, target) };
    }
    let applied;
    try {
      applied = applyProposal(records, proposal, { now: nowIso() });
    } catch (err) {
      if (err instanceof ApplyError) throw new HttpError(APPLY_ERROR_STATUS[err.code], err.code, APPLY_ERROR_MESSAGE[err.code], { revision: storeRevision });
      throw err;
    }
    // Code computed the change above; the store commits records + proposal + revision in one atomic step,
    // only while the revision is still the one this request loaded.
    const out = await commit(storeFor(req), b.id, key.key, hash, {
      expectedRevision: expected, records: applied.records, proposals: [{ ...proposal, state: "confirmed", decidedAt: nowIso() }],
      response: { affectedRecordIds: applied.affectedRecordIds, warnings: applied.warnings },
    }, STALE_MESSAGE);
    if (out.replay) return out.body;
    await refreshPending(storeFor(req), b.id, applied.records, Number(out.body.storeRevision), nowIso());
    return out.body;
  });

  app.post("/review/:id/dismiss", async (req) => {
    const b = businessOf(req);
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { expectedRevision?: unknown };
    const key = idempotencyKey(req);
    const hash = requestHash("dismiss", id, body);
    const prior = await priorDecision(storeFor(req), b.id, key, hash);
    if (prior) return prior.body;
    const [{ records, storeRevision }, proposals] = await Promise.all([storeFor(req).load(b.id), storeFor(req).listProposals(b.id)]);
    const proposal = proposals.find((p) => p.id === id);
    if (!proposal) throw new HttpError(404, "NOT_FOUND", "That item is no longer in Review.");
    if (proposal.state !== "proposed") throw new HttpError(409, "NOT_PROPOSED", `This item was already ${proposal.state}.`);
    const out = await commit(storeFor(req), b.id, key.key, hash, {
      expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : storeRevision,
      records: {}, proposals: [{ ...proposal, state: "dismissed", decidedAt: nowIso() }], response: { id, state: "dismissed" },
    }, STALE_MESSAGE);
    if (out.replay) return out.body;
    // The commit moved the revision: rebuild the other pending proposals against it.
    await refreshPending(storeFor(req), b.id, records, Number(out.body.storeRevision), nowIso());
    return out.body;
  });

  // Body (optional): { expectedRevision?, commitmentId?, newDate? }: the owner's picks.
  app.post("/signals/:id/:decision", async (req) => {
    const b = businessOf(req);
    const { id, decision } = req.params as { id: string; decision: string };
    if (decision !== "apply" && decision !== "dismiss") throw new HttpError(404, "NOT_FOUND", "Apply or dismiss.");
    const body = (req.body ?? {}) as { expectedRevision?: unknown; commitmentId?: unknown; newDate?: unknown };
    const key = idempotencyKey(req);
    const hash = requestHash(`signal-${decision}`, id, body);
    const prior = await priorDecision(storeFor(req), b.id, key, hash);
    if (prior) return prior.body;
    const { records, storeRevision } = await storeFor(req).load(b.id);
    const signal = records.signals.find((s) => s.id === id);
    if (!signal) throw new HttpError(404, "NOT_FOUND", "That message is no longer in Review.");
    if (signal.state !== "proposed") throw new HttpError(409, "NOT_PROPOSED", `This message was already ${signal.state}.`, { revision: storeRevision });
    if (typeof body.expectedRevision === "number" && body.expectedRevision !== storeRevision) {
      throw new HttpError(409, "STALE_REVIEW", "Your books changed. Review it again.", { revision: storeRevision, retryable: true });
    }
    let next: Signal;
    if (decision === "dismiss") {
      next = { ...signal, state: "dismissed" };
    } else {
      const commitmentId = signal.commitmentId ?? (typeof body.commitmentId === "string" ? body.commitmentId : undefined);
      const needsCommitment = ["date_change", "amount_change", "cancel"].includes(signal.claim.kind);
      if (needsCommitment && (!commitmentId || !records.commitments.some((c) => c.id === commitmentId))) {
        throw new HttpError(422, "COMMITMENT_REQUIRED", "Pick which invoice this message is about.", { fieldIssues: [{ field: "commitmentId", issue: "required" }] });
      }
      const vague = (b.profile.account?.intakeNotes ?? []).some((n) => n.scope === signal.id && n.text === "owner must confirm the date");
      if (body.newDate !== undefined && !isIsoDate(body.newDate)) throw new HttpError(400, "INVALID_ARGUMENT", "Dates look like 2026-11-03.", { fieldIssues: [{ field: "newDate", issue: "YYYY-MM-DD" }] });
      if (vague && body.newDate === undefined) throw new HttpError(422, "DATE_REQUIRED", "They didn't give an exact date. Pick the date they mean.", { fieldIssues: [{ field: "newDate", issue: "required" }] });
      const claim = signal.claim.kind === "date_change" && typeof body.newDate === "string" ? { ...signal.claim, newDate: body.newDate } : signal.claim;
      next = { ...signal, ...(commitmentId ? { commitmentId } : {}), claim, state: "applied" };
    }
    const nextRecords = { ...records, signals: records.signals.map((s) => (s.id === id ? next : s)) };
    const expected = typeof body.expectedRevision === "number" ? body.expectedRevision : storeRevision;
    if (decision === "dismiss") {
      const out = await commit(storeFor(req), b.id, key.key, hash, { expectedRevision: expected, records: { signals: [next] }, proposals: [], response: { signal: next, alert: null } }, "Your books changed. Review it again.");
      if (!out.replay) await refreshPending(storeFor(req), b.id, nextRecords, Number(out.body.storeRevision), nowIso());
      return out.body;
    }

    const { profile, asOf, fxRates } = runInputs(b, deps.now);
    const scenario = savedScenario(await storeFor(req).loadOverrides(b.id));
    const before = forecast(records, profile, scenario, asOf, fxRates).lowPoint;
    const after = forecast(nextRecords, profile, scenario, asOf, fxRates).lowPoint;
    const c = nextRecords.commitments.find((x) => x.id === next.commitmentId);
    const who = nextRecords.parties.find((p) => p.id === (next.partyId ?? c?.partyId))?.name ?? "A message";
    const money = (n: number) => fmtMoney(n, profile.baseCurrency);
    const response = {
      signal: next, lowPoint: after,
      alert: {
        title: `${who}: ${c?.reference ?? c?.sourceRef.record ?? "the change"}${next.claim.kind === "date_change" ? ` moves to ${fmtDate(next.claim.newDate, asOf)}` : " updated"}`,
        detail: `Your low point is now ${money(after.amount)} on ${fmtDate(after.date, asOf)}${after.amount < before.amount ? `, down ${money(before.amount - after.amount)}` : ""}.`,
      },
    };
    const out = await commit(storeFor(req), b.id, key.key, hash, { expectedRevision: expected, records: { signals: [next] }, proposals: [], response }, "Your books changed. Review it again.");
    if (!out.replay) await refreshPending(storeFor(req), b.id, nextRecords, Number(out.body.storeRevision), nowIso());
    return out.body;
  });

  // The owner approves or dismisses a standing rule that Ask Neri proposed. Only a confirmed rule reaches the forecast.
  app.post("/rules/:id/:decision", async (req) => {
    const b = businessOf(req);
    const { id, decision } = req.params as { id: string; decision: string };
    if (decision !== "confirm" && decision !== "dismiss") throw new HttpError(404, "NOT_FOUND", "Confirm or dismiss.");
    const key = idempotencyKey(req);
    const hash = requestHash(`rule-${decision}`, id, {});
    const prior = await priorDecision(storeFor(req), b.id, key, hash);
    if (prior) return prior.body;
    const { records, storeRevision } = await storeFor(req).load(b.id);
    const rule = records.rules.find((r) => r.id === id);
    if (!rule) throw new HttpError(404, "NOT_FOUND", "That rule is no longer in your list.");
    if (rule.state !== "proposed") throw new HttpError(409, "NOT_PROPOSED", `This rule was already ${rule.state}.`, { revision: storeRevision });
    const next: Rule = { ...rule, state: decision === "confirm" ? "confirmed" : "dismissed" };
    const nextRecords = { ...records, rules: records.rules.map((r) => (r.id === id ? next : r)) };
    const out = await commit(storeFor(req), b.id, key.key, hash, { expectedRevision: storeRevision, records: { rules: [next] }, proposals: [], response: { rule: next } }, "Your books changed. Reload and try again.");
    if (!out.replay) await refreshPending(storeFor(req), b.id, nextRecords, Number(out.body.storeRevision), nowIso());
    return out.body;
  });
};
