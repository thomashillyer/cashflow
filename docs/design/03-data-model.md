# 03 — Data model (the contract)

Six record types, agreed in the first hour and **frozen at 11:00** on build day. Adapters write them, the engine reads them, and the UI and Claude only ever see them. Nothing in the model is specific to trading.

After the freeze: adding optional fields is OK; renaming or removing fields is not.

## Overview

| Record | Purpose |
|---|---|
| **Party** | Who money moves with; owner notes and learned payment behavior live here |
| **Commitment** | Anything that will move cash; expands into events through its payment pattern |
| **CashEvent** | One dated movement of money; the only thing the engine sums |
| **Signal** | Information from outside the books that changes a commitment |
| **Rule** | An owner statement made machine-readable ("they always pay 20 days late") |
| **WorkItem** | One entry in the ranked list; the top three are "three things to do today" |

## Status ladder

`actual` (in the bank) → `committed` (invoiced, billed, scheduled) → `likely` (won deal not yet invoiced, owner plan) → `possible` (quoted RFQ).

The main forecast line uses actual, committed, and likely. `possible` is drawn as a separate band weighted by probability.

## Types (`schema/records.ts`)

Conventions: amounts are integers in minor units (cents); dates are ISO `YYYY-MM-DD`; timestamps are ISO 8601 UTC.

```ts
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
  | { kind: "split"; commitmentId: string; shares: number[]; legIndex?: number }   // next remaining leg -> installments every thresholds.splitIntervalDays (default 30)
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
```

## Supporting records

These make the engine inputs complete and carry over the reconciliation rules from the earlier cashflow plan. They are part of the 11:00 freeze too.

```ts
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
```

### Reconciliation rules (carried over)

- One invoice can arrive as a Zoho record, CSV row, PDF, email link, and WhatsApp reminder. That is one Commitment with several `evidenceIds`, and it is counted once.
- Match order: existing `sourceRef`/provider ID, then file hash, then same party + document type/direction + reference + currency. Amount and date are consistency checks only; never match on amount or display name alone. Invoice numbers are not globally unique.
- New document-derived commitments and new cross-source links are proposals until the owner confirms. Conflicts (different totals, currencies, or vendors) stay in the Review screen and add no events.
- Never replace `outstanding` with a PDF's original total, and never infer `settlement` from an old attachment or a payment link.
- A purchase order is `likely` until the owner confirms it. When an invoice fulfills part of a PO, link them and reduce the PO's remaining amount so the same money is never forecast twice.
- Missing amounts or dates are missing, never zero.

## Example cash event

```json
{
  "id": "evt-inv-INV-1187-0",
  "commitmentId": "inv-INV-1187",
  "legIndex": 0,
  "date": "2026-12-24",
  "amount": 5200000, "currency": "USD", "amountBase": 5200000,
  "direction": "in",
  "status": "committed",
  "confidence": 0.72,
  "basis": "due 2026-12-02 + 22 days (median of last 8 payments)",
  "sourceRef": { "system": "zoho_books", "record": "INV-1187" }
}
```

## Storage

SQLite or Postgres (Supabase if we reuse the Neri prototype). One table per record type, plus:

- `forecast_runs` — snapshot of each run (inputs hash, FX rates, weekly output), so a change alert can say what moved.
- `aliases` — real name → stage name, for masking in demo mode.
- `column_mappings` — saved per source file layout (see `04-adapters.md`).
