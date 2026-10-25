// ForecastRun.review (#42): each needs-review code fires on a minimal input; informational notes do not set it.

import { describe, expect, it } from "vitest";
import type { CashEvent, Commitment, Records, Scenario, Settlement } from "../schema/records";
import type { Profile } from "../schema/profile";
import type { ForecastRun } from "../schema/forecast";
import { forecast } from "./forecast";
import { simulate } from "./simulate";
import { addDays } from "./dates";

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
  safetyLine: { kind: "fixed", amount: $(5000) },
  paymentPatterns: [
    { id: "split_50_50", appliesTo: "purchase_order", legs: [{ share: 0.5, anchor: "order", offsetDays: 0, direction: "out" }, { share: 0.5, anchor: "ship", offsetDays: 0, direction: "out" }] },
  ],
  revenueModel: { kind: "deals" },
  recurring: [],
  thresholds: { signalAutoApplyConfidence: 0.85, rankFloor: 0.1, relationshipPenalty: {} },
  signalSources: [],
  vocabulary: {},
};

const empty = (): Records => ({ parties: [], commitments: [], events: [], signals: [], rules: [], settlements: [], balances: [], evidence: [] });
const com = (id: string, o: Partial<Commitment> & Pick<Commitment, "type" | "amount">): Commitment => ({ id, currency: "USD", anchors: {}, status: "committed", sourceRef: src, ...o });
const bal = (amount: number, date = asOf, account = "main", currency = "USD") => ({ id: `bal-${account}-${date}`, account, amount, currency, asOf: date, sourceRef: src });
const withBal = (amount = $(100000), date = asOf): Records => ({ ...empty(), balances: [bal(amount, date)] });
const sale = (date: string): CashEvent => ({ id: `s-${date}`, legIndex: 0, date, amount: $(700), currency: "USD", amountBase: $(700), direction: "in", status: "actual", confidence: 1, basis: "bank", category: "sales", sourceRef: src });
const set = (id: string, commitmentId: string, amount: number, date: string, currency = "USD"): Settlement => ({ id, commitmentId, amount, currency, date, sourceRef: src });
const inv = (o: Partial<Commitment> = {}) => com("inv-s", { type: "invoice", amount: $(1000), anchors: { due: "2026-11-10" }, ...o });
const daily: Profile = { ...profile, revenueModel: { kind: "dailySales", weekdayWeights: [1, 1, 1, 1, 1, 1, 1] } };

