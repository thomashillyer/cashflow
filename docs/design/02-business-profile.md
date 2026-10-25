# 02 — Business profile: how Neri adapts

Each business gets one profile file (`profiles/<name>.json`). The owner picks a starter template, Claude proposes edits from the first data import ("payroll looks biweekly, about $14K"), and the owner confirms. The engine, warnings, and UI read only the profile, never a business name.

## Fields

| Field | Controls | Trading (PilotCo) | Restaurant | Agency |
|---|---|---|---|---|
| `paymentPatterns` | How each kind of commitment turns into cash | Supplier 30% at order, 70% before ship; customer advance, balance 60 days after delivery | Food suppliers net-7; card sales settle in 2 days | Monthly retainer; 50/50 milestones; clients net-60 |
| `revenueModel` | Where future inflows come from | Deals and RFQs from CRM or email | Daily sales with weekday pattern, from bank or POS | Retainers plus project milestones |
| `recurring` | Fixed outflows | Payroll biweekly, rent, quarterly tax | Payroll weekly, rent, monthly sales tax | Payroll semi-monthly, software |
| `safetyLine` | Least cash to keep | Owner-set amount | Two weeks of fixed costs | One month of payroll |
| `defaultLagDays` | Payment lag before history exists | 20 | 0 (cards) | 15 |
| `thresholds` | When each warning fires | Idle over $50K for 4+ weeks; one customer over 30% of receivables | Idle over $20K; no concentration check | One client over 40% |
| `signalSources` | Outside-the-books inputs | Email, WhatsApp, CRM | Email | Email |
| `vocabulary` | Words Claude uses with this owner | RFQ, PO, landed cost | Covers, prime cost | SOW, retainer |

Numbers above are starter defaults for illustration; each owner overrides them.

## The core primitive: the payment pattern

Every pattern is a list of legs: a share of the total, an anchor date, an offset, and a direction. Any business's terms can be written this way.

```json
{
  "id": "trading_customer_advance_net60",
  "appliesTo": "sales_deal",
  "legs": [
    { "share": 0.30, "anchor": "order",    "offsetDays": 0,  "direction": "in" },
    { "share": 0.70, "anchor": "delivery", "offsetDays": 60, "direction": "in" }
  ],
  "linkedCosts": ["supplier_deposit_balance", "freight_and_duties"]
}
```

- **Anchors are a fixed set:** `order`, `ship`, `delivery`, `invoice`, `due`, `month_end`, `weekday`. The engine stays generic because it only understands these.
- **`linkedCosts`** lets a sales deal pull in its supplier payments. That is how "can I afford this order?" works for any business that buys before it sells.
- **Lead times** (`leadTimes.transitDays`, `leadTimes.productionDays`) let the engine estimate a missing anchor (for example, delivery = ship + transit).

## Profile schema (sketch)

```ts
type Profile = {
  id: string;                         // "trading"
  displayName: string;
  baseCurrency: string;               // "USD"
  horizonWeeks: number;               // 13
  freeCashLookaheadWeeks: number;     // 6
  defaultLagDays: number;
  lagShrinkageK: number;              // 3
  safetyLine:
    | { kind: "fixed"; amount: number }
    | { kind: "weeksOfFixedCosts"; weeks: number };
  paymentPatterns: PaymentPattern[];
  revenueModel:
    | { kind: "deals" }                                   // deals/RFQs/invoices
    | { kind: "dailySales"; weekdayWeights: number[] }    // restaurants, retail
    | { kind: "retainers" };
  recurring: { name: string; amount: number; cadence: "weekly" | "biweekly" | "semimonthly" | "monthly" | "quarterly"; anchor: string; category: string }[];
  leadTimes?: { transitDays?: number; productionDays?: number };
  thresholds: {
    idleBalanceOver?: { amount: number; minWeeks: number };
    arConcentrationPct?: number;      // omit to disable the check
    signalAutoApplyConfidence: number;
    rankFloor: number;
    relationshipPenalty: Record<string, number>;   // tag -> multiplier, e.g. { "preferred": 0.5 }
  };
  signalSources: ("email" | "whatsapp" | "crm" | "owner")[];
  vocabulary: Record<string, string>;
};

type PaymentPattern = {
  id: string;
  appliesTo: "invoice" | "bill" | "sales_deal" | "purchase_order" | "recurring" | "plan";
  legs: { share: number; anchor: Anchor; offsetDays: number; direction: "in" | "out" }[];
  linkedCosts?: string[];
};

type Anchor = "order" | "ship" | "delivery" | "invoice" | "due" | "month_end" | "weekday";
```

Validation: the shares of a pattern's legs must sum to 1.0.

## Starter templates to ship

- `trading.json` — trading and import (PilotCo's starting point)
- `restaurant.json` — restaurant and retail (daily card sales)
- `agency.json` — services and agency (retainers, milestones)
- `contractor.json` — trades and construction (retainage held until project end)

Only `trading` and `restaurant` need to be fully working on Sunday; the other two are template files.

## Onboarding flow

1. Owner picks a starter template.
2. First import runs; Claude proposes profile edits from detected patterns (recurring payments, typical terms).
3. Owner confirms or edits each proposal.
4. Later owner statements ("Customer A always pays 20 days late") become party-level rules, not profile edits.
