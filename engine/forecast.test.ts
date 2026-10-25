import { describe, expect, it } from "vitest";
import type { CashEvent, Commitment, Records, Scenario, Settlement } from "../schema/records";
import type { Profile } from "../schema/profile";
import { countedActualIds, forecast } from "./forecast";
import { matchPayments, SETTLEMENT_MATCH_DAYS } from "./expand";
import { simulate } from "./simulate";
import { partyLag } from "./lag";
import { addDays, mondayOf } from "./dates";

const $ = (n: number) => n * 100;
const src = { system: "test", record: "x" };

const profile: Profile = {
  id: "test",
  displayName: "Test Co",
  baseCurrency: "USD",
  horizonWeeks: 13,
  assumeSettledBeforeWeeks: 520,   // these suites exercise the overdue roll on old dates; the assumed-paid rule has its own tests
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
const base: Scenario = { id: "base", kind: "base", overrides: [] };
const stress: Scenario = { id: "stress", kind: "stress", overrides: [] };

function com(id: string, o: Partial<Commitment> & Pick<Commitment, "type" | "amount">): Commitment {
  return { id, currency: "USD", anchors: {}, status: "committed", sourceRef: src, ...o };
}
const bal = (amount: number, asOf = "2026-10-25") => ({ id: `bal-${asOf}`, account: "main", amount, currency: "USD", asOf, sourceRef: src });
const closing = (r: { days: { date: string; closing: number }[] }, date: string) => r.days.find((d) => d.date === date)?.closing;

// The hand-calculated demo fixture from docs/HACKATHON_PLAN.md.
function demo(): { records: Records; profile: Profile } {
  const records = empty();
  records.balances = [bal($(15000))];
  records.commitments = [
    com("bill-supplier", { type: "bill", amount: $(20000), anchors: { due: "2026-10-29" } }),
    com("inv-customer", { type: "invoice", amount: $(12000), anchors: { due: "2026-10-30" } }),
    com("loan", { type: "plan", direction: "in", funding: true, status: "likely", amount: $(40000), anchors: { due: "2026-10-30" } }),
  ];
  return {
    records,
    profile: { ...profile, recurring: [{ id: "payroll", name: "Payroll", amount: $(18000), cadence: "monthly", anchor: "2026-11-01", endDate: "2026-11-01", category: "payroll", nonDeferrable: true }] },
  };
}

describe("demo fixture arithmetic", () => {
  it("base: -$5,000 on Oct 29, $29,000 after payroll on Nov 1", () => {
    const { records, profile: p } = demo();
    const run = forecast(records, p, base, "2026-10-25", {});
    expect(closing(run, "2026-10-28")).toBe($(15000));
    expect(closing(run, "2026-10-29")).toBe(-$(5000));
    expect(closing(run, "2026-10-30")).toBe($(47000));
    expect(closing(run, "2026-11-01")).toBe($(29000));
    expect(run.firstNegative).toBe("2026-10-29");
    expect(run.firstBelowSafety).toBe("2026-10-29");
    expect(run.lowPoint).toMatchObject({ date: "2026-10-29", amount: -$(5000) });
  });

  const rescheduled = { id: "ov-bill", target: { commitmentId: "bill-supplier" }, change: { date: "2026-11-04" }, origin: "owner" as const };

  it("supplier rescheduled to Nov 4: $49,000 Nov 1, $29,000 Nov 4", () => {
    const { records, profile: p } = demo();
    const run = forecast(records, p, { ...base, overrides: [rescheduled] }, "2026-10-25", {});
    expect(closing(run, "2026-11-01")).toBe($(49000));
    expect(closing(run, "2026-11-04")).toBe($(29000));
    expect(run.events.find((e) => e.commitmentId === "bill-supplier")?.overriddenBy).toEqual(["ov-bill"]);
  });

  it("stress without loan and receipt +7 days: -$3,000 Nov 1, -$23,000 Nov 4", () => {
    const { records, profile: p } = demo();
    const run = forecast(records, p, { ...stress, overrides: [rescheduled] }, "2026-10-25", {});
    expect(closing(run, "2026-11-01")).toBe(-$(3000));
    expect(closing(run, "2026-11-04")).toBe(-$(23000));
    expect(run.events.find((e) => e.commitmentId === "loan")).toBeUndefined();
  });

  it("is deterministic and does not mutate inputs", () => {
    const { records, profile: p } = demo();
    const snapshot = JSON.stringify(records);
    const a = forecast(records, p, base, "2026-10-25", {});
    const b = forecast(records, p, base, "2026-10-25", {});
    expect(a).toEqual(b);
    expect(JSON.stringify(records)).toBe(snapshot);
  });

  it("simulate: deferring the bill raises the low point and leaves the base untouched", () => {
    const { records, profile: p } = demo();
    const sim = simulate(records, p, [], [{ kind: "defer", commitmentId: "bill-supplier", days: 6 }], "2026-10-25", {});
    expect(sim.base.lowPoint.amount).toBe(-$(5000));
    expect(sim.lowPointDelta).toBeGreaterThan(0);
    expect(sim.run.scenarioId).toMatch(/^whatif-/);
  });
});

describe("opening-cash boundary", () => {
  it("$100 opening + $20 actual after as-of + $30 remaining expected = $150", () => {
    const r = empty();
    r.balances = [bal($(100))];
    r.commitments = [com("inv", { type: "invoice", amount: $(50), outstanding: $(30), settlement: "partial", anchors: { due: "2026-10-27" } })];
    const actual: CashEvent = { id: "bank-1", commitmentId: "inv", legIndex: 0, date: "2026-10-26", amount: $(20), currency: "USD", amountBase: $(20), direction: "in", status: "actual", confidence: 1, basis: "bank", sourceRef: src };
    r.events = [actual];
    const run = forecast(r, profile, base, "2026-10-25", {});
    expect(closing(run, "2026-10-28")).toBe($(150));
  });

  it("actuals between the snapshot and as-of roll into opening; earlier ones are excluded", () => {
    const r = empty();
    r.balances = [bal($(100), "2026-10-20")];
    const mk = (id: string, date: string, amount: number): CashEvent => ({ id, legIndex: 0, date, amount, currency: "USD", amountBase: amount, direction: "in", status: "actual", confidence: 1, basis: "bank", sourceRef: src });
    r.events = [mk("pre", "2026-10-19", $(999)), mk("mid", "2026-10-22", $(10))];
    expect(forecast(r, profile, base, "2026-10-25", {}).openingBalance).toBe($(110));
  });

  it("no snapshot warns instead of looking green", () => {
    expect(forecast(empty(), profile, base, "2026-10-25", {}).warnings.join(" ")).toMatch(/No opening balance/);
  });
});

describe("opening cash with several accounts", () => {
  const snap = (account: string, amount: number, asOf: string, currency = "USD") => ({ id: `bal-${account}-${asOf}`, account, amount, currency, asOf, sourceRef: src });
  const act = (id: string, date: string, amount: number, o: Partial<CashEvent> = {}): CashEvent => ({ id, legIndex: 0, date, amount, currency: "USD", amountBase: amount, direction: "in", status: "actual", confidence: 1, basis: "bank", sourceRef: src, ...o });
  const run = (r: Records) => forecast(r, profile, base, "2026-10-25", {});

  it("rolls each account forward from its own snapshot date", () => {
    const r = { ...empty(), balances: [snap("chk", $(100), "2026-10-18"), snap("sav", $(1000), "2026-10-22")] };
    r.events = [
      act("chk-mid", "2026-10-20", $(10), { account: "chk" }), // after chk snapshot, before sav: counted
      act("chk-late", "2026-10-23", $(5), { account: "chk", direction: "out" }),
      act("sav-early", "2026-10-20", $(999), { account: "sav" }), // already in sav's snapshot
      act("sav-mid", "2026-10-23", $(50), { account: "sav" }),
      act("after", "2026-10-25", $(7), { account: "chk" }), // on as-of: a forecast actual, not opening
    ];
    const out = run(r);
    expect(out.openingBalance).toBe($(100 + 10 - 5 + 1000 + 50));
    expect(out.warnings.join(" ")).not.toMatch(/different as-of|could not be matched/);
    expect(out.events.filter((e) => e.status === "actual").map((e) => e.id)).toEqual(["after"]);
  });

  it("an actual dated before its account's snapshot is excluded", () => {
    const r = { ...empty(), balances: [snap("chk", $(100), "2026-10-20"), snap("sav", $(0), "2026-10-15")] };
    r.events = [act("chk-pre", "2026-10-18", $(999), { account: "chk" }), act("sav-in", "2026-10-18", $(3), { account: "sav" })];
    expect(run(r).openingBalance).toBe($(103));
  });

  it("unattributed actuals go to the only account", () => {
    const r = { ...empty(), balances: [snap("chk", $(100), "2026-10-20")], events: [act("pre", "2026-10-19", $(999)), act("mid", "2026-10-22", $(10))] };
    const out = run(r);
    expect(out.openingBalance).toBe($(110));
    expect(out.warnings.join(" ")).not.toMatch(/could not be matched/);
  });

  it("untagged actuals between snapshot dates with several accounts: outflows counted, inflows left out, flagged", () => {
    const r = { ...empty(), balances: [snap("chk", $(100), "2026-10-18"), snap("sav", $(1000), "2026-10-22")] };
    r.events = [
      act("old", "2026-10-10", $(999)), // before every snapshot: already in them, not ambiguous
      act("amb-in", "2026-10-19", $(20)),
      act("amb-out", "2026-10-21", $(30), { direction: "out" }),
      act("amb-in2", "2026-10-21", $(15)),
      act("new", "2026-10-23", $(4)), // after the latest snapshot: rolled forward
    ];
    const out = run(r);
    expect(out.openingBalance).toBe($(1100 - 30 + 4));
    expect(out.warnings.join(" ")).toMatch(/3 actuals with no account dated Oct 18 to before Oct 22.*net \$5\.00 in.*outflows \(\$30\.00\) are counted.*inflows \(\$35\.00\) left out.*needs review/);
    const ids = countedActualIds(r, profile, "2026-10-25", {});
    expect([...ids].sort()).toEqual(["amb-out", "new", "old"]);
  });

  it("an actual with no FX rate in an account's roll-forward is left out with a warning", () => {
    const r = { ...empty(), balances: [snap("chk", $(100), "2026-10-18"), snap("eur", $(50), "2026-10-22")] };
    r.events = [act("eur-1", "2026-10-20", $(10), { account: "chk", currency: "EUR" }), act("usd-1", "2026-10-20", $(5), { account: "chk" })];
    const out = run(r);
    expect(out.openingBalance).toBe($(155));
    expect(out.warnings.join(" ")).toMatch(/Actual eur-1 is in EUR with no FX rate; left out of opening cash/);
  });

  it("actuals tagged to an account with no snapshot are left out of opening and the main line, one warning per account", () => {
    const r = { ...empty(), balances: [snap("chk", $(100), "2026-10-20")] };
    r.events = [
      act("card-old", "2026-10-01", $(500), { account: "card", direction: "out" }), // before the oldest snapshot: ignored
      act("card-1", "2026-10-22", $(10), { account: "card", direction: "out" }),
      act("card-2", "2026-10-23", $(4), { account: "card" }),
      act("card-3", "2026-10-27", $(20), { account: "card", direction: "out" }), // after asOf: also out of the main line
    ];
    const out = run(r);
    expect(out.openingBalance).toBe($(100));
    expect(out.events.some((e) => e.id.startsWith("card"))).toBe(false);
    const w = out.warnings.filter((x) => /account card/.test(x));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^3 actuals tagged to account card, which has no balance on or before Oct 25 \(net \$26\.00 out\).*needs review/);
    expect(countedActualIds(r, profile, "2026-10-25", {}).size).toBe(0);
  });

  it("with no snapshot at all, tagged actuals from the last 90 days are reported", () => {
    const r = { ...empty(), events: [act("a", "2026-07-01", $(1), { account: "chk" }), act("b", "2026-10-01", $(2), { account: "chk" })] };
    expect(run(r).warnings.join(" ")).toMatch(/1 actual tagged to account chk.*net \$2\.00 in/);
  });

  it("stale balances are checked per account", () => {
    const r = { ...empty(), balances: [snap("checking", $(100), "2026-10-24"), snap("savings", $(100), "2026-09-01")] };
    const w = forecast(r, { ...profile, thresholds: { ...profile.thresholds, staleAfterHours: 48 } }, base, "2026-10-25", {}).warnings;
    expect(w.filter((x) => /older than 48 hours/.test(x))).toEqual(["Bank balance for savings is from Sep 1, older than 48 hours; refresh before relying on this."]);
  });

  it("countedActualIds: in-snapshot, rolled and main-line actuals count; no-FX and orphan ones do not", () => {
    const r = { ...empty(), balances: [snap("chk", $(100), "2026-10-20")] };
    r.events = [
      act("in-snap", "2026-10-19", $(5000), { account: "chk", direction: "out" }),
      act("rolled", "2026-10-21", $(5000), { account: "chk", direction: "out" }),
      act("no-fx", "2026-10-21", $(5000), { account: "chk", direction: "out", currency: "EUR" }),
      act("orphan", "2026-10-21", $(5000), { account: "card", direction: "out" }),
      act("future", "2026-10-26", $(5000), { direction: "out" }),
      act("future-no-fx", "2026-10-26", $(5000), { direction: "out", currency: "EUR" }),
    ];
    expect([...countedActualIds(r, profile, "2026-10-25", {})].sort()).toEqual(["future", "in-snap", "rolled"]);
    expect(countedActualIds(r, profile, "2026-10-25", { EUR: 1.1 }).has("no-fx")).toBe(true);
  });
});

