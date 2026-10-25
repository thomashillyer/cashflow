# Cashflow: seven-hour hackathon plan

Date: October 25, 2026. Status: proposed execution plan. Team: five people.

## Product decision

Build a cash-flow assistant that answers three questions: **What needs my attention? When do I need to act? What happens if an expected payment slips?** The chart supports those answers.

The pilot business already has CSV exports and access to a live Zoho Books connector. These are starting inputs. The ingestion layer must also accept invoice and purchase-order evidence from email, WhatsApp, hosted invoice links, PDFs, and spreadsheets. Separate the channel a document arrived through from its format and the business record it describes. Keep business setup configurable through the UI so the second business does not require code changes.

Revision: expanded document intake following the owner's clarification. This supersedes the earlier CSV-first scope and the one-accounting-source-per-business restriction. Multiple sources may describe one obligation; they must be reconciled before affecting cash.

The product should reduce the owner's mental workload. It must not claim “you are fine” merely because a tentative loan appears in a forecast.

## What makes the demo compelling

An invoice first arrives through Zoho or an export. The owner then imports an email containing its hosted payment link and PDF attachment, or uploads an Excel invoice received through WhatsApp. The app links matching evidence to one invoice, previews any changed fields, and keeps the forecast amount unchanged for duplicate evidence. It retains the original invoice/payment link for the owner to open.

Next the owner pastes: “The customer says invoice INV-104 will be paid November 3 instead of October 30.” The app identifies the invoice, previews the proposed date change, and asks the owner to confirm it. The app shows the changed receipt date in the base forecast, the existing October 29 supplier deficit, and the payroll exposure in the delayed-inflow scenario that excludes tentative funding. The customer update does not itself cause a new base-scenario payroll deficit in this fixture. The app explains which risk each proposed action addresses and shows the impact of that action.

An adjacent future use is a shared rehearsal tool: an owner and bookkeeper could compare “hire next month” against “customer pays two weeks late” in the same timeline. Preserve scenario separation now; defer hiring workflows.

## Constraints and premises

- Seven hours includes integration, deployment, rehearsal, and submission. Feature work stops at hour five.
- The pilot is the first data fixture, not a hard-coded business model. A second synthetic business demonstrates configuration and onboarding.
- Use one currency per business, a 30-day daily forecast, and a configurable cash reserve. Multi-currency, tax modeling, and long-range forecasting are deferred.
- CSV is the baseline fixture path. PDF and XLSX upload, pasted email/WhatsApp content, and invoice-link intake are MVP work. Zoho is the preferred live accounting source if a 20-minute read-only probe succeeds. Channel capture is separate from document parsing: live email and WhatsApp sync can be deferred while their messages, links, and attachments enter through paste/upload. Label manual intake accurately.
- Use AI to extract proposed updates and explain supplied facts. Ordinary code calculates balances, dates, risk, and action impact.
- Preview changes before saving them. Draft messages and in-app reminders are sufficient actions for the demo. External sending, money movement, and CRM/accounting write-back are deferred.
- Invoices represent customer money coming in; bills represent supplier money going out. Track counterparty roles explicitly because one business can be both.

## Alternatives considered

| Approach | Effort and risk in seven hours | Benefit | Tradeoff |
|---|---|---|---|
| A. Shared document intake with Zoho and manual channel capture | Medium to high; recommended | PDFs, spreadsheets, messages, and links become source-linked records through one review and reconciliation flow | Native mailbox/WhatsApp sync and long-tail document layouts remain deferred |
| B. Accounting, email, WhatsApp, and CRM integrations from the start | Very high | Broader eventual product | Each integration adds authentication, mapping, and reconciliation work before the core experience is usable |
| C. Chat-only assistant over an uploaded spreadsheet | Low | Fast conversational demo | Harder to inspect assumptions, compare scenarios, and demonstrate configurable payment patterns |

Recommendation: A. Keep the full product loop, prioritize document intake over extra presets and secondary chart polish, and constrain the number of live integrations. There is no existing application code in this workspace to reuse.

## MVP experience

