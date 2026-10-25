// Runnable version of the flow in ai/README.md: how the API lane (person 3) and the integration lane
// (person 5) wire the Person 4 modules into routes. An in-memory `Store` stands in for Supabase
// (loadRecords / upsert* / confirm RPC); everything else is the real Person 4 code, in cache_only mode
// against the committed cascade_trade caches, so it needs no network and no API key.
//
// The README snippets are copied from the REGION blocks below. If you change one, change the other.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChangeProposal, IntakeCandidate } from "../schema/intake";
import type { Records, Signal, WorkItem } from "../schema/records";
import { loadBriefFixture } from "../scripts/brief-fixture";
import { draftMessage, writeBrief, type BriefContext } from "./brief";
import { ingest, mergeEvidence, type IntakeInput } from "./intake";
import { ApplyError, applyProposal, type ApplyErrorCode } from "./reconcile/apply";
import { poRemaining } from "./reconcile/match";
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
};

const newStore = (): Store => ({ records: baseRecords(), storeRevision: 1, candidates: new Map(), proposals: new Map() });

// Demo mode: the committed caches answer; nothing calls the network. For live mode use
// `mode: "live"` with ANTHROPIC_API_KEY set (see "Demo mode vs live mode" in the README).
const MODE = "cache_only" as const;
const BUSINESS = { name: "Cascade Trade Co.", aliases: ["Cascade Trade"] };   // from the business profile, not hard-coded
const NOW = "2026-11-28T18:00:00Z";                                          // pass the clock in

// REGION http-errors
// ApplyError.code -> HTTP status for POST /review/:id/confirm. `Record<ApplyErrorCode, number>` makes
// tsc fail if a new code is added without a status.
export const APPLY_ERROR_STATUS: Record<ApplyErrorCode, number> = {
  STALE_REVIEW: 409,       // the books changed since the owner looked: refresh Review, do not resubmit
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
  for (const p of result.proposals) store.proposals.set(p.id, p);   // upsertChangeProposals
  store.records.signals.push(...result.signals.filter((s) => !store.records.signals.some((x) => x.id === s.id))); // upsertSignals (state "proposed")

  return result;   // { evidence, candidates, proposals, signals, notes } is everything Review renders
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
    return { storeRevision: store.storeRevision, affectedRecordIds: applied.affectedRecordIds, warnings: applied.warnings };
  } catch (err) {
    if (err instanceof ApplyError) throw new HttpError(APPLY_ERROR_STATUS[err.code], err.code, err.message);
    throw err;
  }
}
// END REGION

// ---------------------------------------------------------------------------
// POST /signals/:id/apply