describe("legs, partial payments, overlap", () => {
  it("allocates legs exactly and consumes settled money in order", () => {
    const r = empty();
    r.balances = [bal(0)];
    r.commitments = [com("po", { type: "purchase_order", patternId: "split_50_50", amount: 10001, outstanding: 5000, anchors: { order: "2026-10-26", ship: "2026-11-10" } })];
    const run = forecast(r, profile, base, "2026-10-25", {});
    // legs are 5000 + 5001; the 5001 already paid consumes leg 0 (5000) then 1 of leg 1, leaving 5000 on leg 1
    const out = run.events.filter((e) => e.commitmentId === "po");
    expect(out.reduce((a, e) => a + e.amount, 0)).toBe(5000);
    expect(out.map((e) => e.legIndex)).toEqual([1]);
  });

  it("linked invoice replaces its PO portion", () => {
    const r = empty();
    r.balances = [bal($(100000))];
    r.commitments = [
      com("po", { type: "purchase_order", patternId: "split_50_50", amount: $(10000), linkedCommitmentIds: ["bill-1"], anchors: { order: "2026-10-26", ship: "2026-11-10" } }),
      com("bill-1", { type: "bill", amount: $(4000), anchors: { due: "2026-11-02" } }),
    ];
    const run = forecast(r, profile, base, "2026-10-25", {});
    const po = run.events.filter((e) => e.commitmentId === "po").reduce((a, e) => a + e.amount, 0);
    expect(po).toBe($(6000));
  });

  it("paid, cancelled, and credited commitments emit nothing", () => {
    const r = empty();
    r.balances = [bal(0)];
    r.commitments = (["paid", "cancelled", "credited"] as const).map((s) => com(`c-${s}`, { type: "bill", amount: $(1), settlement: s, anchors: { due: "2026-11-01" } }));
    expect(forecast(r, profile, base, "2026-10-25", {}).events).toEqual([]);
  });
});

describe("settlements, linked overlap, and currency (#45 #63 #64 #67)", () => {
  const payIn = (id: string, date: string, amount: number, currency = "USD"): CashEvent => ({ id, commitmentId: "inv", legIndex: 0, date, amount, currency, amountBase: amount, direction: "in", status: "actual", confidence: 1, basis: "bank", sourceRef: src });
  const settle = (amount: number, o: Partial<Settlement> = {}): Settlement => ({ id: "set-1", commitmentId: "inv", amount, currency: "USD", date: "2026-10-24", sourceRef: src, ...o }); // default: before the Oct 25 snapshot
  const sumOf = (run: ReturnType<typeof forecast>, id: string) => run.events.filter((e) => e.commitmentId === id).reduce((a, e) => a + e.amount, 0);

  it("TECHNICAL_PLAN 6: $100 opening + $20 actual + $30 expected = $150 with outstanding unset", () => {
    const r = empty();
    r.balances = [bal($(100))];
    r.commitments = [com("inv", { type: "invoice", amount: $(50), settlement: "partial", anchors: { due: "2026-10-27" } })];
    r.settlements = [settle($(20), { date: "2026-10-26" })];
    r.events = [payIn("bank-1", "2026-10-26", $(20))];
    const run = forecast(r, profile, base, "2026-10-25", {});
    expect(closing(run, "2026-10-28")).toBe($(150));
    expect(run.events.filter((e) => e.commitmentId === "inv" && e.status !== "actual").map((e) => e.amount)).toEqual([$(30)]);
    expect(run.warnings.join(" ")).not.toMatch(/partially paid|not seen in the bank/);
  });

  it("a settlement after the snapshot with no bank line keeps the money expected and asks for reconciliation", () => {
    const r = empty();
    r.balances = [bal($(100))];
    r.commitments = [com("inv", { type: "invoice", amount: $(50), settlement: "partial", anchors: { due: "2026-10-27" } })];
    r.settlements = [settle($(20), { date: "2026-10-26" })];
    const run = forecast(r, profile, base, "2026-10-25", {});
    expect(closing(run, "2026-10-28")).toBe($(150)); // $100 + $50 still expected, the $20 is not lost
    expect(run.warnings.join(" ")).toMatch(/payment of \$20\.00 recorded on Oct 26 but not seen in the bank; still forecast as expected \(needs reconciliation\)/);
  });

  it("a settlement before the snapshot is inside opening cash and reduces what is expected", () => {
    const r = empty();
    r.balances = [bal($(100))];
    r.commitments = [com("inv", { type: "invoice", amount: $(50), settlement: "partial", anchors: { due: "2026-10-27" } })];
    r.settlements = [settle($(20), { date: "2026-10-24" })];
    const run = forecast(r, profile, base, "2026-10-25", {});
    expect(closing(run, "2026-10-28")).toBe($(130));
    expect(run.warnings.join(" ")).not.toMatch(/not seen in the bank/);
  });

  it("settlements beyond what outstanding reflects warn of a possible double count", () => {
    const r = { ...empty(), balances: [bal(0)], commitments: [com("inv", { type: "invoice", amount: $(50), outstanding: $(40), anchors: { due: "2026-10-27" } })], settlements: [settle($(20))] };
    const run = forecast(r, profile, base, "2026-10-25", {});
    expect(sumOf(run, "inv")).toBe($(40));
    expect(run.warnings.join(" ")).toMatch(/settlements \(\$20\.00\) exceed what outstanding reflects \(\$10\.00\); possible double count/);
  });

  it("a settlement in another currency is not deducted, and says so", () => {
    const r = { ...empty(), balances: [bal(0)], commitments: [com("inv", { type: "invoice", amount: $(50), anchors: { due: "2026-10-27" } })], settlements: [settle($(20), { currency: "EUR" })] };
    const run = forecast(r, profile, base, "2026-10-25", {});
    expect(sumOf(run, "inv")).toBe($(50));
    expect(run.warnings.join(" ")).toMatch(/settlement set-1 is in EUR/);
  });

  it("warns when the settlement status contradicts what is outstanding", () => {
    const w = (c: Partial<Commitment>, settlements: Settlement[] = []) =>
      forecast({ ...empty(), balances: [bal(0)], commitments: [com("inv", { type: "invoice", amount: $(50), anchors: { due: "2026-10-27" }, ...c })], settlements }, profile, base, "2026-10-25", {}).warnings.join(" ");
    expect(w({ settlement: "partial" })).toMatch(/marked partially paid but nothing is recorded as paid/);
    expect(w({ settlement: "partial", outstanding: $(50) })).toMatch(/marked partially paid/);
    expect(w({ settlement: "paid", outstanding: $(10) })).toMatch(/marked paid but \$10\.00 is still outstanding/);
    expect(w({ settlement: "open" }, [settle($(20))])).toMatch(/marked open but \$20\.00 is already paid/);
    expect(w({ settlement: "open", outstanding: $(30) })).toMatch(/marked open/);
    expect(w({ settlement: "paid" })).not.toMatch(/marked paid/); // books often mark paid without a Settlement row
    expect(w({ settlement: "open" })).not.toMatch(/marked open/);
  });

  it("an actual with no FX rate between snapshot and as-of is left out of opening cash with a warning", () => {
    const r = { ...empty(), balances: [bal($(100), "2026-10-20")], events: [payIn("eur-1", "2026-10-22", $(10), "EUR"), payIn("usd-1", "2026-10-22", $(5))] };
    const run = forecast(r, profile, base, "2026-10-25", {});
    expect(run.openingBalance).toBe($(105));
    expect(run.warnings.join(" ")).toMatch(/Actual eur-1 is in EUR with no FX rate; left out of opening cash/);
  });

  it("a linked invoice in another currency does not offset the PO", () => {
    const r = empty();
    r.balances = [bal(0)];
    r.commitments = [
      com("po", { type: "purchase_order", patternId: "split_50_50", amount: $(10000), linkedCommitmentIds: ["bill-eur"], anchors: { order: "2026-10-26", ship: "2026-11-10" } }),
      com("bill-eur", { type: "bill", currency: "EUR", amount: $(4000), anchors: { due: "2026-11-02" } }),
    ];
    const run = forecast(r, profile, base, "2026-10-25", { EUR: 1.1 });
    expect(sumOf(run, "po")).toBe($(10000));
    expect(run.warnings.join(" ")).toMatch(/linked bill-eur is in EUR, not USD; not offset/);
  });

  // Leg allocation for linked invoices (#45). PO legs: 30% at order (Oct 26), 70% at ship (Nov 10).
  const p3070: Profile = {
    ...profile,
    paymentPatterns: [
      { id: "s30_70", appliesTo: "purchase_order", isDefault: true, legs: [{ share: 0.3, anchor: "order", offsetDays: 0, direction: "out" }, { share: 0.7, anchor: "ship", offsetDays: 0, direction: "out" }] },
      { id: "freight", appliesTo: "purchase_order", legs: [{ share: 1, anchor: "ship", offsetDays: -7, direction: "out" }] },
      { id: "adv", appliesTo: "sales_deal", isDefault: true, legs: [{ share: 0.3, anchor: "order", offsetDays: 0, direction: "in" }, { share: 0.7, anchor: "delivery", offsetDays: 0, direction: "in" }], linkedCosts: [{ patternId: "s30_70", share: 0.55 }, { patternId: "freight", share: 0.1 }] },
    ],
  };
  const po = (o: Partial<Commitment> = {}) => com("po", { type: "purchase_order", amount: $(10000), linkedCommitmentIds: ["bill"], anchors: { order: "2026-10-26", ship: "2026-11-10" }, ...o });
  const legsOf = (run: ReturnType<typeof forecast>, id: string) => run.events.filter((e) => e.commitmentId === id).map((e) => [e.date, e.amount]);
  const runP = (cs: Commitment[], extra: Partial<Records> = {}) => forecast({ ...empty(), balances: [bal(0)], commitments: cs, ...extra }, p3070, base, "2026-10-25", {});

  it("a deposit bill dated before shipment replaces only the deposit leg", () => {
    const run = runP([po(), com("bill", { type: "bill", amount: $(3000), anchors: { due: "2026-10-28" } })]);
    expect(legsOf(run, "po")).toEqual([["2026-11-10", $(7000)]]);
  });

  it("a balance bill dated at shipment replaces the shipment leg, not the unpaid deposit", () => {
    const run = runP([po(), com("bill", { type: "bill", amount: $(7000), anchors: { due: "2026-11-10" } })]);
    expect(legsOf(run, "po")).toEqual([["2026-10-26", $(3000)]]);
  });

  it("a bill dated before every leg, or undated, consumes the latest leg first and keeps the deposit", () => {
    const early = runP([po(), com("bill", { type: "bill", amount: $(5000), anchors: { invoice: "2026-10-01" } })]);
    expect(legsOf(early, "po")).toEqual([["2026-10-26", $(3000)], ["2026-11-10", $(2000)]]);
    const undated = runP([po(), com("bill", { type: "bill", amount: $(7000), anchors: {} })]);
    expect(legsOf(undated, "po")).toEqual([["2026-10-26", $(3000)]]);
  });

  it("a PO whose outstanding already reflects its linked bill is not reduced twice", () => {
    // reconcile (or an import) lowered outstanding to $70 for the $30 bill; total supplier outflow stays $100
    const run = runP([po({ amount: $(100), outstanding: $(70) }), com("bill", { type: "bill", amount: $(30), anchors: { due: "2026-10-26" } })]);
    expect(sumOf(run, "po") + sumOf(run, "bill")).toBe($(100));
    expect(legsOf(run, "po")).toEqual([["2026-11-10", $(70)]]);
    expect(run.warnings.join(" ")).not.toMatch(/marked open|double count/);
    const open = runP([po({ amount: $(100), outstanding: $(70), settlement: "open" }), com("bill", { type: "bill", amount: $(30), anchors: { due: "2026-10-26" } })]);
    expect(open.warnings.join(" ")).not.toMatch(/marked open/);
  });

  it("a paid deposit plus a balance bill leaves nothing on the PO (outstanding derived from the settlement)", () => {
    const run = runP([po(), com("bill", { type: "bill", amount: $(7000), anchors: { due: "2026-11-10" } })], { settlements: [settle($(3000), { commitmentId: "po", legIndex: 0 })] });
    expect(legsOf(run, "po")).toEqual([]);
  });

  it("a billed leg with an unresolved anchor is only reached by the remainder", () => {
    // no order date: the deposit leg cannot be scheduled, so the bill dated at shipment consumes the shipment leg
    const run = runP([po({ anchors: { ship: "2026-11-10" } }), com("bill", { type: "bill", amount: $(7000), anchors: { due: "2026-11-10" } })]);
    expect(legsOf(run, "po")).toEqual([]);
    expect(run.warnings.join(" ")).toMatch(/no order date for leg 1/);
  });

  const deal = (o: Partial<Commitment> = {}) => com("deal", { type: "sales_deal", status: "likely", amount: $(100000), anchors: { order: "2026-10-26", ship: "2026-11-10", delivery: "2026-11-30" }, ...o });
  const costs = (run: ReturnType<typeof forecast>) => {
    const out: Record<string, number> = {};
    for (const e of run.events) if (e.commitmentId?.startsWith("deal~")) out[e.commitmentId] = (out[e.commitmentId] ?? 0) + e.amount;
    return out;
  };

  it("#63: a deal linked to its goods PO keeps the freight cost", () => {
    const goods = com("po1", { type: "purchase_order", patternId: "s30_70", amount: $(55000), anchors: { order: "2026-10-26", ship: "2026-11-10" } });
    const run = runP([deal({ linkedCommitmentIds: ["po1"] }), goods]);
    expect(costs(run)).toEqual({ "deal~freight": $(10000) });
    expect(sumOf(run, "po1")).toBe($(55000));
  });

  it("#63: a linked PO with no patternId covers the cost of its default pattern only", () => {
    const goods = com("po1", { type: "purchase_order", amount: $(55000), anchors: { order: "2026-10-26", ship: "2026-11-10" } });
    expect(costs(runP([deal({ linkedCommitmentIds: ["po1"] }), goods]))).toEqual({ "deal~freight": $(10000) });
  });

  it("a customer deposit does not shrink the supplier costs of the deal", () => {
    const run = runP([deal()], { settlements: [settle($(30000), { commitmentId: "deal" })] });
    expect(costs(run)).toEqual({ "deal~s30_70": $(55000), "deal~freight": $(10000) });
    expect(sumOf(run, "deal")).toBe($(70000));
  });
});

