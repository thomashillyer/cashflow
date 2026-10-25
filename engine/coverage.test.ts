// Coverage gaps from issue #48 and tasks/02-cashflow-engine.md "Milestones and checks".
// Expected values are worked out by hand from the inputs (see the comments), never copied from engine output.

import { describe, expect, it } from "vitest";
import type { CashEvent, Commitment, Records, Scenario, Settlement } from "../schema/records";
import type { Profile } from "../schema/profile";
import { forecast } from "./forecast";
import { addDays } from "./dates";

const $ = (n: number) => n * 100;
const src = { system: "test", record: "x" };
const AS_OF = "2026-10-25"; // a Sunday; horizon = Mon 2026-10-19 + 13 weeks = 2027-01-18 (exclusive)

const profile: Profile = {
  id: "test",
  displayName: "Test Co",
  baseCurrency: "USD",
  horizonWeeks: 13,
  freeCashLookaheadWeeks: 6,
  defaultLagDays: 0,
  lagShrinkageK: 3,
  safetyLine: { kind: "fixed", amount: 0 },
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
const bal = (amount: number, asOf = AS_OF) => ({ id: `bal-${asOf}`, account: "main", amount, currency: "USD", asOf, sourceRef: src });
const withBal = (amount = 0): Records => ({ ...empty(), balances: [bal(amount)] });
const closing = (r: { days: { date: string; closing: number }[] }, date: string) => r.days.find((d) => d.date === date)?.closing;
const of = (run: { events: CashEvent[] }, id: string) => run.events.filter((e) => e.commitmentId === id).map((e) => `${e.date}:${e.amount}`);

describe("recurrence end date equal to an occurrence date (inclusive)", () => {
  type Rec = Profile["recurring"][number];
  const run = (rec: Rec) => forecast(withBal($(100000)), { ...profile, recurring: [rec] }, base, AS_OF, {});
  const dates = (rec: Rec) => run(rec).events.filter((e) => e.commitmentId === rec.id).map((e) => e.date);

  it("monthly: an endDate on the 15th keeps that month's 15th", () => {
    // anchor Nov 15, ends Dec 15: Oct 15 is before asOf, so Nov 15 and Dec 15; Jan 15 is after the end.
    expect(dates({ id: "r", name: "Rent", amount: $(1000), cadence: "monthly", anchor: "2026-11-15", endDate: "2026-12-15", category: "rent" })).toEqual(["2026-11-15", "2026-12-15"]);
  });

  it("weekly: an endDate on a Friday keeps that Friday", () => {
    expect(dates({ id: "r", name: "Pay", amount: $(10), cadence: "weekly", anchor: "2026-10-30", endDate: "2026-11-13", category: "payroll" })).toEqual(["2026-10-30", "2026-11-06", "2026-11-13"]);
  });

  it("semimonthly: an endDate on secondDay keeps it; quarterly: an endDate on the occurrence keeps it", () => {
    expect(dates({ id: "r", name: "Pay", amount: $(10), cadence: "semimonthly", anchor: "2026-11-01", secondDay: 15, endDate: "2026-11-15", category: "payroll" })).toEqual(["2026-11-01", "2026-11-15"]);
    expect(dates({ id: "r", name: "Tax", amount: $(10), cadence: "quarterly", anchor: "2026-10-15", endDate: "2027-01-15", category: "tax" })).toEqual(["2027-01-15"]);
  });

  it("startDate = endDate = asOf = an occurrence: exactly one payment, on asOf, in the balance", () => {
    const r = run({ id: "r", name: "Fee", amount: $(250), cadence: "weekly", anchor: AS_OF, startDate: AS_OF, endDate: AS_OF, category: "fees" });
    expect(of(r, "r")).toEqual([`${AS_OF}:${$(250)}`]);
    expect(closing(r, AS_OF)).toBe($(100000 - 250));
    expect(r.days.at(-1)?.closing).toBe($(100000 - 250));
  });
});

describe("stress with linked costs and funding together", () => {
  const p: Profile = {
    ...profile,
    paymentPatterns: [
      { id: "supplier_cost", appliesTo: "purchase_order", legs: [{ share: 1, anchor: "order", offsetDays: 0, direction: "out" }] },
      { id: "deal", appliesTo: "sales_deal", isDefault: true, legs: [{ share: 1, anchor: "due", offsetDays: 0, direction: "in" }], linkedCosts: [{ patternId: "supplier_cost", share: 0.6 }] },
    ],
    thresholds: { ...profile.thresholds, stressDelayDays: 7 },
  };
  const records = (): Records => ({
    ...withBal($(100)),
    commitments: [
      // likely deal: $1,000 receipt on Nov 10 (no party, default lag 0); virtual supplier cost 60% = $600 on its order date Nov 2
      com("deal", { type: "sales_deal", status: "likely", amount: $(1000), anchors: { order: "2026-11-02", due: "2026-11-10" } }),
      com("loan", { type: "plan", direction: "in", funding: true, status: "likely", amount: $(500), anchors: { due: "2026-11-05" } }),
      com("line", { type: "plan", direction: "in", funding: true, status: "committed", amount: $(200), anchors: { due: "2026-11-06" } }),
    ],
  });

  it("base: cost, loan, committed line and deal all in the main line", () => {
    const b = forecast(records(), p, base, AS_OF, {});
    // 100 - 600 = -500 (Nov 2); + 500 = 0 (Nov 5); + 200 = 200 (Nov 6); + 1000 = 1200 (Nov 10)
    expect([closing(b, "2026-11-02"), closing(b, "2026-11-05"), closing(b, "2026-11-06"), closing(b, "2026-11-10")]).toEqual([$(-500), 0, $(200), $(1200)]);
    expect(of(b, "deal~supplier_cost")).toEqual([`2026-11-02:${$(600)}`]);
  });

  it("stress: drops the likely loan, keeps the committed line on time, delays only the deal receipt, keeps the cost", () => {
    const s = forecast(records(), p, stress, AS_OF, {});
    // 100 - 600 = -500 (Nov 2); loan gone; + 200 = -300 (Nov 6); deal moves Nov 10 -> Nov 17: -300 until Nov 16, then 700
    expect([closing(s, "2026-11-02"), closing(s, "2026-11-05"), closing(s, "2026-11-06"), closing(s, "2026-11-10"), closing(s, "2026-11-16"), closing(s, "2026-11-17")]).toEqual([
      $(-500), $(-500), $(-300), $(-300), $(-300), $(700),
    ]);
    expect(of(s, "loan")).toEqual([]);
    expect(of(s, "line")).toEqual([`2026-11-06:${$(200)}`]);
    expect(of(s, "deal")).toEqual([`2026-11-17:${$(1000)}`]);
    const cost = s.events.filter((e) => e.commitmentId === "deal~supplier_cost");
    expect(cost.map((e) => `${e.date}:${e.amount}`)).toEqual([`2026-11-02:${$(600)}`]);
    expect(cost[0]?.overriddenBy ?? []).not.toContain("stress");
    expect(s.lowPoint).toMatchObject({ date: "2026-11-02", amount: $(-500) });
  });
});

describe("cancelled overlap: a cancelled or credited link never offsets, and a cancelled deal keeps its real PO", () => {
  it("a PO linked to a cancelled or credited bill is forecast in full; the bill emits nothing", () => {
    for (const settlement of ["cancelled", "credited"] as const) {
      const r = withBal();
      r.commitments = [
        com("po", { type: "purchase_order", patternId: "split_50_50", amount: $(10000), linkedCommitmentIds: ["bill-1"], anchors: { order: "2026-10-26", ship: "2026-11-10" } }),
        com("bill-1", { type: "bill", amount: $(4000), anchors: { due: "2026-11-02" }, settlement }),
      ];
      const run = forecast(r, profile, base, AS_OF, {});
      // 50/50 of $10,000, nothing offset
      expect(of(run, "po")).toEqual([`2026-10-26:${$(5000)}`, `2026-11-10:${$(5000)}`]);
      expect(of(run, "bill-1")).toEqual([]);
      expect(run.days.at(-1)?.closing).toBe($(-10000));
    }
  });

  it("a deal billed in part counts once; when that invoice is cancelled the deal is expected in full", () => {
    const deal = (o: Partial<Commitment> = {}) => com("deal", { type: "sales_deal", amount: $(1000), linkedCommitmentIds: ["inv"], anchors: { due: "2026-11-10" }, ...o });
    const inv = (o: Partial<Commitment> = {}) => com("inv", { type: "invoice", amount: $(400), anchors: { due: "2026-11-03" }, ...o });
    const open = forecast({ ...withBal(), commitments: [deal(), inv()] }, profile, base, AS_OF, {});
    // invoice $400 Nov 3 replaces $400 of the deal: $600 left on Nov 10; total in = $1,000
    expect(of(open, "inv")).toEqual([`2026-11-03:${$(400)}`]);
    expect(of(open, "deal")).toEqual([`2026-11-10:${$(600)}`]);
    const cancelled = forecast({ ...withBal(), commitments: [deal(), inv({ settlement: "cancelled" })] }, profile, base, AS_OF, {});
    expect(of(cancelled, "inv")).toEqual([]);
    expect(of(cancelled, "deal")).toEqual([`2026-11-10:${$(1000)}`]);
    expect(open.days.at(-1)?.closing).toBe($(1000));
    expect(cancelled.days.at(-1)?.closing).toBe($(1000));
  });

  it("a cancelled deal drops its receipt and virtual cost, but its real linked PO stays owed", () => {
    const p: Profile = {
      ...profile,
      paymentPatterns: [
        { id: "supplier_cost", appliesTo: "purchase_order", legs: [{ share: 1, anchor: "due", offsetDays: 0, direction: "out" }] },
        { id: "deal", appliesTo: "sales_deal", isDefault: true, legs: [{ share: 1, anchor: "due", offsetDays: 0, direction: "in" }], linkedCosts: [{ patternId: "supplier_cost", share: 0.6 }] },
      ],
    };
    const r = withBal($(100));
    r.commitments = [
      com("deal", { type: "sales_deal", amount: $(1000), settlement: "cancelled", linkedCommitmentIds: ["po1"], anchors: { due: "2026-11-10" } }),
      com("po1", { type: "purchase_order", patternId: "supplier_cost", direction: "out", amount: $(600), anchors: { due: "2026-11-05" } }),
    ];
    const run = forecast(r, p, base, AS_OF, {});
    expect(run.events.map((e) => `${e.commitmentId}:${e.date}:${e.amount}`)).toEqual([`po1:2026-11-05:${$(600)}`]);
    expect(run.days.at(-1)?.closing).toBe($(-500));
    // #117: the owner is told the PO is still owed after the deal fell through
    const flagged = run.review?.reasons.filter((x) => x.code === "linked_po_after_cancel") ?? [];
    expect(flagged.map((x) => x.refs)).toEqual([["deal", "po1"]]);
    expect(run.review?.needed).toBe(true);
  });

  it("linked_po_after_cancel: credited deals flag too; open deals and paid or cancelled POs do not", () => {
    const p: Profile = { ...profile, paymentPatterns: [{ id: "deal", appliesTo: "sales_deal", isDefault: true, legs: [{ share: 1, anchor: "due", offsetDays: 0, direction: "in" }] }] };
    const codes = (dealSettlement: Commitment["settlement"], poSettlement?: Commitment["settlement"]) => {
      const r = withBal($(100));
      r.commitments = [
        com("deal", { type: "sales_deal", amount: $(1000), settlement: dealSettlement, linkedCommitmentIds: ["po1"], anchors: { due: "2026-11-10" } }),
        com("po1", { type: "purchase_order", direction: "out", amount: $(600), settlement: poSettlement, anchors: { due: "2026-11-05" } }),
      ];
      return (forecast(r, p, base, AS_OF, {}).review?.reasons ?? []).filter((x) => x.code === "linked_po_after_cancel").length;
    };
    expect(codes("credited")).toBe(1);
    expect(codes("open")).toBe(0);
    expect(codes(undefined)).toBe(0);
    expect(codes("cancelled", "paid")).toBe(0);
    expect(codes("cancelled", "cancelled")).toBe(0);
  });
});

describe("lag basis text with fewer than three payments (n < 3)", () => {
  // Paid receivables for party `cust`, `late` days after due, due dates 10 days apart from Jan 1.
  const history = (lates: number[]): { commitments: Commitment[]; settlements: Settlement[] } => {
    const commitments: Commitment[] = [];
    const settlements: Settlement[] = [];
    lates.forEach((late, i) => {
      const due = addDays("2026-01-01", i * 10);
      commitments.push(com(`p${i}`, { type: "invoice", partyId: "cust", amount: $(1), settlement: "paid", anchors: { due } }));
      settlements.push({ id: `s${i}`, commitmentId: `p${i}`, partyId: "cust", amount: $(1), currency: "USD", date: addDays(due, late), sourceRef: src });
    });
    return { commitments, settlements };
  };
  const receipt = (lates: number[], defaultLagDays: number, due: string) => {
    const h = history(lates);
    const r = { ...withBal(), commitments: [...h.commitments, com("inv", { type: "invoice", partyId: "cust", amount: $(10), anchors: { due } })], settlements: h.settlements };
    const run = forecast(r, { ...profile, defaultLagDays }, base, AS_OF, {});
    return run.events.find((e) => e.commitmentId === "inv")!;
  };

  it("n = 0: profile default, labeled as no history", () => {
    const e = receipt([], 20, "2026-11-02");
    expect(e.date).toBe("2026-11-22");
    expect(e.basis).toBe("due 2026-11-02 + 20 days (profile default; no payment history)");
    expect(e.confidence).toBeCloseTo(0.95 * 0.1, 10);
  });

  it("n = 1: '1 payment' (singular), shrunk toward the default", () => {
    // (1 * 10 + 3 * 20) / 4 = 17.5 -> 18 (half rounds up); confidence 1/4 * 1/(1 + 0/14) = 0.25
    const e = receipt([10], 20, "2026-11-02");
    expect(e.date).toBe("2026-11-20");
    expect(e.basis).toBe("due 2026-11-02 + 18 days (median 10 of last 1 payment, shrunk toward default 20 with k=3; rounded to nearest day)");
    expect(e.confidence).toBeCloseTo(0.95 * 0.25, 10);
  });

  it("n = 2: median of two, spread lowers confidence", () => {
    // median (0 + 6) / 2 = 3; (2 * 3 + 3 * 20) / 5 = 13.2 -> 13; IQR = 4.5 - 1.5 = 3; confidence 2/5 * 1/(1 + 3/14) = 5.6/17
    const e = receipt([0, 6], 20, "2026-11-02");
    expect(e.date).toBe("2026-11-15");
    expect(e.basis).toBe("due 2026-11-02 + 13 days (median 3 of last 2 payments, shrunk toward default 20 with k=3; rounded to nearest day)");
    expect(e.confidence).toBeCloseTo(0.95 * (5.6 / 17), 10);
  });

  it("n = 2, early payer: the sign is spelled out and the date moves earlier", () => {
    // (2 * -30 + 3 * 0) / 5 = -12
    const e = receipt([-30, -30], 0, "2026-11-20");
    expect(e.date).toBe("2026-11-08");
    expect(e.basis).toBe("due 2026-11-20 - 12 days (median -30 of last 2 payments, shrunk toward default 0 with k=3; rounded to nearest day)");
  });
});

describe("same-day events and horizon edges", () => {
  it("nets every event on a day; asOf is in the horizon and horizonEnd is not", () => {
    const r = withBal($(100));
    r.commitments = [
      com("today", { type: "bill", amount: $(10), anchors: { due: AS_OF } }),
      com("b1", { type: "bill", amount: $(150), anchors: { due: "2026-10-28" } }),
      com("b2", { type: "bill", amount: $(30), anchors: { due: "2026-10-28" } }),
      com("i1", { type: "invoice", amount: $(200), anchors: { due: "2026-10-28" } }),
      com("late", { type: "bill", amount: $(999), anchors: { due: "2027-01-18" } }),
    ];
    const run = forecast(r, profile, base, AS_OF, {});
    expect(run.days[0]).toMatchObject({ date: AS_OF, inflow: 0, outflow: $(10), closing: $(90) });
    // Oct 28: in 200, out 180, closing 90 + 20 = 110
    expect(run.days.find((d) => d.date === "2026-10-28")).toMatchObject({ inflow: $(200), outflow: $(180), closing: $(110) });
    expect([...run.days.find((d) => d.date === "2026-10-28")!.eventIds].sort()).toEqual(["evt-b1-0", "evt-b2-0", "evt-i1-0"]);
    expect(run.days.at(-1)?.date).toBe("2027-01-17");
    expect(run.days.at(-1)?.closing).toBe($(110)); // the Jan 18 bill is outside the horizon
  });
});

describe("daily-sales average with receipts in another currency (review of #32)", () => {
  const p: Profile = { ...profile, revenueModel: { kind: "dailySales", weekdayWeights: [1, 1, 1, 1, 1, 1, 1] } };
  const sale = (date: string, amount: number, currency = "USD"): CashEvent => ({ id: `s-${date}`, legIndex: 0, date, amount, currency, amountBase: amount, direction: "in", status: "actual", confidence: 1, basis: "bank", category: "sales", sourceRef: src });
  const records = (): Records => ({
    ...withBal(),
    // Oct 18-23 in USD ($700 each), Oct 24 in EUR (500 EUR): 7 days of history before asOf
    events: [...Array.from({ length: 6 }, (_, i) => sale(addDays("2026-10-18", i), $(700))), sale("2026-10-24", $(500), "EUR")],
  });
  const firstSale = (run: ReturnType<typeof forecast>) => run.events.find((e) => e.commitmentId === "daily-sales")?.amount;

  it("converts at the run's FX rate", () => {
    // (6 * $700 + 500 EUR * 1.2) / 7 days = $4,800 / 7 = $685.714... -> 68571 cents per (equal-weight) day
    expect(firstSale(forecast(records(), p, base, AS_OF, { EUR: 1.2 }))).toBe(68571);
  });

  it("leaves a receipt with no FX rate out of the average and says so", () => {
    const run = forecast(records(), p, base, AS_OF, {});
    expect(firstSale(run)).toBe($(700)); // $4,200 / 6 days: the EUR-only day leaves the divisor too
    expect(run.warnings.join(" ")).toMatch(/Sales receipt s-2026-10-24 is in EUR with no FX rate; left out of the daily-sales average/);
  });
});

describe("daily-sales weekday weights are validated; closed days emit nothing (#119)", () => {
  const sale = (date: string): CashEvent => ({ id: `s-${date}`, legIndex: 0, date, amount: $(700), currency: "USD", amountBase: $(700), direction: "in", status: "actual", confidence: 1, basis: "bank", category: "sales", sourceRef: src });
  // Oct 11-24: 14 days of $700 receipts before asOf (Sun Oct 25)
  const records = (): Records => ({ ...withBal(), events: Array.from({ length: 14 }, (_, i) => sale(addDays("2026-10-11", i))) });
  const run = (weekdayWeights: number[]) => forecast(records(), { ...profile, revenueModel: { kind: "dailySales", weekdayWeights } }, base, AS_OF, {});
  const sales = (r: ReturnType<typeof forecast>) => r.events.filter((e) => e.commitmentId === "daily-sales");

  it.each([
    ["a negative weight", [1, 1, 1, 1, 1, 1, -1]],
    ["all zero", [0, 0, 0, 0, 0, 0, 0]],
    ["six weights", [1, 1, 1, 1, 1, 1]],
    ["eight weights", [1, 1, 1, 1, 1, 1, 1, 1]],
    ["NaN", [1, 1, 1, 1, 1, 1, Number.NaN]],
    ["Infinity", [1, 1, 1, 1, 1, 1, Number.POSITIVE_INFINITY]],
  ])("%s: invalid_profile and no daily sales", (_, w) => {
    const r = run(w);
    expect(sales(r)).toEqual([]);
    expect(r.review?.reasons.find((x) => x.code === "invalid_profile")?.refs).toEqual(["daily-sales"]);
  });

  it("a closed day (weight 0) emits no event; open days carry the week's sales", () => {
    // Closed Mondays: weights [0,1,1,1,1,1,1], mean 6/7. History Oct 11-24 has 2 Mondays (weight 0) and 12 open days:
    // weight-days = 12 / (6/7) = 14, avg = 14 x $700 / 14 = $700; an open day = 700 x 1 / (6/7) = $816.67 -> 81667 cents.
    const r = run([0, 1, 1, 1, 1, 1, 1]);
    const ev = sales(r);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.some((e) => new Date(`${e.date}T00:00:00Z`).getUTCDay() === 1)).toBe(false); // no Monday events
    expect(ev.every((e) => e.amount === 81667)).toBe(true);
    expect(r.review?.reasons.some((x) => x.code === "invalid_profile")).toBe(false);
  });
});

