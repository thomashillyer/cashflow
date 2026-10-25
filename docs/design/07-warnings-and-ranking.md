# 07 — Warnings and ranking

Warnings are named, plain-code checks over a `ForecastRun`. Each one generates candidate levers, each lever is re-simulated for its real dollar effect, and the ranked results become `WorkItem`s. Thresholds come from the profile, so the same checks serve any business.

## Warnings

| Warning | Fires when | Levers it generates |
|---|---|---|
| `projected_cash_gap(amount, horizon)` | A daily closing balance falls below the safety line within the horizon (weekly view shows its containing week) | Chase receivables due before the gap; defer payables a supplier will flex on; split or delay a purchase order; optional financing partner card |
| `idle_balance_over(threshold, weeks)` | Free cash stays above the threshold for at least that many weeks | Explain how much and for how long, with general options; optional treasury partner card |
| `ar_concentration_risk(pct)` | One party holds more than pct of open receivables | Ask for a deposit or tighter terms on the next order |
| `deal_affordability(deal)` | Taking a likely or possible deal pushes the low point below the safety line | The smallest upfront share that keeps cash above the line (search helper in `05-forecast-engine.md`), e.g. "ask for 40% instead of 30%" |
| `early_pay_discount(bill)` | A bill offers an early-payment discount and free cash covers it through the discount date | Pay early and keep the discount |
| `payment_slip(signal)` | An applied signal moved a receivable later | Re-rank everything; raise a change alert |

Each warning is a function:

```ts
type Check = (run: ForecastRun, records: Records, profile: Profile) => Candidate[];
type Candidate = { warning: string; lever?: Lever; evidenceRefs: string[]; neededBy: string };
```

Checks are registered in one list; a profile can disable a check by omitting its threshold.

## Lever generation details

- **Chase:** open receivables from parties whose expected date falls after the gap week, assume paid by their due date (or a date the owner can reach), sorted by amount × confidence.
- **Defer:** payables with a confirmed `flexibility` rule, or with no tag that carries a relationship penalty, moved by the rule's `extraDays` (default 10).
- **Split or delay a PO:** purchase orders not yet placed, with legs before the gap week.
- Every candidate is run through `simulate()`; `value` is its `lowPointDelta` (or dollars saved for discounts). Candidates with value ≤ 0 are dropped.

## Ranking

```
score = value × 1 / (1 + d / 7) × confidence × relationship
```

- `value` — rise in the low point, or dollars saved.
- `d` — days from today until the lever stops helping (`neededBy`), clamped to zero for today or past deadlines.
- `confidence` — of the underlying events.
- `relationship` — 1, or the profile's penalty for the party's tags (for example, 0.5 for deferring a party tagged `preferred`).

The top three above `profile.thresholds.rankFloor` become "three things to do today." If only one clears the floor, the list shows one; never pad to three. The rest form the full money list behind it.

## Partner cards

A warning may carry `partnerAction` (sample only on Sunday). Rules from the product brief:

- Whether to borrow, delay, or spend is never influenced by who pays Neri.
- Paying gets a partner onto the list, never higher on it.
- The card says, in plain words, that partners pay a referral fee and Neri is paid the same whichever is picked.
- Idle-cash views explain amount and duration plus general options only. Never "put $200K in T-bills."