describe("payment lag", () => {
  const paid = (n: number, late: number): { commitments: Commitment[]; settlements: Settlement[] } => {
    const commitments: Commitment[] = [];
    const settlements: Settlement[] = [];
    for (let i = 0; i < n; i++) {
      const due = addDays("2026-01-01", i * 10);
      commitments.push(com(`p${i}`, { type: "invoice", partyId: "cust", amount: $(1), settlement: "paid", anchors: { due } }));
      settlements.push({ id: `s${i}`, commitmentId: `p${i}`, partyId: "cust", amount: $(1), currency: "USD", date: addDays(due, late), sourceRef: src });
    }
    return { commitments, settlements };
  };

  it("shrinks toward the profile default with little history", () => {
    const r = { ...empty(), ...paid(1, 30) };
    const lag = partyLag(r, { ...profile, defaultLagDays: 10 }, "cust");
    expect(lag.days).toBe(Math.floor((1 * 30 + 3 * 10) / 4 + 0.5)); // 15
    expect(lag.n).toBe(1);
  });

  it("uses what history exists: one or two payments still count, with low confidence and the sample count shown", () => {
    const p = { ...profile, defaultLagDays: 20 };
    const none = partyLag(empty(), p, "cust");
    const one = partyLag({ ...empty(), ...paid(1, 0) }, p, "cust");
    const two = partyLag({ ...empty(), ...paid(2, 0) }, p, "cust");
    const many = partyLag({ ...empty(), ...paid(12, 0) }, p, "cust");
    expect([none.days, one.days, two.days, many.days]).toEqual([20, 15, 12, 4]); // each payment pulls toward the customer's real behavior
    expect(none.confidence).toBeLessThan(one.confidence);
    expect(one.confidence).toBeLessThan(two.confidence);
    expect(two.confidence).toBeLessThan(many.confidence);
    expect(one.basis).toMatch(/last 1 payment,/);
    expect(two.basis).toMatch(/last 2 payments/);
    expect(none.basis).toMatch(/no payment history/);
  });

  it("uses the median and says how many payments it saw", () => {
    const r = { ...empty(), ...paid(12, 20) };
    const lag = partyLag(r, { ...profile, defaultLagDays: 0 }, "cust");
    expect(lag.days).toBe(16); // (12*20)/(15)
    expect(lag.basis).toMatch(/last 12 payments/);
  });

  it("a confirmed rule replaces the model; an unconfirmed one does not", () => {
    const r = { ...empty(), ...paid(5, 20) };
    r.rules = [{ id: "rule-1", scope: { partyId: "cust" }, kind: "lag_offset", params: { offsetDays: 3 }, fromNote: "pays in 3 days", state: "proposed" }];
    expect(partyLag(r, profile, "cust").ruleId).toBeUndefined();
    r.rules[0]!.state = "confirmed";
    expect(partyLag(r, profile, "cust")).toMatchObject({ days: 3, ruleId: "rule-1" });
  });

  it("dates a receivable at due + lag and records it in basis", () => {
    const r = empty();
    r.balances = [bal(0)];
    r.commitments = [com("inv", { type: "invoice", partyId: "nobody", amount: $(10), anchors: { due: "2026-11-01" } })];
    const run = forecast(r, { ...profile, defaultLagDays: 20 }, base, "2026-10-25", {});
    expect(run.events[0]?.date).toBe("2026-11-21");
    expect(run.events[0]?.basis).toMatch(/profile default/);
  });

  it("payables stay on their due dates", () => {
    const r = empty();
    r.balances = [bal(0)];
    r.commitments = [com("bill", { type: "bill", partyId: "s", amount: $(10), anchors: { due: "2026-11-01" } })];
    expect(forecast(r, { ...profile, defaultLagDays: 20 }, base, "2026-10-25", {}).events[0]?.date).toBe("2026-11-01");
  });
});

