// Runnable version of the flow in ai/README.md: how the API lane (person 3) and the integration lane
// (person 5) wire the Person 4 modules into routes. An in-memory `Store` stands in for Supabase
// (loadRecords / upsert* / confirm RPC); everything else is the real Person 4 code, in cache_only mode
// against the committed cascade_trade caches, so it needs no network and no API key.
//
// The README snippets are copied from the REGION blocks below. If you change one, change the other.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChangeProposal, CommitmentFieldChange, IntakeCandidate } from "../schema/intake";
import type { Commitment, Records, Signal, WorkItem } from "../schema/records";
import { loadBriefFixture } from "../scripts/brief-fixture";
import { draftMessage, writeBrief, type BriefContext } from "./brief";
import { ingest, mergeEvidence, type IntakeInput, type IntakeNote } from "./intake";
import { ApplyError, applyProposal, type ApplyErrorCode } from "./reconcile/apply";
import { poRemaining, propose } from "./reconcile/match";
import { baseRecords, cashView } from "./reconcile/testkit";

const dir = join(import.meta.dirname, "../fixtures/cascade_trade/intake");
const bytes = (name: string) => new Uint8Array(readFileSync(join(dir, name)));
const text = (name: string) => readFileSync(join(dir, name), "utf8");

// ---------------------------------------------------------------------------
// The stand-in store. In the real app: loadRecords(db, businessId) for reads, the upsertX helpers
// (service role) for writes, and change_proposals / intake_candidates tables for the review queue.

type Store = {
  records: Records;
  storeRevision: number;
  candidates: Map<string, IntakeCandidate>;
  proposals: Map<string, ChangeProposal>;
  notes: IntakeNote[];
};

const newStore = (): Store => ({
  records: baseRecords(), storeRevision: 1, candidates: new Map(), proposals: new Map(), notes: [],
});

// Demo mode: the committed caches answer; nothing calls the network. For live mode use
// `mode: "live"` with ANTHROPIC_API_KEY set (see "Demo mode vs live mode" in the README).
const MODE = "cache_only" as const;
const BUSINESS = { name: "Cascade Trade Co.", aliases: ["Cascade Trade"] };   // from the business profile, not hard-coded
const NOW = "2026-11-28T18:00:00Z";                                          // pass the clock in

// REGION http-errors
// ApplyError.code -> HTTP status for POST /review/:id/confirm. `Record<ApplyErrorCode, number>` makes
// tsc fail if a new code is added without a status.
export const APPLY_ERROR_STATUS: Record<ApplyErrorCode, number> = {
  STALE_REVIEW: 409,       // a field changed since the owner looked: rebuild the proposal, show it again
  NOT_PROPOSED: 409,       // already confirmed or dismissed (a double click or a retry)
  OVER_ALLOCATED: 409,     // linked invoices would exceed the PO; the owner picks how much to allocate
  NOTHING_TO_APPLY: 422,   // a conflict/review item with no ops and no ownerEdits: the owner must resolve it
  UNKNOWN_TARGET: 404,     // the commitment the proposal points at no longer exists
};
// END REGION

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// POST /import/:adapter

// REGION import
// The adapter (person 1) has already captured the file/paste and stored the original; the route passes
// its ids through input.source and Person 4 does the reading.
async function importRoute(store: Store, input: IntakeInput) {
  const { records, storeRevision } = store;                       // loadRecords(db, businessId)
  const result = await ingest(input, { records, storeRevision, business: BUSINESS, mode: MODE, now: NOW });

  // Persist for Review (service role). Use the individual upsertEvidence / upsertIntakeCandidates /
  // upsertChangeProposals / upsertSignals helpers. NOT upsertRecords: it bumps the store revision and
  // would make the proposals you just created stale.
  store.records = mergeEvidence(store.records, result.evidence);  // upsertEvidence
  for (const c of result.candidates) store.candidates.set(c.id, c); // upsertIntakeCandidates
  for (const p of result.proposals) {                              // upsertChangeProposals
    // Same input gives the same ids, so a re-import must not reopen a decided proposal.
    if (!store.proposals.has(p.id) || store.proposals.get(p.id)!.state === "proposed") store.proposals.set(p.id, p);
  }
  for (const s of result.signals) {                                // upsertSignals (state "proposed")
    if (!store.records.signals.some((x) => x.id === s.id)) store.records.signals.push(s);
  }
  store.notes.push(...result.notes);                               // keep notes for Review

  return result;   // { evidence, candidates, proposals, signals, notes } is everything Review renders
}
// END REGION

