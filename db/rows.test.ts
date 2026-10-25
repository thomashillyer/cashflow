import { describe, expect, it } from "vitest";
import type { CashEvent, Commitment, Evidence } from "../schema/records";
import { fromRow, toRow } from "./rows";

describe("row mappers", () => {
  it("round-trips a Commitment", () => {
    const c: Commitment = {
      id: "inv-INV-1187",
      type: "invoice",
      direction: "in",
      reference: "INV-1187",
      partyId: "evergreen-home",
      amount: 2800000,
      currency: "USD",
      anchors: { invoice: "2026-11-10", due: "2026-12-10" },
      status: "committed",
      outstanding: 2800000,
      settlement: "open",
      invoiceUrl: "https://books.zoho.example/portal/cascadetrade/invoice/2-INV-1187",
      evidenceIds: ["ev-zoho-INV-1187"],
      sourceRef: { system: "zoho_books", record: "INV-1187" },
    };
    const row = toRow(c, "cascade_trade");
    expect(row).toMatchObject({
      business_id: "cascade_trade",
      direction: "in",
      reference: "INV-1187",
      party_id: "evergreen-home",
      invoice_url: c.invoiceUrl,
      evidence_ids: ["ev-zoho-INV-1187"],
      anchors: { invoice: "2026-11-10", due: "2026-12-10" },  // nested jsonb keeps camelCase
      source_ref: { system: "zoho_books", record: "INV-1187" },
    });
    expect(row).not.toHaveProperty("pattern_id");  // undefined fields are not written

    // What PostgREST returns: db-filled columns plus nulls for unset optionals.
    const fromDb = {
      ...row, pattern_id: null, probability: null, category: null, funding: null,
      created_at: "2026-10-25T18:00:00+00:00", source_system: "zoho_books", source_record: "INV-1187",
    };
    expect(fromRow<Commitment>(fromDb)).toEqual(c);
  });

  it("round-trips an unmatched bank actual (no commitmentId)", () => {
    const e: CashEvent = {
      id: "evt-bank-2026-11-16-001",
      legIndex: 0,
      date: "2026-11-16",
      amount: 2000000, currency: "USD", amountBase: 2000000,
      direction: "in",
      status: "actual",
      confidence: 1,
      basis: "bank line 2026-11-16",
      sourceRef: { system: "bank_csv", record: "a1b2c3" },
      overriddenBy: [],
    };
    const row = toRow(e, "cascade_trade");
    expect(row).toMatchObject({ leg_index: 0, amount_base: 2000000, overridden_by: [] });
    expect(row).not.toHaveProperty("commitment_id");
    const fromDb = {
      ...row, commitment_id: null, category: null,
      created_at: "2026-10-25T18:00:00+00:00", source_system: "bank_csv", source_record: "a1b2c3",
    };
    expect(fromRow<CashEvent>(fromDb)).toEqual(e);
  });

  it("round-trips Evidence with file metadata", () => {
    const ev: Evidence = {
      id: "ev-email-evg-1126#att-1",
      channel: "email",
      format: "pdf",
      receivedAt: "2026-11-27T00:42:10Z",
      parentId: "ev-email-evg-1126",
      fileName: "inv1187.pdf",
      mime: "application/pdf",
      storageKey: "cascade_trade/evidence/inv1187.pdf",
      fileHash: "sha256:abc",
      text: "INVOICE INV-1187",
      extraction: "ok",
      sourceRef: { system: "email", record: "evg-20261126-1642#att-1" },
    };
    const row = toRow(ev, "cascade_trade");
    expect(row).toMatchObject({ file_name: "inv1187.pdf", storage_key: ev.storageKey, parent_id: ev.parentId });
    const fromDb = {
      ...row, url: null, created_at: "2026-10-25T18:00:00+00:00", source_system: "email", source_record: "x",
    };
    expect(fromRow<Evidence>(fromDb)).toEqual(ev);
  });
});
