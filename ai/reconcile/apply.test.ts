import { describe, expect, it } from "vitest";
import type { ChangeProposal } from "../../schema/intake";
import type { Records } from "../../schema/records";
import { ApplyError, applyProposal } from "./apply";
import { poRemaining, propose } from "./match";
import { baseRecords, candidate, cashView, f, inv1187 } from "./testkit";

const ctx = { storeRevision: 1, now: "2026-11-26T12:00:00Z" };
const opts = { now: ctx.now };

function withPo(): Records {
  const r = baseRecords();
  const po = propose(candidate({
    id: "cand-po", kind: "purchase_order", direction: "in", partyId: "party-harbor-hearth", evidenceIds: ["ev-po"],
    fields: { reference: f("HH-PO-552"), amount: f(1000000), currency: f("USD") },
  }), r, ctx);
  return applyProposal(r, po, opts).records;
}

const inv1203 = (amount = 400000, ref = "INV-1203", ev = "ev-1203") => candidate({
  id: `cand-${ref}`, partyId: "party-harbor-hearth", evidenceIds: [ev],
  fields: { reference: f(ref), poReference: f("HH-PO-552"), amount: f(amount), currency: f("USD"), dueDate: f("2026-12-16") },
});

describe("applyProposal", () => {
  it("links all four sources of INV-1187 to one commitment without changing cash", () => {
    let r = baseRecords();
    const before = cashView(r);
    for (const ev of ["ev-email-inv1187", "ev-pdf-inv1187", "ev-whatsapp-inv1187"]) {
      r = applyProposal(r, propose(inv1187({}, ev), r, ctx), opts).records;
    }
    expect(r.commitments).toHaveLength(3);
    const inv = r.commitments.find((c) => c.id === "inv-INV-1187")!;
    expect(inv.evidenceIds).toEqual(["ev-zoho-INV-1187", "ev-email-inv1187", "ev-pdf-inv1187", "ev-whatsapp-inv1187"]);
    expect(cashView(r)).toEqual(before);
    expect(inv.settlement).toBe("open");
  });

  it("does not mutate its input and is idempotent for links", () => {
    const r = baseRecords();
    const snapshot = structuredClone(r);
    const p = propose(inv1187(), r, ctx);
    const once = applyProposal(r, p, opts).records;
    expect(r).toEqual(snapshot);
    const twice = applyProposal(once, p, opts);
    expect(twice.records).toEqual(once);
    expect(twice.affectedRecordIds).toEqual([]);
  });

  it("creates a new bill with a stable id and evidence source", () => {
    const r = baseRecords();
    const p = propose(candidate({
      id: "cand-ningbo", kind: "bill", partyId: "party-ningbo-pack", evidenceIds: ["ev-ningbo"],
      fields: { reference: f("0042"), amount: f(620000), currency: f("USD") },
    }), r, ctx);
    const out = applyProposal(r, p, opts).records;
    const bill = out.commitments.find((c) => c.id === "bill-party-ningbo-pack-0042")!;
    expect(bill).toMatchObject({ amount: 620000, outstanding: 620000, settlement: "open", sourceRef: { system: "intake", record: "ev-ningbo" } });
    expect(out.commitments.find((c) => c.id === "bill-SC-0042")?.evidenceIds).toEqual([]);
  });

  it("links a partial invoice to its PO without touching the PO's amount or outstanding (the engine computes coverage)", () => {
    const r = withPo();
    const poBefore = structuredClone(r.commitments.find((c) => c.id === "po-HH-PO-552")!);
    const out = applyProposal(r, propose(inv1203(), r, ctx), opts);
    const po = out.records.commitments.find((c) => c.id === "po-HH-PO-552")!;
    const inv = out.records.commitments.find((c) => c.id === "inv-INV-1203")!;
    expect(po.amount).toBe(1000000);
    expect(po.outstanding).toBe(poBefore.outstanding);
    expect(po.outstanding).toBe(1000000);
    expect(po.linkedCommitmentIds).toEqual(["inv-INV-1203"]);
    expect({ ...po, linkedCommitmentIds: undefined }).toEqual({ ...poBefore, linkedCommitmentIds: undefined });
    expect(inv).toMatchObject({ amount: 400000, outstanding: 400000 });
    expect(inv.linkedCommitmentIds).toEqual(["po-HH-PO-552"]);
    // The read helper still reports the uninvoiced remainder for Review display.
    expect(poRemaining(out.records, "po-HH-PO-552")).toBe(600000);
    expect(out.affectedRecordIds).toContain("po-HH-PO-552");
  });

  it("records each PO link once even when the proposal is applied twice", () => {
    const r = withPo();
    const p = propose(inv1203(), r, ctx);
    const once = applyProposal(r, p, opts).records;
    const twice = applyProposal(once, p, opts).records;
    expect(twice).toEqual(once);
    expect(twice.commitments.find((c) => c.id === "po-HH-PO-552")!.linkedCommitmentIds).toEqual(["inv-INV-1203"]);
  });

  it("refuses an invoice that would over-allocate the PO", () => {
    let r = withPo();
    r = applyProposal(r, propose(inv1203(), r, ctx), opts).records;
    const p = propose(inv1203(700000, "INV-1299", "ev-1299"), r, ctx);
    expect(p.action).toBe("conflict");
    expect(p.conflicts[0]?.field).toBe("poAllocation");
    expect(() => applyProposal(r, p, opts)).toThrowError(ApplyError);
  });

  it("refuses unresolved or already-decided proposals", () => {
    const r = baseRecords();
    const conflict = propose(inv1187({ currency: f("CAD") }), r, ctx);
    expect(() => applyProposal(r, conflict, opts)).toThrow(expect.objectContaining({ code: "NOTHING_TO_APPLY" }));
    const done: ChangeProposal = { ...propose(inv1187(), r, ctx), state: "confirmed" };
    expect(() => applyProposal(r, done, opts)).toThrow(expect.objectContaining({ code: "NOT_PROPOSED" }));
  });

  it("rejects a stale update with STALE_REVIEW", () => {
    const r = baseRecords();
    const p = propose(inv1187({ dueDate: f("2026-12-20") }), r, ctx);
    const moved = structuredClone(r);
    moved.commitments.find((c) => c.id === "inv-INV-1187")!.anchors.due = "2026-12-15";
    expect(() => applyProposal(moved, p, opts)).toThrow(expect.objectContaining({ code: "STALE_REVIEW" }));
    const ok = applyProposal(r, p, opts).records;
    expect(ok.commitments.find((c) => c.id === "inv-INV-1187")!.anchors.due).toBe("2026-12-20");
  });

  it("applies owner edits last", () => {
    const r = baseRecords();
    const p: ChangeProposal = { ...propose(inv1187({ currency: f("CAD") }), r, ctx), ownerEdits: [{ field: "anchors.due", to: "2026-12-31" }] };
    const out = applyProposal(r, p, opts).records;
    expect(out.commitments.find((c) => c.id === "inv-INV-1187")!).toMatchObject({ currency: "USD", anchors: { due: "2026-12-31" } });
  });

  it("records a confirmed payment as a settlement without editing settlement state", () => {
    const r = baseRecords();
    const p = propose(candidate({
      kind: "payment_evidence", partyId: "party-evergreen-home", evidenceIds: ["ev-remit"],
      fields: { paidAmount: f(1000000), paidDate: f("2026-12-01"), coversReferences: f(["INV-1187"]), currency: f("USD") },
    }), r, ctx);
    const out = applyProposal(r, p, opts);
    expect(out.records.settlements).toHaveLength(1);
    expect(out.records.commitments.find((c) => c.id === "inv-INV-1187")!.settlement).toBe("open");
    expect(applyProposal(out.records, p, opts).records.settlements).toHaveLength(1);
  });

  it("creates a second invoice from the same email instead of skipping it", () => {
    let r = baseRecords();
    const mk = (ref: string, amount: number) => candidate({
      id: `cand-${ref}`, partyId: "party-puget-market", evidenceIds: ["ev-email-two"],
      fields: { reference: f(ref), amount: f(amount), currency: f("USD") },
    });
    r = applyProposal(r, propose(mk("INV-3001", 100000), r, ctx), opts).records;
    const p2 = propose(mk("INV-3002", 250000), r, ctx);
    expect(p2.action).toBe("create");
    r = applyProposal(r, p2, opts).records;
    expect(r.commitments.filter((c) => c.evidenceIds?.includes("ev-email-two")).map((c) => c.id)).toEqual(["inv-INV-3001", "inv-INV-3002"]);
  });

  it("creates an unknown counterparty and its bill in one step", () => {
    const r = baseRecords();
    const p = propose(candidate({ kind: "bill", fields: { sellerName: f("New Freight LLC"), reference: f("NF-1"), amount: f(50000), currency: f("USD") } }), r, ctx);
    const out = applyProposal(r, p, opts).records;
    expect(out.parties.find((x) => x.id === "party-new-freight-llc")?.kind).toBe("supplier");
    expect(out.commitments.find((c) => c.reference === "NF-1")?.partyId).toBe("party-new-freight-llc");
  });
});
