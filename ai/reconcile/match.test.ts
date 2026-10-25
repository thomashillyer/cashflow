import { describe, expect, it } from "vitest";
import { normalizeRef, poAllocated, poRemaining, propose, TEMP_COMMITMENT } from "./match";
import { baseRecords, candidate, f, inv1187 } from "./testkit";

const ctx = { storeRevision: 7, now: "2026-11-26T12:00:00Z" };

describe("propose", () => {
  it("links a duplicate PDF of an existing invoice without new cash", () => {
    const p = propose(inv1187(), baseRecords(), ctx);
    expect(p.action).toBe("link");
    expect(p.targetCommitmentId).toBe("inv-INV-1187");
    expect(p.ops.map((o) => o.op)).toContain("linkEvidence");
    expect(p.ops.some((o) => o.op === "createCommitment" || o.op === "createSettlement")).toBe(false);
    expect(p.expectedStoreRevision).toBe(7);
    expect(p.id).toBe("cp-cand-inv1187-r1");
  });

  it("is a no-op link when the evidence is already linked", () => {
    const p = propose(inv1187({}, "ev-zoho-INV-1187"), baseRecords(), ctx);
    expect(p.action).toBe("link");
    expect(p.ops).toEqual([]);
  });

  it("flags a different currency as a conflict", () => {
    const p = propose(inv1187({ currency: f("CAD", "ev-pdf-cad") }), baseRecords(), ctx);
    expect(p.action).toBe("conflict");
    expect(p.conflicts.map((c) => c.field)).toEqual(["currency"]);
    expect(p.ops).toEqual([]);
  });

  it("flags a revised total as a conflict, keeping both values", () => {
    const p = propose(inv1187({ amount: f(2950000, "ev-pdf-rev", "29,500.00") }), baseRecords(), ctx);
    expect(p.action).toBe("conflict");
    expect(p.conflicts[0]?.field).toBe("amount");
    expect(p.conflicts[0]?.values.map((v) => v.value)).toEqual([2800000, 2950000]);
  });

  it("proposes a due-date update, not a conflict", () => {
    const p = propose(inv1187({ dueDate: f("2026-12-20") }), baseRecords(), ctx);
    expect(p.action).toBe("update");
    expect(p.ops).toContainEqual(expect.objectContaining({ op: "updateCommitment", change: { field: "anchors.due", from: "2026-12-10", to: "2026-12-20" } }));
  });

  it("never links the same number from another vendor", () => {
    const ningbo = candidate({
      id: "cand-ningbo", kind: "bill", partyId: "party-ningbo-pack", evidenceIds: ["ev-ningbo"],
      fields: { reference: f("0042"), amount: f(620000), currency: f("USD"), dueDate: f("2026-12-18"), sellerName: f("Ningbo Pack Co., Ltd.") },
    });
    const p = propose(ningbo, baseRecords(), ctx);
    expect(p.action).toBe("create");
    expect(p.targetCommitmentId).toBeUndefined();
    const create = p.ops[0];
    expect(create?.op === "createCommitment" && create.draft.partyId).toBe("party-ningbo-pack");
    expect(create?.op === "createCommitment" && create.draft.direction).toBe("out");
  });

  it("creates an accepted PO as likely, not committed", () => {
    const po = candidate({
      id: "cand-po", kind: "purchase_order", direction: "in", partyId: "party-harbor-hearth", evidenceIds: ["ev-po"],
      fields: { reference: f("HH-PO-552"), amount: f(1000000), currency: f("USD"), issueDate: f("2026-11-02") },
    });
    const p = propose(po, baseRecords(), ctx);
    expect(p.action).toBe("create");
    const op = p.ops[0];
    expect(op?.op === "createCommitment" && op.draft.status).toBe("likely");
    expect(op?.op === "createCommitment" && op.draft.amount).toBe(1000000);
  });

  it("sends unreadable, empty, and message-only sources to review without ops", () => {
    for (const c of [
      candidate({ extraction: "unreadable" }),
      candidate({ kind: "none" }),
      candidate({ kind: "conversational_update", partyId: "party-evergreen-home" }),
    ]) {
      const p = propose(c, baseRecords(), ctx);
      expect(p.action).toBe("review");
      expect(p.ops).toEqual([]);
    }
  });

  it("never creates a commitment without an amount", () => {
    const c = candidate({ partyId: "party-puget-market", fields: { reference: f("INV-2000"), currency: f("USD") } });
    const p = propose(c, baseRecords(), ctx);
    expect(p.action).toBe("review");
    expect(p.ops).toEqual([]);
  });

  it("suggests, but does not link, a same-amount commitment without a reference match", () => {
    const c = candidate({ partyId: "party-evergreen-home", fields: { reference: f("EVG-PO-9"), amount: f(2800000), currency: f("USD") } });
    const p = propose(c, baseRecords(), ctx);
    expect(p.action).toBe("review");
    expect(p.matchCandidates?.[0]?.commitmentId).toBe("inv-INV-1187");
    expect(p.ops).toEqual([]);
  });

  it("needs a confirmed party; similar names are only candidates", () => {
    const c = inv1187();
    delete c.partyId;
    c.partyCandidates = [{ partyId: "party-evergreen-home", reason: "similar name" }];
    const p = propose(c, baseRecords(), ctx);
    expect(p.action).toBe("review");
    expect(p.ops).toEqual([]);
  });

  it("suggests creating an unknown counterparty together with its bill", () => {
    const c = candidate({ kind: "bill", fields: { sellerName: f("New Freight LLC"), reference: f("NF-1"), amount: f(50000), currency: f("USD") } });
    const p = propose(c, baseRecords(), ctx);
    expect(p.action).toBe("review");
    expect(p.ops.map((o) => o.op)).toEqual(["createParty", "createCommitment"]);
  });

  it("ignores a PAID stamp and payment links when deciding settlement", () => {
    const p = propose(inv1187({ statedStatus: f("PAID") }), baseRecords(), ctx);
    expect(p.ops.some((o) => o.op === "createSettlement")).toBe(false);
  });

  it("proposes a settlement only from payment evidence naming one commitment", () => {
    const pay = candidate({
      kind: "payment_evidence", partyId: "party-evergreen-home", evidenceIds: ["ev-remit"],
      fields: { paidAmount: f(1000000), paidDate: f("2026-12-01"), coversReferences: f(["INV-1187"]), currency: f("USD") },
    });
    const p = propose(pay, baseRecords(), ctx);
    expect(p.action).toBe("update");
    expect(p.ops[0]).toMatchObject({ op: "createSettlement", settlement: { commitmentId: "inv-INV-1187", amount: 1000000 } });
  });

  it("normalizes references", () => {
    expect(normalizeRef(" inv 1187 ")).toBe(normalizeRef("INV-1187"));
  });

  it("links a partial invoice to its PO", () => {
    const records = baseRecords();
    records.commitments.push({
      id: "po-HH-PO-552", type: "purchase_order", direction: "in", reference: "HH-PO-552", partyId: "party-harbor-hearth",
      amount: 1000000, currency: "USD", anchors: { order: "2026-11-02" }, status: "likely", sourceRef: { system: "upload", record: "ev-po" },
    });
    const inv = candidate({
      id: "cand-1203", partyId: "party-harbor-hearth", evidenceIds: ["ev-1203"],
      fields: { reference: f("INV-1203"), poReference: f("HH-PO-552"), amount: f(400000), currency: f("USD"), dueDate: f("2026-12-16") },
    });
    const p = propose(inv, records, ctx);
    expect(p.action).toBe("create");
    expect(p.ops).toContainEqual({ op: "linkCommitments", fromId: TEMP_COMMITMENT, toId: "po-HH-PO-552", allocated: 400000 });
  });
});

