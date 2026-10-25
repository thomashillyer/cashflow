// Intake contracts: what document understanding produces for the Review screen
// and what the confirm step consumes. Source: docs/design/03-data-model.md
// (reconciliation rules), docs/design/06-signals.md, and docs/TECHNICAL_PLAN.md (sections 3-6).
//
// Raw extraction never creates cash. An IntakeCandidate becomes a
// ChangeProposal; only a confirmed ChangeProposal changes Records.

import type { Commitment, CommitmentType, Direction, Status } from "./records";

// Where a field value came from, so the UI can show the words behind it.
export type FieldEvidence = {
  evidenceId: string;
  page?: number;                         // 1-based, PDFs
  sheet?: string;                        // XLSX
  row?: number;                          // XLSX / CSV, 1-based
  excerpt?: { start: number; end: number };  // span in the page or message text
  text?: string;                         // the excerpt itself, short
};

// A field is found, missing, or in conflict. Missing is never coerced to 0 or "".
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

export type CandidateFields = {
  sellerName: Field<string>;
  buyerName: Field<string>;
  reference: Field<string>;          // invoice / bill / PO number
  poReference: Field<string>;        // PO an invoice fulfills
  amount: Field<number>;             // document total, minor units
  outstanding: Field<number>;        // balance due if the document states one
  currency: Field<string>;           // ISO 4217
  issueDate: Field<string>;
  dueDate: Field<string>;
  terms: Field<string>;              // "Net 30", "30% at order"
  invoiceUrl: Field<string>;
  paymentUrl: Field<string>;         // never evidence of payment
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
  confidence: number;                // 0..1, from extraction
  extraction: "ok" | "partial" | "unreadable" | "unsupported";
  notes: string[];                   // why fields are missing, what to upload
};

export type ProposalAction =
  | "create"     // new commitment from a document
  | "link"       // attach evidence to an existing commitment; no cash change
  | "update"     // change fields on an existing commitment (date, outstanding, ...)
  | "conflict"   // sources disagree; owner must resolve; no cash change
  | "review";    // not enough to decide (unknown party, unreadable, ambiguous match)

// An unresolved name/provider ID/contact set. Not a confirmed Party.
export type PartyCandidate = {
  partyId?: string;                  // existing party this might be
  name?: string;
  providerId?: string;
  emails?: string[];
  phones?: string[];
  reason: string;                    // "same email domain", "similar name"
};

export type FieldChange = {
  field: keyof Commitment | "expectedDate";
  from: unknown;
  to: unknown;
  evidence: FieldEvidence[];
};

export type ChangeProposal = {
  id: string;
  action: ProposalAction;
  candidateId?: string;
  candidateRevision?: number;        // stale if the candidate was re-extracted
  expectedStoreRevision: number;     // business revision the proposal was computed against
  signalId?: string;
  evidenceIds: string[];
  targetCommitmentId?: string;       // link / update / conflict
  matchCandidates?: string[];        // commitment ids when ambiguous
  draft?: {                          // create only
    type: CommitmentType;
    partyId?: string;
    amount: number;
    currency: string;
    anchors: Commitment["anchors"];
    status: Status;
    invoiceUrl?: string;
    paymentUrl?: string;
  };
  changes: FieldChange[];
  reasons: string[];                 // why this match: "same party, reference, currency"
  conflicts: string[];               // human-readable disagreements
  state: "proposed" | "confirmed" | "dismissed";
  createdAt: string;
  decidedAt?: string;
};

// Returned by the confirmation service (persons 3/5) after one atomic store transaction.
export type ConfirmationResult = {
  operationId: string;               // idempotency key of the applied (or replayed) mutation
  replayed: boolean;
  storeRevision: number;             // new business revision
  affectedRecordIds: string[];
  warnings: string[];                // unresolved facts that remain after applying
};
