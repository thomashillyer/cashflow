# Cashflow

An action-first cash-flow assistant for small businesses: **what needs attention, by when, and why?**

This repository currently contains the hackathon execution plan and five contributor checklists. The application is not implemented yet.

## Start here

1. Read the [seven-hour plan](docs/HACKATHON_PLAN.md).
2. Claim one of the [five roles](tasks/README.md).
3. Agree the source-evidence → document-candidate → canonical-record → cash-event → forecast/action contracts during the first 30 minutes.
4. Build against shared synthetic fixtures immediately, integrate by hour two, and freeze features at hour five.

## Five roles

| Person | Responsibility | Task list |
|---|---|---|
| 1 | Data adapters: CSV, XLSX, Zoho, invoice links | [Tasks](tasks/01-data-and-source-adapters.md) |
| 2 | Cash events, payment timing, deterministic forecasts | [Tasks](tasks/02-cashflow-engine.md) |
| 3 | Onboarding, document intake/review, briefing, chart | [Tasks](tasks/03-product-ui-and-onboarding.md) |
| 4 | PDF/message understanding, invoice/PO classification, reconciliation | [Tasks](tasks/04-document-understanding-and-reconciliation.md) |
| 5 | Recommendations, action impact, integration, deployment, submission | [Tasks](tasks/05-actions-integration-and-demo.md) |

## MVP workflow

CSV/Zoho records, PDF/XLSX invoices and POs, invoice links, and email/WhatsApp text or attachments enter a shared intake pipeline. Extract and review fields, reconcile multiple representations of the same obligation, confirm changes, then recompute daily cash and recommend an action.

- Count one invoice once even when it appears in a provider record, PDF, and message.
- Preserve contractual terms, expected payment dates, original totals, and outstanding balances separately.
- A Pay now link is not payment confirmation. A PO needs its own commitment state and invoice linkage.
- Use code for cash calculations and action impact; use AI for proposed extraction and grounded explanations.
- Show tentative funding, incomplete data, and source evidence with the briefing.
- Keep configurable payment rules in the UI so a second business can onboard without code changes.

## Seven-hour delivery

First 30 minutes: contracts and fixtures. By hour two: integrated forecast. By hour 3.5: document review and updates. By hour five: full demo and feature freeze. Final two hours: verify, rehearse, record backup, and submit.

Public demos and committed fixtures must be synthetic. Keep pilot financial records, message exports, attachments, and connector credentials outside version control. Native continuous email/WhatsApp sync, external sending, money movement, and accounting write-back are follow-on work.

A contributor-provided `CLAUDE.md` can be added later for coding conventions and agent guidance.