describe("recurrence, overdue, possible, signals", () => {
  it("respects end dates and clamps month-end days", () => {
    const r = empty();
    r.balances = [bal($(100000))];
    const p: Profile = { ...profile, recurring: [{ id: "rent", name: "Rent", amount: $(1000), cadence: "monthly", anchor: "2026-01-31", endDate: "2026-12-30", category: "rent" }] };
    const dates = forecast(r, p, base, "2026-10-25", {}).events.map((e) => e.date);
    expect(dates).toEqual(["2026-10-31", "2026-11-30"]);
  });

  it("overdue receivables keep their date, warn, and stay out of the balance", () => {
    const r = empty();
    r.balances = [bal($(100))];
    r.commitments = [com("old", { type: "invoice", amount: $(500), anchors: { due: "2026-10-01" } })];
    const run = forecast(r, profile, base, "2026-10-25", {});
    expect(run.warnings.join(" ")).toMatch(/Overdue/);
    expect(run.days.at(-1)?.closing).toBe($(100));
    expect(run.events[0]?.date).toBe("2026-10-01");
  });

  it("overdue unpaid bills stay in the balance on asOf, tagged and warned (#61)", () => {
    const r = empty();
    r.balances = [bal($(100000), "2026-10-26")];
    r.commitments = [com("bill-old", { type: "bill", amount: $(80000), anchors: { due: "2026-10-20" } })];
    const run = forecast(r, profile, base, "2026-10-26", {});
    expect(closing(run, "2026-10-26")).toBe($(20000));
    const e = run.events.find((x) => x.commitmentId === "bill-old")!;
    expect(e.date).toBe("2026-10-26");
    expect(e.basis).toMatch(/overdue since 2026-10-20, assumed payable now/);
    expect(run.warnings.join(" ")).toMatch(/Overdue: .*payment dated Oct 20/);
    // Safety ($5,000) is breached on day one once the bill is a little bigger.
    r.commitments = [com("bill-old", { type: "bill", amount: $(96000), anchors: { due: "2026-10-20" } })];
    expect(forecast(r, profile, base, "2026-10-26", {}).firstBelowSafety).toBe("2026-10-26");
  });

  it("overdue bills that are paid or only possible do not roll into the balance", () => {
    const r = empty();
    r.balances = [bal($(100000), "2026-10-26")];
    r.commitments = [
      com("bill-paid", { type: "bill", amount: $(1000), settlement: "paid", anchors: { due: "2026-10-20" } }),
      com("bill-maybe", { type: "bill", amount: $(2000), status: "possible", anchors: { due: "2026-10-20" } }),
    ];
    const run = forecast(r, profile, base, "2026-10-26", {});
    expect(run.days.at(-1)?.closing).toBe($(100000));
  });

  it("deferring an overdue bill counts the days from asOf", () => {
    const r = empty();
    r.balances = [bal($(100000), "2026-10-26")];
    r.commitments = [com("bill-old", { type: "bill", amount: $(80000), anchors: { due: "2026-10-20" } })];
    const sim = simulate(r, profile, [], [{ kind: "defer", commitmentId: "bill-old", days: 3 }], "2026-10-26", {});
    expect(sim.run.events.find((x) => x.commitmentId === "bill-old")?.date).toBe("2026-10-29");
    expect(closing(sim.run, "2026-10-28")).toBe($(100000));
    expect(closing(sim.run, "2026-10-29")).toBe($(20000));
  });

  it("stress never makes an overdue receipt come back into the horizon (#60)", () => {
    const r = empty();
    r.balances = [bal($(100000), "2026-10-26")];
    r.commitments = [
      com("inv-old", { type: "invoice", amount: $(50000), anchors: { due: "2026-10-23" } }),
      com("bill", { type: "bill", amount: $(106000), anchors: { due: "2026-11-02" } }),
    ];
    const b = forecast(r, profile, base, "2026-10-26", {});
    const s = forecast(r, profile, stress, "2026-10-26", {});
    expect(b.lowPoint.amount).toBe($(-6000));
    expect(s.lowPoint.amount).toBeLessThanOrEqual(b.lowPoint.amount);
    const old = s.events.find((x) => x.commitmentId === "inv-old")!;
    expect(old.date).toBe("2026-10-23");
    expect(old.overriddenBy ?? []).not.toContain("stress");
  });

  it("stress delays customer receipts but not card/POS daily sales (#69)", () => {
    const r = empty();
    r.balances = [bal($(1000), "2026-10-26")];
    r.events = [{ id: "sale-1", date: "2026-10-20", amount: $(2800), currency: "USD", direction: "in", category: "sales", basis: "pos", sourceRef: src } as CashEvent];
    r.commitments = [com("inv-cust", { type: "invoice", amount: $(500), anchors: { due: "2026-10-28" } })];
    const p: Profile = { ...profile, revenueModel: { kind: "dailySales", weekdayWeights: [1, 1, 1, 1, 1, 1, 1] } };
    const b = forecast(r, p, base, "2026-10-26", {});
    const s = forecast(r, p, stress, "2026-10-26", {});
    const sales = (x: typeof b) => x.events.filter((e) => e.commitmentId === "daily-sales").map((e) => `${e.date}:${e.amount}`);
    expect(sales(s).length).toBeGreaterThan(0);
    expect(sales(s)).toEqual(sales(b));
    expect(s.events.find((e) => e.commitmentId === "inv-cust")?.date).toBe("2026-11-04");
  });

  it("possible deals stay out of the main line and feed only the pipeline band", () => {
    const r = empty();
    r.balances = [bal($(100))];
    r.commitments = [com("rfq", { type: "sales_deal", status: "possible", probability: 0.5, amount: $(1000), anchors: { due: "2026-11-02" } })];
    const run = forecast(r, profile, base, "2026-10-25", {});
    expect(run.days.at(-1)?.closing).toBe($(100));
    expect(run.weeks.at(-1)?.pipelineClosing).toBe($(600));
    expect(run.days.find((d) => d.date === "2026-11-01")?.pipeline).toBe($(100));
    expect(run.days.find((d) => d.date === "2026-11-02")?.pipeline).toBe($(600));
    expect(run.days.at(-1)?.pipeline).toBe($(600));
  });

  it("daily pipeline includes weighted possible costs and receipts without changing cash or safety", () => {
    const r = empty();
    r.balances = [bal($(100))];
    r.commitments = [
      com("rfq-cost", { type: "bill", status: "possible", probability: 0.5, amount: 10001, anchors: { due: "2026-10-28" } }),
      com("rfq-sale", { type: "sales_deal", status: "possible", probability: 0.5, amount: 20001, anchors: { due: "2026-11-02" } }),
      com("bill", { type: "bill", amount: $(20), anchors: { due: "2026-10-30" } }),
    ];
    const run = forecast(r, profile, base, "2026-10-25", {});
    // Per-event cent rounding: -10001 * 0.5 = -5000; +20001 * 0.5 = +10001.
    expect(run.days.find((d) => d.date === "2026-10-28")).toMatchObject({ closing: 10000, pipeline: 5000 });
    expect(run.days.find((d) => d.date === "2026-10-30")).toMatchObject({ closing: 8000, pipeline: 3000 });
    expect(run.days.find((d) => d.date === "2026-11-02")).toMatchObject({ closing: 8000, pipeline: 13001 });
    expect(run.lowPoint.amount).toBe(8000);
    expect(run.days.flatMap((d) => d.eventIds)).not.toContain("evt-rfq-cost-0");
    expect(run.days.every((d) => Number.isInteger(d.pipeline))).toBe(true);
    for (const w of run.weeks) {
      const last = run.days.filter((d) => mondayOf(d.date) === w.start).at(-1)!;
      expect(w.pipelineClosing).toBe(last.pipeline);
    }
  });

  it("daily pipeline equals cash when no possible amount has a probability", () => {
    const r = empty();
    r.balances = [bal($(100))];
    r.commitments = [com("rfq", { type: "sales_deal", status: "possible", amount: $(1000), anchors: { due: "2026-11-02" } })];
    const run = forecast(r, profile, base, "2026-10-25", {});
    expect(run.days.every((d) => d.pipeline === d.closing)).toBe(true);
    expect(run.warnings.join(" ")).toMatch(/without a probability/);
  });

  it("applied date_change signals move the date; proposed ones do not", () => {
    const r = empty();
    r.balances = [bal(0)];
    r.commitments = [com("inv", { type: "invoice", amount: $(10), anchors: { due: "2026-10-30" } })];
    r.signals = [{ id: "sig-1", channel: "email", receivedAt: "2026-10-25T00:00:00Z", commitmentId: "inv", claim: { kind: "date_change", newDate: "2026-11-03" }, confidence: 0.9, state: "proposed", sourceRef: src }];
    expect(forecast(r, profile, base, "2026-10-25", {}).events[0]?.date).toBe("2026-10-30");
    r.signals[0]!.state = "applied";
    const e = forecast(r, profile, base, "2026-10-25", {}).events[0];
    expect(e?.date).toBe("2026-11-03");
    expect(e?.overriddenBy).toContain("sig-1");
  });

  it("flags same-day ordering when receipts rescue a payment", () => {
    const r = empty();
    r.balances = [bal($(100))];
    r.commitments = [
      com("bill", { type: "bill", amount: $(150), anchors: { due: "2026-10-28" } }),
      com("inv", { type: "invoice", amount: $(200), anchors: { due: "2026-10-28" } }),
    ];
    expect(forecast(r, profile, base, "2026-10-25", {}).warnings.join(" ")).toMatch(/intraday ordering/);
  });

  it("foreign currency without a rate is excluded with a warning, never 1:1", () => {
    const r = empty();
    r.balances = [bal(0)];
    r.commitments = [com("eur", { type: "bill", currency: "EUR", amount: $(100), anchors: { due: "2026-11-01" } })];
    const run = forecast(r, profile, base, "2026-10-25", {});
    expect(run.events).toEqual([]);
    expect(run.warnings.join(" ")).toMatch(/no FX rate for EUR/);
    expect(forecast(r, profile, base, "2026-10-25", { EUR: 1.1 }).events[0]?.amountBase).toBe($(110));
  });
});

describe("review regressions", () => {
  const dealProfile: Profile = {
    ...profile,
    paymentPatterns: [
      ...profile.paymentPatterns,
      { id: "supplier_cost", appliesTo: "purchase_order", legs: [{ share: 1, anchor: "due", offsetDays: 0, direction: "out" }] },
      { id: "deal", appliesTo: "sales_deal", isDefault: true, legs: [{ share: 1, anchor: "due", offsetDays: 0, direction: "in" }], linkedCosts: [{ patternId: "supplier_cost", share: 0.6 }] },
    ],
  };
  const deal = (o: Partial<Commitment> = {}) => com("deal1", { type: "sales_deal", amount: $(1000), anchors: { due: "2026-11-10" }, ...o });
  const run = (cs: Commitment[], extra: Partial<Records> = {}) => {
    const r = { ...empty(), balances: [bal($(100))], commitments: cs, ...extra };
    return forecast(r, dealProfile, base, "2026-10-25", {});
  };
  const costOut = (r: ReturnType<typeof run>) => r.events.filter((e) => e.direction === "out").reduce((a, e) => a + e.amount, 0);

  it("linked supplier cost is in the forecast and stops when the deal is cancelled or paid", () => {
    expect(costOut(run([deal()]))).toBe($(600));
    expect(costOut(run([deal({ settlement: "cancelled" })]))).toBe(0);
    expect(costOut(run([deal({ settlement: "paid" })]))).toBe(0);
  });

  it("an applied cancel signal drops the deal and its linked cost", () => {
    const signals: Records["signals"] = [{ id: "s", channel: "owner", receivedAt: "2026-10-25T00:00:00Z", commitmentId: "deal1", claim: { kind: "cancel" }, confidence: 1, state: "applied", sourceRef: src }];
    expect(run([deal()], { signals }).events).toEqual([]);
  });

  it("an amount_change signal rescales the linked cost too", () => {
    const signals: Records["signals"] = [{ id: "s", channel: "owner", receivedAt: "2026-10-25T00:00:00Z", commitmentId: "deal1", claim: { kind: "amount_change", newAmount: $(500) }, confidence: 1, state: "applied", sourceRef: src }];
    expect(costOut(run([deal()], { signals }))).toBe($(300));
  });

  it("a linked invoice does not erase the supplier cost; a linked PO does", () => {
    const inv = com("inv1", { type: "invoice", amount: $(400), anchors: { due: "2026-11-10" } });
    expect(costOut(run([deal({ linkedCommitmentIds: ["inv1"] }), inv]))).toBe($(600));
    const po = com("po1", { type: "purchase_order", patternId: "supplier_cost", direction: "out", amount: $(600), anchors: { due: "2026-11-05" } });
    expect(costOut(run([deal({ linkedCommitmentIds: ["po1"] }), po]))).toBe($(600)); // only the real PO, not a second virtual one
  });

  it("input order of signals, rules and settlements does not change the run", () => {
    const mk = (id: string, newDate: string, at: string): Records["signals"][number] => ({ id, channel: "owner", receivedAt: at, commitmentId: "inv", claim: { kind: "date_change", newDate }, confidence: 1, state: "applied", sourceRef: src });
    const a = mk("a", "2026-11-12", "2026-10-25T01:00:00Z");
    const b = mk("b", "2026-11-20", "2026-10-25T02:00:00Z");
    const r1 = { ...empty(), balances: [bal(0)], commitments: [com("inv", { type: "invoice", amount: $(10), anchors: { due: "2026-10-30" } })], signals: [a, b] };
    const r2 = { ...r1, signals: [b, a] };
    const x = forecast(r1, profile, base, "2026-10-25", {});
    const y = forecast(r2, profile, base, "2026-10-25", {});
    expect(x).toEqual(y);
    expect(x.events[0]?.date).toBe("2026-11-20"); // the later message wins
  });

  it("stress delay comes from the profile", () => {
    const { records, profile: p } = demo();
    const run10 = forecast(records, { ...p, thresholds: { ...p.thresholds, stressDelayDays: 10 } }, stress, "2026-10-25", {});
    expect(run10.events.find((e) => e.commitmentId === "inv-customer")?.date).toBe("2026-11-09");
  });
});

