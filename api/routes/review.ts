// Import -> Review -> confirm (ai/README.md): POST /import/:adapter, GET /review, GET /review/proposals,
// POST /review/:id/confirm|dismiss, POST /signals/:id/apply|dismiss. Importing never applies anything;
// cash changes only when the owner confirms a proposal or applies a signal.

import type { FastifyInstance } from "fastify";
import type { ChangeProposal, CommitmentFieldChange } from "../../schema/intake";
import type { Commitment, Override, Records, Signal } from "../../schema/records";
import { forecast } from "../../engine/forecast";
import { ingest, type IntakeInput, type IntakeNote } from "../../ai/intake";
import { ApplyError, applyProposal, type ApplyErrorCode } from "../../ai/reconcile/apply";
import { propose } from "../../ai/reconcile/match";
import { fmtMoney } from "../../ai/money";
import type { Deps } from "../app";
import { businessIdentity, loadForRun, runInputs, savedScenario } from "../engine";
import { businessOf, HttpError, isIsoDate } from "../http";
import type { Business, Store } from "../store";

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
    message: { id: s.sourceRef.record, channel: s.channel, from: ev?.sourceRef.record ?? "", receivedAt: s.receivedAt, body: ev?.text ?? excerpt, excerpt },
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

function toInput(adapter: string, body: Record<string, unknown>, now: string): IntakeInput {
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
    kind = ext === "pdf" ? "pdf" : ext === "eml" ? "email" : ext === "txt" || ext === undefined ? "paste" : `.${ext}`;
  }
  switch (kind) {
    case "pdf": return { kind: "pdf", bytes: bytes(), ...(fileName ? { fileName } : {}) };
    case "email": return { kind: "email", raw: raw() };
    case "whatsapp": return { kind: "whatsapp", raw: raw() };
    case "paste": {
      const t = raw();
      if (!t.trim()) throw new HttpError(400, "INVALID_ARGUMENT", "Paste the message text first.", { fieldIssues: [{ field: "text", issue: "empty" }] });
      return { kind: "paste", text: t, receivedAt: typeof body.receivedAt === "string" && !Number.isNaN(Date.parse(body.receivedAt)) ? body.receivedAt : now };
    }
    default:
      throw new HttpError(415, "UNSUPPORTED", "Neri reads PDFs, emails (.eml), WhatsApp exports and pasted text here. For a spreadsheet, export it as PDF or paste the rows.");
  }
}

