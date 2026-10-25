import { describe, expect, it } from "vitest";
import type { Commitment, Override, Records, Scenario } from "../schema/records";
import type { Profile } from "../schema/profile";
import { forecast, settledCutoff } from "./forecast";

const $ = (n: number) => n * 100;
const src = { system: "test", record: "x" };
const asOf = "2026-10-28";   // Wednesday; this week starts 10-26, last week 10-19
const profile: Profile = {
  id: "test", displayName: "Test Co", baseCurrency: "USD", horizonWeeks: 8, freeCashLookaheadWeeks: 4, defaultLagDays: 0, lagShrinkageK: 3,
  safetyLine: { kind: "fixed", amount: 0 }, paymentPatterns: [], revenueModel: { kind: "deals" }, recurring: [],
  thresholds: { signalAutoApplyConfidence: 0.85, rankFloor: 0.1, relationshipPenalty: {} }, signalSources: [], vocabulary: {},
};
const bill = (id: string, due: string, amount = $(1000)): Commitment =>
  ({ id, type: "bill", currency: "USD", amount, anchors: { due }, status: "committed", sourceRef: src });
const records = (cs: Commitment[]): Records => ({
  parties: [], commitments: cs, events: [], signals: [], rules: [], settlements: [], evidence: [],
  balances: [{ id: "b", account: "main", amount: $(10000), currency: "USD", asOf, sourceRef: src }],
});
const scen = (overrides: Override[] = []): Scenario => ({ id: "base", kind: "base", overrides });
const run = (cs: Commitment[], p = profile, overrides: Override[] = []) => forecast(records(cs), p, scen(overrides), asOf, {});
const open = (id: string): Override => ({ id: `o-${id}`, target: { commitmentId: id }, change: { stillOpen: true }, origin: "owner" });

describe("overdue items older than last week are assumed paid", () => {
  const cs = [bill("old", "2026-10-12"), bill("recent", "2026-10-22")];

  it("cutoff is the Monday of last week (default 1 week)", () => {
    expect(settledCutoff(profile, asOf)).toBe("2026-10-19");
    expect(settledCutoff({ ...profile, assumeSettledBeforeWeeks: 3 }, asOf)).toBe("2026-10-05");
  });

  it("leaves the old one out of the forecast and flags; the recent one still rolls to asOf and is flagged", () => {
    const r = run(cs);
    expect(r.events.map((e) => e.commitmentId)).toEqual(["recent"]);
    expect(r.assumedPaid).toHaveLength(1);
    expect(r.assumedPaid![0]).toMatchObject({ commitmentId: "old", amountBase: $(1000) });
    expect(r.assumedPaid![0]!.basis).toMatch(/assumed paid \(due before 2026-10-19\)/);
    const flagged = r.review!.reasons.filter((x) => x.code === "overdue_payment").flatMap((x) => x.refs);
    expect(flagged).toContain("recent");
    expect(flagged).not.toContain("old");
    expect(r.days[0]!.closing).toBe($(10000) - $(1000));   // only the recent bill
  });

  it("a still-open override keeps the old item in the forecast as expected now, unflagged", () => {
    const r = run(cs, profile, [open("old"), open("recent")]);
    expect(r.assumedPaid).toBeUndefined();
    expect(r.days[0]!.closing).toBe($(10000) - $(2000));
    expect(r.events.find((e) => e.commitmentId === "old")).toMatchObject({ date: asOf });
    expect(r.events.find((e) => e.commitmentId === "old")!.basis).toMatch(/owner says still open/);
    expect(r.review!.reasons.some((x) => x.code === "overdue_payment")).toBe(false);
  });

  it("an owner exclude (paid / done) removes the item and its flag", () => {
    const r = run(cs, profile, [{ id: "d", target: { commitmentId: "recent" }, change: { exclude: true }, origin: "owner" }]);
    expect(r.events).toHaveLength(0);
    expect(r.review?.reasons.some((x) => x.code === "overdue_payment")).toBe(false);
  });

  it("the profile cutoff is respected", () => {
    const wide = run(cs, { ...profile, assumeSettledBeforeWeeks: 2 });
    expect(wide.assumedPaid).toBeUndefined();
    expect(wide.events.map((e) => e.commitmentId).sort()).toEqual(["old", "recent"]);
    const tight = run(cs, { ...profile, assumeSettledBeforeWeeks: 0 });
    expect(tight.assumedPaid!.map((a) => a.commitmentId).sort()).toEqual(["old", "recent"]);
  });

  it("is pure: same input, same run", () => {
    expect(run(cs)).toEqual(run(cs));
  });
});
