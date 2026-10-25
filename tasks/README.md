# Five-person task board

Claim one role by adding your name to its GitHub issue. The issue checkboxes track live progress; the committed role documents define scope, handoffs, and acceptance criteria. The [technical implementation plan](../docs/TECHNICAL_PLAN.md) defines the two ingestion layers, transaction/API contracts, and current five-owner handoffs. The primary design is [`docs/design/`](../docs/design/01-overview-and-architecture.md); lane ownership is in [09-api-repo-lanes](../docs/design/09-api-repo-lanes.md#five-people). These checklists came from the earlier [seven-hour plan](../docs/HACKATHON_PLAN.md) and still apply where they match the lanes. Event times in [11-plan-demo-risks](../docs/design/11-plan-demo-risks.md) replace the hour-based milestones below.

| Person | Role | Task list | Tracking issue |
|---|---|---|---|
| 1 | Data and source adapters | [Checklist](01-data-and-source-adapters.md) | [#1](https://github.com/thomashillyer/cashflow/issues/1) |
| 2 | Cash-flow engine | [Checklist](02-cashflow-engine.md) | [#2](https://github.com/thomashillyer/cashflow/issues/2) |
| 3 | Product UI and onboarding | [Checklist](03-product-ui-and-onboarding.md) | [#3](https://github.com/thomashillyer/cashflow/issues/3) |
| 4 | Document understanding and reconciliation | [Checklist](04-document-understanding-and-reconciliation.md) | [#4](https://github.com/thomashillyer/cashflow/issues/4) |
| 5 | Actions, integration, deployment, and demo | [Checklist](05-actions-integration-and-demo.md) | [#5](https://github.com/thomashillyer/cashflow/issues/5) |

## Shared milestones

- [ ] First 30 minutes: agree contracts, fixtures, stack, and owners.
- [ ] Hour 1: synthetic preview deployed.
- [ ] Hour 2: CSV → canonical records → forecast → UI integrated.
- [ ] Hour 3.5: documents/messages/links reach confirmed create/link/update.
- [ ] Hour 5: duplicate-evidence demo, configurable onboarding, and at least one action work; freeze features.
- [ ] Hour 6: acceptance checks complete and essential bugs fixed.
- [ ] Hour 6.5: rehearsal and backup recording complete.
- [ ] Hour 7: submission complete.

Each owner connects their own module and supplies focused checks. Raise contract changes with affected owners before implementation. No real invoices, business messages, credentials, or private accounting exports belong in this public repository.