1. **Onboard:** enter business name, currency, business timezone, opening available cash with an as-of date, reserve floor, and payroll or other recurring obligations. Select a payment pattern or customize one in the UI.
2. **Import:** use one intake area for CSV/XLSX/PDF uploads, pasted email/WhatsApp text, invoice URLs, and records from Zoho. Show extracted document type, seller/buyer, invoice or PO reference, currency, amount, dates, source, and possible existing match. Preview create/link/update before committing. Treat blank amounts and unresolved dates as missing facts, never zeroes. Retain invoice and payment links with the record.
3. **See a daily briefing:** lead with the next cash risk, its date and cause, and at most three priority actions. Show “No action needed based on current data” only alongside freshness and key dependencies. Keep a collapsible watchlist for future follow-ups.
4. **Inspect the forecast:** daily balances for base and delayed-inflow scenarios, reserve line, first shortfall, minimum balance, and the events driving a selected day. Every event links to its source or entered assumption.
5. **Update in plain language:** paste a message or use existing device dictation into the same text field. Show counterparty, invoice/bill, amount if present, proposed date, and source text. Resolve ambiguity before saving; never silently create a duplicate payment.
6. **Act:** open a recommendation, inspect the reason and scenario impact, copy a grounded message draft, create an in-app reminder, or save a confirmed forecast override. Show suggested, planned, and completed as different states.

Payment settings include daily/every-other-day receipts, selected weekdays, customer invoice terms, supplier bill terms, and explicit recurring dates. A preset only populates editable rules. “Every other day” must visibly distinguish calendar days from business days. For the MVP, use calendar days by default and let owners enter explicit exceptions; holiday calendars are deferred.

## Architecture and integration boundary

```text
Zoho / exports ────────────────────────────────┐
Email / WhatsApp → text + attachments + URLs ──┤
Direct upload → PDF / XLSX / CSV ──────────────┘
                         ↓
             source evidence + format parsing
                         ↓
       classify + extract + resolve counterparty
                         ↓
      match existing record + review create/update
                         ↓
         canonical invoices / bills / POs + history
                         ↓
               cash events + scenarios
                         ↓
              deterministic forecast
                         ↓
       attention rules + briefing + action previews
```

Use the team's most familiar web stack and one shared persistence store. Keep these modules in one application for this hackathon. Source imports, owner overrides, and scenario edits remain distinguishable. Zoho refreshes must not erase owner overrides. Public hosting, submitted screenshots, and recordings use synthetic records only. Run real pilot imports and the live Zoho connector in a separate local developer environment bound to loopback; do not deploy its data or credentials. Public intake demonstrates the full pipeline using bundled synthetic attachments, messages, and links rather than accepting private uploads or accessing live Zoho. Its reset and second-business flow use only synthetic fixtures. Hosted pilot access control is deferred.

Agree on the data contract in the first 30 minutes. Commit shared fixtures immediately so each person can build against the same data without waiting for another layer.

### Minimum shared records

| Record | Required meaning |
|---|---|
| Business | ID, name, currency, timezone, opening available cash in minor units, as-of date, reserve floor, editable payment rules |
| Counterparty | Business-scoped ID, customer/supplier roles, display name, source IDs, email/phone aliases, terms, observed timing sample count |
| Source evidence | Business-scoped ID, channel, format, sender/source identity, received/fetched time, original file or URL, attachment/message relationship, file hash/provider ID, extraction result, field-level evidence locations |
| Obligation | Stable ID, business ID, counterparty ID, receivable/payable, invoice/bill reference, outstanding amount, currency, issue date, contractual due date, settlement status, linked evidence IDs, invoice URL, payment URL, provider IDs |
| Purchase order | Stable ID, business ID, issuer/recipient, purchase/sales direction, PO reference, total, currency, expected dates/terms, draft/accepted/cancelled/partially invoiced state, linked invoice IDs and remaining uninvoiced amount |
| Cash event | Stable ID, linked obligation or recurring rule, inflow/outflow, amount, expected date, assumption type, source, tentative/confirmed/settled state, scenario ID |
| Proposed update | Source evidence IDs, candidate record, proposed create/link/update, changed fields and evidence, unresolved ambiguities/conflicts, confirmation state |
| Action | Triggering risk, evidence event IDs, proposed change, impact from a recomputed scenario, act-by date, next review date, state |

