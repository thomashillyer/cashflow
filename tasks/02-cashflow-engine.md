# Person 2: Cash-flow engine

Owner: Thomas. Track progress in [tracking issue #2](https://github.com/thomashillyer/cashflow/issues/2).

## Outcome

Correct daily cash balances and explainable shortfall dates for a 30-day base forecast and delayed-inflow scenario.

## Owns and hands off

Own event construction, recurrence, expected payment timing, forecast arithmetic, reserve/negative-cash detection, and scenario recomputation. Supply a pure forecast interface to persons 3 and 5. Consume only canonical records confirmed through persons 1 and 4; do not parse raw documents inside the engine.

## Technical handoff

Follow the [technical plan](../docs/TECHNICAL_PLAN.md) and the current [five-person lanes](../docs/design/09-api-repo-lanes.md#five-people) where this earlier checklist differs. Layer 1 extracts structured candidates; Layer 2 reconciles accepted records and applies profile rules to cash events. Person 3 owns API routes; person 5 coordinates store/integration and owns deterministic warnings/ranking. Person 4 owns AI extraction, proposals, explanations, Ask Neri, and drafts.

## First 30 minutes

- [ ] Agree the business timezone, opening-cash boundary, currency/minor units, and event/scenario contract.
- [ ] Publish the synthetic fixture and hand-calculated expected balances from the shared plan.
- [ ] Give persons 3 and 5 a stable sample forecast response before waiting for real data.

## Build checklist

- [ ] Implement a pure forecast function with explicit as-of date and 30-day horizon.
- [ ] Use integer minor units and business dates; enforce one currency per business.
- [ ] Calculate each closing balance as previous cash plus inflows minus outflows.
- [ ] Exclude settled movements already reflected in opening cash; reduce obligations for partial settlements.
- [ ] Preserve contractual due dates separately from expected receipt dates and confirmed owner overrides.
- [ ] Use confirmed promised dates first; otherwise infer median customer delay only with at least three settled samples, showing sample count.
- [ ] Fall back to stated terms with a visible assumption when settlement history is insufficient.
- [ ] Schedule supplier outflows by agreed dates; do not infer permission to pay late from historical behavior.
- [ ] Expand editable recurring obligations and receipt patterns with explicit start/end dates and calendar-day behavior.
- [ ] Retain unresolved overdue items as warnings/review requirements rather than silently moving them to today.
- [ ] Produce a stress scenario that delays unsettled customer receipts seven calendar days and excludes tentative loans.
- [ ] Keep planned PO contributions scenario-specific; remove invoiced portions when linked invoices replace them.
- [ ] Return first below-reserve date, first negative date, minimum balance/date, daily driving events, assumptions, and freshness warnings.
- [ ] Recompute proposed action scenarios without changing the saved baseline.
- [ ] Flag same-day receipt/payment ordering when intraday liquidity cannot be established.

## Milestones and checks

- [ ] Hour 2: shared CSV fixture forecasts correctly and feeds the UI.
- [ ] Hour 3.5: confirmed payment updates and editable recurrence recalculate the same interface.
- [ ] Verify baseline October 29 is -$5,000 and November 1 is $29,000 for the plan fixture.
- [ ] Verify supplier-rescheduled base balances are $49,000 on November 1 and $29,000 on November 4.
- [ ] Verify that scenario without the tentative loan and with the delayed customer receipt gives -$3,000 on November 1 and -$23,000 on November 4.
- [ ] Check opening-cash boundary, same-day events, partial payment, insufficient history, overdue records, recurrence end dates, and invoice/PO overlap.
- [ ] By hour 5: integrate action impact calculations with person 5 and freeze features.

## Cut line

Defer multi-currency, holiday calendars, statistical confidence intervals, tax modeling, and long-range forecasting. Preserve arithmetic and explicit assumptions.

## Definition of done

The same inputs always produce the same balances; the known fixture checks pass; changed dates and action scenarios recompute correctly; unresolved data cannot produce an unqualified green briefing. See [shared plan](../docs/HACKATHON_PLAN.md).
