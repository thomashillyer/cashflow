// Intake contracts: what document understanding produces for the Review screen
// and what the confirm step consumes. Source: docs/design/03-data-model.md
// (reconciliation rules) and docs/design/06-signals.md.
//
// Raw extraction never creates cash. A DocumentCandidate becomes a
// ProposedUpdate; only a confirmed ProposedUpdate changes Records.

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

export type DocumentCandidate = {
  id: string;
  evidenceIds: string[];             // the bundle this came from (message + attachments + links)
  kind: DocumentKind;
  direction?: Direction;             // in = receivable, out = payable
  fields: CandidateFields;
  partyId?: string;                  // set by entity resolution when certain
  partyCandidates?: { partyId: string; reason: string }[];  // similar names, for review
  confidence: number;                // 0..1, from extraction
  extraction: "ok" | "partial" | "unreadable" | "unsupported";
  notes: string[];                   // why fields are missing, what to upload
};

export type ProposedAction =
  | "create"     // new commitment from a document
  | "link"       // attach evidence to an existing commitment; no cash change
  | "update"     // change fields on an existing commitment (date, outstanding, ...)
  | "conflict"   // sources disagree; owner must resolve; no cash change
  | "review";    // not enough to decide (unknown party, unreadable, ambiguous match)

export type FieldChange = {
  field: keyof Commitment | "expectedDate";
  from: unknown;
  to: unknown;
  evidence: FieldEvidence[];
};

export type ProposedUpdate = {
  id: string;
  action: ProposedAction;
  candidateId?: string;
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
