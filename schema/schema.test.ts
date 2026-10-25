import { describe, expect, it } from "vitest";
import type { CashEvent, Records } from "./records";
import type { IntakeCandidate, Field } from "./intake";

// Compile-time checks that the contracts fit the examples in docs/design/03-data-model.md.
describe("schema", () => {
  it("accepts the documented example cash event", () => {
    const evt: CashEvent = {
      id: "evt-inv-INV-1187-0",
      commitmentId: "inv-INV-1187",
      legIndex: 0,
      date: "2026-12-24",
      amount: 5200000, currency: "USD", amountBase: 5200000,
      direction: "in",
      status: "committed",
      confidence: 0.72,
      basis: "due 2026-12-02 + 22 days (median of last 8 payments)",
      sourceRef: { system: "zoho_books", record: "INV-1187" },
    };
    const records: Records = {
      parties: [], commitments: [], events: [evt], signals: [], rules: [],
      settlements: [], balances: [], evidence: [],
    };
    expect(records.events).toHaveLength(1);
  });

  it("represents a missing amount without a zero", () => {
    const missing: Field<number> = { state: "missing", reason: "blank Total column" };
    const candidate: Pick<IntakeCandidate, "kind" | "extraction"> & { amount: Field<number> } = {
      kind: "invoice", extraction: "partial", amount: missing,
    };
    expect(candidate.amount).not.toHaveProperty("value");
  });
});
