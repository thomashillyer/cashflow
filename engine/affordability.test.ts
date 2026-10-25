import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Commitment, Records } from "../schema/records";
import type { Profile } from "../schema/profile";
import { runAtUpfrontShare, smallestUpfrontShare } from "./affordability";
import { forecast } from "./forecast";

const $ = (n: number) => n * 100;
const src = { system: "test", record: "x" };
const asOf = "2026-11-02";

// A deal with a 20% deposit at order and 80% at delivery; its supplier cost (60% of the deal) is paid in full at order.
const profile: Profile = {
  id: "test",
  displayName: "Test Co",
  baseCurrency: "USD",
  horizonWeeks: 13,
  freeCashLookaheadWeeks: 6,
  defaultLagDays: 0,
  lagShrinkageK: 3,
  safetyLine: { kind: "fixed", amount: $(5000) },
  paymentPatterns: [
    {
      id: "deal_20_80",
      appliesTo: "sales_deal",
      isDefault: true,
      legs: [{ share: 0.2, anchor: "order", offsetDays: 0, direction: "in" }, { share: 0.8, anchor: "delivery", offsetDays: 0, direction: "in" }],
      linkedCosts: [{ patternId: "supplier_at_order", share: 0.6 }],
    },
    { id: "supplier_at_order", appliesTo: "purchase_order", legs: [{ share: 1, anchor: "order", offsetDays: 0, direction: "out" }] },
  ],
  revenueModel: { kind: "deals" },
  recurring: [],
  thresholds: { signalAutoApplyConfidence: 0.85, rankFloor: 0.1, relationshipPenalty: {} },
  signalSources: [],
  vocabulary: {},
};

function com(id: string, o: Partial<Commitment> & Pick<Commitment, "type" | "amount">): Commitment {
  return { id, currency: "USD", anchors: {}, status: "committed", sourceRef: src, ...o };
}

// Opening cash $10,000. Order day: +$10,000 deposit - $30,000 supplier = -$10,000 low point, below the $5,000 line.
// With upfront share X the order-day balance is -$20,000 + $50,000 X, so X >= 0.5 is needed.
function records(opening = $(10000), status: Commitment["status"] = "likely", extra: Commitment[] = []): Records {
  return {
    parties: [],
    commitments: [
      com("deal", { type: "sales_deal", direction: "in", amount: $(50000), anchors: { order: "2026-11-09", delivery: "2026-12-07" }, status, ...(status === "possible" ? { probability: 0.5 } : {}) }),
      ...extra,
    ],
    events: [],
    signals: [],
    rules: [],
    settlements: [],
    balances: [{ id: "bal", account: "main", amount: opening, currency: "USD", asOf, sourceRef: src }],
    evidence: [],
  };
}

