# Cashflow (Neri Cash)

An action-first cash-flow copilot for small businesses: **what needs attention, by when, and why?** It reads the books, bank, and outside signals (email, WhatsApp, owner notes), projects cash 13 weeks ahead with daily detail, and shows the owner "three things to do today," each with its dollar effect and a drafted action.

This repository contains the design and contributor checklists. The application is not implemented yet.

## Start here

1. Read [`CLAUDE.md`](CLAUDE.md) for the rules and conventions, then the [design](docs/design/01-overview-and-architecture.md) and [technical implementation plan](docs/TECHNICAL_PLAN.md).
2. Claim a role in the [task board](tasks/README.md); lane ownership is in [09-api-repo-lanes](docs/design/09-api-repo-lanes.md#five-people).
3. Freeze [`schema/records.ts`](docs/design/03-data-model.md) at 11:00 and commit fixture records so every lane builds against the same data.
4. Integrate at 1:00, freeze features at 3:00, submit by 5:30 ([timeline](docs/design/11-plan-demo-risks.md)).

## Five roles

| Person | Lane | Task list |
|---|---|---|
| 1 | Data and adapters: Zoho/CSV, bank, XLSX, email/WhatsApp paste, invoice links, evidence storage | [Tasks](tasks/01-data-and-source-adapters.md) |
| 2 | Engine: expand, payment lag, forecast, simulate, golden tests | [Tasks](tasks/02-cashflow-engine.md) |
| 3 | App: home screen, forecast chart, Review, onboarding/profile editor | [Tasks](tasks/03-product-ui-and-onboarding.md) |
| 4 | AI: signal/document extraction, reconciliation proposals, brief text, Ask Neri, drafts | [Tasks](tasks/04-document-understanding-and-reconciliation.md) |
| 5 | Warnings and ranking, integration, deployment, demo, submission | [Tasks](tasks/05-actions-integration-and-demo.md) |

## Principles

- **Generic core, specific profile.** Business-specific terms, thresholds, and vocabulary live in `profiles/`, never in code.
- **Code computes, Claude judges.** All money math is deterministic TypeScript; Claude extracts, explains, and drafts, and every figure it states comes from a tool result.
- **Count one invoice once,** even when it arrives as an export row, a PDF, an email link, and a WhatsApp reminder.
- **Suggest, then wait.** The owner confirms every change. Nothing sends a message, pays a bill, or moves money.
- **Honest state.** Tentative funding, stale or incomplete data, and unresolved reviews stay visible; no all-clear without the data to back it.

## Setup for contributors

Run Claude Code on the hackathon API credits without touching your normal login: `bash scripts/setup-claude-hack.sh` (macOS/Linux) or `scripts/setup-claude-hack.ps1` (Windows), then `claude-hack` in this folder.

Public demos and committed fixtures must be synthetic. Real exports live in `data/private/` (gitignored); secrets go in `.env` only.

The earlier [seven-hour plan](docs/HACKATHON_PLAN.md) is superseded by `docs/design/`, but keeps the duplicate-evidence demo story and its daily fixture arithmetic.
