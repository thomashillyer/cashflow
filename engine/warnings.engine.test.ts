// Warnings and ranking against the real engine (forecast, simulate, affordability), not the stand-in in
// warnings.test.ts: per-leg levers, deal_affordability, and dollar effects that match the drafted text.

import { describe, expect, it } from "vitest";
import type { Profile } from "../schema/profile";
import type { Commitment, Records } from "../schema/records";
import { buildBrief } from "./brief";

const $ = (n: number) => n * 100;
const src = { system: "test", record: "x" };
const asOf = "2026-11-02";

const profile: Profile = {
  id: "test", displayName: "Test Co", baseCurrency: "USD", horizonWeeks: 13, freeCashLookaheadWeeks: 6,
  defaultLagDays: 0, lagShrinkageK: 3, safetyLine: { kind: "fixed", amount: $(5000) },
  paymentPatterns: [
    { id: "deal_20_80", appliesTo: "sales_deal", isDefault: true,
      legs: [{ share: 0.2, anchor: "order", offsetDays: 0, direction: "in" }, { share: 0.8, anchor: "delivery", offsetDays: 0, direction: "in" }],
      linkedCosts: [{ patternId: "supplier_at_order", share: 0.6 }] },
    { id: "supplier_at_order", appliesTo: "purchase_order", legs: [{ share: 1, anchor: "order", offsetDays: 0, direction: "out" }] },
    { id: "supplier_30_70", appliesTo: "purchase_order", isDefault: true,
      legs: [{ share: 0.3, anchor: "order", offsetDays: 0, direction: "out" }, { share: 0.7, anchor: "ship", offsetDays: 0, direction: "out" }] },
  ],
  revenueModel: { kind: "deals" },
  recurring: [],
  thresholds: { signalAutoApplyConfidence: 0.85, rankFloor: 0.1, relationshipPenalty: {} },
  signalSources: [],
  vocabulary: {},
};

function com(id: string, o: Partial<Commitment> & Pick<Commitment, "type" | "amount">): Commitment {
  return { id, currency: "USD", anchors: {}, status: "committed", sourceRef: src, reference: id.toUpperCase(), ...o };
}

function records(opening: number, commitments: Commitment[]): Records {
  return { parties: [], commitments, events: [], signals: [], rules: [], settlements: [], evidence: [],
    balances: [{ id: "bal", account: "main", amount: opening, currency: "USD", asOf, sourceRef: src }] };
}

describe("per-leg defer on a two-leg purchase order", () => {
  // Opening $10,000. PO $20,000 at 30/70: -$6,000 Nov 5 (gap starts), -$14,000 Nov 12 (low -$10,000).
  // A $20,000 receipt lands Nov 18.
  const input = {
    records: records($(10000), [
      com("po-1", { type: "purchase_order", direction: "out", amount: $(20000), anchors: { order: "2026-11-05", ship: "2026-11-12" } }),
      com("inv-1", { type: "invoice", amount: $(20000), anchors: { due: "2026-11-18" } }),
    ]),
    profile, asOf, fxRates: {},
  };
  const { run, brief } = buildBrief(input);

  it("finds the gap", () => {
    expect(run.firstBelowSafety).toBe("2026-11-05");
    expect(run.lowPoint).toMatchObject({ date: "2026-11-12", amount: -$(10000) });
  });

  it("offers one lever per leg and keeps only the leg that helps, valued by the real simulate()", () => {
    // Deferring the 70% leg to Nov 22 lifts the low point to $4,000 (+$14,000). Deferring the 30% leg
    // alone still leaves -$10,000 on Nov 15, so it is dropped.
    const defers = brief.all.filter((w) => w.lever?.kind === "defer");
    expect(defers).toHaveLength(1);
    expect(defers[0]).toMatchObject({
      id: "wi-projected_cash_gap-defer-po-1-1",
      lever: { kind: "defer", commitmentId: "po-1", days: 10, legIndex: 1 },
      cashEffect: $(14000),
    });
    expect(defers[0]!.why).toBe("If it can wait, your low point rises by $14,000.");
  });
});

describe("deal_affordability", () => {
  // From engine/affordability.test.ts: opening $10,000; a $50,000 deal at 20/80 with 60% supplier cost at order
  // takes the order day to -$10,000. Upfront share X gives -$20,000 + $50,000 X, so 50% is needed.
  const deal = (o: Partial<Commitment> = {}) =>
    com("deal", { type: "sales_deal", direction: "in", amount: $(50000), status: "likely",
      anchors: { order: "2026-11-09", delivery: "2026-12-07" }, ...o });

  it("asks for the smallest upfront share that keeps cash above the line", () => {
    const { run, brief } = buildBrief({ records: records($(10000), [deal()]), profile, asOf, fxRates: {} });
    const item = brief.all.find((w) => w.warning === "deal_affordability")!;
    expect(item).toMatchObject({
      lever: { kind: "ask_advance", commitmentId: "deal", share: 0.5 },
      cashEffect: $(15000),           // low point -$10,000 at 20% -> $5,000 at 50%
      neededBy: "2026-11-09",
    });
    // A likely deal's confidence is the engine's, from its own legs.
    const legs = run.events.filter((e) => e.commitmentId === "deal");
    expect(item.confidence).toBe(Math.min(...legs.map((e) => e.confidence)));
    expect(item.title).toBe("Ask the customer for 50% upfront on DEAL");
    expect(item.why).toBe("At 20% upfront this order takes cash below your safety line; 50% keeps it above and raises your low point by $15,000.");
    expect(brief.today.map((w) => w.id)).toContain("wi-deal_affordability-ask_advance-deal");
  });

  it("weighs a possible deal by its probability", () => {
    const { brief } = buildBrief({ records: records($(10000), [deal({ status: "possible", probability: 0.5 })]),
      profile, asOf, fxRates: {} });
    expect(brief.all.find((w) => w.warning === "deal_affordability")).toMatchObject({ confidence: 0.5, cashEffect: $(15000) });
  });

  it("explains, without a lever, when even 100% upfront is not enough", () => {
    const costly: Profile = { ...profile, paymentPatterns: profile.paymentPatterns.map((p) =>
      p.id === "deal_20_80" ? { ...p, linkedCosts: [{ patternId: "supplier_at_order", share: 1.2 }] } : p) };
    const { brief } = buildBrief({ records: records($(10000), [deal()]), profile: costly, asOf, fxRates: {} });
    const item = brief.all.find((w) => w.warning === "deal_affordability")!;
    expect(item.lever).toBeUndefined();
    expect(item.title).toBe("DEAL would take cash below your safety line");
    expect(brief.today).not.toContainEqual(expect.objectContaining({ warning: "deal_affordability" }));
  });

  it("stays quiet when cash is short without the deal (the cash-gap warning owns it)", () => {
    const { brief } = buildBrief({ records: records($(1000), [deal()]), profile, asOf, fxRates: {} });
    expect(brief.all.some((w) => w.warning === "deal_affordability")).toBe(false);
  });
});
