# 05 — Forecast engine

One pure function, deterministic and fast enough to rerun on every click:

```ts
forecast(records: Records, profile: Profile, scenario: Scenario, asOf: string, fxRates: Record<string, number>): ForecastRun
```

It knows nothing about any industry beyond what the profile says. No I/O, no clock (use `asOf`), no randomness. Fixed FX rates are explicit inputs captured at the API boundary and saved with the run; the pure engine never fetches them.

## Steps in each run

1. **Expand commitments into events** using each one's payment pattern (`02-business-profile.md`). A missing anchor date is estimated from profile lead times (for example, delivery = ship + transit days). Linked commitments (a deal's supplier POs, freight, duties) expand too.
2. **Date each receivable by how that party really pays:** due date plus the learned lag (below). Payables stay on their due dates unless a confirmed `flexibility` rule says the supplier will flex.
3. **Add recurring outflows** from the profile and from confirmed recurring commitments detected in the bank file.
4. **Apply confirmed rules, then applied signals, then scenario overrides**, in that order, so a what-if always wins. Record every applied id in `event.overriddenBy`.
5. **Bucket into weeks** (Monday to Sunday, `profile.horizonWeeks`, 13 by default), starting from today's bank balance. Keep daily detail underneath for drill-down.
6. **Compute outputs:** weekly closing balance, the low point and its week, weeks below the safety line, free cash and how long it stays free, and a separate pipeline band for `possible` deals.

## Output

```ts
type ForecastRun = {
  id: string;
  asOf: string;
  inputsHash: string;          // hash of records + profile + overrides, for caching
  fxRates: Record<string, number>;
  openingBalance: number;
  safetyLine: number;
  scenarioId: string;
  firstBelowSafety?: string;   // date
  firstNegative?: string;      // date
  warnings: string[];          // data-quality: stale source, unresolved reviews, missing facts
  review?: { needed: boolean; reasons: { code: string; message: string; refs: string[] }[] };  // structured needs-review flag
  days: { date: string; closing: number; eventIds: string[] }[];  // daily drill-down
  weeks: {
    start: string;             // Monday
    inflow: number; outflow: number; closing: number;
    pipelineClosing: number;   // closing + probability-weighted possible deals
    eventIds: string[];
  }[];
  lowPoint: { week: string; date?: string; amount: number };
  weeksBelowSafety: string[];
  freeCash: { week: string; amount: number; weeksFree: number }[];
  events: CashEvent[];         // fully dated, with basis and overriddenBy
};
```

Daily balances determine the low point, first-negative date, safety warnings, and free-cash windows; weekly closes are summaries and cannot hide an intervening daily deficit. The low point keeps its week and may include its exact date. See the [technical plan](../TECHNICAL_PLAN.md) for snapshot/settlement boundaries and partial-week horizon behavior.

## Scenarios

- **base:** confirmed rules, applied signals, and the owner's saved overrides.
- **stress:** base, then every unsettled customer receipt moves 7 calendar days later and every `likely` funding (loans, owner plans marked as funding) is excluded. Planned outflows stay put. It's a sensitivity check, not a confidence interval.
- **what-if:** base plus the levers from `simulate()`. Never saved over the base.

## Honesty rules (carried over)

- The opening balance comes from the latest `BalanceSnapshot`; settled events already in it are not counted again.
- Overdue receivables with no promise are not quietly moved to today. They keep their date, get a `basis` that says so, and raise a review item.
- Payables stay on their contractual dates; past late payment is not permission to pay late.
- If a receipt and a large outflow land on the same day and the order matters, flag that intraday ordering is unknown.
- No data, stale data, or unresolved material reviews can never produce an all-clear brief. Say what is missing.
  The engine sets `ForecastRun.review` (`needed` plus coded reasons with record refs) for every warning that means data is missing or unresolved, so consumers check `review.needed` instead of parsing `warnings`. Informational notes (lever no-ops, short horizon) do not set it.
- Report both "below safety line" and "below zero"; a positive month-end can hide a mid-month payroll gap.

## Payment-lag model

Each party's lag is its median days late, pulled toward the profile default when there is little history, so one odd payment doesn't swing the forecast:

```
lag_p = (n_p × median_p + k × defaultLagDays) / (n_p + k),   k = profile.lagShrinkageK (3)
```

- `n_p` = number of past paid invoices for the party; `median_p` = median of (paid − due) in days, negative allowed.
- Use the last 12 payments at most, so behavior changes show up.
- A confirmed `lag_offset` rule replaces the model for that party.
- **Confidence:** start at `n / (n + k)`, reduce by spread: `confidence = n/(n+k) × 1/(1 + iqrDays/14)`. Shown to the owner as "based on Customer A's last 8 payments."
- `event.basis` example: `"due 2026-12-02 + 22 days (median of last 8 payments)"`.

## Free cash

Money is only "free" if it stays above the safety line through upcoming outflows, not just this week.

```
free(w)  = min(daily closing balances in weeks w … w+H) − safetyLine,   H = profile.freeCashLookaheadWeeks (6)
weeksFree = consecutive weeks from w where free > 0
```

## Safety line

From the profile: a fixed amount, or N weeks of average fixed costs (recurring outflows over the horizon).

## Deals

- `likely` (won, not yet invoiced): in the main line in full, including linked supplier costs.
- `possible` (quoted RFQ): never in the main line; contributes `probability × amount` to `pipelineClosing` only.

## Currency

Each run converts at one fixed rate per currency, stored on the run. Foreign-currency exposure is reported (total outflow by currency over the horizon), not modeled.

## Simulation

```ts
simulate(records, profile, baseOverrides, levers: Lever[], asOf, fxRates): {
  run: ForecastRun;
  lowPointDelta: number;     // new low point − base low point
  freeCashDelta: number;
}
```

Applies levers as extra overrides and reruns. Every recommendation's dollar effect comes from this, never from Claude.

## Search helper: smallest upfront share

For `deal_affordability`: binary-search the advance share in [current, 1.0] in 5% steps with `simulate` until `lowPoint ≥ safetyLine`. Return the smallest share that works, or "not achievable with terms alone."

## Performance target

Full run on 13 weeks and a few thousand events in under 50 ms, so the UI can rerun on every slider move without a spinner.
