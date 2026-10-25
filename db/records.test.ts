import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Commitment } from "../schema/records";
import { StoreError, confirmChangeProposal, loadRecords, upsertCommitments, upsertRecords } from "./records";

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