Store monetary amounts as integer minor units. Store daily business dates as `YYYY-MM-DD` in the selected business timezone. Forecast output includes `asOf`, `horizonDays`, scenario, daily balances, first below-reserve day, first negative day, minimum balance/date, and data-quality warnings.

Imported evidence uses `(businessId, source, sourceRecordId)` when available; file hashes identify byte-identical attachments. Evidence identity is separate from obligation identity: one invoice can have a Zoho record, CSV row, PDF, email link, and WhatsApp reminder. Preserve each evidence-to-record mapping. Reimporting evidence must not increase forecast cash.

For cross-source matching, prefer an existing confirmed provider-ID mapping. Otherwise propose a match using business, document direction/type, confirmed seller and buyer identities, invoice reference, and currency, with amount/date as consistency checks. Invoice references are not globally unique; amount or display name alone cannot establish a match. For the MVP, require owner confirmation of new cross-source matches and document-derived creates/updates. A confirmed link attaches evidence to the existing obligation and never creates a second cash event. Conflicts and ambiguous overlaps stay in the review queue, excluded from new forecast events until resolved. Keep prior values and field provenance; do not replace an outstanding amount with a PDF's original total or infer settlement from an old attachment.

Identity matching uses explicit source IDs or confirmed email/phone aliases. Similar display names produce a review candidate. Multiple contacts may belong to one counterparty. Message changes should link to an existing obligation; genuinely new obligations require a separate explicit creation preview.

### Internal module contract

- Ingestion produces source evidence and normalized document candidates, plus extraction errors, unresolved fields, and source freshness. Matching and confirmation produce canonical records; raw extraction cannot directly emit cash events.
- Event construction combines unsettled obligations, recurring rules, and confirmed owner overrides into scenario-specific cash events.
- Forecast is a pure function of business settings, events, as-of date, and horizon. It returns the same result for the same inputs.
- Attention rules consume forecast output and underlying events; explanations cannot introduce new amounts or dates.
- UI mutations save a proposed update, confirm it, then recompute the forecast and actions together. Draft extraction alone does not change balances.

### Document and link intake scope

| Input | MVP handling | Boundary |
|---|---|---|
| CSV or Zoho record | Map structured fields into the same candidate/record model | Support pilot columns and verified connector entities; preserve source IDs |
| XLSX invoice or PO | Inspect sheets and used ranges, extract candidate document(s) or tabular rows, preview mappings and totals | Confirm whether the workbook is one document or many; do not sum totals, subtotals, and line items together; legacy XLS conversion is deferred |
| PDF invoice or PO | Extract embedded text and document fields; retain page evidence and original file | Image-only or unreadable pages go to explicit review/manual completion unless an already-working OCR path is available |
| Email or WhatsApp content | Capture pasted/exported text, links, and separately uploaded attachments in one source bundle | Native continuous sync is separate connector work; unsupported exports can enter through manual capture |
| Hosted Zoho/QuickBooks invoice link | Keep the exact original link and attempt read-only retrieval of invoice details using an existing authorized API or a supported public invoice page | No assumption that every provider URL is fetchable. Login/expiry/unsupported pages request attachment upload or manual fields; never drop the source |

The same email may include a PDF and an invoice/payment URL. Treat them as evidence for a possible single invoice, not independent amounts. Extract payment URLs without invoking payment, following a Pay now action, or storing card details. An invoice link routed through Stripe does not establish that an invoice has been paid. Change settlement status only from identified payment/settlement evidence, an accounting reconciliation, or explicit owner confirmation. An invoice may be partially paid, cancelled, or credited; retain that state instead of assuming its original face value is still due.

Fetch invoice URLs on the server through a bounded read-only resolver: allow supported HTTPS providers and validated redirects, block local/private-network targets, and limit response size/time. Treat document text and linked-page content as data rather than instructions. Unsupported input remains visible with its source and required next step. “Anything can arrive” is an extensible intake requirement, not a promise to parse every file type perfectly during the hackathon.