describe("daily-sales legIndex is the sale date's day number, stable across asOf (#118)", () => {
  const p: Profile = { ...profile, revenueModel: { kind: "dailySales", weekdayWeights: [1, 1, 1, 1, 1, 1, 1], settleLagDays: 2 } };
  const sale = (date: string): CashEvent => ({ id: `s-${date}`, legIndex: 0, date, amount: $(700), currency: "USD", amountBase: $(700), direction: "in", status: "actual", confidence: 1, basis: "bank", category: "sales", sourceRef: src });
  // 28 days of $700 receipts before the earliest asOf, so the average is $700 in every run
  const records = (): Records => ({ ...withBal(), events: Array.from({ length: 28 }, (_, i) => sale(addDays("2026-09-27", i))) });
  // Sale day Nov 3 settles Nov 5 (lag 2). 2026-11-03 is day 20760 since 1970-01-01.
  const saleDay = 20760;

  it("an owner override on { daily-sales, legIndex } hits the same day when asOf moves", () => {
    expect(addDays("1970-01-01", saleDay)).toBe("2026-11-03");
    const owner: Scenario = { id: "base", kind: "base", overrides: [{ id: "ov-1", target: { commitmentId: "daily-sales", legIndex: saleDay }, change: { amount: $(1) }, origin: "owner" }] };
    for (const asOf of ["2026-10-25", "2026-10-26", "2026-10-28"]) {
      const r = { ...records(), balances: [bal(0, asOf)] };
      const plain = forecast(r, p, base, asOf, {}).events.filter((e) => e.commitmentId === "daily-sales");
      expect(plain.find((e) => e.legIndex === saleDay)?.date, asOf).toBe("2026-11-05");
      expect(new Set(plain.map((e) => e.id)).size, `${asOf} unique ids`).toBe(plain.length);
      expect(new Set(plain.map((e) => e.legIndex)).size, `${asOf} unique legIndex`).toBe(plain.length);
      const run = forecast(r, p, owner, asOf, {});
      const hit = run.events.filter((e) => e.overriddenBy?.includes("ov-1"));
      expect(hit.map((e) => `${e.date}:${e.amount}`), asOf).toEqual([`2026-11-05:${$(1)}`]);
      expect(run.review?.reasons.some((x) => x.code === "override_unmatched")).toBe(false);
    }
  });
});