// ---------------------------------------------------------------------------
// After any write that moves the store revision

// REGION refresh
// Every pending proposal is pinned to the revision it was computed against. A confirm or a signal apply
// bumps the revision, so without this step the owner's second confirm is STALE_REVIEW forever.
// Rebuild each still-pending proposal from its stored candidate against the new records. The id is the
// same ("cp-<candidate>-r<n>"), so it replaces the old one in place; decided proposals are never touched.
// (A note-only candidate loses its "attach this message to the invoice" link op here; the signal is
// unaffected. Re-run ingest from the stored original instead if you need that link back.)
function refreshPending(store: Store): void {
  for (const [id, p] of store.proposals) {
    const candidate = p.candidateId ? store.candidates.get(p.candidateId) : undefined;
    if (p.state !== "proposed" || !candidate) continue;
    store.proposals.set(id, propose(candidate, store.records, { storeRevision: store.storeRevision, now: NOW }));
  }
}
// END REGION

// ---------------------------------------------------------------------------
// POST /review/:id/confirm

// REGION confirm
// Today the confirm_change_proposal RPC validates and locks but raises NOT_IMPLEMENTED when a proposal
// has ops. Until the RPC applies ops, the server applies them here with applyProposal and writes the
// result. Ideally this whole function runs in one transaction (extend the RPC or wrap it in one).
function confirmRoute(store: Store, proposalId: string, expectedRevision: number) {
  const proposal = store.proposals.get(proposalId);
  if (!proposal) throw new HttpError(404, "NOT_FOUND", "That item is no longer in Review.");
  // Decided already (a double click, or a retry after a lost response): say so before the revision check,
  // because the first confirm moved the revision. With an Idempotency-Key, replay the stored result instead.
  if (proposal.state !== "proposed") throw new HttpError(409, "NOT_PROPOSED", `This item was already ${proposal.state}.`);
  // applyProposal does not check revisions; the route does (the RPC does the same check).
  if (expectedRevision !== store.storeRevision || proposal.expectedStoreRevision !== store.storeRevision) {
    throw new HttpError(409, "STALE_REVIEW", "Your books changed since you opened this. Review it again.");
  }
  try {
    const applied = applyProposal(store.records, proposal, { now: NOW });
    // Persist: upsertRecords(db, businessId, applied.records) (idempotent upserts, bumps the revision)
    // and upsert the proposal as { ...proposal, state: "confirmed", decidedAt: NOW }.
    store.records = applied.records;
    store.storeRevision += 1;
    store.proposals.set(proposal.id, { ...proposal, state: "confirmed", decidedAt: NOW });
    refreshPending(store);   // the other pending proposals are now one revision behind
    return { storeRevision: store.storeRevision, affectedRecordIds: applied.affectedRecordIds, warnings: applied.warnings };
  } catch (err) {
    if (err instanceof ApplyError) throw new HttpError(APPLY_ERROR_STATUS[err.code], err.code, err.message);
    throw err;
  }
}
// END REGION

// ---------------------------------------------------------------------------
// Resolving a review item the owner has to decide

// REGION resolve
// A `review` proposal with matchCandidates has no ops until the owner picks one. Turn the pick into an op
// (link this evidence to that invoice), save the resolved proposal, then confirm it as usual.
function resolveWithPick(proposal: ChangeProposal, commitmentId: string): ChangeProposal {
  if (!proposal.matchCandidates?.some((m) => m.commitmentId === commitmentId)) {
    throw new HttpError(400, "INVALID_ARGUMENT", "Pick one of the invoices offered.");
  }
  return {
    ...proposal, action: "link", targetCommitmentId: commitmentId,
    ops: [...proposal.ops, { op: "linkEvidence", commitmentId, evidenceIds: proposal.evidenceIds }],
  };
}

