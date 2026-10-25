# 06 — Signals: from a message to a moved invoice

This is the must-have differentiator: at least one forecast change must come from outside the books (an email, a WhatsApp message, a CRM record), with the message cited.

The pipeline is channel-agnostic. An email, a WhatsApp message, a CRM note, and something the owner types into Ask Neri all go through the same steps and become the same `Signal` record.

## Pipeline

1. **Filter.** Only messages from known parties (matched by `party.contacts.emailDomains` or `phones`) are read. Everything else is ignored and never stored.
2. **Triage.** A cheap pass (small model or keyword rules: pay, payment, invoice, PO, delay, next week, wire, transfer, ship, date words) drops messages with no mention of payment, dates, amounts, or orders.
3. **Extract.** Claude returns a `Signal` through a structured-output schema: party, referenced invoice or PO, claim type, new value, the excerpt span, and a confidence.
4. **Match.** Plain code links the claim to a commitment: exact reference number for that party first, then same party plus amount within 2%, then same party with exactly one open commitment. These are proposals, not facts. Ambiguous matches go to the owner, never a guess.
5. **Price it.** The engine simulates the change and fills `signal.effect` ("week 7 is now short $21K").
6. **Ask.** For the hackathon every signal waits as `proposed` for one-tap confirmation, showing the excerpt and the priced effect. Auto-apply above `profile.thresholds.signalAutoApplyConfidence` (with undo) is post-hackathon; ship the threshold disabled.
7. **Cite it.** The affected cash event's `basis` and `overriddenBy` point to the signal, whose `sourceRef` points to the message and excerpt, so the UI shows the words behind the moved date.

## Extraction schema (structured output)

```json
{
  "partyName": "string",
  "reference": "string | null",
  "amountMentioned": "number | null",
  "claim": "date_change | amount_change | cancel | new_commitment | plan | none",
  "newDate": "YYYY-MM-DD | null",
  "newAmount": "number | null",
  "dependsOn": "string | null",
  "excerpt": { "start": 0, "end": 0 },
  "confidence": 0.0
}
```

Relative dates ("next Friday", "end of the month") are resolved against the message's `receivedAt`, in code, after extraction. Claude returns the phrase and a best guess; code recomputes.

## Owner input uses the same path

| Owner types | Becomes |
|---|---|
| "Planning a $40K supplier deposit in December" | A `plan` commitment, status `likely`, source `owner` |
| "Customer A always pays 20 days late" | A `lag_offset` rule for Customer A, pending confirmation |
| "Supplier C will give us 15 more days if I ask" | A `flexibility` rule (`extraDays: 15`) for Supplier C |
| "We lost the Harbor deal" | A `cancel` signal on that deal |

Neither path needs code per business.

## Documents and links in messages

An email often carries a PDF and an invoice/payment link for an invoice already in the books. Each becomes an `Evidence` record linked to the existing commitment (see reconciliation rules in `03-data-model.md`), not a new amount. A payment promise changes expected timing, not settlement. A "Pay now" link is never proof of payment. Unreadable PDFs and inaccessible links stay visible with a request for upload or manual fields.

## Safety

- Message text is passed only to the extraction schema, never as instructions to the model that ranks or drafts.
- A signal can change a forecast; it can never trigger an action, send anything, or change a rule without owner confirmation.
- Store only the excerpt span and message id, not whole inboxes.
