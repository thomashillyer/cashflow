// Did the books record a payment we expect? Given payments a document or email says were made (a PO's
// advances, "Less Advance USD 9639"), look for an unallocated payment in the books with the same
// direction, currency, exact amount, and the same supplier. A hit is a PROPOSAL with the books' date as
// evidence: the owner confirms, and nothing here marks an invoice paid or changes cash. Plain code.
//
// Names must match as whole names (same words, ignoring "Pvt Ltd" style suffixes). A name that only
// partly matches ("Acme" vs "Acme Logistics") never confirms: it comes back ambiguous for the owner.

import { nameTokens } from "../../ai/reconcile/parties";
import type { UnallocatedPayment } from "./common";

export type ExpectedPayment = {
  label: string;                   // "30% advance on PO-00010"
  partyName: string;
  currency: string;
  amount: number;                  // minor units
  direction: "in" | "out";         // out = we pay a supplier; required so an inbound payment never confirms an outbound one
};

export type PaymentCheck = {
  expected: ExpectedPayment;
  status: "found_in_books" | "ambiguous" | "not_found";
  matches: UnallocatedPayment[];   // the books' records that fit; the owner picks when ambiguous
  note: string;
};

const sameName = (a: string, b: string) => {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  return ta.size > 0 && ta.size === tb.size && [...ta].every((t) => tb.has(t));
};
const overlaps = (a: string, b: string) => {
  const tb = new Set(nameTokens(b));
  return nameTokens(a).some((t) => tb.has(t));
};

export function checkExpectedPayments(expected: ExpectedPayment[], books: UnallocatedPayment[]): PaymentCheck[] {
  const base = (e: ExpectedPayment) => books.filter((b) => b.currency === e.currency && b.amount === e.amount && b.direction === e.direction);
  const taken = new Set<string>();   // one books payment cannot confirm two expected payments
  const result = new Map<number, PaymentCheck>();

  // Pass 1, repeated: an expected payment with exactly one whole-name fit claims it; claiming can
  // make another expected payment unique, so the answer does not depend on input order.
  for (let changed = true; changed; ) {
    changed = false;
    expected.forEach((e, i) => {
      if (result.has(i)) return;
      const fits = base(e).filter((b) => !taken.has(b.id) && sameName(e.partyName, b.partyName ?? ""));
      if (fits.length === 1) {
        taken.add(fits[0]!.id);
        result.set(i, { expected: e, status: "found_in_books", matches: fits, note: `Books record this payment on ${fits[0]!.date} (not yet applied to a bill).` });
        changed = true;
      }
    });
  }

  return expected.map((e, i) => {
    const done = result.get(i);
    if (done) return done;
    const whole = base(e).filter((b) => !taken.has(b.id) && sameName(e.partyName, b.partyName ?? ""));
    if (whole.length > 1) return { expected: e, status: "ambiguous", matches: whole, note: `${whole.length} payments in the books fit; pick the one that belongs to this.` };
    const partial = base(e).filter((b) => !taken.has(b.id) && overlaps(e.partyName, b.partyName ?? ""));
    if (partial.length > 0) {
      return { expected: e, status: "ambiguous", matches: partial, note: "The amount matches, but the supplier name only partly matches. Confirm it is the same company before treating it as paid." };
    }
    return { expected: e, status: "not_found", matches: [], note: "No matching payment in the books. It may be recorded under another name or amount, or not recorded yet." };
  });
}
