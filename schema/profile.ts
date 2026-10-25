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
    | { kind: "dailySales"; weekdayWeights: number[] }    // restaurants, retail
    | { kind: "retainers" };
  recurring: {
    id: string;                       // stable; becomes the commitment id so overrides can target it
    name: string;
    amount: number;
    direction?: Direction;            // default "out"
    cadence: "weekly" | "biweekly" | "semimonthly" | "monthly" | "quarterly";
    anchor: string;                   // first occurrence, YYYY-MM-DD
    secondDay?: number;               // semimonthly: second day of month (first comes from anchor)
    endDate?: string;
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
    stressDelayDays?: number;         // stress scenario: delay unsettled receipts by this many days (default 7)
  };
  actionLeadDays?: Partial<Record<Lever["kind"], number>>;  // e.g. { chase: 3, defer: 3 }
  signalSources: ("email" | "whatsapp" | "crm" | "owner")[];
  vocabulary: Record<string, string>;
};

export type PaymentPattern = {
  id: string;
  appliesTo: CommitmentType;
  legs: { share: number; anchor: Anchor; offsetDays: number; direction: Direction; weekday?: number }[];  // weekday: 0=Mon..6=Sun, for anchor "weekday"
  linkedCosts?: { patternId: string; share: number }[];  // share of the deal amount, e.g. supplier cost 0.6
  isDefault?: boolean;                // default for its appliesTo when a commitment has no patternId
};

export type Anchor = "order" | "ship" | "delivery" | "invoice" | "due" | "month_end" | "weekday";