POs are commitments or possible future business, not settled cash or automatically payable invoices. Classify the business as buyer or seller and preserve acceptance/delivery/payment conditions. For this MVP, show POs as planned scenario items until the owner confirms the commitment, amount, and expected cash date. If an invoice later fulfills all or part of a PO, link it and remove that invoiced portion from the PO scenario contribution. Never forecast the full PO plus its related invoices as separate receipts/payments.

## Forecast behavior

For each day: `closingCash = priorClosingCash + inflows - outflows`. The first day's prior balance is the entered opening available cash. Define the as-of date as the start of that business day; include only unsettled events on or after that date. Settled transactions already represented in opening cash must not be counted again.

1. Preserve contractual dates separately from expected dates. An explicit owner override has precedence over a message suggestion or inferred payment history.
2. For customer receipts, use a confirmed promised date when supplied. Otherwise, with at least three settled invoices for that customer, use the median observed delay from due date, including negative delays for early payers. Show sample count. With less history, fall back to stated terms and label that assumption.
3. Historical delay is measured from actual settlement data. Missing settlement history is not evidence of on-time payment. Use actual settlement dates where available; partial settlements reduce the remaining obligation.
4. Supplier outflows use scheduled or contractual dates. Do not assume the owner can pay late because they did so historically. A proposed postponement remains conditional on supplier agreement.
5. Overdue, unpaid receivables without a current promise are uncertain. Require a review date/expected date; do not quietly move them to today. Past-due payables remain visible as overdue obligations and need an explicit schedule or a clearly labeled immediate-payment assumption.
6. Base scenario uses configured expected dates, with tentative funding called out. The stress scenario delays unsettled customer receipts by seven calendar days and excludes tentative loans. It is a sensitivity check, not a statistical confidence interval. Keep planned outflows unchanged.
7. Distinguish below-reserve from negative-cash risk. A positive month-end balance can still hide an earlier payroll shortfall.
8. No data, stale data, unresolved material obligations, or an incomplete import cannot produce an unqualified green status. Show the limitation and request the missing fact.

The daily model does not establish intraday liquidity. If payroll and a receipt share a date, label their ordering as unresolved when it matters.

## Attention and action behavior

Use three states: **Act now**, **Watch**, and **No action needed based on current data**. “Act now” means intervention is due now, not merely that the projected shortfall is close. A shortfall next week may require action today if the remedy takes a week. Use visible, owner-editable lead-time assumptions: three calendar days for customer follow-up, three for supplier negotiation, and two for funding confirmation. Calculate act-by as the relevant risk date minus that lead time; for supplier negotiations, use the earlier of bill due date and risk date. These are operational assumptions, not promised remedy times. If act-by is today or past, label the action Act now. Without a known risk date or owner-entered deadline, show Watch with a request to establish timing; AI cannot invent a deadline.

- Rank by cash impact, days until the last useful action date, and confidence in the proposed remedy. A reminder deadline must precede the risk it is intended to prevent.
- A customer follow-up is appropriate when collecting an outstanding invoice could address the shortfall. Do not invent an earlier payment commitment.
- A follow-up draft may include the matched provider's original invoice/payment link and refer to its original PDF when available. Preserve the existing invoice destination; do not create another invoice or payment request just because it arrived through a new channel. Sending remains outside this MVP's draft/copy flow.
- Supplier deferral is a proposed negotiation, never a completed cash improvement. Payroll and owner-marked non-deferrable expenses cannot be offered as routine delay candidates.
- Tentative loan proceeds trigger a dependency check: show the projected balance if they fail to arrive. Do not present an unconfirmed loan as cash on hand.
- Deduplicate actions by obligation, action type, and forecast version. Respect the recorded next follow-up date unless a material payment/date change creates a new risk.
- Hide routine non-actionable message updates from the main briefing, but retain them in the source history and watchlist. Always surface unresolved updates that could change the risk assessment.
- For the MVP, implement three action types: follow up with customer, request supplier date change, and confirm funding arrival. Compute the forecast impact of each candidate change in code. AI may phrase those facts and draft text, but cannot mark the action done.

## Five-person ownership

