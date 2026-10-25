// Shared records: the contract between every lane. Source: docs/design/03-data-model.md.
// Frozen at 11:00 on build day. After that, additive optional fields only.
// Amounts are integer minor units; dates are YYYY-MM-DD; timestamps are ISO 8601 UTC.
// These TS types are the source of truth. Runtime validation (zod) of LLM output and JSON input
// lives next to its consumer and is declared `satisfies z.ZodType<T>` against these types.

export type Status = "actual" | "committed" | "likely" | "possible";
export type Direction = "in" | "out";

export type SourceRef = {
  system: string;            // "zoho_books" | "quickbooks" | "xero" | "bank_csv" | "email" | "whatsapp" | "crm" | "owner" | "generic_file"
  record: string;            // id in that system: invoice number, bank line hash, message id
  url?: string;              // deep link when the system has one
  excerpt?: { start: number; end: number; text?: string };  // span in a message, for signals; keep the words
};

export type Party = {
  id: string;
  name: string;              // masked in demo mode
  kind: "customer" | "supplier" | "employee" | "agency" | "other";
  tags: string[];            // "preferred", "avoid", "strategic", "slow_payer" ...
  notes: string[];           // owner's words, verbatim
  contacts?: { emailDomains?: string[]; phones?: string[] };  // for signal matching
  lagStats?: { n: number; medianDaysLate: number; iqrDays: number; updatedAt: string };
  sourceRefs?: SourceRef[];  // provider ids (Zoho contact id ...), the upsert key for parties
  aliases?: string[];        // other confirmed display names
};

export type CommitmentType =
  | "invoice" | "bill" | "recurring" | "sales_deal" | "purchase_order" | "plan";

export type Commitment = {
  id: string;
  type: CommitmentType;
  direction?: Direction;     // in = receivable; required for purchase_order and plan, implied for invoice/bill
  reference?: string;        // document number (INV-1187, PO-2291); not globally unique
  category?: string;         // "payroll", "rent", "supplier balance" ...
  funding?: true;            // loans/financing; excluded from the stress scenario while likely
  partyId?: string;
  amount: number;
  currency: string;
  anchors: Partial<Record<"order" | "ship" | "delivery" | "invoice" | "due", string>>;
  patternId?: string;        // a profile payment pattern; default by type if absent
  status: Status;
  probability?: number;      // 0..1, required for "possible"
  discount?: { pct: number; byDate: string };  // early-payment terms, e.g. 2/10
  linkedCommitmentIds?: string[];  // a sales deal's supplier POs, freight, duties; a PO's invoices
  // Remaining after partial settlements; `amount` stays the original total. The engine expands
  // from outstanding when set; settlements consume pattern legs in order unless Settlement.legIndex says otherwise.
  outstanding?: number;
  settlement?: "open" | "partial" | "paid" | "cancelled" | "credited";
  invoiceUrl?: string;       // hosted invoice link, kept for drafts
  paymentUrl?: string;       // "Pay now" link; never evidence of payment
  evidenceIds?: string[];    // every Evidence record that describes this commitment (the only evidence link)
  sourceRef: SourceRef;      // the first/authoritative source; for document-created commitments, the first evidence
};

// A commitment before it has an id. Used by signals, owner plans, and intake proposals.
export type CommitmentDraft = Omit<Commitment, "id" | "sourceRef"> & { sourceRef?: SourceRef };

// Stored actuals (bank lines) may lack amountBase/confidence/basis; the engine fills them per run.
export type CashEvent = {
  id: string;
  commitmentId?: string;     // absent for unmatched bank actuals (card sales, fees)
  legIndex: number;
  date: string;
  amount: number;
  currency: string;
  amountBase: number;        // in profile base currency at the run's FX rate
  direction: Direction;
  status: Status;
  confidence: number;        // 0..1
  basis: string;             // human-readable reason for this date and amount
  category?: string;
  sourceRef: SourceRef;
  overriddenBy?: string[];   // rule, signal, or scenario ids applied to this event
};

export type SignalClaim =
  | { kind: "date_change"; newDate: string; legIndex?: number }
  | { kind: "amount_change"; newAmount: number }
  | { kind: "cancel" }
  | { kind: "new_commitment"; draft: CommitmentDraft }
  | { kind: "plan"; draft: CommitmentDraft };

// Signals are confirmed through their own state (POST /signals/:id/apply); they are not ChangeProposals.

