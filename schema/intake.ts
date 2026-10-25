// Intake contracts: what document understanding produces for the Review screen
// and what the confirm step consumes. Source: docs/design/03-data-model.md
// (reconciliation rules), docs/design/06-signals.md, and docs/TECHNICAL_PLAN.md (sections 3-6).
//
// Raw extraction never creates cash. An IntakeCandidate becomes a ChangeProposal;
// only a confirmed ChangeProposal changes Records. Message claims (promises, delays)
// become Signals, which are confirmed through Signal.state instead.

import type {
  CommitmentDraft, Direction, ExtractionState, Party, Settlement, SourceRef,
} from "./records";

// Where a field value came from, so the UI can show the words behind it.
// The model supplies the quote; code finds the offsets.
export type FieldEvidence = {
  evidenceId: string;
  text: string;                          // the quoted words
  page?: number;                         // 1-based, PDFs
  sheet?: string;                        // XLSX
  row?: number;                          // XLSX / CSV, 1-based
  excerpt?: { start: number; end: number };  // span in the page or message text, when located
};

// A field is found, missing, or in conflict. Missing is never coerced to 0 or "".
// Validators enforce: found has >= 1 evidence; conflict has >= 2 values.
export type Field<T> =
  | { state: "found"; value: T; evidence: FieldEvidence[] }
  | { state: "missing"; reason?: string }
  | { state: "conflict"; values: { value: T; evidence: FieldEvidence[] }[] };

// What a document is, relative to this business.
export type DocumentKind =
  | "invoice"                // we bill a customer: money in
  | "bill"                   // a supplier bills us: money out
  | "purchase_order"         // a commitment, not cash; direction says who buys
  | "payment_evidence"       // remittance, receipt, bank confirmation
  | "conversational_update"  // promise, delay, question; becomes a Signal
  | "none";                  // nothing cash-relevant

// Code-normalized fields: amounts are parsed into minor units and dates into
// YYYY-MM-DD by code, never by the model.
export type CandidateFields = {
  sellerName: Field<string>;
  buyerName: Field<string>;
  reference: Field<string>;          // invoice / bill / PO number
  amount: Field<number>;             // document total, minor units
  currency: Field<string>;           // ISO 4217
  issueDate: Field<string>;
  dueDate: Field<string>;
  poReference?: Field<string>;       // PO an invoice fulfills
  outstanding?: Field<number>;       // balance due if the document states one
  terms?: Field<string>;             // "Net 30", "30% at order"
  invoiceUrl?: Field<string>;
  paymentUrl?: Field<string>;        // never evidence of payment
  statedStatus?: Field<string>;      // "PAID" stamp etc.; shown, never mapped to settlement by itself
  paidAmount?: Field<number>;        // payment_evidence
  paidDate?: Field<string>;          // payment_evidence
  coversReferences?: Field<string[]>;  // payment_evidence: which invoices it pays
};

// An unresolved name/provider ID/contact set. Not a confirmed Party.
export type PartyCandidate = {
  partyId?: string;                  // existing party this might be
  name?: string;
  providerId?: string;
  emails?: string[];
  phones?: string[];
  reason: string;                    // "same email domain", "similar name"
};

export type IntakeCandidate = {
  id: string;
  revision: number;                  // bumps when re-extracted; proposals pin the revision they were built from
  extractionVersion: string;         // prompt/parser version, for cache keys and audits
  evidenceIds: string[];             // the bundle this came from (message + attachments + links)
  kind: DocumentKind;
  direction?: Direction;             // in = receivable, out = payable
  fields: CandidateFields;
  partyId?: string;                  // set by entity resolution when certain
  partyCandidates?: PartyCandidate[];  // unresolved identity, for review
  confidence: number;                // 0..1, a review hint; never authorizes a write
  extraction: ExtractionState;
  notes: string[];                   // why fields are missing, what to upload
};

// Fields a document may change on an existing commitment. Settlement, ids, type,
// and sourceRef are deliberately absent: documents never mark anything paid.
export type CommitmentFieldChange =
  | { field: "amount"; from?: number; to: number }
  | { field: "outstanding"; from?: number; to: number }
  | { field: "currency"; from?: string; to: string }
  | { field: "reference"; from?: string; to: string }
  | { field: "anchors.invoice" | "anchors.due" | "anchors.order" | "anchors.ship" | "anchors.delivery"; from?: string; to: string }
  | { field: "invoiceUrl" | "paymentUrl"; from?: string; to: string }
  | { field: "partyId"; from?: string; to: string };

// One step of a proposal. All ops in a proposal are confirmed or dismissed together.
export type ProposalOp =
  | { op: "createParty"; party: Omit<Party, "id">; tempId: string }
  | { op: "createCommitment"; draft: CommitmentDraft; tempId: string }   // partyId may reference a createParty tempId
  | { op: "linkEvidence"; commitmentId: string; evidenceIds: string[] }  // no cash change
  | { op: "linkCommitments"; fromId: string; toId: string; allocated?: number }  // invoice -> PO, allocated minor units
  | { op: "updateCommitment"; commitmentId: string; change: CommitmentFieldChange; evidence: FieldEvidence[] }
  | { op: "createSettlement"; settlement: Omit<Settlement, "id"> };  // only from identified payment evidence

export type ProposalAction =
  | "create"     // new commitment from a document
  | "link"       // attach evidence to an existing commitment; no cash change
  | "update"     // change fields on an existing commitment
  | "conflict"   // sources disagree; owner must resolve; no cash change until resolved
  | "review";    // not enough to decide (unknown party, unreadable, ambiguous match)

export type ChangeProposal = {
  id: string;
  action: ProposalAction;            // summary for the Review list; ops are what gets applied
  ops: ProposalOp[];                 // empty for conflict/review until the owner resolves
  candidateId?: string;
  candidateRevision?: number;        // stale if the candidate was re-extracted
  expectedStoreRevision: number;     // business revision the proposal was computed against
  evidenceIds: string[];
  targetCommitmentId?: string;       // the main existing commitment, for display
  matchCandidates?: { commitmentId: string; reasons: string[] }[];  // when ambiguous
  reasons: string[];                 // why this match: "same party, reference, currency"
  conflicts: { field: string; values: { value: unknown; evidence: FieldEvidence[] }[] }[];
  ownerEdits?: CommitmentFieldChange[];  // values the owner typed or picked; kept apart from extracted ones
  state: "proposed" | "confirmed" | "dismissed";
  createdAt: string;
  decidedAt?: string;
  sourceRef?: SourceRef;             // used for created commitments; defaults to the first evidence
};

// Returned by the confirmation service (persons 3/5) after one atomic store transaction.
export type ConfirmationResult = {
  operationId: string;               // idempotency key of the applied (or replayed) mutation
  replayed: boolean;
  storeRevision: number;             // new business revision
  affectedRecordIds: string[];
  warnings: string[];                // unresolved facts that remain after applying
};