// ownerEdits come from the request body, and applyProposal writes them as given. Validate first:
// only these fields, integer minor units, ISO dates, `from` read from the stored commitment. Never settlement.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function validOwnerEdits(body: unknown, target: Commitment): CommitmentFieldChange[] {
  if (!Array.isArray(body)) throw new HttpError(400, "INVALID_ARGUMENT", "Edits must be a list.");
  return body.map((raw: { field?: unknown; to?: unknown }) => {
    const { field, to } = raw;
    const bad = () => new HttpError(400, "INVALID_ARGUMENT", `Cannot change ${String(field)} to that value.`);
    if (field === "amount" || field === "outstanding") {
      if (typeof to !== "number" || !Number.isSafeInteger(to) || to < 0) throw bad();
      return { field, from: target[field], to };
    }
    if (field === "currency") {
      if (typeof to !== "string" || !/^[A-Z]{3}$/.test(to)) throw bad();
      return { field, from: target.currency, to };
    }
    if (field === "anchors.invoice" || field === "anchors.due" || field === "anchors.order" || field === "anchors.ship" || field === "anchors.delivery") {
      if (typeof to !== "string" || !ISO_DATE.test(to)) throw bad();
      return { field, from: target.anchors[field.slice(8) as keyof Commitment["anchors"]], to };
    }
    throw bad();   // settlement, type, id, sourceRef, urls, party: not editable here
  });
}
// END REGION

// ---------------------------------------------------------------------------
// POST /signals/:id/apply

// REGION signal-apply
// The owner confirmed. Flipping state is the write; the engine applies "applied" signals as overrides on
// the next run, but it skips a signal with no commitmentId, so one must be set. The body carries what the
// owner picked: { commitmentId?, newDate? }.
function applySignalRoute(store: Store, signalId: string, expectedRevision: number, pick: { commitmentId?: string; newDate?: string } = {}): Signal {
  const signal = store.records.signals.find((s) => s.id === signalId);
  if (!signal) throw new HttpError(404, "NOT_FOUND", "That message is no longer in Review.");
  if (signal.state !== "proposed") throw new HttpError(409, "NOT_PROPOSED", `This message was already ${signal.state}.`);
  if (expectedRevision !== store.storeRevision) throw new HttpError(409, "STALE_REVIEW", "Your books changed. Review it again.");

  // Ambiguous match: no commitmentId until the owner picks one of signal.matchCandidates.
  const commitmentId = signal.commitmentId ?? pick.commitmentId;
  if (!commitmentId || !store.records.commitments.some((c) => c.id === commitmentId)) {
    throw new HttpError(422, "COMMITMENT_REQUIRED", "Pick which invoice this message is about.");
  }
  // Vague date ("end of the month"): claim.newDate is only a suggestion. The owner must pick or accept one.
  const vague = store.notes.some((n) => n.scope === signal.id && n.text === "owner must confirm the date");
  if (vague && !pick.newDate) throw new HttpError(422, "DATE_REQUIRED", "Pick the date they mean.");
  if (pick.newDate && !/^\d{4}-\d{2}-\d{2}$/.test(pick.newDate)) throw new HttpError(400, "INVALID_ARGUMENT", "Dates look like 2026-11-03.");

  const claim = signal.claim.kind === "date_change" && pick.newDate ? { ...signal.claim, newDate: pick.newDate } : signal.claim;
  const applied: Signal = { ...signal, commitmentId, claim, state: "applied" };   // dismiss: state "dismissed", nothing else
  store.records = { ...store.records, signals: store.records.signals.map((s) => (s.id === signalId ? applied : s)) };
  store.storeRevision += 1;   // db.rpc("bump_store_revision", ...) after upsertSignals
  refreshPending(store);
  return applied;
}
// END REGION

// ---------------------------------------------------------------------------
// GET /brief and POST /work-items/:id/draft

// REGION brief
// `items` are the engine's ranked WorkItems (runChecks + rank, person 5) for the run you are returning;
// `run`, `records`, `profile` are that same run's inputs, so every number in the words matches the chart.
async function briefRoute(items: WorkItem[], ctx: BriefContext) {
  const { items: top, usedFallback } = await writeBrief(items, ctx);   // at most 3 items, order unchanged
  return { items: top, usedFallback };   // only title and why changed; cashEffect, score, neededBy, lever are the engine's
}

