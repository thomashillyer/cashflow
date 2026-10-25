import { describe, expect, it } from "vitest";
import type { CashEvent, Records } from "./records";
import type { ChangeProposal, CommitmentFieldChange, Field, ProposalOp } from "./intake";

// Type-level checks run under `tsc --noEmit` (part of `npm test`).
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

  it("pins intake invariants", () => {
    // @ts-expect-error a missing field has no value
    const bad: Field<number> = { state: "missing", value: 0 };
    // @ts-expect-error documents can't change settlement
    const settle: CommitmentFieldChange = { field: "settlement", to: "paid" };
    // @ts-expect-error found needs evidence
    const noEvidence: Field<string> = { state: "found", value: "INV-1187" };
    const link: ProposalOp = { op: "linkEvidence", commitmentId: "inv-INV-1187", evidenceIds: ["ev-pdf-1"] };
    const proposal: ChangeProposal = {
      id: "cp-1", action: "link", ops: [link], expectedStoreRevision: 3, evidenceIds: ["ev-pdf-1"],
      targetCommitmentId: "inv-INV-1187", reasons: ["same party, reference, currency"], conflicts: [],
      state: "proposed", createdAt: "2026-11-26T00:00:00Z",
    };
    expect([bad, settle, noEvidence].length).toBe(3);
    expect(proposal.ops[0]?.op).toBe("linkEvidence");
  });
});