describe("smallestUpfrontShare", () => {
  it("grid point X = current share (20%) is exactly the base run", () => {
    const base = forecast(records(), profile, { id: "base", kind: "base", overrides: [] }, asOf, {});
    expect(runAtUpfrontShare(records(), profile, [], "deal", asOf, {}, 0.2)).toEqual(base);
    expect(base.lowPoint.amount).toBe(-$(10000));
  });

  it("share X means the deposit is X of the deal, the rest on the other legs, dates unchanged, cents exact", () => {
    const r = runAtUpfrontShare(records(), profile, [], "deal", asOf, {}, 0.45);
    const legs = r.events.filter((e) => e.commitmentId === "deal").map((e) => [e.legIndex, e.date, e.amount]);
    expect(legs).toEqual([
      [0, "2026-11-09", $(22500)],
      [1, "2026-12-07", $(27500)],
    ]);
  });

  it("returns the smallest 5% grid share that keeps the low point at or above the safety line", () => {
    const r = smallestUpfrontShare(records(), profile, [], "deal", asOf, {});
    expect(r).toMatchObject({ kind: "ok", share: 0.5, lowPoint: $(5000), currentShare: 0.2, upfrontLegs: [0] });
    if (r.kind !== "ok") return;
    expect(r.run.lowPoint.amount).toBeGreaterThanOrEqual(r.run.safetyLine);
    // One step lower fails: 45% leaves $2,500 at the low point.
    expect(runAtUpfrontShare(records(), profile, [], "deal", asOf, {}, 0.45).lowPoint.amount).toBe($(2500));
  });

  it("low point is non-decreasing in share across the grid (binary search is safe)", () => {
    const lows = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.75, 1].map((share) => runAtUpfrontShare(records(), profile, [], "deal", asOf, {}, share).lowPoint.amount);
    for (let i = 1; i < lows.length; i++) expect(lows[i]!).toBeGreaterThanOrEqual(lows[i - 1]!);
  });

  it("honors a custom step", () => {
    const r = smallestUpfrontShare(records(), profile, [], "deal", asOf, {}, { step: 0.01 });
    expect(r).toMatchObject({ kind: "ok", share: 0.5, lowPoint: $(5000) });
  });

  it("already_ok when the current terms keep cash above the line", () => {
    const r = smallestUpfrontShare(records($(40000)), profile, [], "deal", asOf, {});
    expect(r).toMatchObject({ kind: "already_ok", share: 0.2, lowPoint: $(20000) });
  });

  it("not_deal_driven when cash is below the line even without the deal", () => {
    const bill = com("bill", { type: "bill", amount: $(70000), anchors: { due: "2026-11-04" } });
    const r = smallestUpfrontShare(records($(10000), "likely", [bill]), profile, [], "deal", asOf, {});
    expect(r).toMatchObject({ kind: "not_deal_driven", lowPointWithoutDeal: -$(60000) });
    // The without-deal run drops the deal's virtual linked supplier cost too.
    expect(r.run.events.some((e) => e.commitmentId?.startsWith("deal"))).toBe(false);
  });

  it("not_achievable when even 100% upfront leaves cash below the line", () => {
    // Supplier cost 120% of the deal: at 100% upfront the order day is $10,000 + $50,000 - $60,000 = $0.
    const costly: Profile = { ...profile, paymentPatterns: profile.paymentPatterns.map((p) => (p.id === "deal_20_80" ? { ...p, linkedCosts: [{ patternId: "supplier_at_order", share: 1.2 }] } : p)) };
    const r = smallestUpfrontShare(records(), costly, [], "deal", asOf, {});
    expect(r).toMatchObject({ kind: "not_achievable", bestShare: 1, lowPoint: 0 });
  });

  it("with no deposit leg, the earliest receipt is the upfront leg and the result says so", () => {
    const noDeposit: Profile = {
      ...profile,
      paymentPatterns: profile.paymentPatterns.map((p) =>
        p.id === "deal_20_80" ? { ...p, legs: [{ share: 0.5, anchor: "delivery" as const, offsetDays: -28, direction: "in" as const }, { share: 0.5, anchor: "delivery" as const, offsetDays: 0, direction: "in" as const }] } : p,
      ),
    };
    // Opening $5,000; Nov 9: +$50,000 X - $30,000 >= $0 needs X >= 0.6.
    const r = smallestUpfrontShare(records($(5000)), noDeposit, [], "deal", asOf, {});
    expect(r).toMatchObject({ kind: "ok", share: 0.6, currentShare: 0.5, upfrontLegs: [0], lowPoint: $(5000) });
    expect(r.note).toMatch(/earliest receipt/);
  });

  it("evaluates a possible deal as if taken, without mutating the caller's records", () => {
    const recs = records($(10000), "possible");
    const before = JSON.stringify(recs);
    const r = smallestUpfrontShare(recs, profile, [], "deal", asOf, {});
    expect(r).toMatchObject({ kind: "ok", share: 0.5, lowPoint: $(5000) });
    expect(JSON.stringify(recs)).toBe(before);
    // Same answer twice: pure and deterministic.
    expect(smallestUpfrontShare(recs, profile, [], "deal", asOf, {})).toEqual(r);
  });

  it("throws on an unknown deal", () => {
    expect(() => smallestUpfrontShare(records(), profile, [], "nope", asOf, {})).toThrow(/no commitment/);
  });
});

describe("smallestUpfrontShare on fixtures/cascade_trade", () => {
  const root = join(import.meta.dirname, "..");
  const read = <T>(p: string): T => JSON.parse(readFileSync(join(root, p), "utf8")) as T;
  const meta = read<{ profile: string; asOf: string; fxRates: Record<string, number> }>("fixtures/cascade_trade/fixture.json");
  const recs = read<Records>("fixtures/cascade_trade/records.json");
  const prof = read<Profile>(meta.profile);

  it("rfq-harbor-spring (possible RFQ-77)", () => {
    const r = smallestUpfrontShare(recs, prof, [], "rfq-harbor-spring", meta.asOf, meta.fxRates);
    const { run, ...rest } = r;
    expect({ ...rest, safety: run.safetyLine }).toMatchInlineSnapshot(`
      {
        "currentShare": 0.3,
        "kind": "not_deal_driven",
        "lowPointWithoutDeal": -550000,
        "safety": 3500000,
        "upfrontLegs": [
          0,
        ],
      }
    `);
  });
});
