// Issue #46: weekday and month_end anchors, daily-sales settlement lag.

import { describe, expect, it } from "vitest";
import type { CashEvent, Commitment, Records, Scenario } from "../schema/records";
import type { Profile } from "../schema/profile";
import { forecast } from "./forecast";
import { addDays, dowOf } from "./dates";

const $ = (n: number) => n * 100;
const src = { system: "test", record: "x" };
const asOf = "2026-10-25"; // a Sunday
const base: Scenario = { id: "base", kind: "base", overrides: [] };

const profile: Profile = {
  id: "test", displayName: "Test", baseCurrency: "USD", horizonWeeks: 13, freeCashLookaheadWeeks: 6,
  defaultLagDays: 0, lagShrinkageK: 3, safetyLine: { kind: "fixed", amount: 0 },
  paymentPatterns: [
    { id: "friday_after", appliesTo: "bill", legs: [{ share: 1, anchor: "weekday", weekday: 4, offsetDays: 7, direction: "out" }] },
    { id: "no_weekday", appliesTo: "bill", legs: [{ share: 1, anchor: "weekday", offsetDays: 0, direction: "out" }] },
    { id: "eom_30", appliesTo: "bill", legs: [{ share: 1, anchor: "month_end", offsetDays: 30, direction: "out" }] },
  ],
  revenueModel: { kind: "deals" }, recurring: [],
  thresholds: { signalAutoApplyConfidence: 0.85, rankFloor: 0.1, relationshipPenalty: {} },
  signalSources: [], vocabulary: {},
};

const records = (commitments: Commitment[] = [], events: CashEvent[] = []): Records => ({
  parties: [], commitments, events, signals: [], rules: [], settlements: [], evidence: [],
  balances: [{ id: "bal", account: "main", amount: $(1000), currency: "USD", asOf, sourceRef: src }],
});
const bill = (id: string, patternId: string, anchors: Commitment["anchors"]): Commitment =>
  ({ id, type: "bill", amount: $(100), currency: "USD", anchors, patternId, status: "committed", sourceRef: src });

describe("weekday anchor", () => {
  it("lands on the first matching weekday on/after the invoice date, plus offsetDays", () => {
    const run = forecast(records([
      bill("wed", "friday_after", { invoice: "2026-10-28", due: "2026-11-30" }), // Wednesday -> Fri 10-30 + 7
      bill("fri", "friday_after", { order: "2026-11-06" }),                     // already a Friday; no invoice, uses order
    ]), profile, base, asOf, {});
    const wed = run.events.find((e) => e.commitmentId === "wed")!;
    expect(wed.date).toBe("2026-11-06");
    expect(dowOf("2026-10-30")).toBe(4);
    expect(wed.basis).toMatch(/first Fri on\/after invoice 2026-10-28/);
    expect(run.events.find((e) => e.commitmentId === "fri")?.date).toBe("2026-11-13");
  });

  it("warns and schedules nothing when the leg has no weekday", () => {
    const run = forecast(records([bill("b", "no_weekday", { invoice: "2026-10-28" })]), profile, base, asOf, {});
    expect(run.events.some((e) => e.commitmentId === "b")).toBe(false);
    expect(run.warnings.join(" ")).toMatch(/b: no weekday date for leg 1 \(weekday anchor needs a leg weekday/);
  });
});

describe("month_end anchor", () => {
  it("is the end of the invoice month, then offsetDays; basis names the anchor used", () => {
    const run = forecast(records([bill("m", "eom_30", { invoice: "2026-11-10", due: "2026-12-10" })]), profile, base, asOf, {});
    const e = run.events.find((x) => x.commitmentId === "m")!;
    expect(e.date).toBe("2026-12-30");
    expect(e.basis).toMatch(/end of month of invoice 2026-11-10/);
  });
});

describe("daily sales settleLagDays", () => {
  const sale = (date: string): CashEvent => ({ id: `s-${date}`, legIndex: 0, date, amount: $(700), currency: "USD", amountBase: $(700), direction: "in", status: "actual", confidence: 1, basis: "bank", category: "sales", sourceRef: src });
  const history = Array.from({ length: 28 }, (_, i) => sale(addDays("2026-09-27", i)));
  const p = (settleLagDays: number, weekdayWeights = [1, 1, 1, 1, 1, 1, 1]): Profile => ({ ...profile, revenueModel: { kind: "dailySales", weekdayWeights, settleLagDays } });

  it("settles each sale day settleLagDays later, covering every settlement date in the horizon", () => {
    const lag0 = forecast(records([], history), p(0), base, asOf, {});
    const lag2 = forecast(records([], history), p(2), base, asOf, {});
    const sales = (r: typeof lag0) => r.events.filter((e) => e.commitmentId === "daily-sales");
    expect(sales(lag2).length).toBe(sales(lag0).length);
    expect(sales(lag2).map((e) => e.date)).toEqual(sales(lag0).map((e) => e.date));
    expect(sales(lag2)[0]?.basis).toMatch(/sales of 2026-10-23 settle 2 days later/);
    expect(sales(lag2)[0]?.amount).toBe($(700));
  });

  it("shapes by the sale weekday, not the settlement weekday", () => {
    const sales = forecast(records([], history), p(2, [1, 1, 1, 1, 1, 2, 1]), base, asOf, {}).events.filter((e) => e.commitmentId === "daily-sales");
    const mon = sales.find((e) => e.date === "2026-11-02")!.amount; // settles Saturday 10-31
    const tue = sales.find((e) => e.date === "2026-11-03")!.amount; // settles Sunday 11-01
    expect(mon).toBe(2 * tue);
  });

  it("does not forecast a settlement date that already has an actual sales receipt", () => {
    const run = forecast(records([], [...history, sale("2026-10-27")]), p(2), base, asOf, {});
    const dates = run.events.filter((e) => e.commitmentId === "daily-sales").map((e) => e.date);
    expect(dates).not.toContain("2026-10-27");
    expect(dates).toContain("2026-10-26");
  });
});