| Person | Owns | Concrete deliverables | Done when |
|---|---|---|---|
| 1: Data and source adapters | CSV/Zoho adapters, XLSX parsing, invoice-link resolver, source-evidence storage | Pilot import; Zoho probe; spreadsheet candidates; link capture/read-only resolution with upload fallback; shared evidence fixtures | Each input reaches the same candidate contract; unreadable links retain a source and fallback; repeated imports preserve balances |
| 2: Cash engine | Cash-event construction, payment-date inference, recurrence, scenarios, math | Pure forecast module; base/stress output; reserve and deficit calculation; focused arithmetic/date tests | Shared fixture produces agreed daily balances; a late receipt exposes the correct shortfall; current cash is not double-counted |
| 3: Product UI | Onboarding, shared intake/review UI, briefing, chart and event detail | Upload/paste/link entry; candidate and conflict preview; source-linked records; configurable payment settings | Owner can create/link/update from one intake screen; second-business setup needs no code changes |
| 4: Document understanding and reconciliation | PDF/message extraction, invoice/PO classification, field provenance, entity and record matching | Structured document candidates; source bundling; cross-source match proposals; confirmed create/link/update; PO-to-invoice links | Zoho/export + email link + PDF produce one obligation; XLSX PO stays planned; ambiguous/conflicting evidence requires review |
| 5: Actions and integration | Attention rules, action cards, drafts/reminders, deployment and demo | Deterministic action triggers; scenario impact; grounded drafts; app integration; deployed preview; submission recording | Risk produces a justified action and act-by date; repeated refresh does not repeat reminders; end-to-end demo works |

Person 5 is the integration owner. Every contributor connects their own module to the agreed contract and adds its focused checks; person 5 should not have to rewrite four incompatible interfaces. In the final two hours, everyone helps verify and repair the integrated flow.

## Seven-hour schedule

| Elapsed | Team outcome |
|---|---|
| 0:00–0:30 | Choose stack/integration owner; inspect CSV plus one PDF, XLSX, and invoice link; confirm opening cash/date/currency; freeze evidence/candidate/record contracts and fixtures. Person 1 probes Zoho for at most 20 minutes. |
| 0:30–2:00 | Build independently against fixtures. Deploy the application shell by hour one. By hour two, a CSV fixture must flow through the engine into the UI. |
| 2:00–3:30 | Integrate PDF/XLSX/message extraction and link capture, then create/link/update review. Use real pilot inputs locally and synthetic counterparts publicly. Verify duplicate evidence leaves cash unchanged. |
| 3:30–4:30 | Connect action ranking, scenario impact, drafts, and reminders. Verify import → update → forecast → action on the deployed app. |
| 4:30–5:00 | Run the email + invoice link + PDF duplicate demo and an XLSX PO intake; verify configurable payment rules with a second synthetic business. Freeze features at hour five. |
| 5:00–6:00 | Run acceptance checks together. Resolve money/date/dedup bugs first; polish briefing and chart next. Confirm CSV fallback and resettable demo data. |
| 6:00–6:30 | Rehearse a three-minute demo; capture a backup video; prepare screenshots and rubric mapping. |
| 6:30–7:00 | Verify public preview, submit links/video/materials, and retain time for upload or hosting failures. |

Cut order if behind: extra presets, secondary chart details, richer draft wording, optional OCR, and additional provider URL resolvers; keep link capture with attachment/manual fallback. Cut a nonworking live Zoho adapter after its probe rather than blocking intake. Preserve CSV/PDF/XLSX intake, source-linked messages/URLs, invoice/PO classification, confirmed reconciliation, correct arithmetic, configurable onboarding, and one justified action. Native continuous email/WhatsApp sync remains follow-on work.

## Demo fixture with known arithmetic

Use a fixed demo clock of October 25, 2026 and visibly label this synthetic dataset. These numbers illustrate the workflow; they are not claims about the pilot's actual books.

- Opening cash: $15,000 at the start of October 25. Reserve: $5,000.
- Supplier bill: $20,000 due October 29.
- Customer invoice: $12,000 expected October 30.
- Tentative loan: $40,000 expected October 30.
- Payroll: $18,000 due November 1.

