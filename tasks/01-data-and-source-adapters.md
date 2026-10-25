# Person 1: Data and source adapters

Owner: unassigned. Claim this role in [tracking issue #1](https://github.com/thomashillyer/cashflow/issues/1).

## Outcome

CSV, XLSX, invoice links, and the existing Zoho connector feed one source-evidence and document-candidate interface. Preserve every source without creating duplicate cash.

## Owns and hands off

Own source adapters, original file/message/URL storage, XLSX row/sheet reading, source IDs, import diagnostics, and the bounded invoice-link resolver. Person 4 owns document interpretation and cross-source matching. Person 3 owns intake screens. Agree the interface together in the first 30 minutes.

Deliver candidate payloads to person 4 and import/source status to person 3. Coordinate with person 5 for persistence and deployment configuration. Pick implementation paths with the team at kickoff; do not introduce a second application or data store.

## Technical handoff

Follow the [technical plan](../docs/TECHNICAL_PLAN.md) and the current [five-person lanes](../docs/design/09-api-repo-lanes.md#five-people) where this earlier checklist differs. Layer 1 extracts structured candidates; Layer 2 reconciles accepted records and applies profile rules to cash events. Person 3 owns API routes; person 5 coordinates store/integration and owns deterministic warnings/ranking. Person 4 owns AI extraction, proposals, explanations, Ask Neri, and drafts.

## First 30 minutes

- [ ] Inspect representative receivables/payables exports, a PDF, XLSX invoice/PO, message, and invoice URL.
- [ ] Probe the existing Zoho connector for up to 20 minutes; record supported entities and stop if it is not immediately usable.
- [ ] Agree evidence/candidate IDs, currency/date conventions, error payloads, and fixtures with persons 2 and 4.
- [ ] Confirm which inputs contain settlement history and outstanding balances rather than only original invoice totals.

## Build checklist

- [ ] Store business-scoped source evidence, channel, format, timestamps, provider IDs, original URL/file, and attachment/message relationships.
- [ ] Import the pilot CSV columns with a mapping preview and row-level errors; missing amounts must never become zero.
- [ ] Parse XLSX sheets/used ranges into rows or document content for person 4; identify workbook/sheet/row provenance.
- [ ] Distinguish one spreadsheet invoice from a table containing multiple invoices; avoid adding line items and totals twice.
- [ ] Normalize available Zoho invoice, bill, counterparty, and settlement data into the same contract when the probe succeeds.
- [ ] Capture exact invoice/payment URLs and resolve supported public or authorized Zoho/QuickBooks invoice details read-only.
- [ ] Bound URL requests by provider, redirect validation, timeout, and size; reject private-network destinations.
- [ ] Return an upload/manual-completion fallback for inaccessible, expired, or unsupported URLs; retain their source.
- [ ] Deduplicate provider records and byte-identical files while allowing distinct evidence to point to one obligation.
- [ ] Preserve owner overrides on source refresh and expose source freshness/import completeness.
- [ ] Keep pilot data and credentials local; supply synthetic source fixtures for the public demo.

## Milestones and checks

- [ ] Hour 2: CSV fixture reaches the shared engine/UI; other contributors can use stable candidate fixtures.
- [ ] Hour 3.5: XLSX and supported URL paths feed review, alongside PDF content supplied by person 4.
- [ ] Verify repeat import leaves cash unchanged, invalid rows remain visible, and a workbook with several invoices creates distinct candidates.
- [ ] Verify failed URL retrieval preserves its source and requests a supported fallback.
- [ ] Verify Zoho refresh retains confirmed owner overrides.
- [ ] By hour 5: integrate the real adapter outputs and stop adding formats/providers.

## Cut line

Drop a nonworking live Zoho adapter after the probe and additional URL resolvers before dropping CSV/XLSX intake or link capture. Legacy XLS conversion and continuous email/WhatsApp sync are follow-on work.

## Definition of done

The agreed CSV/XLSX/link fixtures produce source-linked candidates and visible errors, repeat ingestion does not duplicate cash, and persons 3 and 4 consume your real outputs. See [shared plan](../docs/HACKATHON_PLAN.md).
