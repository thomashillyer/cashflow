# 04 — Adapters

Every source implements one small interface and outputs only the shared records (`03-data-model.md`). Adding Xero, a second bank, or Slack later is one new adapter, with no change to the engine.

## Interface

```ts
export interface Adapter {
  id: string;                         // "zoho_books", "bank_csv", "email_m365"
  kind: "books" | "bank" | "signals" | "owner";
  pull(input: PullInput): Promise<RawItem[]>;   // live API, uploaded file, or pasted text
  normalize(raw: RawItem[], profile: Profile, ctx: NormalizeContext): Normalized;
}

export type PullInput =
  | { mode: "live"; since?: string }
  | { mode: "file"; path: string; mime: string }
  | { mode: "text"; text: string };

export type Normalized = {
  parties: Party[];
  commitments: Commitment[];
  events: CashEvent[];      // only for actuals (bank lines, past payments)
  signals: Signal[];
  paymentHistory?: { partyId: string; invoiceId: string; due: string; paid: string }[];
};
```

Adapters do not compute forecasts. Future cash events are created by the engine from commitments.

## Adapters for build day

| Adapter | Produces | Live mode | No-setup fallback | Sunday |
|---|---|---|---|---|
| Accounting (Zoho Books, QuickBooks, Xero) | Parties, open invoices and bills, payment history | Read-only API | CSV or Excel export | Build, on PilotCo's books |
| Bank | Opening balance, recurring payments | Read-only token (Mercury, SimpleFIN) | CSV or OFX statement | Build, from a statement file |
| Email | Signals, supplier invoices, PO confirmations | Microsoft 365 or Gmail read access | Paste a message or upload an .eml file | Build: paste first, live if the prototype's connection works |
| WhatsApp | Signals | Existing Neri connection | Paste a chat export | Stretch |
| CRM (Zoho CRM) | Sales deals and RFQs | Read-only API | CSV export | Stretch |
| Owner (Ask Neri) | Plans and rules | In the app | Not needed | Build |
| Generic file | Anything tabular | n/a | Any spreadsheet | Stretch |

## Rules every adapter follows

- **Idempotent upserts** keyed on `sourceRef` (`system` + `record`). Re-importing the same export changes nothing.
- **Column mapping is learned once.** For an unfamiliar spreadsheet, Claude proposes a mapping from the headers and a few sample rows; the owner confirms; the mapping is saved in `column_mappings` keyed by a hash of the header row, and applied by plain code from then on.
- **Masking at the edge.** A per-business alias table swaps real party names for stage names before anything reaches the UI in demo mode.
- **Read-only.** No adapter writes back to a source system.
- **Keep payment history.** Accounting adapters must emit due date and paid date for past invoices; the lag model depends on it.
- **Bank recurring detection** is plain code: group outflows by normalized payee, look for regular intervals (7, 14, 15, 30, 91 days ± 2) and stable amounts (± 10%), then propose them as `recurring` commitments for the owner to confirm.

## Accounting export: minimum fields

| Need | Typical column |
|---|---|
| Party name | Customer Name / Vendor Name |
| Document number | Invoice # / Bill # |
| Amount and currency | Total, Currency |
| Invoice date, due date | Invoice Date, Due Date |
| Paid date (history) | Payment Date (from a payments export if not on the invoice) |
| Status | Open / Paid / Overdue |

If the export lacks paid dates, join a separate payments export by document number.
