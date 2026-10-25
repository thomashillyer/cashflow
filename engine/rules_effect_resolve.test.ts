import { describe, expect, it } from "vitest";
import type { CashEvent, Commitment, Records, Rule, Scenario } from "../schema/records";
import type { Profile } from "../schema/profile";
import { forecast } from "./forecast";
import { partyLag } from "./lag";
import { signalEffect } from "./signal_effect";
import { resolveEventSource } from "./resolve";

const $ = (n: number) => n * 100;
const src = { system: "test", record: "x" };
const asOf = "2026-10-25";
const base: Scenario = { id: "base", kind: "base", overrides: [] };

const profile: Profile = {
  id: "test",
  displayName: "Test Co",
  baseCurrency: "USD",
  horizonWeeks: 13,
  freeCashLookaheadWeeks: 6,
  defaultLagDays: 0,
  lagShrinkageK: 3,
  safetyLine: { kind: "fixed", amount: $(1000) },
  paymentPatterns: [
    { id: "deal_default", appliesTo: "sales_deal", isDefault: true, legs: [{ share: 1, anchor: "due", offsetDays: 0, direction: "in" }], linkedCosts: [{ patternId: "supplier", share: 0.6 }] },
    { id: "supplier", appliesTo: "purchase_order", legs: [{ share: 1, anchor: "order", offsetDays: 0, direction: "out" }] },
  ],
  revenueModel: { kind: "deals" },
  recurring: [{ id: "rec-rent", name: "Rent", amount: $(500), cadence: "monthly", anchor: "2026-11-01", category: "rent" }],
  thresholds: { signalAutoApplyConfidence: 0.85, rankFloor: 0.1, relationshipPenalty: {} },
  signalSources: [],
  vocabulary: {},
};

const empty = (): Records => ({ parties: [], commitments: [], events: [], signals: [], rules: [], settlements: [], balances: [], evidence: [] });
const com = (id: string, o: Partial<Commitment> & Pick<Commitment, "type" | "amount">): Commitment => ({ id, currency: "USD", anchors: {}, status: "committed", sourceRef: src, ...o });
const bal = (amount: number) => ({ id: "bal", account: "main", amount, currency: "USD", asOf, sourceRef: src });

describe("lag rule precedence (#65)", () => {
  const all: Rule = { id: "r-a-all", scope: { all: true }, kind: "lag_offset", params: { offsetDays: 5 }, fromNote: "all", state: "confirmed" };
  const own: Rule = { id: "r-b-party", scope: { partyId: "pA" }, kind: "lag_offset", params: { offsetDays: 30 }, fromNote: "pA pays in 30", state: "confirmed" };

  it.each([
    ["global first", [all, own]],
    ["party first", [own, all]],
  ])("the party's own confirmed rule wins (%s)", (_, rules) => {
    const r = { ...empty(), rules, balances: [bal(0)], commitments: [com("inv", { type: "invoice", partyId: "pA", amount: $(10), anchors: { due: "2026-11-10" } })] };
    expect(partyLag(r, profile, "pA").ruleId).toBe("r-b-party");
    expect(forecast(r, profile, base, asOf, {}).events.find((e) => e.commitmentId === "inv")?.date).toBe("2026-12-10");
    expect(partyLag(r, profile, "pB").ruleId).toBe("r-a-all");
  });

  it("a proposed party rule does not beat a confirmed global one", () => {
    const r = { ...empty(), rules: [{ ...own, state: "proposed" as const }, all] };
    expect(partyLag(r, profile, "pA").ruleId).toBe("r-a-all");
  });
});

describe("signalEffect (#73)", () => {
  const records = (): Records => ({
    ...empty(),
    balances: [bal($(100))],
    commitments: [
      com("bill", { type: "bill", amount: $(300), anchors: { due: "2026-10-28" } }),
      com("inv", { type: "invoice", amount: $(500), anchors: { due: "2026-10-27" } }),
    ],
    signals: [{ id: "s1", channel: "email", receivedAt: "2026-10-24T00:00:00Z", commitmentId: "inv", claim: { kind: "date_change", newDate: "2026-11-04" }, confidence: 0.9, state: "proposed", sourceRef: src }],
  });

  const flat = { ...profile, recurring: [] };
  const inState = (state: "proposed" | "applied" | "dismissed"): Records => {
    const r = records();
    r.signals[0]!.state = state;
    return r;
  };

  it.each(["proposed", "applied", "dismissed"] as const)("prices the signal the same way when it is %s", (state) => {
    const r = inState(state);
    // Not applied: +500 on Oct 27, -300 Oct 28 -> low $100 at asOf. Applied: receipt moves to Nov 4 -> -$200 on Oct 28.
    expect(signalEffect(r, flat, [], "s1", asOf, {})).toEqual({ lowPointDelta: -$(300), week: "2026-10-26" });
    expect(r.signals[0]!.state).toBe(state);
  });

  it("returns undefined for an unknown signal", () => {
    expect(signalEffect(records(), flat, [], "nope", asOf, {})).toBeUndefined();
  });

  it.each([
    ["date_change", { kind: "date_change", newDate: "2026-11-04" }],
    ["amount_change", { kind: "amount_change", newAmount: $(1) }],
    ["cancel", { kind: "cancel" }],
  ] as const)("returns undefined for an unmatched %s (ambiguous match)", (_, claim) => {
    const r = records();
    r.signals = [{ ...r.signals[0]!, commitmentId: undefined, claim, matchCandidates: [{ commitmentId: "inv", reasons: ["amount"] }] }];
    expect(signalEffect(r, flat, [], "s1", asOf, {})).toBeUndefined();
  });
});