describe("levers act on one leg, in the right direction", () => {
  const dealPattern: Profile["paymentPatterns"][number] = {
    id: "deal", appliesTo: "sales_deal", isDefault: true,
    legs: [{ share: 0.3, anchor: "order", offsetDays: 0, direction: "in" }, { share: 0.7, anchor: "delivery", offsetDays: 0, direction: "in" }],
  };
  const p: Profile = {
    ...profile,
    paymentPatterns: [...profile.paymentPatterns, dealPattern],
    recurring: [
      { id: "rec-payroll", name: "Payroll", amount: $(1000), cadence: "weekly", anchor: "2026-10-30", category: "payroll", nonDeferrable: true },
      { id: "rec-sub", name: "Software", amount: $(200), cadence: "weekly", anchor: "2026-10-30", category: "software" },
    ],
  };
  const sim = (records: Records, levers: Parameters<typeof simulate>[3]) => simulate(records, p, [], levers, "2026-10-25", {});
  const po = () => {
    const r = empty();
    r.balances = [bal($(100000))];
    r.commitments = [com("po", { type: "purchase_order", patternId: "split_50_50", amount: $(10000), anchors: { order: "2026-10-28", ship: "2026-11-10" } })];
    return r;
  };
  const dates = (run: { events: CashEvent[] }, id: string) => run.events.filter((e) => e.commitmentId === id).map((e) => `${e.legIndex}:${e.date}`);

  it("defer moves only the earliest remaining payment by default and keeps the other leg put", () => {
    const { run } = sim(po(), [{ kind: "defer", commitmentId: "po", days: 5 }]);
    expect(dates(run, "po")).toEqual(["0:2026-11-02", "1:2026-11-10"]);
  });

  it("defer with a legIndex moves that leg only", () => {
    const { run } = sim(po(), [{ kind: "defer", commitmentId: "po", days: 5, legIndex: 1 }]);
    expect(dates(run, "po")).toEqual(["0:2026-10-28", "1:2026-11-15"]);
  });

  it("chase moves one receipt leg, not the whole deal onto the assumed date", () => {
    const r = empty();
    r.balances = [bal(0)];
    r.commitments = [com("deal", { type: "sales_deal", amount: $(1000), anchors: { order: "2026-10-27", delivery: "2026-11-20" } })];
    const { run } = sim(r, [{ kind: "chase", commitmentId: "deal", assumeDate: "2026-10-26" }]);
    expect(dates(run, "deal")).toEqual(["0:2026-10-26", "1:2026-11-20"]);
  });

  it("chase ignores outflow legs and warns when there is nothing to chase", () => {
    const { run } = sim(po(), [{ kind: "chase", commitmentId: "po", assumeDate: "2026-10-26" }]);
    expect(dates(run, "po")).toEqual(["0:2026-10-28", "1:2026-11-10"]);
    expect(run.warnings.join(" ")).toMatch(/lever chase on po: no remaining receipt/);
  });

  it("chase never pulls a receipt later, so it skips legs already before the assumed date", () => {
    const r = empty();
    r.balances = [bal(0)];
    r.commitments = [com("deal", { type: "sales_deal", amount: $(1000), anchors: { order: "2026-10-28", delivery: "2026-11-20" } })];
    const { run } = sim(r, [{ kind: "chase", commitmentId: "deal", assumeDate: "2026-11-05" }]);
    expect(dates(run, "deal")).toEqual(["0:2026-10-28", "1:2026-11-05"]);
    const none = sim(r, [{ kind: "chase", commitmentId: "deal", assumeDate: "2026-12-01" }]);
    expect(dates(none.run, "deal")).toEqual(["0:2026-10-28", "1:2026-11-20"]);
    expect(none.lowPointDelta).toBe(0);
    expect(none.run.warnings.join(" ")).toMatch(/no remaining receipt later than Dec 1/);
  });

  it("a legIndex that matches nothing warns and changes nothing", () => {
    const s = sim(po(), [{ kind: "defer", commitmentId: "po", days: 5, legIndex: 9 }]);
    expect(dates(s.run, "po")).toEqual(["0:2026-10-28", "1:2026-11-10"]);
    expect(s.lowPointDelta).toBe(0);
    expect(s.run.warnings.join(" ")).toMatch(/no remaining payment/);
  });

  it("nonDeferrable also covers the same category under a different id (e.g. payroll found in the bank file)", () => {
    const r = empty();
    r.balances = [bal($(100000))];
    r.commitments = [com("payroll-bank", { type: "bill", category: "payroll", amount: $(500), anchors: { due: "2026-10-30" } })];
    const s = sim(r, [{ kind: "defer", commitmentId: "payroll-bank", days: 7 }]);
    expect(s.run.events.find((e) => e.commitmentId === "payroll-bank")?.date).toBe("2026-10-30");
    expect(s.run.warnings.join(" ")).toMatch(/nonDeferrable/);
  });

  it("defer on a recurring item moves the next occurrence only", () => {
    const { run } = sim(empty(), [{ kind: "defer", commitmentId: "rec-sub", days: 3 }]);
    const sub = run.events.filter((e) => e.commitmentId === "rec-sub").map((e) => e.date);
    expect(sub.slice(0, 3)).toEqual(["2026-11-02", "2026-11-06", "2026-11-13"]);
  });

  it("nonDeferrable items are never deferred, and the run says so", () => {
    const s = sim(empty(), [{ kind: "defer", commitmentId: "rec-payroll", days: 7 }]);
    expect(s.lowPointDelta).toBe(0);
    expect(s.run.events.find((e) => e.commitmentId === "rec-payroll")?.date).toBe("2026-10-30");
    expect(s.run.warnings.join(" ")).toMatch(/nonDeferrable/);
  });

  it("pay_early discount applies per outflow leg and never touches receipts", () => {
    const r = po();
    r.commitments = [{ ...r.commitments[0]!, discount: { pct: 2, byDate: "2026-11-30" } }];
    const { run } = sim(r, [{ kind: "pay_early", commitmentId: "po" }]);
    expect(run.events.filter((e) => e.commitmentId === "po").map((e) => [e.date, e.amount])).toEqual([["2026-10-25", $(4900)], ["2026-10-25", $(4900)]]);
    expect(run.events.every((e) => e.direction === "out")).toBe(true);
  });

  it("pay_early after the discount date moves the date but keeps the amount", () => {
    const r = po();
    r.commitments = [{ ...r.commitments[0]!, discount: { pct: 2, byDate: "2026-10-01" } }];
    const { run } = sim(r, [{ kind: "pay_early", commitmentId: "po" }]);
    expect(run.events.filter((e) => e.commitmentId === "po").map((e) => e.amount)).toEqual([$(5000), $(5000)]);
  });
});

describe("horizon and weeks", () => {
  it("buckets Monday-Sunday with a partial first week and a Monday + 13*7 end", () => {
    const r = empty();
    r.balances = [bal(0)];
    const run = forecast(r, profile, base, "2026-10-25", {}); // a Sunday
    expect(run.weeks).toHaveLength(13); // the partial first week counts as one of the 13
    expect(run.weeks[0]?.start).toBe(mondayOf("2026-10-25"));
    expect(run.days[0]?.date).toBe("2026-10-25");
    expect(run.days.at(-1)?.date).toBe(addDays("2026-10-19", 90)); // Sunday Jan 17
  });
});

