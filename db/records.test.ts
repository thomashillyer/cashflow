import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Commitment, WorkItem } from "../schema/records";
import {
  StoreError, confirmChangeProposal, loadRecords, loadWorkItems, saveWorkItems, setWorkItemState, upsertCommitments, upsertRecords,
} from "./records";

const commitment: Commitment = {
  id: "inv-INV-1187", type: "invoice", direction: "in", partyId: "p1", amount: 100, currency: "USD",
  anchors: {}, status: "committed", sourceRef: { system: "zoho_books", record: "INV-1187" },
};

function mockClient(rpcResult: { data?: unknown; error?: { message: string; code?: string } | null } = { data: 1, error: null }) {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn(() => ({ upsert }));
  const rpc = vi.fn().mockResolvedValue({ data: rpcResult.data ?? null, error: rpcResult.error ?? null });
  return { db: { from, rpc } as unknown as SupabaseClient, from, upsert, rpc };
}

describe("upsert", () => {
  it("passes onConflict and defaultToNull: false", async () => {
    const { db, from, upsert } = mockClient();
    await upsertCommitments(db, "cascade_trade", [commitment]);
    expect(from).toHaveBeenCalledWith("commitments");
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]![1]).toEqual({ onConflict: "business_id,id", defaultToNull: false });
    expect(upsert.mock.calls[0]![0][0]).toMatchObject({ business_id: "cascade_trade", id: "inv-INV-1187" });
  });

  it("upsertRecords bumps the store revision after writing", async () => {
    const { db, upsert, rpc } = mockClient({ data: 7 });
    const revision = await upsertRecords(db, "cascade_trade", { commitments: [commitment] });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("bump_store_revision", { p_business_id: "cascade_trade" });
    expect(revision).toBe(7);
  });
});

describe("loadRecords", () => {
  it("maps the load_records snapshot and returns the store revision", async () => {
    const { db, rpc } = mockClient({
      data: {
        storeRevision: 4,
        records: {
          parties: [], commitments: [{
            business_id: "b", id: "inv-1", type: "invoice", amount: 5, currency: "USD", anchors: {}, status: "committed",
            source_ref: { system: "zoho_books", record: "1" }, source_system: "zoho_books", source_record: "1",
            created_at: "2026-10-25T18:00:00+00:00", party_id: null,
          }],
          events: [], signals: [], rules: [], settlements: [], balances: [],
          evidence: [{
            business_id: "b", id: "ev-1", received_at: "2026-11-27T00:42:10.123456+00:00", channel: "email",
            format: "eml", extraction: "ok", source_ref: { system: "email", record: "x" },
          }],
        },
      },
    });
    const { records, storeRevision } = await loadRecords(db, "b");
    expect(rpc).toHaveBeenCalledWith("load_records", { p_business_id: "b" });
    expect(storeRevision).toBe(4);
    expect(records.commitments).toEqual([{
      id: "inv-1", type: "invoice", amount: 5, currency: "USD", anchors: {}, status: "committed",
      sourceRef: { system: "zoho_books", record: "1" },
    }]);
    expect(records.evidence[0]?.receivedAt).toBe("2026-11-27T00:42:10.123Z");
    expect(records.events).toEqual([]);
  });
});

describe("error mapping", () => {
  it("maps PT409/PT501 RPC errors to StoreError with code and HTTP status", async () => {
    const stale = mockClient({ error: { message: "STALE_REVIEW", code: "PT409" } });
    const err = await confirmChangeProposal(stale.db, "b", "cp-1", 0, "k").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err).toMatchObject({ code: "STALE_REVIEW", status: 409 });

    const notImpl = mockClient({ error: { message: "NOT_IMPLEMENTED", code: "PT501" } });
    await expect(confirmChangeProposal(notImpl.db, "b", "cp-1", 0, "k")).rejects.toMatchObject({ code: "NOT_IMPLEMENTED", status: 501 });

    const other = mockClient({ error: { message: "boom", code: "XX000" } });
    await expect(loadRecords(other.db, "b")).rejects.toMatchObject({ code: "DB_ERROR", status: 500 });
  });
});