export type Signal = {
  id: string;
  channel: "email" | "whatsapp" | "crm" | "owner";
  receivedAt: string;
  partyId?: string;
  commitmentId?: string;     // matched commitment
  matchCandidates?: { commitmentId: string; reasons: string[] }[];  // when the match is ambiguous
  claim: SignalClaim;
  confidence: number;
  effect?: { lowPointDelta: number; week: string };  // filled by the engine
  state: "proposed" | "applied" | "dismissed";
  sourceRef: SourceRef;      // points at the message and excerpt span
};

export type Rule = {
  id: string;
  scope: { partyId: string } | { all: true };
  kind: "lag_offset" | "preference" | "flexibility";
  params: Record<string, unknown>;   // { offsetDays: 20 } | { tag: "preferred" } | { extraDays: 15 }
  fromNote: string;          // the owner's original words
  state: "proposed" | "confirmed" | "dismissed";
};

export type Lever =
  | { kind: "chase"; commitmentId: string; assumeDate: string }
  | { kind: "defer"; commitmentId: string; days: number }
  | { kind: "split"; commitmentId: string; shares: number[] }
  | { kind: "pay_early"; commitmentId: string }
  | { kind: "ask_advance"; commitmentId: string; share: number };

export type WorkItem = {
  id: string;
  warning: string;           // "projected_cash_gap" ...
  title: string;             // written by Claude from evidence
  why: string;               // written by Claude, numbers from tools only
  lever?: Lever;
  cashEffect: number;        // from simulate(), never from Claude
  neededBy: string;          // last date the lever still helps
  confidence: number;
  score: number;
  evidenceRefs: string[];    // record ids
  actions: { kind: "draft_email" | "draft_message" | "mark_done"; draftId?: string }[];
  partnerAction?: { label: string; sample: true; disclosure: string };
  state: "open" | "done" | "dismissed";
};

// Opening cash. The forecast starts from the latest snapshot on or before asOf.
export type BalanceSnapshot = {
  id: string;
  account: string;
  amount: number;            // minor units, may be negative
  currency: string;
  asOf: string;              // YYYY-MM-DD, start of day
  sourceRef: SourceRef;
};

// Payment history. Input to the lag model; partial payments reduce Commitment.outstanding.
export type Settlement = {
  id: string;
  commitmentId: string;
  partyId?: string;
  amount: number;
  currency: string;
  date: string;              // actual paid date
  legIndex?: number;         // which pattern leg this pays, when known (deposits)
  sourceRef: SourceRef;      // bank line, accounting payment, or owner confirmation
};

// One piece of source material: a CSV row, PDF, XLSX sheet, email, WhatsApp message, or URL.
// Many Evidence records can describe one Commitment; evidence never creates cash by itself.
export type Evidence = {
  id: string;
  channel: "zoho_books" | "quickbooks" | "xero" | "bank_csv" | "email" | "whatsapp" | "crm" | "upload" | "url" | "owner";
  format: "csv" | "xlsx" | "pdf" | "text" | "eml" | "html" | "image" | "api";
  receivedAt: string;
  parentId?: string;         // attachment or link inside a message
  fileName?: string;
  mime?: string;
  storageKey?: string;       // where the original bytes live, for preview
  fileHash?: string;         // byte-identical files dedupe on this
  url?: string;
  text?: string;             // extracted text (bounded), for excerpts after the original is gone
  extraction: ExtractionState;
  sourceRef: SourceRef;
};
// Links to commitments live only in Commitment.evidenceIds (one evidence can describe several).

export type ExtractionState = "ok" | "partial" | "unreadable" | "unsupported";

// A change applied on top of the expanded events. Rules, applied signals, and levers all become overrides.
export type Override = {
  id: string;
  target: { commitmentId: string; legIndex?: number };
  change: { date?: string; shiftDays?: number; amount?: number; exclude?: true };
  origin: "rule" | "signal" | "lever" | "owner";
  originId?: string;
};

export type Scenario = {
  id: string;                // "base", "stress", or a generated what-if id
  kind: "base" | "stress" | "what_if";
  overrides: Override[];     // applied after base overrides
  levers?: Lever[];          // what produced a what-if
};

// Everything the engine reads; the store returns this for one business.
export type Records = {
  parties: Party[];
  commitments: Commitment[];
  events: CashEvent[];       // actuals only; future events come from expansion
  signals: Signal[];
  rules: Rule[];
  settlements: Settlement[];
  balances: BalanceSnapshot[];
  evidence: Evidence[];
};