describe("recurring items, pattern fallback, daily-sales coverage (#62 #75 #66 #68)", () => {
  const rent: Profile["recurring"][number] = { id: "rent", name: "Rent", amount: $(1000), cadence: "monthly", anchor: "2026-12-01", category: "rent" };
  const rentOf = (run: { events: CashEvent[] }) => run.events.filter((e) => e.commitmentId === "rent").map((e) => `${e.legIndex}:${e.date}:${e.amount}`);
  const withBal = () => {
    const r = empty();
    r.balances = [bal($(100000))];
    return r;
  };

  it("#75 an anchor after asOf is a phase: earlier occurrences are forecast, legIndex counts from the anchor", () => {
    const run = forecast(withBal(), { ...profile, recurring: [rent] }, base, "2026-10-25", {});
    expect(rentOf(run)).toEqual([`-1:2026-11-01:${$(1000)}`, `0:2026-12-01:${$(1000)}`, `1:2027-01-01:${$(1000)}`]);
    const pay: Profile["recurring"][number] = { id: "pay", name: "Payroll", amount: $(500), cadence: "biweekly", anchor: "2026-11-13", category: "payroll" };
    const p = forecast(withBal(), { ...profile, recurring: [pay] }, base, "2026-10-25", {});
    expect(p.events.filter((e) => e.commitmentId === "pay").slice(0, 2).map((e) => `${e.legIndex}:${e.date}`)).toEqual(["-1:2026-10-30", "0:2026-11-13"]);
  });

  it("#75 startDate and endDate bound the projection", () => {
    const run = forecast(withBal(), { ...profile, recurring: [{ ...rent, startDate: "2026-12-01", endDate: "2026-12-31" }] }, base, "2026-10-25", {});
    expect(rentOf(run)).toEqual([`0:2026-12-01:${$(1000)}`]);
  });

  it("#75 semimonthly before the anchor uses stable 2n / 2n+1 indexes", () => {
    const semi: Profile["recurring"][number] = { id: "rent", name: "Pay", amount: $(10), cadence: "semimonthly", anchor: "2026-12-01", secondDay: 15, endDate: "2026-12-15", category: "payroll" };
    const run = forecast(withBal(), { ...profile, recurring: [semi] }, base, "2026-10-25", {});
    expect(rentOf(run).map((s) => s.split(":").slice(0, 2).join(":"))).toEqual(["-2:2026-11-01", "-1:2026-11-15", "0:2026-12-01", "1:2026-12-15"]);
  });

  it("#62 a commitment with a profile recurring id overrides amount and anchor but keeps the cadence", () => {
    const r = withBal();
    r.commitments = [com("rent", { type: "recurring", amount: $(1200), category: "rent", anchors: { due: "2026-11-05" } })];
    const run = forecast(r, { ...profile, recurring: [rent] }, base, "2026-10-25", {});
    expect(rentOf(run)).toEqual([`-1:2026-11-05:${$(1200)}`, `0:2026-12-05:${$(1200)}`, `1:2027-01-05:${$(1200)}`]);
    expect(run.events.find((e) => e.commitmentId === "rent")?.sourceRef).toEqual(src);
  });

  it("#62 legIndex counts from the profile anchor, so a re-import that moves the due date keeps override targets", () => {
    const at = (due: string) => {
      const r = withBal();
      r.commitments = [com("rent", { type: "recurring", amount: $(1200), category: "rent", anchors: { due } })];
      return forecast(r, { ...profile, recurring: [rent] }, base, "2026-10-25", {}).events.find((e) => e.commitmentId === "rent" && e.date === "2026-12-05")?.legIndex;
    };
    expect(at("2026-11-05")).toBe(0);
    expect(at("2026-12-05")).toBe(0);
    const weekly: Profile["recurring"][number] = { id: "rent", name: "Pay", amount: $(10), cadence: "weekly", anchor: "2026-11-02", category: "payroll" };
    const w = (due: string) => {
      const r = withBal();
      r.commitments = [com("rent", { type: "recurring", amount: $(10), anchors: { due } })];
      return forecast(r, { ...profile, recurring: [weekly] }, base, "2026-10-25", {}).events.filter((e) => e.commitmentId === "rent").map((e) => `${e.legIndex}:${e.date}`).slice(0, 2);
    };
    expect(w("2026-11-04")).toEqual(["-1:2026-10-28", "0:2026-11-04"]);
    expect(w("2026-11-11")).toEqual(["-1:2026-10-28", "0:2026-11-04"]);
  });

  it("#62 a paid or credited matched commitment drops only its own occurrence", () => {
    for (const settlement of ["paid", "credited"] as const) {
      const r = withBal();
      r.commitments = [com("rent", { type: "recurring", amount: $(1200), category: "rent", anchors: { due: "2026-11-01" }, settlement })];
      const run = forecast(r, { ...profile, recurring: [rent] }, base, "2026-10-25", {});
      expect(rentOf(run)).toEqual([`0:2026-12-01:${$(1200)}`, `1:2027-01-01:${$(1200)}`]);
    }
  });

  it("#62 a cancelled matched commitment ends the series from its due date and warns", () => {
    const r = withBal();
    r.commitments = [com("rent", { type: "recurring", amount: $(1000), category: "rent", anchors: { due: "2026-12-01" }, settlement: "cancelled" })];
    const run = forecast(r, { ...profile, recurring: [rent] }, base, "2026-10-25", {});
    expect(rentOf(run)).toEqual([`-1:2026-11-01:${$(1000)}`]);
    expect(run.warnings.join(" ")).toMatch(/rent: recurring Rent is cancelled from Dec 1.*needs review/);
  });

  it("#62 an actual matched commitment projects committed occurrences", () => {
    const r = withBal();
    r.commitments = [com("rent", { type: "recurring", amount: $(1000), category: "rent", status: "actual", anchors: { due: "2026-10-01" } })];
    const run = forecast(r, { ...profile, recurring: [rent] }, base, "2026-10-25", {});
    const evs = run.events.filter((e) => e.commitmentId === "rent");
    expect(evs.length).toBe(3);
    expect(evs.every((e) => e.status === "committed")).toBe(true);
  });

  it("#62 without a due date the commitment overrides the amount only and keeps the profile anchor", () => {
    const r = withBal();
    r.commitments = [com("rent", { type: "recurring", amount: $(1200), category: "rent" })];
    const run = forecast(r, { ...profile, recurring: [rent] }, base, "2026-10-25", {});
    expect(rentOf(run)).toEqual([`-1:2026-11-01:${$(1200)}`, `0:2026-12-01:${$(1200)}`, `1:2027-01-01:${$(1200)}`]);
  });

  it("#62 a recurring commitment that yields no events warns", () => {
    const r = withBal();
    r.commitments = [com("gym", { type: "recurring", amount: $(50) })];
    const run = forecast(r, profile, base, "2026-10-25", {});
    expect(run.warnings.join(" ")).toMatch(/gym: recurring commitment has no due date/);
  });

  it("#66 an unknown patternId warns and falls back to the type default, saying so in basis", () => {
    const r = withBal();
    const deal: Profile["paymentPatterns"][number] = {
      id: "deal", appliesTo: "sales_deal", isDefault: true,
      legs: [{ share: 0.3, anchor: "order", offsetDays: 0, direction: "in" }, { share: 0.7, anchor: "delivery", offsetDays: 0, direction: "in" }],
    };
    r.commitments = [com("d1", { type: "sales_deal", patternId: "typo", amount: $(1000), anchors: { order: "2026-10-28", delivery: "2026-11-20" } })];
    const run = forecast(r, { ...profile, paymentPatterns: [...profile.paymentPatterns, deal] }, base, "2026-10-25", {});
    const evs = run.events.filter((e) => e.commitmentId === "d1");
    expect(evs.map((e) => e.amount)).toEqual([$(300), $(700)]);
    expect(evs[0]?.basis).toMatch(/unknown pattern typo; used default deal/);
    expect(run.warnings.join(" ")).toMatch(/d1: unknown payment pattern typo; used the sales_deal default deal \(needs review\)/);
  });

  it("#68 the daily-sales average divides by the days of history covered and warns when short", () => {
    const p: Profile = { ...profile, revenueModel: { kind: "dailySales", weekdayWeights: [1, 1, 1, 1, 1, 1, 1] } };
    const sale = (date: string): CashEvent => ({ id: `s-${date}`, legIndex: 0, date, amount: $(700), currency: "USD", amountBase: $(700), direction: "in", status: "actual", confidence: 1, basis: "bank", category: "sales", sourceRef: src });
    const r = withBal();
    r.events = Array.from({ length: 7 }, (_, i) => sale(addDays("2026-10-18", i)));
    const run = forecast(r, p, base, "2026-10-25", {});
    expect(run.events.find((e) => e.commitmentId === "daily-sales")?.amount).toBe($(700));
    expect(run.warnings.join(" ")).toMatch(/covers only 7 days/);
    const full = withBal();
    full.events = Array.from({ length: 28 }, (_, i) => sale(addDays("2026-09-27", i)));
    const f = forecast(full, p, base, "2026-10-25", {});
    expect(f.events.find((e) => e.commitmentId === "daily-sales")?.amount).toBe($(700));
    expect(f.warnings.join(" ")).not.toMatch(/covers only/);
  });

  it("#68 a single Saturday receipt forecasts the same Saturday amount, weighted by weekday", () => {
    const p: Profile = { ...profile, revenueModel: { kind: "dailySales", weekdayWeights: [1, 1, 1, 1, 1, 2, 1] } };
    const r = withBal();
    r.events = [{ id: "s-sat", legIndex: 0, date: "2026-10-24", amount: $(800), currency: "USD", amountBase: $(800), direction: "in", status: "actual", confidence: 1, basis: "bank", category: "sales", sourceRef: src }];
    const sales = forecast(r, p, base, "2026-10-25", {}).events.filter((e) => e.commitmentId === "daily-sales");
    expect(sales.find((e) => e.date === "2026-10-31")?.amount).toBe($(800)); // Saturday
    expect(sales.find((e) => e.date === "2026-10-26")?.amount).toBe($(400)); // Monday
  });

  it("#66/#62 settled commitments do not warn about patterns or missing due dates", () => {
    const r = withBal();
    r.commitments = [
      com("d1", { type: "sales_deal", patternId: "typo", amount: $(10), settlement: "paid" }),
      com("gym", { type: "recurring", amount: $(50), settlement: "cancelled" }),
    ];
    const w = forecast(r, profile, base, "2026-10-25", {}).warnings.join(" ");
    expect(w).not.toMatch(/unknown payment pattern|no due date/);
  });
});

describe("overdue outflows: what rolls to asOf and what does not", () => {
  const asOf = "2026-11-16";

  it("a deal's past-dated virtual linked costs stay out of the balance, warned", () => {
    const p: Profile = {
      ...profile,
      paymentPatterns: [
        { id: "supplier_cost", appliesTo: "purchase_order", legs: [{ share: 1, anchor: "order", offsetDays: 0, direction: "out" }] },
        { id: "deal", appliesTo: "sales_deal", isDefault: true, legs: [{ share: 0.3, anchor: "order", offsetDays: 0, direction: "in" }, { share: 0.7, anchor: "due", offsetDays: 0, direction: "in" }], linkedCosts: [{ patternId: "supplier_cost", share: 0.55 }] },
      ],
    };
    const r = { ...empty(), balances: [bal($(100000), asOf)], commitments: [com("deal1", { type: "sales_deal", amount: $(100000), anchors: { order: "2026-10-01", due: "2027-03-01" } })] };
    const run = forecast(r, p, base, asOf, {});
    const cost = run.events.filter((e) => e.commitmentId?.startsWith("deal1~"));
    expect(cost.length).toBeGreaterThan(0);
    for (const e of cost) expect(e.date < asOf).toBe(true);
    expect(closing(run, asOf)).toBe($(100000));
    expect(run.warnings.join(" ")).toMatch(/past-dated linked\/estimated cost, not counted/);
  });

  it("a past-dated leg from an estimated anchor is not rolled", () => {
    const p: Profile = {
      ...profile,
      leadTimes: { productionDays: 10 },
      paymentPatterns: [{ id: "po", appliesTo: "purchase_order", isDefault: true, legs: [{ share: 1, anchor: "ship", offsetDays: 0, direction: "out" }] }],
    };
    const r = { ...empty(), balances: [bal($(100000), asOf)], commitments: [com("po1", { type: "purchase_order", amount: $(1000), anchors: { order: "2026-10-01" } })] };
    const run = forecast(r, p, base, asOf, {});
    expect(run.events.find((e) => e.commitmentId === "po1")?.date).toBe("2026-10-11");
    expect(closing(run, asOf)).toBe($(100000));
  });

  it("a bank actual tagged to an unpaid overdue bill is not counted twice", () => {
    const r = empty();
    r.balances = [bal($(100000), "2026-11-10")];
    r.commitments = [com("bill-x", { type: "bill", amount: $(5000), anchors: { due: "2026-11-01" } })];
    r.events = [{ id: "bank-1", commitmentId: "bill-x", date: "2026-11-12", amount: $(5000), currency: "USD", direction: "out", basis: "bank", sourceRef: src } as CashEvent];
    const run = forecast(r, profile, base, asOf, {});
    expect(run.openingBalance).toBe($(95000));
    expect(closing(run, asOf)).toBe($(95000));
    expect(run.warnings.join(" ")).toMatch(/\$5,000\.00 paid per bank line bank-1 with no matching settlement in the books; deducted from what is expected \(needs reconciliation\)/);
  });

  it("partial bank cover rolls only the uncovered remainder", () => {
    const r = empty();
    r.balances = [bal($(100000), "2026-11-10")];
    r.commitments = [com("bill-x", { type: "bill", amount: $(5000), anchors: { due: "2026-11-01" } })];
    r.events = [{ id: "bank-1", commitmentId: "bill-x", date: "2026-11-12", amount: $(2000), currency: "USD", direction: "out", basis: "bank", sourceRef: src } as CashEvent];
    const run = forecast(r, profile, base, asOf, {});
    expect(closing(run, asOf)).toBe($(95000));
    expect(run.events.find((e) => e.commitmentId === "bill-x" && e.status !== "actual")?.amount).toBe($(3000));
  });

  it("a bank actual the books already count as paid does not hide the rest", () => {
    const r = empty();
    r.balances = [bal($(100000), "2026-11-10")];
    r.commitments = [com("bill-x", { type: "bill", amount: $(5000), outstanding: $(3000), anchors: { due: "2026-11-01" } })];
    r.events = [{ id: "bank-1", commitmentId: "bill-x", date: "2026-11-12", amount: $(2000), currency: "USD", direction: "out", basis: "bank", sourceRef: src } as CashEvent];
    const run = forecast(r, profile, base, asOf, {});
    expect(closing(run, asOf)).toBe($(95000));
  });

  it("a shiftDays override on an overdue bill counts from asOf; a date override is kept as given", () => {
    const r = { ...empty(), balances: [bal($(100000), asOf)], commitments: [com("bill-old", { type: "bill", amount: $(1000), anchors: { due: "2026-11-01" } })] };
    const shifted = forecast(r, profile, { id: "s1", kind: "base", overrides: [{ id: "o1", target: { commitmentId: "bill-old" }, change: { shiftDays: 3 }, origin: "owner" }] }, asOf, {});
    expect(shifted.events.find((e) => e.commitmentId === "bill-old")?.date).toBe("2026-11-19");
    const dated = forecast(r, profile, { id: "s2", kind: "base", overrides: [{ id: "o2", target: { commitmentId: "bill-old" }, change: { date: "2026-11-25" }, origin: "owner" }] }, asOf, {});
    expect(dated.events.find((e) => e.commitmentId === "bill-old")?.date).toBe("2026-11-25");
  });

  it("a date_change signal without a leg moves only the overdue first leg", () => {
    const p: Profile = { ...profile, paymentPatterns: [{ id: "two", appliesTo: "bill", isDefault: true, legs: [{ share: 0.5, anchor: "order", offsetDays: 0, direction: "out" }, { share: 0.5, anchor: "due", offsetDays: 0, direction: "out" }] }] };
    const r = empty();
    r.balances = [bal($(100000), asOf)];
    r.commitments = [com("bill2", { type: "bill", amount: $(1000), anchors: { order: "2026-10-01", due: "2026-12-01" } })];
    r.signals = [{ id: "sig-d", channel: "owner", receivedAt: "2026-11-15T00:00:00Z", commitmentId: "bill2", claim: { kind: "date_change", newDate: "2026-11-20" }, confidence: 1, state: "applied", sourceRef: src }];
    const run = forecast(r, p, base, asOf, {});
    expect(run.events.filter((e) => e.commitmentId === "bill2").map((e) => e.date).sort()).toEqual(["2026-11-20", "2026-12-01"]);
  });
});