// REGION signal-apply
// The owner confirmed. Flipping state is the whole write; the engine applies "applied" signals as
// overrides on the next run, and the store revision moves so the forecast and brief are recomputed.
function applySignalRoute(store: Store, signalId: string): Signal {
  const signal = store.records.signals.find((s) => s.id === signalId);
  if (!signal) throw new HttpError(404, "NOT_FOUND", "That message is no longer in Review.");
  if (signal.state !== "proposed") throw new HttpError(409, "NOT_PROPOSED", `This message was already ${signal.state}.`);
  const applied: Signal = { ...signal, state: "applied" };   // dismiss is the same with state: "dismissed"
  store.records = { ...store.records, signals: store.records.signals.map((s) => (s.id === signalId ? applied : s)) };
  store.storeRevision += 1;
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

describe("integration flow (README)", () => {
  it("POST /import: an INV-1187 PDF is linked to the invoice already in the books, then confirmed", async () => {
    const store = newStore();
    const before = structuredClone(store.records.commitments);

    const result = await importRoute(store, { kind: "pdf", bytes: bytes("inv1187.pdf"), fileName: "inv1187.pdf" });
    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0]!;
    expect(proposal).toMatchObject({ action: "link", state: "proposed", targetCommitmentId: "inv-INV-1187", expectedStoreRevision: 1 });
    // Review shows the words behind each field.
    const candidate = result.candidates[0]!;
    expect(candidate.fields.reference).toMatchObject({ state: "found", value: "INV-1187" });
    expect(candidate.fields.reference.state === "found" && candidate.fields.reference.evidence[0]!.text).toBeTruthy();
    // Nothing is applied by importing.
    expect(store.records.commitments).toEqual(before);

    const confirmed = confirmRoute(store, proposal.id, store.storeRevision);
    expect(confirmed.storeRevision).toBe(2);
    expect(store.records.commitments).toHaveLength(before.length);       // evidence-only link: no new commitment
    expect(store.records.commitments.find((c) => c.id === "inv-INV-1187")!.evidenceIds).toContain(result.evidence[0]!.id);
    expect(cashView(store.records)).toEqual(cashView({ ...store.records, commitments: before }));   // no cash-relevant field moved
    expect(store.proposals.get(proposal.id)!.state).toBe("confirmed");
  });

  it("POST /review/:id/confirm: errors map to the documented HTTP statuses", async () => {
    const store = newStore();
    const { proposals } = await importRoute(store, { kind: "pdf", bytes: bytes("inv1187.pdf"), fileName: "inv1187.pdf" });
    const id = proposals[0]!.id;

    // A stale review (the books moved after the owner opened Review).
    expect(() => confirmRoute(store, id, store.storeRevision - 1)).toThrowError(expect.objectContaining({ status: 409, code: "STALE_REVIEW" }));

    confirmRoute(store, id, store.storeRevision);
    // The proposal is now confirmed, so repeating it is NOT_PROPOSED; this one needs a fresh revision to get past the stale check.
    store.proposals.set(id, { ...store.proposals.get(id)!, expectedStoreRevision: store.storeRevision });
    expect(() => confirmRoute(store, id, store.storeRevision)).toThrowError(expect.objectContaining({ status: 409, code: "NOT_PROPOSED" }));
    expect(() => confirmRoute(store, "missing", store.storeRevision)).toThrowError(expect.objectContaining({ status: 404 }));

    // NOTHING_TO_APPLY: a conflict/review item with no ops and no owner edits.
    const review: ChangeProposal = { ...proposals[0]!, id: "cp-review", action: "review", ops: [], state: "proposed", expectedStoreRevision: store.storeRevision };
    store.proposals.set(review.id, review);
    expect(() => confirmRoute(store, review.id, store.storeRevision)).toThrowError(expect.objectContaining({ status: 422, code: "NOTHING_TO_APPLY" }));

    // UNKNOWN_TARGET.
    const orphan: ChangeProposal = {
      ...proposals[0]!, id: "cp-orphan", state: "proposed", expectedStoreRevision: store.storeRevision,
      ops: [{ op: "linkEvidence", commitmentId: "inv-gone", evidenceIds: ["ev-x"] }],
    };
    store.proposals.set(orphan.id, orphan);
    expect(() => confirmRoute(store, orphan.id, store.storeRevision)).toThrowError(expect.objectContaining({ status: 404, code: "UNKNOWN_TARGET" }));

    // The mapping covers every ApplyError code.
    expect(Object.keys(APPLY_ERROR_STATUS).sort()).toEqual(["NOTHING_TO_APPLY", "NOT_PROPOSED", "OVER_ALLOCATED", "STALE_REVIEW", "UNKNOWN_TARGET"]);
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
    const applied = applySignalRoute(store, signal.id);
    expect(applied.state).toBe("applied");
    expect(store.records.signals[0]!.state).toBe("applied");
    expect(() => applySignalRoute(store, signal.id)).toThrowError(expect.objectContaining({ status: 409 }));
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
    const { proposals } = await importRoute(store, { kind: "pdf", bytes: bytes("harbor-po-552.pdf"), fileName: "harbor-po-552.pdf" });
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
