// Issue #157: an event's direction never disagrees with an explicit Commitment.direction.

import { describe, expect, it } from "vitest";
import type { Commitment, Records } from "../schema/records";
import type { Profile } from "../schema/profile";
import trading from "../profiles/trading.json";
import { expand } from "./expand";

const tradingProfile = trading as unknown as Profile;
const $ = (n: number) => n * 100;
const src = { system: "test", record: "x" };
const asOf = "2026-10-25";
const horizonEnd = "2027-01-24";

const records = (commitments: Commitment[]): Records => ({
  parties: [], commitments, events: [], signals: [], rules: [], settlements: [], evidence: [],
  balances: [{ id: "bal", account: "main", amount: $(1000), currency: "USD", asOf, sourceRef: src }],
});

const po = (over: Partial<Commitment>): Commitment => ({
  id: "po", type: "purchase_order", amount: $(6000), currency: "USD", status: "committed",
  anchors: { order: "2026-11-02", ship: "2026-11-20", due: "2026-12-02" }, sourceRef: src, ...over,
});

const run = (cs: Commitment[], profile: Profile = tradingProfile) => expand(records(cs), profile, asOf, horizonEnd, {});

describe("explicit Commitment.direction vs pattern legs", () => {
  it("customer PO (direction in) under the trading profile: inflows only, on its due date", () => {
    const x = run([po({ id: "cust-po", direction: "in", partyId: "cust" })]);
    const evs = x.events.filter((e) => e.commitmentId === "cust-po");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ direction: "in", date: "2026-12-02", amount: $(6000) });
    expect(evs[0]!.basis).toMatch(/default supplier_30_70 is not money in; used a single due-date leg in/);
    expect(x.reasons.some((r) => r.code === "pattern_direction_mismatch")).toBe(false); // no patternId: a normal customer PO
  });

  it("customer PO gets the customer's lag when the profile lags purchase orders", () => {
    const lagged: Profile = { ...tradingProfile, defaultLagDays: 5, engine: { ...tradingProfile.engine, lag: { ...tradingProfile.engine?.lag, laggedTypes: ["invoice", "sales_deal", "purchase_order"] } } };
    const evs = run([po({ id: "cust-po", direction: "in", partyId: "cust" })], lagged).events.filter((e) => e.commitmentId === "cust-po");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ direction: "in", date: "2026-12-07" });
  });

  it("supplier PO (direction out, or none) is unchanged: the 30/70 legs going out", () => {
    for (const direction of ["out", undefined] as const) {
      const x = run([po({ id: "sup-po", ...(direction ? { direction } : {}) })]);
      const evs = x.events.filter((e) => e.commitmentId === "sup-po");
      expect(evs.map((e) => [e.direction, e.date, e.amount])).toEqual([
        ["out", "2026-11-02", $(1800)],
        ["out", "2026-11-20", $(4200)],
      ]);
      expect(x.reasons).toEqual([]);
    }
  });

  it("an explicit patternId whose legs disagree raises a review reason and still produces inflows", () => {
    const x = run([po({ id: "cust-po", direction: "in", patternId: "supplier_50_50" })]);
    const evs = x.events.filter((e) => e.commitmentId === "cust-po");
    expect(evs.map((e) => [e.direction, e.date, e.amount])).toEqual([["in", "2026-12-02", $(6000)]]);
    expect(evs[0]!.basis).toMatch(/pattern supplier_50_50 is not money in; used a single due-date leg in/);
    const r = x.reasons.find((y) => y.code === "pattern_direction_mismatch");
    expect(r?.refs).toEqual(["cust-po", "supplier_50_50"]);
  });

  it("a mismatching patternId falls back to a type default that matches the direction", () => {
    const profile: Profile = {
      ...tradingProfile,
      paymentPatterns: [
        ...tradingProfile.paymentPatterns,
        { id: "customer_po_net30", appliesTo: "purchase_order", isDefault: true, legs: [{ share: 1, anchor: "ship", offsetDays: 30, direction: "in" }] },
      ],
    };
    const x = run([po({ id: "cust-po", direction: "in", patternId: "supplier_50_50" })], profile);
    const evs = x.events.filter((e) => e.commitmentId === "cust-po");
    expect(evs.map((e) => [e.direction, e.date])).toEqual([["in", "2026-12-20"]]);
    expect(x.reasons.find((y) => y.code === "pattern_direction_mismatch")?.message).toMatch(/used the purchase_order default customer_po_net30/);
    // Without a patternId the matching default is picked over the outflow default listed first.
    const y = run([po({ id: "cust-po2", direction: "in" })], profile);
    expect(y.events.filter((e) => e.commitmentId === "cust-po2").map((e) => [e.direction, e.date])).toEqual([["in", "2026-12-20"]]);
    expect(y.reasons).toEqual([]);
  });

  it("owner plan with direction in or out pays one due-date leg in that direction", () => {
    const plan = (id: string, direction: "in" | "out"): Commitment =>
      ({ id, type: "plan", direction, amount: $(500), currency: "USD", status: "likely", anchors: { due: "2026-11-15" }, sourceRef: src });
    const withOutDefault: Profile = {
      ...tradingProfile,
      paymentPatterns: [...tradingProfile.paymentPatterns, { id: "plan_out", appliesTo: "plan", isDefault: true, legs: [{ share: 1, anchor: "due", offsetDays: 3, direction: "out" }] }],
    };
    for (const profile of [tradingProfile, withOutDefault]) {
      const x = run([plan("p-in", "in"), plan("p-out", "out")], profile);
      const get = (id: string) => x.events.filter((e) => e.commitmentId === id).map((e) => [e.direction, e.amount]);
      expect(get("p-in")).toEqual([["in", $(500)]]);
      expect(get("p-out")).toEqual([["out", $(500)]]);
      expect(x.events.find((e) => e.commitmentId === "p-in")!.date).toBe("2026-11-15");
      expect(x.reasons).toEqual([]);
    }
  });
});