Before any changes, base cash falls to **−$5,000 on October 29**, even though the tentative loan later produces a $29,000 balance after payroll. This is the first risk to show.

Preview negotiating the supplier payment to November 4. If that date is explicitly saved as an agreed scenario, base cash reaches $49,000 after payroll and $29,000 after the bill. Under the stress scenario, the loan is excluded and the customer receipt moves to November 6: payroll produces **−$3,000 on November 1** and the supplier payment produces **−$23,000 on November 4**. The recommendation therefore highlights the funding dependency and proposes confirming the loan before payroll, while preserving the fallback shortfall.

For the live input moment, reset to the baseline and paste the customer message changing October 30 to November 3. Confirm the update, show the changed receipt date, and compare the base and stress scenarios. Never narrate a copied draft or proposed supplier negotiation as a successful external action.

## Acceptance checks and rubric evidence

- **Forecast correctness:** verify fixture balances above, same-day events, opening-cash boundary, overdue obligations, partial payments, insufficient history, recurrence end dates, and tentative-funding exclusion.
- **Safe updates:** identical import is idempotent; a message about an imported invoice updates it once; ambiguous counterparty/date/amount does not mutate the forecast; Zoho refresh preserves owner overrides. The same invoice from CSV/Zoho, an email link, a PDF, and a WhatsApp message becomes one obligation after confirmed matching, with all sources retained.
- **Document intake:** a PDF invoice, XLSX invoice, and XLSX PO produce reviewable candidates with field evidence. A workbook containing multiple invoices is not treated as one invoice. An unreadable/scanned document or inaccessible link requests completion and never becomes a zero-amount record. Conflicting totals remain unresolved until reviewed.
- **Document semantics:** invoice/Pay now URLs never mark invoices paid; outstanding balance is distinct from original total. A PO is planned until confirmed and its invoiced portion cannot contribute twice. A customer payment promise changes timing, not settlement status.
- **General onboarding:** create a second synthetic restaurant with frequent receipts and periodic supplier bills using UI fields; no configuration-file edit. Pilot invoice-based business remains a separate configuration.
- **Action value:** the briefing states a shortfall date, amount, cause, remedy, and last useful action date. Watch items do not flood the main screen. A saved reminder survives refresh.
- **Honest state:** fresh/incomplete/stale data, tentative loans, unresolved updates, conditional remedies, and scenario assumptions remain visible. Copied messages and in-app reminders are labeled correctly.
- **Delivery:** deployed preview works from a clean browser; demo reset restores known data; backup video and submission materials are ready before the final half-hour.

The supplied rubric excerpts emphasize easy onboarding and configurable payment patterns. Demonstrate both explicitly. The transcript also emphasizes actionable inference and simplicity; lead the demo with the briefing. Full rubric weights and any mandatory sponsor integrations remain unknown, so do not claim complete rubric coverage yet.

## Open questions and next action

Confirm the pilot's CSV columns, representative PDF/XLSX invoice and PO layouts, whether PDFs contain selectable text, example invoice URLs, Zoho entities available through the existing connector, opening cash/as-of date, settlement-history coverage, and full rubric. These affect adapter details and demo evidence; the shared architecture can proceed now.

First 30-minute assignment: gather receivables/payables exports, settlement history, opening cash, a representative PDF, an XLSX invoice or PO, and a message containing an invoice URL. Include multiple representations of the same invoice to test reconciliation. Agree expected balances and source-to-record mappings, then assign the five owners above. That is the first integration contract, not a separate discovery phase.

## What the discussion establishes

- “Give me the actions. What do you infer?” makes the briefing and recommendations the primary product surface.
- The owner currently checks WhatsApp and email because those contain promises, delays, and upcoming demands. Those messages are forecast evidence, not just notifications.
- The distinction between agreed terms and actual payment performance belongs in the data model from the beginning.
- “Only show it if it needs attention” calls for scheduled follow-up and an inspectable watchlist, rather than an alert for every message.
- Invoices arrive as payment-service links, PDFs, spreadsheets, and message attachments. Channel, document format, obligation identity, and payment state are separate concepts.

This document is a proposed plan, not a claim that an application, connector, or deployment has been built or tested.
