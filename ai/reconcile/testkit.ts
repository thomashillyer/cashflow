// Test helpers: hand-built candidates over the cascade_trade intake fixtures.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CandidateFields, Field, IntakeCandidate } from "../../schema/intake";
import type { Records } from "../../schema/records";

export function baseRecords(): Records {
  const raw = JSON.parse(readFileSync(join(import.meta.dirname, "../../fixtures/cascade_trade/intake/base_records.json"), "utf8"));
  return { parties: raw.parties, commitments: raw.commitments, evidence: raw.evidence, events: [], signals: [], rules: [], settlements: [], balances: [] };
}

export const f = <T>(value: T, evidenceId = "ev-doc", text = String(value)): Field<T> =>
  ({ state: "found", value, evidence: [{ evidenceId, text }] });
export const none = <T>(): Field<T> => ({ state: "missing" });

export function candidate(over: Omit<Partial<IntakeCandidate>, "fields"> & { fields?: Partial<CandidateFields> }): IntakeCandidate {
  const { fields, ...rest } = over;
  return {
    id: "cand-1", revision: 1, extractionVersion: "test", evidenceIds: ["ev-doc"], kind: "invoice",
    confidence: 0.9, extraction: "ok", notes: [],
    ...rest,
    fields: {
      sellerName: none(), buyerName: none(), reference: none(), amount: none(), currency: none(),
      issueDate: none(), dueDate: none(), ...fields,
    },
  };
}

// INV-1187 as the PDF shows it.
export const inv1187 = (over: Partial<CandidateFields> = {}, evidenceId = "ev-pdf-inv1187") =>
  candidate({
    id: "cand-inv1187", evidenceIds: [evidenceId], kind: "invoice", partyId: "party-evergreen-home",
    fields: {
      sellerName: f("Cascade Trade Co.", evidenceId), buyerName: f("Evergreen Home LLC", evidenceId),
      reference: f("INV-1187", evidenceId), amount: f(2800000, evidenceId, "28,000.00"), currency: f("USD", evidenceId),
      issueDate: f("2026-11-10", evidenceId), dueDate: f("2026-12-10", evidenceId),
      paymentUrl: f("https://checkout.stripe.example/c/pay/cs_live_inv1187_cascade", evidenceId),
      ...over,
    },
  });

// Fields that drive cash: everything except evidence/link bookkeeping.
export const cashView = (r: Records) =>
  r.commitments.map(({ evidenceIds: _e, linkedCommitmentIds: _l, invoiceUrl: _i, paymentUrl: _p, ...c }) => c);