describe("poAllocated / poRemaining (read helpers; the engine owns coverage in the forecast)", () => {
  const withLinks = () => {
    const records = baseRecords();
    records.commitments.push({
      id: "po-HH-PO-552", type: "purchase_order", direction: "in", reference: "HH-PO-552", partyId: "party-harbor-hearth",
      amount: 1000000, currency: "USD", anchors: { order: "2026-11-02" }, status: "likely", sourceRef: { system: "upload", record: "ev-po" },
      linkedCommitmentIds: ["inv-INV-1203", "missing-id"],
    });
    records.commitments.push({
      id: "inv-INV-1203", type: "invoice", direction: "in", reference: "INV-1203", partyId: "party-harbor-hearth",
      amount: 400000, outstanding: 400000, currency: "USD", anchors: { due: "2026-12-16" }, status: "committed",
      sourceRef: { system: "upload", record: "ev-1203" }, linkedCommitmentIds: ["po-HH-PO-552"],
    });
    return records;
  };

  it("computes allocation from linked invoices, never from the PO's outstanding", () => {
    const r = withLinks();
    const po = r.commitments.find((c) => c.id === "po-HH-PO-552")!;
    expect(poAllocated(r, po)).toBe(400000);
    expect(poRemaining(r, po.id)).toBe(600000);
    po.outstanding = 123; // a stale outstanding must not change the helpers
    expect(poRemaining(r, po.id)).toBe(600000);
  });

  it("is undefined for a non-PO and the full amount when nothing is linked", () => {
    const r = withLinks();
    expect(poRemaining(r, "inv-INV-1203")).toBeUndefined();
    r.commitments.find((c) => c.id === "po-HH-PO-552")!.linkedCommitmentIds = [];
    expect(poRemaining(r, "po-HH-PO-552")).toBe(1000000);
  });
});
