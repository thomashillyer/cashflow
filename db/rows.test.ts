import { describe, expect, it } from "vitest";
import type { CashEvent, Commitment } from "../schema/records";
import { fromRow, toRow } from "./rows";

describe("row mappers", () => {
  it("round-trips a Commitment", () => {
    const c: Commitment = {
      id: "inv-INV-1187",
      type: "invoice",
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
      party_id: "evergreen-home",
      invoice_url: c.invoiceUrl,
      evidence_ids: ["ev-zoho-INV-1187"],
      anchors: { invoice: "2026-11-10", due: "2026-12-10" },  // nested jsonb keeps camelCase
      source_ref: { system: "zoho_books", record: "INV-1187" },
    });
    expect(row).not.toHaveProperty("pattern_id");  // undefined fields are not written

    // What PostgREST returns: db-filled columns plus nulls for unset optionals.
    const fromDb = {
      ...row, pattern_id: null, probability: null, created_at: "2026-10-25T18:00:00+00:00",
      source_system: "zoho_books", source_record: "INV-1187",
    };
    expect(fromRow<Commitment>(fromDb)).toEqual(c);
  });

  it("round-trips a CashEvent", () => {
    const e: CashEvent = {
      id: "evt-bank-2026-11-16-001",
      commitmentId: "inv-INV-1150",
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
    expect(row).toMatchObject({ commitment_id: "inv-INV-1150", leg_index: 0, amount_base: 2000000, overridden_by: [] });
    const fromDb = { ...row, created_at: "2026-10-25T18:00:00+00:00", source_system: "bank_csv", source_record: "a1b2c3" };
    expect(fromRow<CashEvent>(fromDb)).toEqual(e);
  });
});