describe("split lever (#39)", () => {
  const p: Profile = {
    ...profile,
    thresholds: { ...profile.thresholds, splitIntervalDays: 14 },
    recurring: [{ id: "rec-payroll", name: "Payroll", amount: $(1000), cadence: "weekly", anchor: "2026-10-30", category: "payroll", nonDeferrable: true }],
  };
  const asOf = "2026-10-25";
  const sim = (records: Records, levers: Parameters<typeof simulate>[3], prof: Profile = p) => simulate(records, prof, [], levers, asOf, {});
  const legs = (run: { events: CashEvent[] }, id: string) => run.events.filter((e) => e.commitmentId === id).map((e) => [e.id, e.date, e.amount] as const);
  const bill = (due = "2026-10-29", amount = 10001) => {
    const r = empty();
    r.balances = [bal($(15000))];
    r.commitments = [com("bill", { type: "bill", amount, anchors: { due } })];
    return r;
  };

  it("installments sum exactly to the leg, are spaced by the profile interval, and keep their source", () => {
    const s = sim(bill(), [{ kind: "split", commitmentId: "bill", shares: [1 / 3, 1 / 3, 1 / 3] }]);
    const orig = s.base.events.find((e) => e.commitmentId === "bill")!.id;
    const out = s.run.events.filter((e) => e.commitmentId === "bill");
    expect(out.map((e) => [e.id, e.date, e.amount])).toEqual([
      [`${orig}-split0`, "2026-10-29", 3333],
      [`${orig}-split1`, "2026-11-12", 3333],
      [`${orig}-split2`, "2026-11-26", 3335],
    ]);
    expect(out.reduce((a, e) => a + e.amount, 0)).toBe(10001);
    expect(out.reduce((a, e) => a + e.amountBase, 0)).toBe(10001);
    for (const e of out) {
      expect(e.overriddenBy).toContain("lever-split-bill");
      expect(e.basis).toMatch(/installment \d of 3/);
      expect(e.sourceRef).toEqual(src);
    }
  });

  it("uses 30 days when the profile has no splitIntervalDays", () => {
    const { run } = sim(bill(), [{ kind: "split", commitmentId: "bill", shares: [0.5, 0.5] }], { ...p, thresholds: profile.thresholds });
    expect(legs(run, "bill").map((x) => x[1])).toEqual(["2026-10-29", "2026-11-28"]);
  });

  it("splitting a payable raises the low point, and simulate reports it", () => {
    const r = bill("2026-10-29", $(20000));
    r.commitments.push(com("inv", { type: "invoice", amount: $(12000), anchors: { due: "2026-11-05" } }));
    const s = sim(r, [{ kind: "split", commitmentId: "bill", shares: [0.5, 0.5] }], { ...p, recurring: [] });
    expect(s.base.lowPoint.amount).toBe(-$(5000));
    expect(s.run.lowPoint.amount).toBe($(5000));
    expect(s.lowPointDelta).toBe($(10000));
    expect(s.lowPointDelta).toBeGreaterThan(0);
    expect(legs(s.base, "bill")).toHaveLength(1);
  });

  it("invalid shares warn and change nothing", () => {
    for (const shares of [[0.5, 0.4], [1.2, -0.2], [], [0.5, 0.5 + 1e-6]]) {
      const s = sim(bill(), [{ kind: "split", commitmentId: "bill", shares }]);
      expect(legs(s.run, "bill")).toEqual(legs(s.base, "bill"));
      expect(s.lowPointDelta).toBe(0);
      expect(s.run.warnings.join(" ")).toMatch(/lever split on bill skipped: shares must be positive and sum to 1/);
    }
    const ok = sim(bill(), [{ kind: "split", commitmentId: "bill", shares: [0.1, 0.2, 0.7] }]);
    expect(legs(ok.run, "bill")).toHaveLength(3);
  });

  it("nonDeferrable items are never split", () => {
    const s = sim(empty(), [{ kind: "split", commitmentId: "rec-payroll", shares: [0.5, 0.5] }]);
    expect(s.lowPointDelta).toBe(0);
    expect(legs(s.run, "rec-payroll")).toEqual(legs(s.base, "rec-payroll"));
    expect(s.run.warnings.join(" ")).toMatch(/lever split on rec-payroll skipped: marked nonDeferrable/);
  });

  it("a receivable splits its next receipt only, never an outflow", () => {
    const r = empty();
    r.balances = [bal(0)];
    r.commitments = [com("inv", { type: "invoice", amount: $(9000), anchors: { due: "2026-11-02" } })];
    const { run } = sim(r, [{ kind: "split", commitmentId: "inv", shares: [0.25, 0.75] }]);
    expect(legs(run, "inv").map((x) => [x[1], x[2]])).toEqual([["2026-11-02", $(2250)], ["2026-11-16", $(6750)]]);
    expect(run.events.filter((e) => e.commitmentId === "inv").every((e) => e.direction === "in")).toBe(true);
  });

  it("splits only the earliest remaining leg by default, or the named legIndex", () => {
    const r = empty();
    r.balances = [bal($(100000))];
    r.commitments = [com("po", { type: "purchase_order", patternId: "split_50_50", amount: $(10000), anchors: { order: "2026-10-28", ship: "2026-11-10" } })];
    const first = sim(r, [{ kind: "split", commitmentId: "po", shares: [0.5, 0.5] }]);
    expect(legs(first.run, "po").map((x) => [x[1], x[2]])).toEqual([["2026-10-28", $(2500)], ["2026-11-10", $(5000)], ["2026-11-11", $(2500)]]);
    const second = sim(r, [{ kind: "split", commitmentId: "po", shares: [0.5, 0.5], legIndex: 1 }]);
    expect(legs(second.run, "po").map((x) => [x[1], x[2]])).toEqual([["2026-10-28", $(5000)], ["2026-11-10", $(2500)], ["2026-11-24", $(2500)]]);
  });

  it("an overdue payment is not split (base applies bank-cover checks to it)", () => {
    const s = sim(bill("2026-10-10", $(3000)), [{ kind: "split", commitmentId: "bill", shares: [0.5, 0.5] }]);
    expect(legs(s.run, "bill")).toEqual(legs(s.base, "bill"));
    expect(s.lowPointDelta).toBe(0);
    expect(s.run.warnings.join(" ")).toMatch(/overdue payment; split skipped — check whether it is already paid/);
  });

  const deal = () => {
    const r = empty();
    r.balances = [bal(0)];
    r.commitments = [com("deal", { type: "sales_deal", amount: $(10000), anchors: { order: "2026-10-10", delivery: "2026-11-20" } })];
    return r;
  };
  const dp: Profile = {
    ...p,
    recurring: [],
    paymentPatterns: [...p.paymentPatterns, { id: "deal", appliesTo: "sales_deal", isDefault: true, legs: [{ share: 0.3, anchor: "order", offsetDays: 0, direction: "in" }, { share: 0.7, anchor: "delivery", offsetDays: 0, direction: "in" }] }],
  };

  it("with no legIndex, an overdue receipt is skipped and the earliest future receipt is split", () => {
    const { run } = sim(deal(), [{ kind: "split", commitmentId: "deal", shares: [0.5, 0.5] }], dp);
    expect(legs(run, "deal").map((x) => [x[1], x[2]])).toEqual([["2026-10-10", $(3000)], ["2026-11-20", $(3500)], ["2026-12-04", $(3500)]]);
  });

  it("a named overdue receipt starts one interval after asOf, never as instant cash", () => {
    const s = sim(deal(), [{ kind: "split", commitmentId: "deal", shares: [0.5, 0.5], legIndex: 0 }], dp);
    expect(legs(s.run, "deal").map((x) => [x[1], x[2]])).toEqual([["2026-11-08", $(1500)], ["2026-11-20", $(7000)], ["2026-11-22", $(1500)]]);
    expect(closing(s.run, asOf)).toBe(0);
  });

  it("a later lever acts on one installment: [split, pay_early] keeps the discount on every part, ids unique", () => {
    const r = bill("2026-11-20", $(10000));
    r.commitments = [{ ...r.commitments[0]!, discount: { pct: 2, byDate: "2026-11-30" } }];
    const { run } = sim(r, [{ kind: "split", commitmentId: "bill", shares: [0.5, 0.5] }, { kind: "pay_early", commitmentId: "bill" }], { ...p, recurring: [] });
    const out = run.events.filter((e) => e.commitmentId === "bill");
    expect(out.map((e) => [e.date, e.amount])).toEqual([[asOf, $(4900)], [asOf, $(4900)]]);
    expect(out.reduce((a, e) => a + e.amount, 0)).toBe($(9800));
    expect(new Set(run.events.map((e) => e.id)).size).toBe(run.events.length);
    const payIds = out.map((e) => e.overriddenBy!.find((x) => x.startsWith("lever-pay_early"))!);
    expect(new Set(payIds).size).toBe(2);
  });

  it("[split, defer 10] defers only the first installment by default", () => {
    const { run } = sim(bill("2026-11-02", $(10000)), [{ kind: "split", commitmentId: "bill", shares: [0.5, 0.5] }, { kind: "defer", commitmentId: "bill", days: 10 }]);
    expect(legs(run, "bill").map((x) => [x[1], x[2]])).toEqual([["2026-11-12", $(5000)], ["2026-11-16", $(5000)]]);
  });
});

