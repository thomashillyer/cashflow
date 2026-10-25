// Business profile: everything industry-specific lives here, never in code.
// Source: docs/design/02-business-profile.md.

import type { CommitmentType, Direction } from "./records";

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

export type PaymentPattern = {
  id: string;
  appliesTo: CommitmentType;
  legs: { share: number; anchor: Anchor; offsetDays: number; direction: Direction }[];
  linkedCosts?: string[];
};

export type Anchor = "order" | "ship" | "delivery" | "invoice" | "due" | "month_end" | "weekday";
