// Business profile: everything industry-specific lives here, never in code.
// Source: docs/design/02-business-profile.md.

import type { CommitmentType, Direction, Lever } from "./records";

export type Profile = {
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
    | { kind: "dailySales"; weekdayWeights: number[]; settleLagDays?: number }  // restaurants, retail; settleLagDays: card sales land N days after the sale (default 0)
    | { kind: "retainers" };
  recurring: {
    id: string;                       // stable; becomes the commitment id so overrides can target it
    name: string;
    amount: number;
    direction?: Direction;            // default "out"
    cadence: "weekly" | "biweekly" | "semimonthly" | "monthly" | "quarterly";
    anchor: string;                   // phase, YYYY-MM-DD: any one occurrence; the engine projects backward and forward from it
    secondDay?: number;               // semimonthly: second day of month (first comes from anchor)
    startDate?: string;               // first possible occurrence (inclusive); omit when the item is already running
    endDate?: string;                 // last possible occurrence (inclusive)
    category: string;
    nonDeferrable?: true;             // payroll, taxes: never offered as a defer lever
  }[];
  leadTimes?: { transitDays?: number; productionDays?: number };
  thresholds: {
    idleBalanceOver?: { amount: number; minWeeks: number };
    arConcentrationPct?: number;      // omit to disable the check
    signalAutoApplyConfidence: number;
    rankFloor: number;
    relationshipPenalty: Record<string, number>;   // tag -> multiplier, e.g. { "preferred": 0.5 }
    staleAfterHours?: number;         // source freshness warning
    conviction?: {                    // Ask Neri conviction cutoffs; omit for defaults documented in 08-claude-layer.md
      highMinLagSamples?: number;     // payment-history samples needed for high conviction on a timing call
      mediumMinLagSamples?: number;
      maxPendingReviewsForHigh?: number;
    };
    stressDelayDays?: number;         // stress scenario: delay unsettled receipts by this many days (default 7)
    splitIntervalDays?: number;       // split lever: days between installments (default 30)
  };
  actionLeadDays?: Partial<Record<Lever["kind"], number>>;  // e.g. { chase: 3, defer: 3 }
  signalSources: ("email" | "whatsapp" | "crm" | "owner")[];
  vocabulary: Record<string, string>;
  engine?: EngineTunables;            // forecast-engine tunables; omit any field for its default (engine/settings.ts)
};

// Engine tunables that depend on the business. Every field is optional; defaults live in engine/settings.ts
// (ENGINE_DEFAULTS) and reproduce the engine's behavior before these fields existed.
export type EngineTunables = {
  statusConfidence?: { committed?: number; likely?: number; possible?: number };  // event confidence by status (0..1); "actual" is always 1; a commitment's own probability wins for possible
  dailySalesConfidence?: number;      // confidence of each forecast daily-sales event (dailySales revenue model)
  salesHistoryDays?: number;          // daily-sales average: days of actual sales receipts before asOf
  lag?: {
    maxSamples?: number;              // most recent paid receivables per party used by the lag model
    noHistoryConfidence?: number;     // lag confidence when a party has no payment history (profile defaultLagDays used)
    iqrScaleDays?: number;            // lag confidence = n/(n+k) * 1/(1 + IQR/iqrScaleDays): spread (days) that halves confidence
    laggedAnchors?: Anchor[];         // inflow legs on these anchors wait for the customer, so the party's lag applies
    laggedTypes?: CommitmentType[];   // commitment types whose inflow legs get the party's lag
  };
  settlementMatchDays?: number;       // a books Settlement and a bank line this many days apart (same amount) are one payment
  staleFallbackDays?: number;         // balance age (days) that needs review when thresholds.staleAfterHours is unset
  noSnapshotLookbackDays?: number;    // with no balance snapshot, actuals this far before asOf are reported as left out
  deferDays?: number;                 // defer lever: days to push a payable with no confirmed flexibility rule
  affordabilityStep?: number;         // deal affordability: grid step of the upfront-share search, in (0, 1]
  urgencyScaleDays?: number;          // ranking: score = value / (1 + daysUntilNeeded / urgencyScaleDays) * confidence * relationship
};

export type PaymentPattern = {
  id: string;
  appliesTo: CommitmentType;
  legs: { share: number; anchor: Anchor; offsetDays: number; direction: Direction; weekday?: number }[];  // weekday: 0=Mon..6=Sun, for anchor "weekday"
  linkedCosts?: { patternId: string; share: number }[];  // share of the deal amount, e.g. supplier cost 0.6
  isDefault?: boolean;                // default for its appliesTo when a commitment has no patternId
};

export type Anchor = "order" | "ship" | "delivery" | "invoice" | "due" | "month_end" | "weekday";