describe("settlement / bank-line identity: a payment counts once (#96)", () => {
  const asOf = "2026-10-25";
  const bank = (id: string, date: string, amount: number, o: Partial<CashEvent> = {}): CashEvent => ({ id, commitmentId: "inv", legIndex: 0, date, amount, currency: "USD", amountBase: amount, direction: "in", status: "actual", confidence: 1, basis: "bank", sourceRef: src, ...o });
  const settle = (id: string, date: string, amount: number, o: Partial<Settlement> = {}): Settlement => ({ id, commitmentId: "inv", amount, currency: "USD", date, sourceRef: src, ...o });
  const expected = (run: ReturnType<typeof forecast>, id = "inv") => run.events.filter((e) => e.commitmentId === id && e.status !== "actual").map((e) => e.amount);
  const inv = (o: Partial<Commitment> = {}) => com("inv", { type: "invoice", amount: $(50), settlement: "partial", anchors: { due: "2026-10-27" }, ...o });

  it("TECHNICAL_PLAN 6, bank only: $100 + $20 tagged bank line + $30 expected = $150", () => {
    const r = { ...empty(), balances: [bal($(100))], commitments: [inv()], events: [bank("bank-1", "2026-10-26", $(20))] };
    const run = forecast(r, profile, base, asOf, {});
    expect(expected(run)).toEqual([$(30)]);
    expect(closing(run, "2026-10-28")).toBe($(150));
    expect(run.warnings.join(" ")).toMatch(/\$20\.00 paid per bank line bank-1 with no matching settlement in the books/);
  });

  it("TECHNICAL_PLAN 6, accounting only: a settlement inside the snapshot reduces what is expected once", () => {
    // The $20 landed on Oct 26; the Oct 27 snapshot of $120 already includes it, and no bank line is loaded.
    const r = { ...empty(), balances: [bal($(120), "2026-10-27")], commitments: [inv({ anchors: { due: "2026-10-29" } })], settlements: [settle("set-1", "2026-10-26", $(20))] };
    const run = forecast(r, profile, base, "2026-10-27", {});
    expect(expected(run)).toEqual([$(30)]);
    expect(closing(run, "2026-10-30")).toBe($(150));
  });

  it("TECHNICAL_PLAN 6, both: a settlement and its bank line a day apart count once", () => {
    const r = { ...empty(), balances: [bal($(100))], commitments: [inv()], settlements: [settle("set-1", "2026-10-25", $(20))], events: [bank("bank-1", "2026-10-26", $(20))] };
    const run = forecast(r, profile, base, asOf, {});
    expect(expected(run)).toEqual([$(30)]);
    expect(closing(run, "2026-10-28")).toBe($(150));
    expect(run.warnings.join(" ")).not.toMatch(/not seen in the bank|no matching settlement|double count/);
  });

  it("the same for a bill with outstanding set: books, bank, or both all give one payment", () => {
    const mk = (settlements: Settlement[], events: CashEvent[], outstanding?: number) =>
      forecast({ ...empty(), balances: [bal($(1000))], commitments: [com("inv", { type: "bill", amount: $(50), ...(outstanding === undefined ? {} : { outstanding }), anchors: { due: "2026-11-05" } })], settlements, events }, profile, base, asOf, {});
    const pay = bank("bank-1", "2026-10-28", $(20), { direction: "out" });
    for (const run of [mk([], [pay]), mk([settle("s", "2026-10-28", $(20))], [pay]), mk([], [pay], $(30)), mk([settle("s", "2026-10-27", $(20))], [pay], $(30))]) {
      expect(expected(run)).toEqual([$(30)]);
      expect(closing(run, "2026-11-06")).toBe($(950));
    }
  });

  it("a future-dated bill the bank already shows as paid is counted once, with or without a settlement", () => {
    const bill = com("bill-f", { type: "bill", amount: $(1000), anchors: { due: "2026-11-10" } });
    const paid = bank("bank-f", "2026-11-03", $(1000), { commitmentId: "bill-f", direction: "out" });
    for (const settlements of [[], [settle("set-f", "2026-11-02", $(1000), { commitmentId: "bill-f" })]]) {
      const run = forecast({ ...empty(), balances: [bal($(5000))], commitments: [bill], settlements, events: [paid] }, profile, base, asOf, {});
      expect(expected(run, "bill-f")).toEqual([]);
      expect(closing(run, "2026-11-11")).toBe($(4000));
    }
  });

  it("a tagged bank line reduces the earliest pattern leg, not only overdue ones", () => {
    const r = empty();
    r.balances = [bal($(100000))];
    r.commitments = [com("po", { type: "purchase_order", patternId: "split_50_50", amount: $(10000), anchors: { order: "2026-10-26", ship: "2026-11-10" } })];
    r.events = [bank("bank-po", "2026-10-26", $(5000), { commitmentId: "po", direction: "out" })];
    const run = forecast(r, profile, base, asOf, {});
    expect(run.events.filter((e) => e.commitmentId === "po" && e.status !== "actual").map((e) => [e.legIndex, e.amount])).toEqual([[1, $(5000)]]);
    expect(closing(run, "2026-11-11")).toBe($(90000));
  });

  it("two partial payments pair up greedily by date, each side used once", () => {
    const c = com("inv", { type: "invoice", amount: $(100), anchors: { due: "2026-11-10" } });
    const records = { ...empty(), settlements: [settle("s1", "2026-10-26", $(30)), settle("s2", "2026-10-28", $(30))], events: [bank("a1", "2026-10-27", $(30)), bank("a2", "2026-10-28", $(30))] };
    const m = matchPayments(c, records, "2027-01-25", []);
    expect(m.pairs.map((p) => `${p.settlement.id}=${p.actual.id}`)).toEqual(["s2=a2", "s1=a1"]);
    expect(m.settlements).toEqual([]);
    expect(m.actuals).toEqual([]);
    const run = forecast({ ...records, balances: [bal($(100))], commitments: [c] }, profile, base, asOf, {});
    expect(expected(run)).toEqual([$(40)]);
    expect(closing(run, "2026-11-11")).toBe($(200));
  });

  it(`dates more than ${SETTLEMENT_MATCH_DAYS} days apart are not the same payment`, () => {
    const c = inv();
    const m = matchPayments(c, { ...empty(), settlements: [settle("s1", "2026-10-26", $(20))], events: [bank("a1", "2026-10-30", $(20))] }, "2027-01-25", []);
    expect(m.pairs).toEqual([]);
  });

  it("an unmatched settlement and bank line (different amount or date) are one payment; the books' figure counts", () => {
    const r = { ...empty(), balances: [bal($(100))], commitments: [inv()], settlements: [settle("set-1", "2026-10-26", $(25))], events: [bank("bank-1", "2026-10-26", $(20))] };
    const run = forecast(r, profile, base, asOf, {});
    expect(expected(run)).toEqual([$(25)]);
    expect(run.warnings.join(" ")).toMatch(/settlement set-1 and bank line bank-1 differ \(amount\/date\); treated as one payment, counting the books' \$25\.00 \(needs reconciliation\)/);
    expect(run.warnings.join(" ")).not.toMatch(/double count|not seen in the bank/);
  });

  it("review A: outstanding set, settlement 10-16 and bank line 10-21 of $1,000 are one payment, $1,000 still expected", () => {
    const r = empty();
    r.balances = [bal($(5000), "2026-10-14")];
    r.commitments = [com("inv", { type: "bill", amount: $(2000), outstanding: $(1000), anchors: { due: "2026-11-05" } })];
    r.settlements = [settle("set-a", "2026-10-16", $(1000))];
    r.events = [bank("bank-a", "2026-10-21", $(1000), { direction: "out" })];
    const run = forecast(r, profile, base, asOf, {});
    expect(expected(run)).toEqual([$(1000)]);
    expect(closing(run, "2026-11-06")).toBe($(3000));
    expect(run.warnings.join(" ")).toMatch(/settlement set-a and bank line bank-a differ/);
  });

  it("review B: outstanding unset, settlement $1,000 and bank line $985 count as the books' $1,000", () => {
    const r = empty();
    r.balances = [bal($(5000))];
    r.commitments = [com("inv", { type: "invoice", amount: $(2000), anchors: { due: "2026-11-05" } })];
    r.settlements = [settle("set-b", "2026-10-26", $(1000))];
    r.events = [bank("bank-b", "2026-10-26", $(985))];
    const run = forecast(r, profile, base, asOf, {});
    expect(expected(run)).toEqual([$(1000)]);
  });

  it("review C: only actuals the run counts reduce what is expected (two accounts, ambiguous window)", () => {
    const snap = (account: string, amount: number, d: string) => ({ id: `bal-${account}`, account, amount, currency: "USD", asOf: d, sourceRef: src });
    const mk = (e: CashEvent, c: Commitment) => forecast({ ...empty(), balances: [snap("chk", $(1000), "2026-10-20"), snap("sav", $(1000), "2026-10-24")], commitments: [c], events: [e] }, profile, base, asOf, {});
    // An untagged bill payment between the two snapshot dates is counted in opening cash (conservative), so it pays the bill once.
    const bill = com("inv", { type: "bill", amount: $(300), anchors: { due: "2026-11-05" } });
    const paidOut = mk(bank("bank-c", "2026-10-22", $(300), { direction: "out" }), bill);
    expect(paidOut.openingBalance).toBe($(1700));
    expect(expected(paidOut)).toEqual([]);
    // An untagged receipt in the same window is left out of opening cash, so the invoice stays expected.
    const invoice = com("inv", { type: "invoice", amount: $(300), anchors: { due: "2026-11-05" } });
    const leftOut = mk(bank("bank-c", "2026-10-22", $(300)), invoice);
    expect(leftOut.openingBalance).toBe($(2000));
    expect(expected(leftOut)).toEqual([$(300)]);
  });

  it("a payment from an account with no snapshot does not cancel the bill", () => {
    const r = { ...empty(), balances: [bal($(1000))], commitments: [com("inv", { type: "bill", amount: $(300), anchors: { due: "2026-11-05" } })], events: [bank("card-1", "2026-10-26", $(300), { direction: "out", account: "card" })] };
    const run = forecast(r, profile, base, asOf, {});
    expect(expected(run)).toEqual([$(300)]);
    expect(closing(run, "2026-11-06")).toBe($(700));
  });

  it("an actual on the (exclusive) horizon end is not a payment toward the commitment", () => {
    const c = inv();
    const at = matchPayments(c, { ...empty(), events: [bank("a1", "2027-01-25", $(20))] }, "2027-01-25", []);
    const before = matchPayments(c, { ...empty(), events: [bank("a1", "2027-01-24", $(20))] }, "2027-01-25", []);
    expect(at.actuals).toEqual([]);
    expect(before.actuals.map((e) => e.id)).toEqual(["a1"]);
  });

  it("payments beyond the amount warn of a possible double count and name a same-party invoice the excess matches", () => {
    const r = empty();
    r.balances = [bal($(1000))];
    r.commitments = [
      com("inv", { type: "invoice", partyId: "p1", reference: "INV-1", amount: $(100), anchors: { due: "2026-11-05" } }),
      com("inv2", { type: "invoice", partyId: "p1", reference: "INV-2", amount: $(50), anchors: { due: "2026-11-05" } }),
    ];
    r.events = [bank("bank-1", "2026-10-26", $(150))];
    const run = forecast(r, profile, base, asOf, {});
    expect(expected(run)).toEqual([]);
    expect(expected(run, "inv2")).toEqual([$(50)]);
    expect(run.warnings.join(" ")).toMatch(/INV-1: payments recorded \(\$150\.00\) exceed the amount \(\$100\.00\); the extra \$50\.00 matches INV-2 of the same party, which bank line bank-1 may also pay; possible double count/);
  });

  it("with outstanding set, bank-only money beyond what the books reflect reduces further", () => {
    const run = forecast({ ...empty(), balances: [bal($(100))], commitments: [inv({ outstanding: $(25) })], events: [bank("bank-1", "2026-10-26", $(45))] }, profile, base, asOf, {});
    expect(expected(run)).toEqual([$(5)]);
    expect(run.warnings.join(" ")).toMatch(/\$20\.00 paid per bank line bank-1 is beyond what outstanding reflects/);
  });

  it("bank lines in the other direction or another currency do not count as payments", () => {
    const r = { ...empty(), balances: [bal($(100))], commitments: [inv()], events: [bank("refund", "2026-10-26", $(20), { direction: "out" }), bank("eur", "2026-10-26", $(20), { currency: "EUR" })] };
    const run = forecast(r, profile, base, asOf, { EUR: 1 });
    expect(expected(run)).toEqual([$(50)]);
    expect(run.warnings.join(" ")).toMatch(/bank line eur is in EUR, not USD/);
  });
});
