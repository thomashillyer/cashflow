import { describe, expect, it } from "vitest";
import { buildAccounting, toMinor, type AccountingDoc } from "./common";

const NOW = "2026-10-25T18:00:00Z";
const doc = (over: Partial<AccountingDoc>): AccountingDoc => ({
  kind: "bill", providerId: "b1", number: "1001", partyId: "v1", partyName: "Ningbo Supply", currency: "USD",
  total: 100, balance: 100, due: "2026-11-01", status: "open", raw: {}, sheet: "bills", row: 1, ...over,
});

describe("toMinor", () => {
  it("accepts only real numbers; blanks, arrays, hex and exponents are missing, not zero", () => {
    for (const bad of [" ", [], [5], "0x10", "1e3", "12abc", "", null, undefined, true, {}, NaN, Infinity]) expect(toMinor(bad, "USD"), String(bad)).toBeUndefined();
    expect(toMinor(" 12.50 ", "USD")).toBe(1250);
    expect(toMinor(0, "USD")).toBe(0);
    expect(toMinor("-3", "USD")).toBe(-300);
  });
});

describe("buildAccounting", () => {
  it("keeps two suppliers' bills with the same number as separate records and warns", () => {
    const r = buildAccounting({
      system: "xero", now: NOW,
      docs: [doc({ providerId: "b1", partyId: "v1", partyName: "A", row: 1 }), doc({ providerId: "b2", partyId: "v2", partyName: "B", total: 250, row: 2 })],
      payments: [{ providerId: "p1", date: "2026-10-20", applied: [{ kind: "bill", docProviderId: "b2", amount: 250 }, { kind: "bill", docNumber: "1001", amount: 5 }] }],
    });
    expect(new Set(r.commitments.map((c) => c.id)).size).toBe(2);
    expect(r.commitments.every((c) => /^bill-1001~[0-9a-f]{12}$/.test(c.id))).toBe(true);
    // Payment by provider id lands on the right bill; payment by the ambiguous number matches neither.
    expect(r.settlements).toHaveLength(1);
    expect(r.settlements[0]).toMatchObject({ amount: 25000, commitmentId: r.commitments[1]!.id });
    expect(r.diagnostics.warnings.join(" ")).toMatch(/used more than once/);
    // Same ids on a re-import, in any order.
    const again = buildAccounting({ system: "xero", now: NOW, docs: [doc({ providerId: "b2", partyId: "v2", partyName: "B", total: 250, row: 1 }), doc({ providerId: "b1", partyId: "v1", partyName: "A", row: 2 })], payments: [] });
    expect(new Set(again.commitments.map((c) => c.id))).toEqual(new Set(r.commitments.map((c) => c.id)));
  });

  it("a blank total is a visible error, not a zero commitment", () => {
    const r = buildAccounting({ system: "xero", now: NOW, docs: [doc({ total: " " })], payments: [] });
    expect(r.commitments).toEqual([]);
    expect(r.diagnostics.errors.map((e) => e.code)).toEqual(["missing_amount"]);
  });

  it("an unchanged record keeps its hash even when display-only fields change; a due date edit does not", () => {
    const a = buildAccounting({ system: "zoho_books", now: NOW, docs: [doc({ raw: { due_days: "Overdue by 3 days" } })], payments: [] });
    const b = buildAccounting({ system: "zoho_books", now: NOW, docs: [doc({ raw: { due_days: "Overdue by 4 days" } })], payments: [] });
    const c = buildAccounting({ system: "zoho_books", now: NOW, docs: [doc({ due: "2026-12-01" })], payments: [] });
    expect(a.evidence[0]!.fileHash).toBe(b.evidence[0]!.fileHash);
    expect(a.evidence[0]!.fileHash).not.toBe(c.evidence[0]!.fileHash);
  });

  it("namespaces evidence by document kind so an invoice and a bill with one provider id never collide", () => {
    const r = buildAccounting({ system: "quickbooks", now: NOW, docs: [doc({ kind: "invoice", providerId: "7", number: "A" }), doc({ kind: "bill", providerId: "7", number: "B" })], payments: [] });
    expect(r.evidence.map((e) => e.sourceRef.record)).toEqual(["invoice:7", "bill:7"]);
    expect(new Set(r.evidence.map((e) => e.id)).size).toBe(2);
  });

  it("emits one payment-history row per invoice, dated by the final payment", () => {
    const inv = doc({ kind: "invoice", providerId: "i1", number: "INV-1", partyId: "c1", total: 100, balance: 0, status: "paid", due: "2026-09-30" });
    const r = buildAccounting({
      system: "xero", now: NOW, docs: [inv],
      payments: [
        { providerId: "p1", date: "2026-09-01", applied: [{ kind: "invoice", docProviderId: "i1", amount: 40 }] },
        { providerId: "p2", date: "2026-10-05", applied: [{ kind: "invoice", docProviderId: "i1", amount: 60 }] },
      ],
    });
    expect(r.settlements).toHaveLength(2);
    expect(r.paymentHistory).toEqual([expect.objectContaining({ invoiceId: "inv-INV-1", paid: "2026-10-05" })]);
  });

  it("keeps a payment that applied to no document as an unallocated payment, never matched by guess", () => {
    const r = buildAccounting({
      system: "zoho_books", now: NOW, docs: [],
      payments: [
        { providerId: "adv1", date: "2026-06-03", kind: "bill", amount: 9639, appliedKnown: true, currency: "USD", partyId: "v9", partyName: "Carry Well Packaging", applied: [] },
        { providerId: "adv2", date: "2026-07-01", kind: "bill", amount: "22491.00", appliedKnown: true, currency: "USD", partyId: "v9", partyName: "Carry Well Packaging", applied: [] },
      ],
    });
    expect(r.settlements).toEqual([]);
    expect(r.unallocatedPayments).toEqual([
      expect.objectContaining({ providerId: "adv1", direction: "out", date: "2026-06-03", amount: 963900, currency: "USD", partyName: "Carry Well Packaging" }),
      expect.objectContaining({ providerId: "adv2", amount: 2249100 }),
    ]);
  });

  it("a partly applied payment leaves only the remainder unallocated; a fully applied one leaves none", () => {
    const docs = [doc({ providerId: "b1", number: "B-1", total: 100, balance: 0, status: "paid" })];
    const r = buildAccounting({
      system: "xero", now: NOW, docs,
      payments: [
        { providerId: "p1", date: "2026-10-01", kind: "bill", amount: 100, appliedKnown: true, currency: "USD", applied: [{ kind: "bill", docProviderId: "b1", amount: 60 }] },
        { providerId: "p2", date: "2026-10-02", kind: "bill", amount: 100, appliedKnown: true, currency: "USD", applied: [{ kind: "bill", docProviderId: "b1", amount: 100 }] },
      ],
    });
    expect(r.unallocatedPayments.map((u) => [u.providerId, u.amount])).toEqual([["p1", 4000]]);
  });

  it("never reports a payment as unallocated from a failed read, an unparseable line, or mixed currencies", () => {
    const docs = [doc({ providerId: "b1", number: "B-1", total: 100, balance: 0, status: "paid", currency: "USD" })];
    const r = buildAccounting({
      system: "zoho_books", now: NOW, docs,
      payments: [
        { providerId: "unread", date: "2026-10-01", kind: "bill", amount: 300, appliedKnown: false, currency: "USD", applied: [] },
        { providerId: "garbled", date: "2026-10-01", kind: "bill", amount: 300, appliedKnown: true, currency: "USD", applied: [{ kind: "bill", docProviderId: "b1", amount: "n/a" }] },
        { providerId: "fx", date: "2026-10-01", kind: "bill", amount: 300, appliedKnown: true, currency: "EUR", applied: [{ kind: "bill", docProviderId: "b1", amount: 100 }] },
      ],
    });
    expect(r.unallocatedPayments).toEqual([]);
  });

  it("uses the provider's own unapplied amount when it states one", () => {
    const r = buildAccounting({
      system: "quickbooks", now: NOW, docs: [],
      payments: [{ providerId: "q1", date: "2026-10-01", kind: "invoice", amount: 500, unapplied: 120.5, currency: "USD", applied: [] }, { providerId: "q2", date: "2026-10-01", kind: "invoice", amount: 500, unapplied: 0, currency: "USD", applied: [] }],
    });
    expect(r.unallocatedPayments.map((u) => [u.providerId, u.amount, u.direction])).toEqual([["q1", 12050, "in"]]);
  });
});