type Case = { code: string; run: () => ForecastRun; refs?: string[] };
const cases: Case[] = [
  { code: "no_opening_balance", run: () => forecast({ ...empty(), commitments: [com("b", { type: "bill", amount: 1, anchors: { due: "2026-11-01" } })] }, profile, base, asOf, {}) },
  {
    code: "stale_balance",
    run: () => forecast(withBal($(100), "2026-10-01"), { ...profile, thresholds: { ...profile.thresholds, staleAfterHours: 72 } }, base, asOf, {}),
    refs: ["bal-main-2026-10-01"],
  },
  {
    code: "unassigned_actual",
    run: () =>
      forecast({ ...empty(), balances: [bal($(1), "2026-10-20", "a"), bal($(1), asOf, "b")], events: [{ id: "bank-amb", date: "2026-10-22", amount: $(5), currency: "USD", direction: "out", basis: "bank", sourceRef: src } as CashEvent] }, profile, base, asOf, {}),
    refs: ["bank-amb"],
  },
  {
    code: "account_without_balance",
    run: () => forecast({ ...withBal(), events: [{ id: "bank-z", account: "z", date: "2026-10-27", amount: $(5), currency: "USD", direction: "out", basis: "bank", sourceRef: src } as CashEvent] }, profile, base, asOf, {}),
    refs: ["bank-z"],
  },
  { code: "missing_fx", run: () => forecast({ ...empty(), balances: [bal($(1), asOf, "eur", "EUR")] }, profile, base, asOf, {}), refs: ["bal-eur-2026-10-25"] },
  { code: "missing_fx", run: () => forecast({ ...withBal(), commitments: [com("eur", { type: "bill", currency: "EUR", amount: $(100), anchors: { due: "2026-11-01" } })] }, profile, base, asOf, {}), refs: ["eur"] },
  {
    code: "missing_fx",
    run: () => forecast({ ...withBal(), events: [{ id: "bank-eur", date: "2026-10-27", amount: $(5), currency: "EUR", direction: "out", basis: "bank", sourceRef: src } as CashEvent] }, profile, base, asOf, {}),
    refs: ["bank-eur"],
  },
  { code: "overdue_receipt", run: () => forecast({ ...withBal(), commitments: [com("old", { type: "invoice", amount: $(500), anchors: { due: "2026-10-01" } })] }, profile, base, asOf, {}), refs: ["evt-old-0", "old"] },
  { code: "overdue_payment", run: () => forecast({ ...withBal(), commitments: [com("bill-old", { type: "bill", amount: $(500), anchors: { due: "2026-10-20" } })] }, profile, base, asOf, {}), refs: ["evt-bill-old-0", "bill-old"] },
  {
    code: "unreconciled_payment",
    run: () =>
      forecast(
        { ...withBal($(100000), "2026-10-20"), commitments: [com("bill-x", { type: "bill", amount: $(5000), anchors: { due: "2026-11-15" } })], events: [{ id: "bank-1", commitmentId: "bill-x", date: "2026-10-22", amount: $(2000), currency: "USD", direction: "out", basis: "bank", sourceRef: src } as CashEvent] },
        profile, base, asOf, {},
      ),
    refs: ["bill-x", "bank-1"],
  },
  {
    code: "payment_mismatch",
    run: () =>
      forecast(
        {
          ...withBal($(100000), "2026-10-20"),
          commitments: [com("bill-x", { type: "bill", amount: $(5000), anchors: { due: "2026-11-15" } })],
          settlements: [set("set-x", "bill-x", $(2000), "2026-10-21")],
          events: [{ id: "bank-1", commitmentId: "bill-x", date: "2026-10-22", amount: $(1990), currency: "USD", direction: "out", basis: "bank", sourceRef: src } as CashEvent],
        },
        profile, base, asOf, {},
      ),
    refs: ["bill-x", "set-x", "bank-1"],
  },
  {
    code: "missing_fx",
    run: () =>
      forecast(
        { ...withBal($(100000), "2026-10-20"), commitments: [com("bill-x", { type: "bill", amount: $(5000), anchors: { due: "2026-11-15" } })], events: [{ id: "bank-eur-x", commitmentId: "bill-x", date: "2026-10-22", amount: $(100), currency: "EUR", direction: "out", basis: "bank", sourceRef: src } as CashEvent] },
        profile, base, asOf, { EUR: 1.1 },
      ),
    refs: ["bill-x", "bank-eur-x"],
  },
  {
    code: "linked_cost_unscheduled",
    run: () => {
      const p: Profile = {
        ...profile,
        paymentPatterns: [
          { id: "supplier_cost", appliesTo: "purchase_order", legs: [{ share: 1, anchor: "order", offsetDays: 0, direction: "out" }] },
          { id: "deal", appliesTo: "sales_deal", isDefault: true, legs: [{ share: 1, anchor: "due", offsetDays: 0, direction: "in" }], linkedCosts: [{ patternId: "supplier_cost", share: 0.5 }] },
        ],
      };
      return forecast({ ...withBal(), commitments: [com("deal1", { type: "sales_deal", amount: $(1000), anchors: { order: "2026-10-01", due: "2027-01-04" } })] }, p, base, asOf, {});
    },
    refs: ["evt-deal1~supplier_cost-0", "deal1~supplier_cost"],
  },
  { code: "missing_anchor", run: () => forecast({ ...withBal(), commitments: [com("po", { type: "purchase_order", patternId: "split_50_50", amount: $(100) })] }, profile, base, asOf, {}), refs: ["po"] },
  { code: "missing_anchor", run: () => forecast({ ...withBal(), commitments: [com("gym", { type: "recurring", amount: $(50) })] }, profile, base, asOf, {}), refs: ["gym"] },
  { code: "unknown_pattern", run: () => forecast({ ...withBal(), commitments: [com("b1", { type: "bill", patternId: "typo", amount: $(10), anchors: { due: "2026-11-01" } })] }, profile, base, asOf, {}), refs: ["b1"] },
  { code: "no_sales_history", run: () => forecast(withBal(), daily, base, asOf, {}) },
  { code: "short_sales_history", run: () => forecast({ ...withBal(), events: Array.from({ length: 7 }, (_, i) => sale(addDays("2026-10-18", i))) }, daily, base, asOf, {}) },
  { code: "invalid_profile", run: () => forecast(withBal(), { ...profile, revenueModel: { kind: "dailySales", weekdayWeights: [1, 1] } }, base, asOf, {}) },
  {
    code: "recurring_cancelled",
    run: () =>
      forecast(
        { ...withBal(), commitments: [com("rent", { type: "recurring", amount: $(1000), anchors: { due: "2026-12-01" }, settlement: "cancelled" })] },
        { ...profile, recurring: [{ id: "rent", name: "Rent", amount: $(1000), cadence: "monthly", anchor: "2026-11-01", category: "rent" }] },
        base, asOf, {},
      ),
    refs: ["rent"],
  },
  {
    code: "linked_overallocated",
    run: () =>
      forecast(
        { ...withBal(), commitments: [com("po", { type: "purchase_order", amount: $(100), anchors: { due: "2026-11-10" }, linkedCommitmentIds: ["bill-a"] }), com("bill-a", { type: "bill", amount: $(150), anchors: { due: "2026-11-10" } })] },
        profile, base, asOf, {},
      ),
    refs: ["po", "bill-a"],
  },
  { code: "no_data", run: () => forecast(withBal(), profile, base, asOf, {}) },
  {
    code: "unconfirmed_signal",
    run: () =>
      forecast(
        { ...withBal(), commitments: [inv({ reference: "INV-9" })], signals: [{ id: "sig-p", channel: "email", receivedAt: "2026-10-24T00:00:00Z", commitmentId: "inv-s", claim: { kind: "date_change", newDate: "2026-12-01" }, confidence: 0.9, state: "proposed", sourceRef: src }] },
        profile, base, asOf, {},
      ),
    refs: ["sig-p", "inv-s"],
  },
  {
    code: "unconfirmed_rule",
    run: () => forecast({ ...withBal(), commitments: [inv()], rules: [{ id: "rule-p", scope: { all: true }, kind: "lag_offset", params: { offsetDays: 10 }, fromNote: "they pay late", state: "proposed" }] }, profile, base, asOf, {}),
    refs: ["rule-p"],
  },
  {
    code: "override_unmatched",
    run: () => forecast({ ...withBal(), commitments: [inv()] }, profile, { id: "s-own", kind: "base", overrides: [{ id: "ov-x", target: { commitmentId: "nope" }, change: { date: "2026-11-20" }, origin: "owner" }] }, asOf, {}),
    refs: ["ov-x", "nope"],
  },
  {
    code: "override_unmatched",
    run: () =>
      forecast(
        { ...withBal(), commitments: [inv({ settlement: "paid", outstanding: 0 })], signals: [{ id: "sig-a", channel: "email", receivedAt: "2026-10-24T00:00:00Z", commitmentId: "inv-s", claim: { kind: "cancel" }, confidence: 0.9, state: "applied", sourceRef: src }] },
        profile, base, asOf, {},
      ),
    refs: ["sig-a", "inv-s"],
  },
  { code: "no_staleness_threshold", run: () => forecast(withBal($(100), "2026-10-10"), profile, base, asOf, {}), refs: ["bal-main-2026-10-10"] },
  { code: "unreconciled_settlement", run: () => forecast({ ...withBal(), commitments: [inv()], settlements: [set("set-1", "inv-s", $(400), asOf)] }, profile, base, asOf, {}), refs: ["inv-s", "set-1"] },
  {
    code: "possible_double_count",
    run: () => forecast({ ...withBal(), commitments: [inv({ outstanding: $(1000) })], settlements: [set("set-1", "inv-s", $(400), "2026-10-10")] }, profile, base, asOf, {}),
    refs: ["inv-s", "set-1"],
  },
  { code: "settlement_status_mismatch", run: () => forecast({ ...withBal(), commitments: [inv({ settlement: "partial", outstanding: $(1000) })] }, profile, base, asOf, {}), refs: ["inv-s"] },
  { code: "settlement_status_mismatch", run: () => forecast({ ...withBal(), commitments: [inv({ settlement: "open" })], settlements: [set("set-1", "inv-s", $(400), "2026-10-10")] }, profile, base, asOf, {}), refs: ["inv-s"] },
  { code: "settlement_status_mismatch", run: () => forecast({ ...withBal(), commitments: [inv({ settlement: "paid", outstanding: $(200) })] }, profile, base, asOf, {}), refs: ["inv-s"] },
  { code: "missing_fx", run: () => forecast({ ...withBal(), commitments: [inv()], settlements: [set("set-eur", "inv-s", $(400), "2026-10-10", "EUR")] }, profile, base, asOf, {}), refs: ["inv-s", "set-eur"] },
  {
    code: "missing_fx",
    run: () => forecast({ ...withBal($(100), "2026-10-20"), events: [{ id: "bank-eur-old", date: "2026-10-22", amount: $(5), currency: "EUR", direction: "out", basis: "bank", sourceRef: src } as CashEvent] }, profile, base, asOf, {}),
    refs: ["bank-eur-old"],
  },
  {
    code: "linked_currency_mismatch",
    run: () =>
      forecast(
        { ...withBal(), commitments: [com("po", { type: "purchase_order", amount: $(100), anchors: { due: "2026-11-10" }, linkedCommitmentIds: ["bill-eur"] }), com("bill-eur", { type: "bill", currency: "EUR", amount: $(100), anchors: { due: "2026-11-10" } })] },
        profile, base, asOf, { EUR: 1.1 },
      ),
    refs: ["po", "bill-eur"],
  },
];