describe("resolveEventSource (#79)", () => {
  it("resolves stored, signal-created, recurring, linked-cost, and actual events", () => {
    const r = empty();
    r.balances = [bal(0)];
    r.commitments = [com("deal", { type: "sales_deal", amount: $(1000), anchors: { order: "2026-10-30", due: "2026-11-20" } })];
    r.signals = [{ id: "s2", channel: "owner", receivedAt: "2026-10-24T00:00:00Z", claim: { kind: "plan", draft: { type: "plan", direction: "out", amount: $(50), currency: "USD", anchors: { due: "2026-11-05" }, status: "likely" } }, confidence: 1, state: "applied", sourceRef: src }];
    const bank: CashEvent = { id: "bank-1", legIndex: 0, date: "2026-10-26", amount: $(5), currency: "USD", amountBase: $(5), direction: "in", status: "actual", confidence: 1, basis: "bank", sourceRef: src };
    r.events = [bank];
    const run = forecast(r, profile, base, asOf, {});
    const kind = (cid: string | undefined) => resolveEventSource(run.events.find((e) => e.commitmentId === cid)!, r, profile, asOf);
    expect(kind("deal")).toMatchObject({ kind: "commitment", commitment: { id: "deal" } });
    expect(kind("sig-s2")).toMatchObject({ kind: "commitment", commitment: { id: "sig-s2", type: "plan" } });
    expect(kind("rec-rent")).toMatchObject({ kind: "profile_recurring", item: { id: "rec-rent" } });
    expect(kind("deal~supplier")).toMatchObject({ kind: "linked_cost", parentCommitment: { id: "deal" }, patternId: "supplier" });
    expect(kind(undefined)).toMatchObject({ kind: "actual", event: { id: "bank-1" } });
    expect(resolveEventSource({ ...bank, id: "ghost", commitmentId: "ghost", status: "committed" }, r, profile, asOf)).toEqual({ kind: "unresolved" });
  });

  it("a bank line that settles part of an invoice resolves as the bank line, with the invoice linked", () => {
    const r = empty();
    r.balances = [bal(0)];
    r.commitments = [com("inv", { type: "invoice", amount: $(50), outstanding: $(30), settlement: "partial", anchors: { due: "2026-10-27" } })];
    const line: CashEvent = { id: "bank-2", commitmentId: "inv", legIndex: 0, date: "2026-10-26", amount: $(20), currency: "USD", amountBase: $(20), direction: "in", status: "actual", confidence: 1, basis: "bank", sourceRef: { system: "bank_csv", record: "line-9" } };
    r.events = [line];
    const run = forecast(r, profile, base, asOf, {});
    const bankEvt = run.events.find((e) => e.id === "bank-2")!;
    expect(resolveEventSource(bankEvt, r, profile, asOf)).toMatchObject({ kind: "actual", event: { id: "bank-2", sourceRef: { system: "bank_csv" } }, commitment: { id: "inv" } });
    const rest = run.events.find((e) => e.commitmentId === "inv" && e.status !== "actual")!;
    expect(resolveEventSource(rest, r, profile, asOf)).toMatchObject({ kind: "commitment", commitment: { id: "inv" } });
  });

  it("daily sales resolve to the actual receipts they were averaged from", () => {
    const p: Profile = { ...profile, recurring: [], revenueModel: { kind: "dailySales", weekdayWeights: [1, 1, 1, 1, 1, 1, 1] } };
    const r = empty();
    r.balances = [bal(0)];
    const sale = (id: string, date: string): CashEvent => ({ id, legIndex: 0, date, amount: $(70), currency: "USD", amountBase: $(70), direction: "in", status: "actual", confidence: 1, basis: "pos", category: "sales", sourceRef: src });
    r.events = [sale("old", "2026-09-01"), sale("recent", "2026-10-20")];
    const e = forecast(r, p, base, asOf, {}).events.find((x) => x.commitmentId === "daily-sales")!;
    expect(resolveEventSource(e, r, p, asOf)).toEqual({ kind: "daily_sales", historyEventIds: ["recent"] });
  });
});
