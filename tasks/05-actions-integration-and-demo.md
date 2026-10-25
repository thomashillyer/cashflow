# Person 5: Actions, integration, deployment, and demo

Owner: unassigned. Claim this role in [tracking issue #5](https://github.com/thomashillyer/cashflow/issues/5).

## Outcome

The integrated app explains what to do, by when, why it matters, and how the forecast changes, then survives a three-minute demo and submission.

## Owns and hands off

Own deterministic attention/action rules, proposed action impact, follow-up drafts, reminders, shared application integration, deployment, and demo/submission. Coordinate the shared persistence and module boundaries. Every contributor integrates their own module and fixes its checks; this role does not absorb four unfinished implementations.

## Technical handoff

Follow the [technical plan](../docs/TECHNICAL_PLAN.md) and the current [five-person lanes](../docs/design/09-api-repo-lanes.md#five-people) where this earlier checklist differs. Layer 1 extracts structured candidates; Layer 2 reconciles accepted records and applies profile rules to cash events. Person 3 owns API routes; person 5 coordinates store/integration and owns deterministic warnings/ranking. Person 4 owns AI extraction, proposals, explanations, Ask Neri, and drafts.

## First 30 minutes

- [ ] Confirm the team's familiar stack, single application/store, shared contracts, and five owners.
- [ ] Confirm the elapsed seven-hour deadline, required submission materials, and available rubric.
- [ ] Establish synthetic demo/reset data and deployment boundaries; prepare a preview with person 3 by hour one.

## Build checklist

- [ ] Consume person 2's forecast and events through a stable attention/action interface.
- [ ] Implement customer follow-up, supplier date-negotiation, and funding-confirmation candidates.
- [ ] Link each action to underlying evidence, obligation, risk date, shortfall amount, and proposed remedy.
- [ ] Use visible owner-editable lead times: three calendar days for customer follow-up, three for supplier negotiation, two for funding confirmation.
- [ ] Compute act-by date from risk date minus lead time; for suppliers use the earlier of due date and risk date.
- [ ] Show Act now when the useful action date is today/past; use Watch and request timing if no deadline is established.
- [ ] Rank a maximum of three main actions by cash impact, urgency, and remedy confidence.
- [ ] Ask person 2's engine to recompute candidate scenario impact; never let generated text calculate balances.
- [ ] Keep supplier deferrals conditional on agreement and exclude payroll/non-deferrable expenses from routine postponement suggestions.
- [ ] Explain tentative loan dependencies with a forecast excluding the funding.
- [ ] Generate grounded follow-up drafts using supplied facts and matched original invoice/payment links.
- [ ] Implement copy-draft and persisted in-app reminders; distinguish suggested, planned, and completed actions.
- [ ] Deduplicate actions and respect next follow-up dates unless a material change creates a new risk.
- [ ] Wire import → review → canonical record → forecast → briefing/action end to end with all owners.
- [ ] Deploy synthetic-only public preview; keep pilot imports, live connector credentials, and private records local.
- [ ] Provide a resettable synthetic demo and confirm the public UI cannot accept private data or access the pilot connector.

## Milestones and checks

- [ ] Hour 1: deployed synthetic application shell.
- [ ] Hour 2: first fixture import-to-forecast path works.
- [ ] Hour 4.5: document reconciliation, confirmed date change, risk, action, and scenario impact are integrated.
- [ ] Hour 5: freeze features and distribute acceptance-check fixes to the module owners.
- [ ] Verify repeated refresh does not repeat reminders; a missing act-by basis does not yield an invented deadline.
- [ ] Verify copied drafts and proposed negotiations are never presented as messages sent or payments completed.
- [ ] Hours 5–6: run arithmetic, import/reconciliation, onboarding, and end-to-end checks as a team.
- [ ] Hours 6–6.5: rehearse a three-minute demo, capture a backup video, and map evidence to the supplied rubric.
- [ ] Hours 6.5–7: verify preview/video links and submit; retain upload/hosting buffer.

## Cut line

Keep one justified action, correct scenario impact, reminders/drafts, and the end-to-end demo. Defer external message sending, money movement, CRM/accounting write-back, and elaborate generation.

## Definition of done

An owner sees an evidence-based action and deadline, can inspect its calculated impact, and can save a reminder or copy a draft. The synthetic public demo, backup recording, and submission materials are ready before the deadline. See [shared plan](../docs/HACKATHON_PLAN.md).
