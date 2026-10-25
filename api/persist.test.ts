import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAccounting, type AccountingDoc, type AccountingPayment } from "../adapters/accounting/common";
import type { Override } from "../schema/records";
import { persistImport, planImport } from "./persist";
import { MemoryStore, type StoredProfile } from "./store";

const profile = JSON.parse(readFileSync(join(import.meta.dirname, "../profiles/trading.json"), "utf8")) as StoredProfile;

const invoice = (over: Partial<AccountingDoc> = {}): AccountingDoc => ({
  kind: "invoice", providerId: "i1", number: "1001", partyId: "c1", partyName: "Evergreen Home", currency: "USD",
  total: 280, balance: 240, issued: "2026-11-10", due: "2026-12-10", status: "partially_paid" as never, raw: { v: 1 },
  sheet: "invoices", row: 1, ...over,
});
const payment: AccountingPayment = { providerId: "p1", date: "2026-11-20", applied: [{ kind: "invoice", docProviderId: "i1", amount: 40 }] };

const pull = (now: string, doc: AccountingDoc = invoice()) =>
  buildAccounting({ system: "zoho_books", now, docs: [doc], payments: [payment] });

async function setup() {
  const store = new MemoryStore();
  const id = await store.createBusiness({ name: "Test Trading", profile, isSynthetic: true });
  return { store, id };
}

describe("persistImport (#148)", () => {
  it("adds a first pull's records and bumps the revision once", async () => {
    const { store, id } = await setup();
    const before = (await store.load(id)).storeRevision;
    const r = await persistImport(store, id, pull("2026-11-25T10:00:00Z"));
    expect(r).toMatchObject({ written: true, storeRevision: before + 1 });
    expect(r.commitments).toEqual({ added: 1, updated: 0, unchanged: 0 });
    const { records } = await store.load(id);
    expect(records.commitments.map((c) => c.id)).toEqual(["inv-1001"]);
    expect(records.settlements).toHaveLength(1);
    expect(records.evidence).toHaveLength(1);
  });

  it("a repeat pull writes nothing and leaves the store revision alone", async () => {
    const { store, id } = await setup();
    await persistImport(store, id, pull("2026-11-25T10:00:00Z"));
    const snapshot = await store.load(id);
    const r = await persistImport(store, id, pull("2026-11-26T10:00:00Z"));   // later read, same books
    expect(r).toMatchObject({ written: false, storeRevision: snapshot.storeRevision });
    expect(r.commitments).toEqual({ added: 0, updated: 0, unchanged: 1 });
    expect(r.evidence).toEqual({ added: 0, updated: 0, unchanged: 1 });
    expect(await store.load(id)).toEqual(snapshot);
  });

  it("an edited invoice updates its one row and its evidence keeps the stored id", async () => {
    const { store, id } = await setup();
    await persistImport(store, id, pull("2026-11-25T10:00:00Z"));
    const r = await persistImport(store, id, pull("2026-11-26T10:00:00Z", invoice({ total: 300, balance: 260, raw: { v: 2 } })));
    expect(r.commitments).toEqual({ added: 0, updated: 1, unchanged: 0 });
    expect(r.evidence).toEqual({ added: 0, updated: 1, unchanged: 0 });
    const { records } = await store.load(id);
    expect(records.commitments).toHaveLength(1);
    expect(records.commitments[0]).toMatchObject({ id: "inv-1001", amount: 30000, outstanding: 26000 });
    expect(records.evidence).toHaveLength(1);
  });

  it("a renumbered invoice keeps its stored id, so no duplicate and the payment follows it", async () => {
    const { store, id } = await setup();
    await persistImport(store, id, pull("2026-11-25T10:00:00Z"));
    await persistImport(store, id, pull("2026-11-26T10:00:00Z", invoice({ number: "1001-A", raw: { v: 3 } })));
    const { records } = await store.load(id);
    expect(records.commitments.map((c) => [c.id, c.reference])).toEqual([["inv-1001", "1001-A"]]);
    expect(records.settlements.map((s) => s.commitmentId)).toEqual(["inv-1001"]);
  });

  it("keeps the owner's party tags and notes, linked evidence, and saved overrides", async () => {
    const { store, id } = await setup();
    await persistImport(store, id, pull("2026-11-25T10:00:00Z"));
    const { records } = await store.load(id);
    const party = records.parties[0]!;
    await store.upsertRecords(id, {
      parties: [{ ...party, tags: ["slow_payer"], notes: ["They always pay about two weeks late"] }],
      commitments: [{ ...records.commitments[0]!, evidenceIds: [...records.commitments[0]!.evidenceIds!, "ev-upload-pdf-1187"] }],
    });
    const override: Override = { id: "ov-1", target: { commitmentId: "inv-1001" }, change: { shiftDays: 7 }, origin: "owner" };
    await store.saveOverrides(id, [override]);

    await persistImport(store, id, pull("2026-11-26T10:00:00Z", invoice({ partyName: "Evergreen Home LLC", balance: 200, raw: { v: 4 } })));
    const after = await store.load(id);
    expect(after.records.parties[0]).toMatchObject({
      name: "Evergreen Home LLC", tags: ["slow_payer"], notes: ["They always pay about two weeks late"], aliases: ["Evergreen Home"],
    });
    expect(after.records.commitments[0]!.evidenceIds).toContain("ev-upload-pdf-1187");
    expect(after.records.commitments[0]!.outstanding).toBe(20000);
    expect(await store.loadOverrides(id)).toEqual([override]);
  });

  it("a failed re-read never replaces a readable document", () => {
    const first = pull("2026-11-25T10:00:00Z");
    const existing = { parties: first.parties, commitments: first.commitments, settlements: first.settlements, evidence: first.evidence,
      events: [], signals: [], rules: [], balances: [] };
    const broken = pull("2026-11-26T10:00:00Z", invoice({ total: 1, balance: 1, raw: { v: 5 } }));
    broken.evidence = broken.evidence.map((e) => ({ ...e, extraction: "unreadable" as const }));
    const { write, summary } = planImport(existing, broken);
    expect(write.evidence).toEqual([]);
    expect(write.commitments).toEqual([]);
    expect(summary.commitments.unchanged).toBe(1);
  });
});
