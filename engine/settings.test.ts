// engineSettings(profile): defaults reproduce the old hard-coded constants, and every profile field changes behavior.

import { describe, expect, it } from "vitest";
import type { Commitment, Records, Scenario, Settlement, CashEvent } from "../schema/records";
import type { EngineTunables, Profile } from "../schema/profile";
import { ENGINE_DEFAULTS, engineSettings } from "./settings";
import { expand, matchPayments, SALES_HISTORY_DAYS, SETTLEMENT_MATCH_DAYS } from "./expand";
import { partyLag } from "./lag";
import { forecast, horizonEnd } from "./forecast";
import { projectedCashGap, DEFAULT_DEFER_DAYS } from "./warnings";
import { DEFAULT_SPLIT_INTERVAL_DAYS, DEFAULT_STRESS_DELAY_DAYS } from "./adjust";
import { DEFAULT_SHARE_STEP, smallestUpfrontShare } from "./affordability";
import { rank } from "./rank";
import { addDays } from "./dates";

const $ = (n: number) => n * 100;
const src = { system: "test", record: "x" };
const asOf = "2026-11-02"; // a Monday
const base: Scenario = { id: "base", kind: "base", overrides: [] };

const profile: Profile = {
  id: "test",
  displayName: "Test Co",
  baseCurrency: "USD",
  horizonWeeks: 13,
  freeCashLookaheadWeeks: 6,
  defaultLagDays: 5,
  lagShrinkageK: 3,
  safetyLine: { kind: "fixed", amount: 0 },
  paymentPatterns: [],
  revenueModel: { kind: "deals" },
  recurring: [],
  thresholds: { signalAutoApplyConfidence: 0.85, rankFloor: 0.1, relationshipPenalty: {} },
  signalSources: [],
  vocabulary: {},
};
const withEngine = (engine: EngineTunables, p: Profile = profile): Profile => ({ ...p, engine });

const empty = (): Records => ({ parties: [], commitments: [], events: [], signals: [], rules: [], settlements: [], balances: [], evidence: [] });
const com = (id: string, o: Partial<Commitment> & Pick<Commitment, "type" | "amount">): Commitment => ({ id, currency: "USD", anchors: {}, status: "committed", sourceRef: src, ...o });
const bal = (amount: number, date = asOf, account = "main") => ({ id: `bal-${account}-${date}`, account, amount, currency: "USD", asOf: date, sourceRef: src });
const actual = (id: string, date: string, amount: number, o: Partial<CashEvent> = {}): CashEvent => ({ id, legIndex: 0, date, amount, currency: "USD", amountBase: amount, direction: "in", status: "actual", confidence: 1, basis: "bank", sourceRef: src, ...o });
const run = (r: Records, p: Profile) => expand(r, p, asOf, horizonEnd(p, asOf), {});
const conf = (r: Records, p: Profile, id: string) => run(r, p).events.find((e) => e.commitmentId === id)!.confidence;

// Paid receivables for one party, `lates[i]` days after due, oldest first.
function history(lates: number[]): Records {
  const r = empty();
  lates.forEach((late, i) => {
    const due = addDays("2026-01-05", i * 30);
    const id = `h${i}`;
    r.commitments.push(com(id, { type: "invoice", direction: "in", partyId: "p", amount: $(100), anchors: { due }, settlement: "paid" }));
    r.settlements.push({ id: `s${i}`, commitmentId: id, partyId: "p", amount: $(100), currency: "USD", date: addDays(due, late), sourceRef: src } as Settlement);
  });
  return r;
}

describe("engineSettings defaults", () => {
  it("equal the constants the engine used before #44", () => {
    const s = engineSettings(profile);
    expect(s).toEqual({
      statusConfidence: { actual: 1, committed: 0.95, likely: 0.7, possible: 0.3 },
      dailySalesConfidence: 0.6,
      salesHistoryDays: 28,
      lag: { maxSamples: 12, noHistoryConfidence: 0.1, iqrScaleDays: 14, laggedAnchors: ["due", "invoice", "delivery", "month_end"], laggedTypes: ["invoice", "sales_deal"] },
      settlementMatchDays: 3,
      staleFallbackDays: 7,
      noSnapshotLookbackDays: 90,
      deferDays: 10,
      affordabilityStep: 0.05,
      urgencyScaleDays: 7,
      stressDelayDays: 7,
      splitIntervalDays: 30,
    });
    expect(s).toEqual(ENGINE_DEFAULTS);
  });

  it("keeps the exported constant names pointing at the defaults", () => {
    expect([SALES_HISTORY_DAYS, SETTLEMENT_MATCH_DAYS, DEFAULT_DEFER_DAYS, DEFAULT_STRESS_DELAY_DAYS, DEFAULT_SPLIT_INTERVAL_DAYS, DEFAULT_SHARE_STEP]).toEqual([28, 3, 10, 7, 30, 0.05]);
  });

  it("reads stressDelayDays and splitIntervalDays from thresholds, where they already live", () => {
    const s = engineSettings({ ...profile, thresholds: { ...profile.thresholds, stressDelayDays: 3, splitIntervalDays: 14 } });
    expect([s.stressDelayDays, s.splitIntervalDays]).toEqual([3, 14]);
  });

  it("a partial group keeps the defaults of the fields it omits", () => {
    const s = engineSettings(withEngine({ statusConfidence: { likely: 0.5 }, lag: { maxSamples: 4 } }));
    expect(s.statusConfidence).toEqual({ actual: 1, committed: 0.95, likely: 0.5, possible: 0.3 });
    expect(s.lag).toMatchObject({ maxSamples: 4, noHistoryConfidence: 0.1, iqrScaleDays: 14 });
  });
});

