import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Commitment, Records } from "../schema/records";
import type { Profile } from "../schema/profile";
import { currentUpfrontShare, smallestUpfrontShare } from "./affordability";
import { simulate } from "./simulate";

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
// With share s advanced to asOf, the order-day balance is -$10,000 + $40,000 s, so s >= 0.375 is needed.
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
  it("reads the current deposit share from the deal's pattern", () => {
    expect(currentUpfrontShare(records().commitments[0]!, profile)).toBe(0.2);
  });

  it("returns the smallest 5% grid share that keeps the low point at or above the safety line", () => {
    const r = smallestUpfrontShare(records(), profile, [], "deal", asOf, {});
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.share).toBe(0.4);
    expect(r.lowPoint).toBe($(6000));
    expect(r.run.lowPoint.amount).toBeGreaterThanOrEqual(r.run.safetyLine);
    // One step lower fails: 35% leaves $4,000 at the low point.
    const lower = simulate(records(), profile, [], [{ kind: "ask_advance", commitmentId: "deal", share: 0.35 }], asOf, {}).run;
    expect(lower.lowPoint.amount).toBe($(4000));
  });

  it("low point is non-decreasing in share across the grid (binary search is safe)", () => {
    const lows = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.75, 1].map(
      (share) => simulate(records(), profile, [], [{ kind: "ask_advance", commitmentId: "deal", share }], asOf, {}).run.lowPoint.amount,
    );
    for (let i = 1; i < lows.length; i++) expect(lows[i]!).toBeGreaterThanOrEqual(lows[i - 1]!);
  });

  it("honors a custom step", () => {
    const r = smallestUpfrontShare(records(), profile, [], "deal", asOf, {}, { step: 0.01 });
    expect(r).toMatchObject({ kind: "ok", share: 0.38, lowPoint: $(5200) });
  });

  it("already_ok when the current terms keep cash above the line", () => {
    const r = smallestUpfrontShare(records($(40000)), profile, [], "deal", asOf, {});
    expect(r).toMatchObject({ kind: "already_ok", share: 0.2, lowPoint: $(20000) });
  });

  it("not_achievable when even 100% upfront leaves cash below the line", () => {
    const bill = com("bill", { type: "bill", amount: $(70000), anchors: { due: "2026-11-04" } });
    const r = smallestUpfrontShare(records($(10000), "likely", [bill]), profile, [], "deal", asOf, {});
    expect(r).toMatchObject({ kind: "not_achievable", bestShare: 1, lowPoint: -$(40000) });
  });

  it("evaluates a possible deal as if taken, without mutating the caller's records", () => {
    const recs = records($(10000), "possible");
    const before = JSON.stringify(recs);
    const r = smallestUpfrontShare(recs, profile, [], "deal", asOf, {});
    expect(r).toMatchObject({ kind: "ok", share: 0.4, lowPoint: $(6000) });
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
    expect({ kind: r.kind, share: r.kind === "not_achievable" ? r.bestShare : r.share, lowPoint: r.lowPoint, safety: r.run.safetyLine }).toMatchInlineSnapshot(`
      {
        "kind": "ok",
        "lowPoint": 3680000,
        "safety": 3500000,
        "share": 0.9,
      }
    `);
  });
});