export const reviewRoutes = (deps: Deps) => async (app: FastifyInstance) => {
  const nowIso = () => deps.now().toISOString();

  app.post("/import/:adapter", async (req) => {
    const b = businessOf(req);
    const { adapter } = req.params as { adapter: string };
    const input = toInput(adapter, (req.body ?? {}) as Record<string, unknown>, nowIso());
    const { records, storeRevision } = await deps.store.load(b.id);
    const result = await ingest(input, {
      records, storeRevision, business: businessIdentity(b), mode: deps.aiMode, now: nowIso(),
      ...(b.profile.account?.timezone ? { timeZone: b.profile.account.timezone } : {}),
    });
    // Same input gives the same ids: never reopen a decided proposal, never reset a decided signal.
    const existing = new Map((await deps.store.listProposals(b.id)).map((p) => [p.id, p]));
    const proposals = result.proposals.filter((p) => existing.get(p.id)?.state !== "confirmed" && existing.get(p.id)?.state !== "dismissed");
    const known = new Set(records.signals.map((s) => s.id));
    const signals = result.signals.filter((s) => !known.has(s.id));
    await deps.store.saveIntake(b.id, { evidence: result.evidence, candidates: result.candidates, proposals, signals });
    if (result.notes.length) {
      const acc = b.profile.account ?? {};
      const seen = new Set((acc.intakeNotes ?? []).map((n) => `${n.scope}\u0000${n.text}`));
      const add: IntakeNote[] = result.notes.filter((n) => !seen.has(`${n.scope}\u0000${n.text}`));
      await deps.store.saveProfile(b.id, { ...b.profile, account: { ...acc, intakeNotes: [...(acc.intakeNotes ?? []), ...add].slice(-MAX_NOTES) } });
    }
    const byAction: Record<string, number> = {};
    for (const p of result.proposals) byAction[p.action] = (byAction[p.action] ?? 0) + 1;
    return { ...result, storeRevision, preview: { candidates: result.candidates.length, proposals: byAction, signals: result.signals.length } };
  });

  // The app's Review list: proposed signals with the words, the invoice, and the priced effect.
  app.get("/review", async (req) => {
    const b = businessOf(req);
    const { records, overrides } = await loadForRun(deps.store, b.id);
    return records.signals.filter((s) => s.state === "proposed").map((s) => signalItem(b, records, overrides, s, deps)).filter((x) => x !== null);
  });

  // Everything pending from imports: change proposals with their candidate fields, evidence and notes,
  // plus every proposed signal (including ambiguous ones that need the owner to pick an invoice).
  app.get("/review/proposals", async (req) => {
    const b = businessOf(req);
    const [{ records, storeRevision }, proposals, candidates] = await Promise.all([
      deps.store.load(b.id), deps.store.listProposals(b.id), deps.store.listCandidates(b.id),
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
    const [{ records, storeRevision }, proposals] = await Promise.all([deps.store.load(b.id), deps.store.listProposals(b.id)]);
    let proposal = proposals.find((p) => p.id === id);
    if (!proposal) throw new HttpError(404, "NOT_FOUND", "That item is no longer in Review.");
    if (proposal.state !== "proposed") throw new HttpError(409, "NOT_PROPOSED", `This item was already ${proposal.state}.`, { revision: storeRevision });
    const expected = typeof body.expectedRevision === "number" ? body.expectedRevision : storeRevision;
    if (expected !== storeRevision || proposal.expectedStoreRevision !== storeRevision) {
      throw new HttpError(409, "STALE_REVIEW", "Your books changed since you opened this. Review it again.", { revision: storeRevision, retryable: true });
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
    // Not one transaction (the RPC can't apply ops yet); the revision check above narrows the window.
    const revision = await deps.store.upsertRecords(b.id, applied.records);
    await deps.store.saveProposals(b.id, [{ ...proposal, state: "confirmed", decidedAt: nowIso() }]);
    await refreshPending(deps.store, b.id, applied.records, revision, nowIso());
    return { storeRevision: revision, affectedRecordIds: applied.affectedRecordIds, warnings: applied.warnings };
  });

  app.post("/review/:id/dismiss", async (req) => {
    const b = businessOf(req);
    const { id } = req.params as { id: string };
    const proposal = (await deps.store.listProposals(b.id)).find((p) => p.id === id);
    if (!proposal) throw new HttpError(404, "NOT_FOUND", "That item is no longer in Review.");
    if (proposal.state !== "proposed") throw new HttpError(409, "NOT_PROPOSED", `This item was already ${proposal.state}.`);
    await deps.store.saveProposals(b.id, [{ ...proposal, state: "dismissed", decidedAt: nowIso() }]);
    return { id, state: "dismissed" };
  });

  // Body (optional): { expectedRevision?, commitmentId?, newDate? }: the owner's picks.
  app.post("/signals/:id/:decision", async (req) => {
    const b = businessOf(req);
    const { id, decision } = req.params as { id: string; decision: string };
    if (decision !== "apply" && decision !== "dismiss") throw new HttpError(404, "NOT_FOUND", "Apply or dismiss.");
    const body = (req.body ?? {}) as { expectedRevision?: unknown; commitmentId?: unknown; newDate?: unknown };
    const { records, storeRevision } = await deps.store.load(b.id);
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
    const revision = await deps.store.upsertRecords(b.id, { signals: [next] });
    await refreshPending(deps.store, b.id, nextRecords, revision, nowIso());
    if (decision === "dismiss") return { signal: next, storeRevision: revision, alert: null };

    const { profile, asOf, fxRates } = runInputs(b, deps.now);
    const scenario = savedScenario(await deps.store.loadOverrides(b.id));
    const before = forecast(records, profile, scenario, asOf, fxRates).lowPoint;
    const after = forecast(nextRecords, profile, scenario, asOf, fxRates).lowPoint;
    const c = nextRecords.commitments.find((x) => x.id === next.commitmentId);
    const who = nextRecords.parties.find((p) => p.id === (next.partyId ?? c?.partyId))?.name ?? "A message";
    const money = (n: number) => fmtMoney(n, profile.baseCurrency);
    return {
      signal: next, storeRevision: revision, lowPoint: after,
      alert: {
        title: `${who}: ${c?.reference ?? c?.sourceRef.record ?? "the change"}${next.claim.kind === "date_change" ? ` moves to ${next.claim.newDate}` : " updated"}`,
        detail: `Your low point is now ${money(after.amount)} on ${after.date}${after.amount < before.amount ? `, down ${money(before.amount - after.amount)}` : ""}.`,
      },
    };
  });
};
