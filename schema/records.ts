// Shared records: the contract between every lane. Source: docs/design/03-data-model.md.
// Frozen at 11:00 on build day. After that, additive optional fields only.
// Amounts are integer minor units; dates are YYYY-MM-DD; timestamps are ISO 8601 UTC.

export type Status = "actual" | "committed" | "likely" | "possible";
export type Direction = "in" | "out";

export type SourceRef = {
  system: string;            // "zoho_books" | "bank_csv" | "email" | "whatsapp" | "crm" | "owner" | "generic_file"
  record: string;            // id in that system: invoice number, bank line hash, message id
  url?: string;              // deep link when the system has one
  excerpt?: { start: number; end: number };  // span in a message, for signals
};

export type Party = {
  id: string;
  name: string;              // masked in demo mode
  kind: "customer" | "supplier" | "employee" | "agency" | "other";
  tags: string[];            // "preferred", "avoid", "strategic", "slow_payer" ...
  notes: string[];           // owner's words, verbatim
  contacts?: { emailDomains?: string[]; phones?: string[] };  // for signal matching
  lagStats?: { n: number; medianDaysLate: number; iqrDays: number; updatedAt: string };
};

export type CommitmentType =
  | "invoice" | "bill" | "recurring" | "sales_deal" | "purchase_order" | "plan";

export type Commitment = {
  id: string;
  type: CommitmentType;
  partyId?: string;
  amount: number;
  currency: string;
  anchors: Partial<Record<"order" | "ship" | "delivery" | "invoice" | "due", string>>;
  patternId?: string;        // a profile payment pattern; default by type if absent
  status: Status;
  probability?: number;      // 0..1, required for "possible"
  discount?: { pct: number; byDate: string };  // early-payment terms, e.g. 2/10
  linkedCommitmentIds?: string[];  // a sales deal's supplier POs, freight, duties; a PO's invoices
  outstanding?: number;      // remaining after partial settlements; `amount` stays the original total
  settlement?: "open" | "partial" | "paid" | "cancelled" | "credited";
  invoiceUrl?: string;       // hosted invoice link, kept for drafts
  paymentUrl?: string;       // "Pay now" link; never evidence of payment
  evidenceIds?: string[];    // every Evidence record that describes this commitment
  sourceRef: SourceRef;      // the first/authoritative source
};

export type CashEvent = {
  id: string;
  commitmentId: string;
  legIndex: number;
  date: string;
  amount: number;
  currency: string;
  amountBase: number;        // in profile base currency at the run's FX rate
  direction: Direction;
  status: Status;
  confidence: number;        // 0..1
  basis: string;             // human-readable reason for this date and amount
  sourceRef: SourceRef;
  overriddenBy?: string[];   // rule, signal, or scenario ids applied to this event
};

export type SignalClaim =
  | { kind: "date_change"; newDate: string }
  | { kind: "amount_change"; newAmount: number }
  | { kind: "cancel" }
  | { kind: "new_commitment"; draft: Omit<Commitment, "id" | "sourceRef"> }
  | { kind: "plan"; draft: Omit<Commitment, "id" | "sourceRef"> };

export type Signal = {
  id: string;
  channel: "email" | "whatsapp" | "crm" | "owner";
  receivedAt: string;
  partyId?: string;
  commitmentRef?: string;    // matched commitment id
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
  confirmed: boolean;
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
  sourceRef: SourceRef;      // bank line, accounting payment, or owner confirmation
};

// One piece of source material: a CSV row, PDF, XLSX sheet, email, WhatsApp message, or URL.
// Many Evidence records can describe one Commitment; evidence never creates cash by itself.
export type Evidence = {
  id: string;
  channel: "zoho_books" | "bank_csv" | "email" | "whatsapp" | "upload" | "url" | "owner";
  format: "csv" | "xlsx" | "pdf" | "text" | "html" | "api";
  receivedAt: string;
  parentId?: string;         // attachment or link inside a message
  fileHash?: string;         // byte-identical files dedupe on this
  url?: string;
  extraction: "ok" | "partial" | "unreadable" | "unsupported";
  commitmentId?: string;     // set only after the owner confirms the link
  sourceRef: SourceRef;
};

// A change applied on top of the expanded events. Rules, applied signals, and levers all become overrides.
export type Override = {
  id: string;
  target: { commitmentId: string; legIndex?: number };
  change: { date?: string; amount?: number; exclude?: true };
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
