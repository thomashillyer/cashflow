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
