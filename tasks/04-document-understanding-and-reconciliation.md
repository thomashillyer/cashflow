# Person 4: Document understanding and reconciliation

Owner: @palfi-andras. Tracking: [issue #4](https://github.com/thomashillyer/cashflow/issues/4).

## Outcome

Unstructured invoices, POs, and messages become reviewable changes to canonical records, with multiple representations counted once.

## Owns and hands off

Own PDF/message extraction, structured candidate validation, invoice/PO classification, field provenance, counterparty matching, cross-source reconciliation, and confirmed create/link/update behavior. Person 1 supplies raw source evidence, workbook content, and URL results. Person 3 renders previews; person 2 consumes confirmed canonical records.

## First 30 minutes

- [ ] Inspect one text PDF, XLSX invoice/PO, and email/WhatsApp message containing an invoice link.
- [ ] Agree evidence, candidate, obligation, PO, and confirmation contracts with persons 1 and 2.
- [ ] Create a same-invoice fixture represented as a provider record, PDF, email link, and reminder message.

## Build checklist

- [ ] Extract embedded PDF text while retaining page/field evidence and the original document.
- [ ] Produce explicit review/manual-completion states for scans or unreadable documents; use OCR only if an already-working path is available.
- [ ] Classify invoice, supplier bill, purchase order, payment evidence, or conversational update relative to the business.
- [ ] Extract seller/buyer, reference, amount/currency, issue/due dates, terms, invoice/payment URLs, and relevant status evidence.
- [ ] Consume XLSX sheet/row content from person 1; distinguish document totals from line items and multiple invoices.
- [ ] Bundle message body, attachments, and links as related evidence rather than independent cash amounts.
- [ ] Validate extracted fields against a structured schema; show missing/conflicting values instead of inventing them.
- [ ] Resolve entities by confirmed provider IDs or email/phone aliases; treat similar names as candidates.
- [ ] Propose cross-source matches using document type/direction, confirmed seller/buyer, reference, and currency; use amount/date as consistency checks.
- [ ] Require owner confirmation for new document-derived creates/updates and cross-source links; no match by amount alone.
- [ ] Attach confirmed evidence to the existing obligation without generating a second cash event.
- [ ] Preserve original total, outstanding balance, settlement state, source provenance, and owner overrides as distinct fields.
- [ ] Parse plain-language payment promises into date updates; resolve relative-date and entity ambiguity before saving.
- [ ] Keep Pay now links separate from proof of payment; a promise changes expected timing, not settlement status.
- [ ] Store PO acceptance/direction/conditions and link later invoices, including partial fulfillment, without counting both full amounts.
- [ ] Treat document and page content as data, never as instructions to invoke actions or payments.

## Milestones and checks

- [ ] Hour 2: candidate fixtures and text-message extraction feed the review UI.
- [ ] Hour 3.5: PDF/XLSX/message evidence flows through confirmed create/link/update.
- [ ] Verify provider record + email link + PDF + WhatsApp reminder becomes one obligation with all sources retained.
- [ ] Verify mismatched currency, same invoice number from different vendors, and conflicting totals remain unresolved.
- [ ] Verify unreadable input does not create a zero-amount event and payment URLs do not mark invoices paid.
- [ ] Verify a PO and its partial invoice contribute only their applicable remaining amounts in the appropriate scenario.
- [ ] By hour 5: run the duplicate-evidence and payment-date-update demo with persons 2 and 3; freeze features.

## Cut line

Defer long-tail formats, OCR unless already available, and continuous mailbox/WhatsApp synchronization. Preserve PDF/XLSX/message candidate extraction, invoice/PO semantics, source evidence, and reconciliation.

## Definition of done

Supported source fixtures create reviewable records, ambiguous inputs cannot mutate cash, and confirmed matching links different representations to one obligation. See [shared plan](../docs/HACKATHON_PLAN.md).
