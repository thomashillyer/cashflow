import { describe, expect, it } from "vitest";
import type { CashEvent, Commitment, Records, Scenario, Settlement } from "../schema/records";
import type { Profile } from "../schema/profile";
import { forecast } from "./forecast";
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

  it("possible deals stay out of the main line and feed only the pipeline band", () => {
    const r = empty();
    r.balances = [bal($(100))];
    r.commitments = [com("rfq", { type: "sales_deal", status: "possible", probability: 0.5, amount: $(1000), anchors: { due: "2026-11-02" } })];
    const run = forecast(r, profile, base, "2026-10-25", {});
    expect(run.days.at(-1)?.closing).toBe($(100));
    expect(run.weeks.at(-1)?.pipelineClosing).toBe($(600));
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
    expect(none.run.warnings.join(" ")).toMatch(/no remaining receipt later than 2026-12-01/);
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
    expect(rentOf(run)).toEqual([`0:2026-11-05:${$(1200)}`, `1:2026-12-05:${$(1200)}`, `2:2027-01-05:${$(1200)}`]);
    expect(run.events.find((e) => e.commitmentId === "rent")?.sourceRef).toEqual(src);
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
});
