import { describe, expect, it } from "vitest";
import type { ChangeProposal } from "../../schema/intake";
import type { Records } from "../../schema/records";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expand } from "../../engine/expand";
import { horizonEnd } from "../../engine/forecast";
import type { Profile } from "../../schema/profile";
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
    expect(bill).toMatchObject({ amount: 620000, settlement: "open", sourceRef: { system: "intake", record: "ev-ningbo" } });
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
    expect(po.outstanding).toBeUndefined(); // intake leaves it unset; the engine derives the remainder
    expect(po.linkedCommitmentIds).toEqual(["inv-INV-1203"]);
    expect({ ...po, linkedCommitmentIds: undefined }).toEqual({ ...poBefore, linkedCommitmentIds: undefined });
    expect(inv).toMatchObject({ amount: 400000 });
    expect(inv.outstanding).toBeUndefined();
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

  it("records a confirmed payment as a settlement and keeps a set outstanding consistent", () => {
    const r = baseRecords(); // INV-1187: amount 2,800,000, outstanding 2,800,000 as the importer stored it
    const p = propose(candidate({
      kind: "payment_evidence", partyId: "party-evergreen-home", evidenceIds: ["ev-remit"],
      fields: { paidAmount: f(1000000), paidDate: f("2026-12-01"), coversReferences: f(["INV-1187"]), currency: f("USD") },
    }), r, ctx);
    const out = applyProposal(r, p, opts);
    expect(out.records.settlements).toHaveLength(1);
    expect(out.records.commitments.find((c) => c.id === "inv-INV-1187")).toMatchObject({ outstanding: 1800000, settlement: "partial" });
    // a second apply must not decrement again
    expect(applyProposal(out.records, p, opts).records).toEqual(out.records);
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

// Issue #97: intake used to set outstanding = amount, and the engine treats a set outstanding as authoritative,
// so a settlement (plus its bank line) was counted twice.
describe("settlements and Commitment.outstanding (#97)", () => {
  const profile = JSON.parse(readFileSync(join(import.meta.dirname, "../../profiles/trading.json"), "utf8")) as Profile;
  const ASOF = "2026-11-16";
  const expected = (r: Records, id: string) =>
    expand(r, profile, ASOF, horizonEnd(profile, ASOF), {}).events
      .filter((e) => e.commitmentId === id && e.status !== "actual").reduce((a, e) => a + e.amount, 0);

  const invoice = (fields: Partial<Parameters<typeof candidate>[0]["fields"] & object> = {}) => candidate({
    id: "cand-9001", partyId: "party-evergreen-home", evidenceIds: ["ev-9001"],
    fields: { reference: f("INV-9001"), amount: f(5000), currency: f("USD"), dueDate: f("2026-12-10"), ...fields },
  });
  const payment = (amount = 2000, currency = "USD", ev = "ev-remit-9001") => candidate({
    id: `cand-pay-${ev}`, kind: "payment_evidence", partyId: "party-evergreen-home", evidenceIds: [ev],
    fields: { paidAmount: f(amount), paidDate: f("2026-11-14"), coversReferences: f(["INV-9001"]), currency: f(currency) },
  });
  // The invoice is created by intake; the bank balance is dated after the payment, so the payment is in opening cash.
  const withInvoice = (fields: Parameters<typeof invoice>[0] = {}): Records => {
    const r = baseRecords();
    r.balances = [{ id: "bal-1", account: "operating", amount: 10000, currency: "USD", asOf: ASOF, sourceRef: { system: "test", record: "bal-1" } }];
    return applyProposal(r, propose(invoice(fields), r, ctx), opts).records;
  };
  const inv = (r: Records) => r.commitments.find((c) => c.reference === "INV-9001")!;
  const pay = (r: Records, amount?: number, currency?: string, ev?: string) =>
    applyProposal(r, propose(payment(amount, currency, ev), r, ctx), opts);

  it("a created invoice leaves outstanding unset unless the document states a balance due", () => {
    expect(inv(withInvoice()).outstanding).toBeUndefined();
    expect(inv(withInvoice({ outstanding: f(3000) })).outstanding).toBe(3000);
  });

  it("$50 invoice + $20 settlement forecasts $30 expected, not $50", () => {
    const r = withInvoice();
    expect(expected(r, inv(r).id)).toBe(5000);
    const out = pay(r);
    expect(inv(out.records).outstanding).toBeUndefined(); // the engine derives it from the settlement
    expect(expected(out.records, inv(r).id)).toBe(3000);
    expect(out.records.settlements).toHaveLength(1);
  });

  it("a stated balance due is decremented by the settlement and the engine agrees", () => {
    const r = withInvoice({ outstanding: f(5000) });
    const out = pay(r);
    expect(inv(out.records)).toMatchObject({ outstanding: 3000, settlement: "partial" });
    expect(expected(out.records, inv(r).id)).toBe(3000);
  });

  it("paying the full balance marks it paid, and never goes below zero", () => {
    const r = withInvoice({ outstanding: f(5000) });
    expect(inv(pay(r, 5000).records)).toMatchObject({ outstanding: 0, settlement: "paid" });
    expect(inv(pay(r, 7000).records)).toMatchObject({ outstanding: 0, settlement: "paid" });
  });

  it("overpayment is floored at zero with a review warning", () => {
    const out = pay(withInvoice({ outstanding: f(5000) }), 7000);
    expect(out.warnings.join(" ")).toMatch(/exceeds the 5000 outstanding/);
  });

  it("does not decrement an outstanding the importer already lowered (would hide a double count or mark it paid)", () => {
    const r = withInvoice({ outstanding: f(3000) }); // 2000 of 5000 already paid per the source
    const out = pay(r, 3000);
    expect(inv(out.records)).toMatchObject({ outstanding: 3000, settlement: "open" });
    expect(out.warnings.join(" ")).toMatch(/already below the invoice total/);
  });

  it("a payment on/after the latest balance snapshot with no bank line leaves outstanding for the engine's boundary", () => {
    const r = withInvoice({ outstanding: f(5000) });
    const p = propose(payment(), r, ctx);
    const op = p.ops[0]!;
    if (op.op !== "createSettlement") throw new Error("expected createSettlement");
    const later: ChangeProposal = { ...p, ops: [{ ...op, settlement: { ...op.settlement, date: ASOF } }] };
    const out = applyProposal(r, later, opts);
    expect(inv(out.records)).toMatchObject({ outstanding: 5000, settlement: "open" });
    expect(out.warnings.join(" ")).toMatch(/not yet in the bank/);
  });

  it("an unset outstanding stays unset and so does settlement state", () => {
    const out = pay(withInvoice());
    expect(inv(out.records).outstanding).toBeUndefined();
    expect(inv(out.records).settlement).toBe("open");
  });

  it("a settlement in another currency leaves outstanding unchanged and warns", () => {
    const r = withInvoice({ outstanding: f(5000) });
    const p = propose(payment(), r, ctx);
    // The matcher only proposes same-currency settlements, so build the mixed-currency op directly.
    const op = p.ops[0]!;
    if (op.op !== "createSettlement") throw new Error("expected createSettlement");
    const mixed: ChangeProposal = { ...p, ops: [{ ...op, settlement: { ...op.settlement, currency: "CAD" } }] };
    const out = applyProposal(r, mixed, opts);
    expect(inv(out.records)).toMatchObject({ outstanding: 5000, settlement: "open" });
    expect(out.records.settlements).toHaveLength(1);
    expect(out.warnings.join(" ")).toMatch(/CAD.*USD.*unchanged/);
  });

  it("applying the same payment proposal twice does not decrement twice", () => {
    const r = withInvoice({ outstanding: f(5000) });
    const p = propose(payment(), r, ctx);
    const once = applyProposal(r, p, opts).records;
    const twice = applyProposal(once, p, opts);
    expect(inv(twice.records).outstanding).toBe(3000);
    expect(twice.records.settlements).toHaveLength(1);
    expect(twice.records).toEqual(once);
  });
});
