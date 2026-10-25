// Did the books record a payment we expect? Given payments a document or email says were made (a PO's
// advances, "Less Advance USD 9639"), look for an unallocated payment in the books with the same
// supplier, currency and exact amount. A hit is a PROPOSAL with the books' date as evidence: the owner
// confirms, and nothing here marks an invoice paid or changes cash. Plain code, no model.

import { nameSimilarity } from "../../ai/reconcile/parties";
import type { UnallocatedPayment } from "./common";

export type ExpectedPayment = {
  label: string;                   // "30% advance on PO-00010"
  partyName: string;
  currency: string;
  amount: number;                  // minor units
  direction?: "in" | "out";
};

export type PaymentCheck = {
  expected: ExpectedPayment;
  status: "found_in_books" | "ambiguous" | "not_found";
  matches: UnallocatedPayment[];   // the books' records that fit; the owner picks when ambiguous
  note: string;
};

export const NAME_MATCH = 0.6;

export function checkExpectedPayments(expected: ExpectedPayment[], books: UnallocatedPayment[]): PaymentCheck[] {
  const taken = new Set<string>();   // one books payment cannot confirm two expected payments
  return expected.map((e) => {
    const fits = books.filter((b) =>
      !taken.has(b.id) && b.currency === e.currency && b.amount === e.amount &&
      (e.direction === undefined || b.direction === e.direction) &&
      nameSimilarity(e.partyName, b.partyName ?? "") >= NAME_MATCH);
    if (fits.length === 1) {
      taken.add(fits[0]!.id);
      return { expected: e, status: "found_in_books", matches: fits, note: `Books record this payment on ${fits[0]!.date} (not yet applied to a bill).` };
    }
    if (fits.length > 1) {
      return { expected: e, status: "ambiguous", matches: fits, note: `${fits.length} payments in the books fit; pick the one that belongs to this.` };
    }
    return { expected: e, status: "not_found", matches: [], note: "No matching payment in the books. It may be recorded under another name or amount, or not recorded yet." };
  });
}