describe("work items", () => {
  // A chainable PostgREST stand-in: records each call and resolves to `result` when awaited.
  function chain(result: { data?: unknown; error: null }) {
    const calls: [string, unknown[]][] = [];
    const q: Record<string, unknown> = {};
    for (const m of ["update", "eq", "select", "order", "maybeSingle"]) {
      q[m] = (...args: unknown[]) => { calls.push([m, args]); return q; };
    }
    q.then = (resolve: (v: unknown) => void) => resolve(result);
    return { q, calls };
  }

  const item: WorkItem = {
    id: 'wi-x-chase-inv-"1"', warning: "projected_cash_gap", title: "t", why: "w", cashEffect: 1, neededBy: "2026-12-12",
    confidence: 1, score: 1, evidenceRefs: [], actions: [{ kind: "mark_done" }], state: "open",
  };

  it("saveWorkItems makes one save_work_items RPC call with snake_case rows and no state", async () => {
    const { db, rpc, from } = mockClient({ data: 1 });
    await saveWorkItems(db, "cascade_trade", [{ ...item, lever: { kind: "defer", commitmentId: "c1", days: 10 } }], "hash-1");
    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0]!;
    expect(name).toBe("save_work_items");
    expect(args.p_business_id).toBe("cascade_trade");
    expect(args.p_inputs_hash).toBe("hash-1");
    expect(args.p_items).toHaveLength(1);
    expect(args.p_items[0]).toMatchObject({
      id: item.id, cash_effect: 1, needed_by: "2026-12-12", evidence_refs: [], lever: { kind: "defer", days: 10 },
    });
    expect(args.p_items[0]).not.toHaveProperty("state");
    expect(args.p_items[0]).not.toHaveProperty("business_id");
    expect(args.p_items[0]).not.toHaveProperty("inputsHash");
  });

  it("saveWorkItems sends an empty ranking so the hash is still stamped", async () => {
    const { db, rpc } = mockClient({ data: 0 });
    await saveWorkItems(db, "b", [], "hash-2");
    expect(rpc).toHaveBeenCalledWith("save_work_items", { p_business_id: "b", p_items: [], p_inputs_hash: "hash-2" });
  });

  it("saveWorkItems maps RPC errors to StoreError", async () => {
    const { db } = mockClient({ error: { message: "NOT_FOUND", code: "PT404" } });
    await expect(saveWorkItems(db, "nope", [], "h")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    const bad = mockClient({ error: { message: "INVALID_ARGUMENT", code: "PT400" } });
    await expect(saveWorkItems(bad.db, "b", [item, item], "h")).rejects.toMatchObject({ code: "INVALID_ARGUMENT", status: 400 });
  });

  const row = { business_id: "b", id: "wi-1", warning: "w", title: "t", why: "", cash_effect: 1, needed_by: "2026-12-12",
    confidence: 1, score: 1, evidence_refs: [], actions: [], state: "open", partner_action: null, lever: null };
  const load = (rows: object[], businessHash: string | null | undefined, business = true) =>
    loadWorkItems({
      from: (table: string) => table === "businesses"
        ? chain({ data: business ? { work_items_inputs_hash: businessHash } : null, error: null }).q
        : chain({ data: rows, error: null }).q,
    } as unknown as SupabaseClient, "b");

  it("loadWorkItems reports the per-business hash, even with zero items", async () => {
    const some = await load([{ ...row, inputs_hash: "old" }, { ...row, id: "wi-2", inputs_hash: null }], "h1");
    expect(some.inputsHash).toBe("h1");
    expect(some.items).toHaveLength(2);
    expect(some.items[0]).not.toHaveProperty("inputsHash");
    expect((await load([], "h2")).inputsHash).toBe("h2");
  });

  it("loadWorkItems has no hash when nothing was saved or the business is hidden", async () => {
    expect((await load([], null)).inputsHash).toBeUndefined();
    expect((await load([], undefined, false)).inputsHash).toBeUndefined();
  });

  it("loadWorkItems falls back to row hashes from before the per-business hash, only when they agree", async () => {
    expect((await load([{ ...row, inputs_hash: "h1" }, { ...row, id: "wi-2", inputs_hash: "h1" }], null)).inputsHash).toBe("h1");
    expect((await load([{ ...row, inputs_hash: "h1" }, { ...row, id: "wi-2", inputs_hash: null }], null)).inputsHash)
      .toBeUndefined();
  });

  it("setWorkItemState throws NOT_FOUND when no row changed", async () => {
    const { q } = chain({ data: [], error: null });
    await expect(setWorkItemState({ from: () => q } as unknown as SupabaseClient, "cascade_trade", "wi-x", "done"))
      .rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});
