# Person 3: Product UI and onboarding

Owner: unassigned. Claim this role in [tracking issue #3](https://github.com/thomashillyer/cashflow/issues/3).

## Outcome

An owner can onboard, supply documents/messages, review proposed changes, and understand what needs attention without interpreting a spreadsheet.

## Owns and hands off

Own onboarding, payment settings, shared intake/review screens, daily briefing, forecast chart, and source-linked event detail. Consume fixtures first from persons 1, 2, 4, and 5, then replace them with real module outputs. Rendering action cards is yours; action eligibility and impact calculations belong to person 5.

## First 30 minutes

- [ ] Agree the owner journey and screen boundaries with the team.
- [ ] Define UI states for import, candidate review, forecast, and actions using the shared payloads.
- [ ] Establish the application shell with person 5 so a synthetic preview is deployed by hour one.

## Build checklist

- [ ] Create onboarding fields for business, currency, timezone, opening available cash/as-of date, reserve, and recurring obligations.
- [ ] Add editable payment patterns for frequent receipts, customer terms, supplier terms, payroll, and explicit exceptions.
- [ ] Build one intake area for CSV/XLSX/PDF uploads, pasted email/WhatsApp text, and invoice URLs.
- [ ] Show extraction progress, source, import counts, rejected rows, and unsupported-input fallback.
- [ ] Render create/link/update previews with invoice/PO type, direction, identities, reference, amount/currency, dates, and field evidence.
- [ ] Show possible existing matches and conflicting values; require explicit confirmation before changes affect cash.
- [ ] Keep original invoice/PDF/payment links visible in record detail without treating them as payment confirmation.
- [ ] Lead the daily briefing with the next risk and at most three actions; show dates, causes, and funding dependencies.
- [ ] Distinguish Act now, Watch, and No action needed based on current data; expose freshness and unresolved assumptions.
- [ ] Add base/stress forecast chart, reserve line, selected-day events, and minimum balance/first shortfall details.
- [ ] Render person 5's action reason, act-by date, scenario impact, copyable draft, and in-app reminder controls.
- [ ] Recalculate chart and briefing after confirmed updates; show suggested/planned/completed states accurately.
- [ ] Implement loading, empty, partial-import, ambiguity, and error states on mobile and desktop.
- [ ] Use bundled synthetic fixtures on the public preview; do not enable private-data intake there.

## Milestones and checks

- [ ] Hour 2: fixture CSV/forecast/briefing works end to end.
- [ ] Hour 3.5: intake preview and confirmed update flow use real module outputs.
- [ ] Hour 5: duplicate-evidence demo and second-business onboarding both work; freeze features.
- [ ] Onboard an invoice-based business and a synthetic restaurant without changing a configuration file.
- [ ] Confirm one date change updates both chart and action briefing.
- [ ] Confirm ambiguous matches do not create events and incomplete data stays visible.
- [ ] During hours 5–6, fix clarity, responsive layout, and core interaction bugs with the team.

## Cut line

Keep the intake/review flow, briefing, editable rules, and readable forecast. Defer extra presets, animations, and secondary chart detail before those core flows.

## Definition of done

A new owner completes the main flow without code changes, can inspect why an action is recommended, and sees the same calculated result in the briefing and chart. See [shared plan](../docs/HACKATHON_PLAN.md).
