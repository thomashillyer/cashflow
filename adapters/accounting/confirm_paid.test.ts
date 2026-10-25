import { describe, expect, it } from "vitest";
import type { UnallocatedPayment } from "./common";
import { checkExpectedPayments, type ExpectedPayment } from "./confirm_paid";

const pay = (id: string, date: string, amount: number, partyName = "Carry Well Packaging Pvt Ltd", over: Partial<UnallocatedPayment> = {}): UnallocatedPayment => ({
  id, system: "zoho_books", providerId: id, direction: "out", date, amount, currency: "USD", partyName, ...over,
});
const exp = (amount: number, label = "advance"): ExpectedPayment => ({ label, partyName: "Carry Well Packaging", currency: "USD", amount, direction: "out" });

describe("checkExpectedPayments", () => {
  it("confirms an expected advance from the books with its date, matching name loosely and amount exactly", () => {
    const r = checkExpectedPayments([exp(963900, "30% advance"), exp(2249100, "balance advance")], [pay("a", "2026-06-03", 963900), pay("b", "2026-07-01", 2249100)]);
    expect(r.map((x) => [x.status, x.matches[0]!.date])).toEqual([["found_in_books", "2026-06-03"], ["found_in_books", "2026-07-01"]]);
    expect(r[0]!.note).toMatch(/2026-06-03/);
  });

  it("an amount off by a cent, another supplier, another currency, or the wrong direction is not a match", () => {
    const books = [
      pay("a", "2026-06-03", 963901), pay("b", "2026-06-03", 963900, "Evergreen Home"),
      pay("c", "2026-06-03", 963900, "Carry Well Packaging", { currency: "INR" }), pay("d", "2026-06-03", 963900, "Carry Well Packaging", { direction: "in" }),
    ];
    const [r] = checkExpectedPayments([exp(963900)], books);
    expect(r!.status).toBe("not_found");
    expect(r!.note).toMatch(/No matching payment/);
  });

  it("two equal payments are ambiguous; one books payment never confirms two expected payments", () => {
    const both = checkExpectedPayments([exp(5000)], [pay("a", "2026-06-03", 5000), pay("b", "2026-06-10", 5000)]);
    expect(both[0]).toMatchObject({ status: "ambiguous" });
    expect(both[0]!.matches).toHaveLength(2);
    const twice = checkExpectedPayments([exp(5000, "first"), exp(5000, "second")], [pay("a", "2026-06-03", 5000)]);
    expect(twice.map((x) => x.status)).toEqual(["found_in_books", "not_found"]);
  });

  it("a partly matching name never confirms: same amount from 'Carry Well Logistics' is ambiguous, for the owner", () => {
    const [r] = checkExpectedPayments([exp(963900)], [pay("a", "2026-06-03", 963900, "Carry Well Logistics")]);
    expect(r!.status).toBe("ambiguous");
    expect(r!.note).toMatch(/only partly matches/);
    const [other] = checkExpectedPayments([exp(963900)], [pay("a", "2026-06-03", 963900, "Evergreen Home")]);
    expect(other!.status).toBe("not_found");
  });

  it("an inbound payment never confirms an expected outbound one", () => {
    const [r] = checkExpectedPayments([exp(963900)], [pay("a", "2026-06-03", 963900, "Carry Well Packaging", { direction: "in" })]);
    expect(r!.status).toBe("not_found");
  });

  it("the answer does not depend on input order", () => {
    const books = [pay("b1", "2026-06-03", 5000), pay("b2", "2026-06-10", 5000)];
    const withUnique = [exp(5000, "B"), { ...exp(5000, "A"), partyName: "Carry Well Packaging Pvt Ltd" }];
    const forward = checkExpectedPayments(withUnique, books).map((x) => x.status);
    const backward = checkExpectedPayments([...withUnique].reverse(), books).map((x) => x.status).reverse();
    expect(forward).toEqual(backward);
  });
});