describe("performance (docs/design/05-forecast-engine.md: a few thousand events in under 50 ms)", () => {
  // ~3,000 forecast events over 13 weeks: 1,500 open invoices from 50 customers with 12 paid invoices of history each
  // (so the lag model has real work), 1,500 open bills, plus the shipped trading profile's recurring items.
  function big(): Records {
    const r: Records = { ...empty(), balances: [bal($(10_000_000), "2026-11-16")] };
    for (let c = 0; c < 50; c++)
      for (let i = 0; i < 12; i++) {
        const id = `hist-${c}-${i}`;
        const due = addDays("2026-01-05", i * 25 + c);
        r.commitments.push(com(id, { type: "invoice", partyId: `cust-${c}`, amount: $(1000), settlement: "paid", anchors: { due }, sourceRef: { system: "test", record: id } }));
        r.settlements.push({ id: `set-${id}`, commitmentId: id, partyId: `cust-${c}`, amount: $(1000), currency: "USD", date: addDays(due, (c * 7 + i) % 20), sourceRef: src });
      }
    for (let i = 0; i < 1500; i++) {
      r.commitments.push(com(`inv-${i}`, { type: "invoice", partyId: `cust-${i % 50}`, amount: $(500) + i, anchors: { due: addDays("2026-11-16", i % 80) }, sourceRef: { system: "test", record: `inv-${i}` } }));
      r.commitments.push(com(`bill-${i}`, { type: "bill", partyId: `vend-${i % 30}`, amount: $(400) + i, anchors: { due: addDays("2026-11-16", (i * 7) % 85) }, sourceRef: { system: "test", record: `bill-${i}` } }));
    }
    // #120: partial payments on open items, so matchPayments has real work. 300 invoices each have a $100 settlement and
    // its matching bank line (one payment); 300 bills each have a $50 bank-only payment.
    const line = (id: string, commitmentId: string, date: string, amount: number, direction: "in" | "out"): CashEvent => ({ id, commitmentId, legIndex: 0, date, amount, currency: "USD", amountBase: amount, direction, status: "actual", confidence: 1, basis: "bank", sourceRef: src });
    for (let i = 0; i < 300; i++) {
      r.settlements.push({ id: `set-inv-${i}`, commitmentId: `inv-${i}`, partyId: `cust-${i % 50}`, amount: $(100), currency: "USD", date: "2026-11-10", sourceRef: src });
      r.events.push(line(`bank-inv-${i}`, `inv-${i}`, "2026-11-11", $(100), "in"));
      r.events.push(line(`bank-bill-${i}`, `bill-${i}`, "2026-11-12", $(50), "out"));
    }
    return r;
  }

  // The 50 ms design target is asserted when run on its own: PERF_STRICT=1 npx vitest run engine/coverage.test.ts
  // (about 40 ms on an M-series laptop). The full parallel suite is noisy and teammates' laptops vary, so the default
  // guard is 200 ms: it only catches gross regressions; PERF_STRICT is the real check.
  const limit = process.env.PERF_STRICT ? 50 : 200;
  it(`runs ~3,000 events in under ${limit} ms median`, async () => {
    const trading = (await import("../profiles/trading.json")).default as Profile;
    const r = big();
    const run = () => forecast(r, trading, base, "2026-11-16", {});
    const first = run();
    expect(first.events.filter((e) => e.status !== "actual").length).toBeGreaterThanOrEqual(3000); // the size this test claims
    // the partial payments were matched and deducted: inv-0 $500 - $100, bill-0 $400 - $50
    expect(first.events.filter((e) => e.commitmentId === "inv-0" && e.status !== "actual").map((e) => e.amount)).toEqual([$(400)]);
    expect(first.events.filter((e) => e.commitmentId === "bill-0" && e.status !== "actual").map((e) => e.amount)).toEqual([$(350)]);
    for (let i = 0; i < 3; i++) run(); // warm up the JIT: the target is for reruns on every slider move
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t = performance.now();
      run();
      times.push(performance.now() - t);
    }
    const median = [...times].sort((a, b) => a - b)[3]!;
    console.log(`forecast perf: median ${median.toFixed(1)} ms over 7 runs (${times.map((t) => t.toFixed(0)).join(", ")})`);
    expect(median).toBeLessThan(limit);
  });
});