async function draftRoute(item: WorkItem, ctx: BriefContext) {
  return draftMessage(item, ctx);   // text only: { subject?, body, channel, links, usedFallback }. Nothing is sent.
}
// END REGION

// ---------------------------------------------------------------------------

const importPdf = (store: Store, name: string) => importRoute(store, { kind: "pdf", bytes: bytes(name), fileName: name });
const rejects = (fn: () => unknown, status: number, code?: string) =>
  expect(fn).toThrowError(expect.objectContaining({ status, ...(code ? { code } : {}) }));

describe("integration flow (README)", () => {
  it("POST /import: an INV-1187 PDF is linked to the invoice already in the books, then confirmed", async () => {
    const store = newStore();
    const before = structuredClone(store.records.commitments);

    const result = await importPdf(store, "inv1187.pdf");
    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0]!;
    expect(proposal).toMatchObject({ action: "link", state: "proposed", targetCommitmentId: "inv-INV-1187", expectedStoreRevision: 1 });
    // Review shows the words behind each field.
    const reference = result.candidates[0]!.fields.reference;
    expect(reference).toMatchObject({ state: "found", value: "INV-1187" });
    expect(reference.state === "found" && reference.evidence[0]!.text).toBeTruthy();
    // Nothing is applied by importing.
    expect(store.records.commitments).toEqual(before);

    const confirmed = confirmRoute(store, proposal.id, store.storeRevision);
    expect(confirmed.storeRevision).toBe(2);
    expect(store.records.commitments).toHaveLength(before.length);       // evidence-only link: no new commitment
    expect(store.records.commitments.find((c) => c.id === "inv-INV-1187")!.evidenceIds).toContain(result.evidence[0]!.id);
    expect(cashView(store.records)).toEqual(cashView({ ...store.records, commitments: before }));   // no cash-relevant field moved
    expect(store.proposals.get(proposal.id)!.state).toBe("confirmed");

    // A re-import proposes the same ids but must not reopen the decided proposal.
    await importPdf(store, "inv1187.pdf");
    expect(store.proposals.get(proposal.id)!.state).toBe("confirmed");
  });

  it("two imports confirmed in turn: the second proposal is rebuilt against the new revision", async () => {
    const store = newStore();
    const link = (await importPdf(store, "inv1187.pdf")).proposals[0]!;
    const bill = (await importPdf(store, "ningbo-bill-0042.pdf")).proposals[0]!;
    expect(bill).toMatchObject({ action: "create", expectedStoreRevision: 1 });
    const commitments = store.records.commitments.length;

    confirmRoute(store, link.id, 1);
    const rebuilt = store.proposals.get(bill.id)!;
    expect(rebuilt).toMatchObject({ id: bill.id, state: "proposed", expectedStoreRevision: 2 });

    confirmRoute(store, bill.id, store.storeRevision);                    // without refreshPending this is STALE_REVIEW
    expect(store.records.commitments).toHaveLength(commitments + 1);
    expect(store.storeRevision).toBe(3);
  });

  it("POST /review/:id/confirm: errors map to the documented HTTP statuses", async () => {
    const store = newStore();
    const { proposals } = await importPdf(store, "inv1187.pdf");
    const id = proposals[0]!.id;

    rejects(() => confirmRoute(store, id, store.storeRevision - 1), 409, "STALE_REVIEW");     // the owner's page is old
    confirmRoute(store, id, store.storeRevision);
    rejects(() => confirmRoute(store, id, store.storeRevision), 409, "NOT_PROPOSED");          // double click or retry
    rejects(() => confirmRoute(store, "missing", store.storeRevision), 404, "NOT_FOUND");

    const open = (over: Partial<ChangeProposal>): ChangeProposal =>
      ({ ...proposals[0]!, state: "proposed", expectedStoreRevision: store.storeRevision, ...over });
    const put = (p: ChangeProposal) => { store.proposals.set(p.id, p); return p.id; };

    // NOTHING_TO_APPLY: a conflict/review item with no ops and no owner edits.
    rejects(() => confirmRoute(store, put(open({ id: "cp-review", action: "review", ops: [] })), store.storeRevision), 422, "NOTHING_TO_APPLY");
    // UNKNOWN_TARGET: the commitment is gone.
    rejects(() => confirmRoute(store, put(open({ id: "cp-orphan", ops: [{ op: "linkEvidence", commitmentId: "inv-gone", evidenceIds: ["ev-x"] }] })), store.storeRevision), 404, "UNKNOWN_TARGET");
    // STALE_REVIEW from applyProposal: the field the proposal wanted to change moved after review.
    rejects(() => confirmRoute(store, put(open({
      id: "cp-stale",
      ops: [{ op: "updateCommitment", commitmentId: "inv-INV-1187", change: { field: "amount", from: 1, to: 2 }, evidence: [] }],
    })), store.storeRevision), 409, "STALE_REVIEW");
    // OVER_ALLOCATED: an invoice bigger than the PO it is linked to.
    const inv = store.records.commitments.find((c) => c.id === "inv-INV-1187")!;
    store.records.commitments.push({ ...inv, id: "po-small", type: "purchase_order", amount: 100, linkedCommitmentIds: undefined } as Commitment);
    rejects(() => confirmRoute(store, put(open({ id: "cp-over", ops: [{ op: "linkCommitments", fromId: inv.id, toId: "po-small" }] })), store.storeRevision), 409, "OVER_ALLOCATED");

    // The mapping covers every ApplyError code.
    expect(Object.keys(APPLY_ERROR_STATUS).sort()).toEqual(["NOTHING_TO_APPLY", "NOT_PROPOSED", "OVER_ALLOCATED", "STALE_REVIEW", "UNKNOWN_TARGET"]);
  });

  it("an ambiguous review item is resolved by the owner's pick, and owner edits are validated", async () => {
    const store = newStore();
    const { proposals } = await importPdf(store, "inv1187.pdf");
    const review: ChangeProposal = {
      ...proposals[0]!, id: "cp-ambiguous", action: "review", ops: [], targetCommitmentId: undefined,
      matchCandidates: [{ commitmentId: "inv-INV-1187", reasons: ["same amount"] }, { commitmentId: "inv-INV-104", reasons: ["same party"] }],
    };
    rejects(() => resolveWithPick(review, "inv-other"), 400);
    const resolved = resolveWithPick(review, "inv-INV-1187");
    store.proposals.set(resolved.id, resolved);
    confirmRoute(store, resolved.id, store.storeRevision);
    expect(store.records.commitments.find((c) => c.id === "inv-INV-1187")!.evidenceIds).toEqual(expect.arrayContaining(review.evidenceIds));

    const target = store.records.commitments.find((c) => c.id === "inv-INV-1187")!;
    expect(validOwnerEdits([{ field: "amount", to: 2750000 }], target)).toEqual([{ field: "amount", from: target.amount, to: 2750000 }]);
    for (const bad of [
      [{ field: "settlement", to: "paid" }], [{ field: "type", to: "bill" }], [{ field: "amount", to: "2750000" }],
      [{ field: "amount", to: 27500.5 }], [{ field: "anchors.due", to: "next friday" }], "amount",
    ]) rejects(() => validOwnerEdits(bad, target), 400);
  });

  it("POST /import then /signals/:id/apply: an owner note about INV-104 becomes a proposed signal", async () => {
    const store = newStore();
    const result = await importRoute(store, { kind: "paste", text: text("owner-message-inv104.txt"), receivedAt: "2026-10-25T16:00:00Z" });

    expect(result.signals).toHaveLength(1);
    const signal = result.signals[0]!;
    expect(signal).toMatchObject({
      state: "proposed", channel: "owner", commitmentId: "inv-INV-104", claim: { kind: "date_change", newDate: "2026-11-03" },
    });
    // The cited words for Review: sourceRef.excerpt.text, never an instruction.
    expect(signal.sourceRef.excerpt!.text).toBe("will be paid November 3 instead of October 30");
    // Notes are plain text scoped to what they are about (candidate, proposal, signal, or evidence id).
    expect(result.notes.every((n) => typeof n.scope === "string" && typeof n.text === "string")).toBe(true);

    // Nothing moves until the owner applies the signal.
    expect(store.records.signals.map((s) => s.state)).toEqual(["proposed"]);
    rejects(() => applySignalRoute(store, signal.id, 0), 409, "STALE_REVIEW");
    const applied = applySignalRoute(store, signal.id, store.storeRevision);
    expect(applied).toMatchObject({ state: "applied", commitmentId: "inv-INV-104" });
    expect(store.records.signals[0]!.state).toBe("applied");
    rejects(() => applySignalRoute(store, signal.id, store.storeRevision), 409, "NOT_PROPOSED");
  });

  it("signal apply: an ambiguous match needs a pick, and a vague date needs the owner's date", async () => {
    const store = newStore();
    const signal = (await importRoute(store, { kind: "paste", text: text("owner-message-inv104.txt"), receivedAt: "2026-10-25T16:00:00Z" })).signals[0]!;

    // No commitmentId: the engine would skip it, so applying must not silently succeed.
    store.records.signals[0] = { ...signal, commitmentId: undefined, matchCandidates: [{ commitmentId: "inv-INV-104", reasons: ["same party"] }] } as Signal;
    delete store.records.signals[0]!.commitmentId;
    rejects(() => applySignalRoute(store, signal.id, store.storeRevision), 422, "COMMITMENT_REQUIRED");
    rejects(() => applySignalRoute(store, signal.id, store.storeRevision, { commitmentId: "inv-nope" }), 422, "COMMITMENT_REQUIRED");

    // A vague date is flagged by this exact note, scoped to the signal.
    store.notes.push({ scope: signal.id, text: "owner must confirm the date" });
    rejects(() => applySignalRoute(store, signal.id, store.storeRevision, { commitmentId: "inv-INV-104" }), 422, "DATE_REQUIRED");
    rejects(() => applySignalRoute(store, signal.id, store.storeRevision, { commitmentId: "inv-INV-104", newDate: "soon" }), 400);
    const applied = applySignalRoute(store, signal.id, store.storeRevision, { commitmentId: "inv-INV-104", newDate: "2026-11-05" });
    expect(applied).toMatchObject({ state: "applied", commitmentId: "inv-INV-104", claim: { kind: "date_change", newDate: "2026-11-05" } });
  });

  it("GET /brief and POST /work-items/:id/draft: three items with words, and a draft that is only text", async () => {
    const fx = loadBriefFixture();
    const ctx: BriefContext = { run: fx.run, records: fx.records, profile: fx.profile, business: fx.business, mode: MODE };

    const brief = await briefRoute(fx.items, ctx);
    expect(brief.items).toHaveLength(3);
    for (const item of brief.items) {
      expect(item.title.trim()).not.toBe("");
      expect(item.why.trim()).not.toBe("");
    }
    expect(brief.items.map((i) => i.id)).toEqual(fx.items.map((i) => i.id));   // the engine's order
    expect(brief.items.map((i) => i.cashEffect)).toEqual(fx.items.map((i) => i.cashEffect));
    expect(brief.usedFallback).toEqual([]);                                     // the committed cache covers the fixture

    const draft = await draftRoute(fx.items[0]!, ctx);
    expect(draft.body.length).toBeGreaterThan(0);
    expect(draft.channel).toBe("email");
    expect(draft.links.every((l) => l.startsWith("https://"))).toBe(true);
  });

  it("a customer PO confirms as a commitment; poRemaining is what no invoice covers yet", async () => {
    const store = newStore();
    const { proposals } = await importPdf(store, "harbor-po-552.pdf");
    expect(proposals[0]!.action).toBe("create");
    const { affectedRecordIds } = confirmRoute(store, proposals[0]!.id, store.storeRevision);
    const po = store.records.commitments.find((c) => c.type === "purchase_order" && affectedRecordIds.includes(c.id))!;
    expect(poRemaining(store.records, po.id)).toBe(po.amount);   // nothing invoiced against it yet
    expect(poRemaining(store.records, "nope")).toBeUndefined();
  });

  it("ingest never touches the records it is given", async () => {
    const store = newStore();
    const snapshot = structuredClone(store.records);
    await ingest({ kind: "pdf", bytes: bytes("inv1187.pdf"), fileName: "inv1187.pdf" },
      { records: store.records, storeRevision: 1, business: BUSINESS, mode: MODE, now: NOW });
    expect(store.records).toEqual(snapshot);
  });
});