describe("each profile engine field changes behavior", () => {
  const bill = (status: Commitment["status"]) => {
    const r = empty();
    r.commitments = [com("b", { type: "bill", amount: $(100), status, anchors: { due: "2026-11-10" } })];
    return r;
  };

  it("statusConfidence.committed", () => {
    expect(conf(bill("committed"), profile, "b")).toBe(0.95);
    expect(conf(bill("committed"), withEngine({ statusConfidence: { committed: 0.8 } }), "b")).toBe(0.8);
  });

  it("statusConfidence.likely", () => {
    expect(conf(bill("likely"), profile, "b")).toBe(0.7);
    expect(conf(bill("likely"), withEngine({ statusConfidence: { likely: 0.5 } }), "b")).toBe(0.5);
  });

  it("statusConfidence.possible (a commitment's own probability still wins)", () => {
    expect(conf(bill("possible"), profile, "b")).toBe(0.3);
    expect(conf(bill("possible"), withEngine({ statusConfidence: { possible: 0.2 } }), "b")).toBe(0.2);
    const r = bill("possible");
    r.commitments[0]!.probability = 0.4;
    expect(conf(r, withEngine({ statusConfidence: { possible: 0.2 } }), "b")).toBe(0.4);
  });

  const restaurant: Profile = { ...profile, revenueModel: { kind: "dailySales", weekdayWeights: [1, 1, 1, 1, 1, 1, 1] } };
  const sales = (daysAgo: number[]) => {
    const r = empty();
    r.events = daysAgo.map((d) => actual(`sale-${d}`, addDays(asOf, -d), $(100), { category: "sales" }));
    return r;
  };

  it("dailySalesConfidence", () => {
    expect(conf(sales([1, 2, 3]), restaurant, "daily-sales")).toBe(0.6);
    expect(conf(sales([1, 2, 3]), withEngine({ dailySalesConfidence: 0.9 }, restaurant), "daily-sales")).toBe(0.9);
  });

  it("salesHistoryDays", () => {
    const r = sales([20]);
    expect(run(r, restaurant).events.some((e) => e.commitmentId === "daily-sales")).toBe(true);
    const short = run(r, withEngine({ salesHistoryDays: 14 }, restaurant));
    expect(short.events.some((e) => e.commitmentId === "daily-sales")).toBe(false);
    expect(short.reasons.map((x) => x.code)).toContain("no_sales_history");
  });

  it("lag.maxSamples", () => {
    const r = history([30, 0, 0]);
    expect(partyLag(r, profile, "p").n).toBe(3);
    expect(partyLag(r, withEngine({ lag: { maxSamples: 2 } }), "p").n).toBe(2);
  });

  it("lag.noHistoryConfidence", () => {
    expect(partyLag(empty(), profile, "p").confidence).toBe(0.1);
    expect(partyLag(empty(), withEngine({ lag: { noHistoryConfidence: 0.5 } }), "p").confidence).toBe(0.5);
  });

  it("lag.iqrScaleDays", () => {
    const r = history([0, 10, 20, 30]); // IQR 15 days
    const n = 4, k = 3;
    expect(partyLag(r, profile, "p").confidence).toBeCloseTo((n / (n + k)) * (1 / (1 + 15 / 14)), 12);
    expect(partyLag(r, withEngine({ lag: { iqrScaleDays: 30 } }), "p").confidence).toBeCloseTo((n / (n + k)) * (1 / (1 + 15 / 30)), 12);
  });

  const invoice = () => {
    const r = empty();
    r.commitments = [com("i", { type: "invoice", direction: "in", partyId: "p", amount: $(100), anchors: { due: "2026-11-10" } })];
    return r;
  };
  const date = (r: Records, p: Profile) => run(r, p).events.find((e) => e.commitmentId === "i")!.date;

  it("lag.laggedAnchors", () => {
    expect(date(invoice(), profile)).toBe("2026-11-15"); // due + defaultLagDays 5
    expect(date(invoice(), withEngine({ lag: { laggedAnchors: ["delivery"] } }))).toBe("2026-11-10");
  });

  it("lag.laggedTypes", () => {
    expect(date(invoice(), withEngine({ lag: { laggedTypes: ["sales_deal"] } }))).toBe("2026-11-10");
  });

  it("settlementMatchDays", () => {
    // Books settlement and bank line for the same $100, 5 days apart.
    const r = empty();
    const c = com("i", { type: "invoice", direction: "in", amount: $(100), anchors: { due: "2026-11-10" }, outstanding: 0, settlement: "paid" });
    r.commitments = [c];
    r.settlements = [{ id: "s1", commitmentId: "i", amount: $(100), currency: "USD", date: "2026-10-20", sourceRef: src } as Settlement];
    r.events = [actual("a1", "2026-10-25", $(100), { commitmentId: "i" })];
    expect(matchPayments(c, r, "2027-02-01", []).pairs).toHaveLength(0);
    expect(matchPayments(c, r, "2027-02-01", [], undefined, 5).pairs).toHaveLength(1);
    // Through expand(): the open invoice sees the pair as one payment only when the profile allows 5 days.
    const open = { ...r, commitments: [{ ...c, settlement: "open" as const, outstanding: undefined }] };
    expect(run(open, profile).reasons.map((x) => x.code)).toContain("payment_mismatch");
    expect(run(open, withEngine({ settlementMatchDays: 5 })).reasons.map((x) => x.code)).not.toContain("payment_mismatch");
  });

  it("staleFallbackDays", () => {
    const r = empty();
    r.balances = [bal($(100), addDays(asOf, -10))];
    const codes = (p: Profile) => forecast(r, p, base, asOf, {}).review!.reasons.map((x) => x.code);
    expect(codes(profile)).toContain("no_staleness_threshold");
    expect(codes(withEngine({ staleFallbackDays: 14 }))).not.toContain("no_staleness_threshold");
  });

  it("noSnapshotLookbackDays", () => {
    const r = empty();
    r.events = [actual("old", addDays(asOf, -100), $(100), { account: "savings" })];
    const left = (p: Profile) => forecast(r, p, base, asOf, {}).review!.reasons.some((x) => x.refs.includes("old"));
    expect(left(profile)).toBe(false);
    expect(left(withEngine({ noSnapshotLookbackDays: 120 }))).toBe(true);
  });

  it("deferDays", () => {
    const r = empty();
    r.balances = [bal($(50))];
    r.commitments = [com("b", { type: "bill", amount: $(100), anchors: { due: "2026-11-10" } })];
    const days = (p: Profile) => {
      const lever = projectedCashGap(forecast(r, p, base, asOf, {}), r, p).find((c) => c.lever?.kind === "defer")?.lever;
      return lever?.kind === "defer" ? lever.days : undefined;
    };
    expect(days(profile)).toBe(10);
    expect(days(withEngine({ deferDays: 4 }))).toBe(4);
  });

  it("affordabilityStep", () => {
    // Deal: 20% deposit at order, 80% at delivery; supplier cost 60% paid at order. Opening $10,000, line $5,000:
    // the order-day balance is -$20,000 + $50,000 X, so X >= 0.5 is needed.
    const p: Profile = {
      ...profile,
      safetyLine: { kind: "fixed", amount: $(5000) },
      defaultLagDays: 0,
      paymentPatterns: [
        { id: "deal", appliesTo: "sales_deal", isDefault: true, legs: [{ share: 0.2, anchor: "order", offsetDays: 0, direction: "in" }, { share: 0.8, anchor: "delivery", offsetDays: 0, direction: "in" }], linkedCosts: [{ patternId: "sup", share: 0.6 }] },
        { id: "sup", appliesTo: "purchase_order", legs: [{ share: 1, anchor: "order", offsetDays: 0, direction: "out" }] },
      ],
    };
    const r = empty();
    r.balances = [bal($(10000))];
    r.commitments = [com("deal", { type: "sales_deal", direction: "in", amount: $(50000), status: "likely", anchors: { order: "2026-11-09", delivery: "2026-12-07" } })];
    const share = (q: Profile) => {
      const res = smallestUpfrontShare(r, q, [], "deal", asOf, {});
      return res.kind === "ok" ? res.share : undefined;
    };
    expect(share(p)).toBe(0.5); // grid 0.20, 0.25, ..., 0.50
    expect(share(withEngine({ affordabilityStep: 0.25 }, p))).toBe(0.7); // grid 0.20, 0.45, 0.70
  });

  it("urgencyScaleDays", () => {
    const r = empty();
    r.balances = [bal($(1000))];
    r.commitments = [com("b", { type: "bill", partyId: "s", amount: $(100), anchors: { due: "2026-11-16" } })];
    const score = (p: Profile) => {
      const fr = forecast(r, p, base, asOf, {});
      const cand = { warning: "projected_cash_gap" as const, lever: { kind: "defer" as const, commitmentId: "b", days: 10 }, evidenceRefs: ["b"], neededBy: "2026-11-16" };
      return rank([cand], fr, r, p, () => ({ lowPointDelta: $(1000) })).all[0]!.score;
    };
    expect(score(profile)).toBe(Math.round(($(1000) / (1 + 14 / 7)) * 0.95));
    expect(score(withEngine({ urgencyScaleDays: 14 }))).toBe(Math.round(($(1000) / (1 + 14 / 14)) * 0.95));
  });
});