describe("ForecastRun.review", () => {
  it.each(cases.map((c, i) => [`${c.code} #${i}`, c] as const))("%s fires", (_, c) => {
    const r = c.run();
    const hits = r.review!.reasons.filter((x) => x.code === c.code);
    expect(r.review!.needed).toBe(true);
    expect(hits.length, JSON.stringify(r.review)).toBeGreaterThan(0);
    for (const h of hits) expect(r.warnings).toContain(h.message); // warnings stay the compatible string view
    if (c.refs) expect(hits.flatMap((h) => h.refs)).toEqual(expect.arrayContaining(c.refs));
  });

  it("every reason message is a warning, and needed matches reasons", () => {
    for (const c of cases) {
      const r = c.run();
      expect(r.review!.needed).toBe(r.review!.reasons.length > 0);
      for (const x of r.review!.reasons) expect(r.warnings).toContain(x.message);
    }
  });

  it("a clean run has review present and not needed", () => {
    const r = forecast({ ...withBal(), commitments: [com("inv", { type: "invoice", amount: $(10), anchors: { due: "2026-11-02" } })] }, profile, base, asOf, {});
    expect(r.warnings).toEqual([]);
    expect(r.review).toEqual({ needed: false, reasons: [] });
  });

  it("informational notes (horizon shorter than free-cash lookahead, lever no-ops) do not need review", () => {
    const records = { ...withBal(), commitments: [com("inv", { type: "invoice", amount: $(10), anchors: { due: "2026-11-02" } })] };
    const short = forecast(records, { ...profile, horizonWeeks: 4 }, base, asOf, {});
    expect(short.warnings.join(" ")).toMatch(/Free-cash lookahead/);
    expect(short.review).toEqual({ needed: false, reasons: [] });
    const sim = simulate(records, profile, [], [{ kind: "defer", commitmentId: "inv", days: 3 }], asOf, {});
    expect(sim.run.warnings.join(" ")).toMatch(/no remaining payment/);
    expect(sim.run.review!.needed).toBe(false);
  });

  it("possible without probability and intraday ordering are informational: warned, not flagged", () => {
    const rfq = forecast({ ...withBal(), commitments: [com("rfq", { type: "sales_deal", status: "possible", amount: $(1000), anchors: { due: "2026-11-02" } })] }, profile, base, asOf, {});
    expect(rfq.warnings.join(" ")).toMatch(/"possible" without a probability/);
    expect(rfq.review).toEqual({ needed: false, reasons: [] });
    const day = forecast({ ...withBal($(100)), commitments: [com("bill", { type: "bill", amount: $(150), anchors: { due: "2026-10-28" } }), com("inv", { type: "invoice", amount: $(200), anchors: { due: "2026-10-28" } })] }, profile, base, asOf, {});
    expect(day.warnings.join(" ")).toMatch(/intraday ordering is unknown/);
    expect(day.review).toEqual({ needed: false, reasons: [] });
  });

  it("without a staleness threshold, a balance up to 7 days old is not flagged", () => {
    const r = forecast({ ...withBal($(100), "2026-10-18"), commitments: [inv()] }, profile, base, asOf, {});
    expect(r.review).toEqual({ needed: false, reasons: [] });
  });

  it("dismissed signals and confirmed rules are not flagged", () => {
    const r = forecast(
      {
        ...withBal(),
        commitments: [inv()],
        signals: [{ id: "sig-d", channel: "email", receivedAt: "2026-10-24T00:00:00Z", commitmentId: "inv-s", claim: { kind: "cancel" }, confidence: 0.9, state: "dismissed", sourceRef: src }],
        rules: [{ id: "rule-c", scope: { all: true }, kind: "preference", params: { tag: "preferred" }, fromNote: "x", state: "confirmed" }],
      },
      profile, base, asOf, {},
    );
    expect(r.review).toEqual({ needed: false, reasons: [] });
  });

  it("does not duplicate a reason raised twice with the same message", () => {
    const r = forecast({ ...withBal(), commitments: [com("old", { type: "invoice", amount: $(500), anchors: { due: "2026-10-01" } })] }, profile, base, asOf, {});
    const keys = r.review!.reasons.map((x) => `${x.code}|${x.message}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
