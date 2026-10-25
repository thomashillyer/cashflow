import { describe, expect, it } from "vitest";
import type { ForecastRun } from "../schema/forecast";
import type { Profile } from "../schema/profile";
import type { CashEvent, Commitment, Lever, Records } from "../schema/records";
import { rank, type SimulateLevers } from "./rank";
import { addDays } from "./dates";
import { runChecks } from "./warnings";

// The legacy daily fixture from docs/TECHNICAL_PLAN.md section 10: opening $15,000 on 2026-10-25,
// supplier bill -$20,000 Oct 29, customer receipt +$12,000 and tentative loan +$40,000 Oct 30,
// payroll -$18,000 Nov 1. Baseline closes at -$5,000 on Oct 29. Amounts in cents.

const ASOF = "2026-10-25";
const END = "2026-11-15";
const SAFETY = 500_000;

const profile: Profile = {
  id: "test", displayName: "Test", baseCurrency: "USD", horizonWeeks: 4, freeCashLookaheadWeeks: 6,
  defaultLagDays: 0, lagShrinkageK: 3, safetyLine: { kind: "fixed", amount: SAFETY },
  paymentPatterns: [], revenueModel: { kind: "deals" },
  recurring: [{ id: "payroll", name: "Payroll", amount: 1_800_000, cadence: "biweekly", anchor: "2026-11-01",
    category: "payroll", nonDeferrable: true }],
  thresholds: {
    idleBalanceOver: { amount: 1_000_000, minWeeks: 2 },
    arConcentrationPct: 30,
    signalAutoApplyConfidence: 0.9,
    rankFloor: 100_000,
    relationshipPenalty: { preferred: 0.5 },
  },
  actionLeadDays: { chase: 3, defer: 3 },
  signalSources: ["email"],
  vocabulary: {},
};

const src = (record: string) => ({ system: "test", record });

function commitment(c: Partial<Commitment> & Pick<Commitment, "id" | "type" | "amount">): Commitment {
  return { currency: "USD", anchors: {}, status: "committed", sourceRef: src(c.id), ...c };
}

function event(commitmentId: string, date: string, amount: number, direction: "in" | "out",
  confidence: number, extra: Partial<CashEvent> = {}): CashEvent {
  return { id: `evt-${commitmentId}-0`, commitmentId, legIndex: 0, date, amount, currency: "USD",
    amountBase: amount, direction, status: "committed", confidence, basis: "test", sourceRef: src(commitmentId),
    ...extra };
}

function fixture(payrollDate = "2026-11-01") {
  const records: Records = {
    parties: [
      { id: "ningbo", name: "Ningbo Pack", kind: "supplier", tags: ["preferred"], notes: [] },
      { id: "evergreen", name: "Evergreen Home", kind: "customer", tags: ["slow_payer"], notes: [] },
    ],
    commitments: [
      commitment({ id: "bill-0042", type: "bill", amount: 2_000_000, partyId: "ningbo", reference: "BILL-0042",
        anchors: { due: "2026-10-29" } }),
      commitment({ id: "inv-104", type: "invoice", amount: 1_200_000, partyId: "evergreen", reference: "INV-104",
        anchors: { due: "2026-10-28" } }),
      commitment({ id: "loan", type: "plan", direction: "in", funding: true, amount: 4_000_000, status: "likely" }),
      commitment({ id: "payroll", type: "recurring", amount: 1_800_000, category: "payroll" }),
    ],
    events: [],
    signals: [{ id: "sig-1", channel: "email", receivedAt: "2026-10-24T18:00:00Z", partyId: "evergreen",
      commitmentId: "inv-104", claim: { kind: "date_change", newDate: "2026-10-30" }, confidence: 0.9,
      state: "applied", sourceRef: src("msg-1") }],
    rules: [], settlements: [], balances: [], evidence: [],
  };
  const events = [
    event("bill-0042", "2026-10-29", 2_000_000, "out", 0.9),
    event("inv-104", "2026-10-30", 1_200_000, "in", 0.8, { overriddenBy: ["sig-1"] }),
    event("loan", "2026-10-30", 4_000_000, "in", 0.6, { status: "likely" }),
    event("payroll", payrollDate, 1_800_000, "out", 1),
  ];
  return { records, events };
}

// A minimal daily forecaster standing in for person 2's engine.
function forecastOf(events: CashEvent[], opening = 1_500_000): ForecastRun {
  const days: ForecastRun["days"] = [];
  let closing = opening;
  for (let d = ASOF; d <= END; d = addDays(d, 1)) {
    const today = events.filter((e) => e.date === d);
    const inflow = today.filter((e) => e.direction === "in").reduce((s, e) => s + e.amountBase, 0);
    const outflow = today.filter((e) => e.direction === "out").reduce((s, e) => s + e.amountBase, 0);
    closing += inflow - outflow;
    days.push({ date: d, inflow, outflow, closing, eventIds: today.map((e) => e.id) });
  }
  const low = days.reduce((m, d) => (d.closing < m.closing ? d : m));
  const mondays: string[] = [];
  for (let m = addDays(ASOF, -((new Date(ASOF).getUTCDay() + 6) % 7)); m <= END; m = addDays(m, 7)) mondays.push(m);
  const free = mondays.map((week) =>
    Math.min(...days.filter((d) => d.date >= week).map((d) => d.closing)) - SAFETY);
  const freeCash = mondays.map((week, i) => {
    let n = 0;
    while (i + n < free.length && free[i + n]! > 0) n++;
    return { week, amount: free[i]!, weeksFree: n };
  });
  return {
    id: "run-test", asOf: ASOF, inputsHash: "test", scenarioId: "base", fxRates: { USD: 1 },
    openingBalance: opening, safetyLine: SAFETY, days,
    weeks: mondays.map((start) => ({ start, inflow: 0, outflow: 0, closing: 0, minClosing: 0, pipelineClosing: 0,
      eventIds: days.filter((d) => d.date >= start && d.date < addDays(start, 7)).flatMap((d) => d.eventIds) })),
    lowPoint: { week: "", date: low.date, amount: low.closing },
    firstBelowSafety: days.find((d) => d.closing < SAFETY)?.date,
    firstNegative: days.find((d) => d.closing < 0)?.date,
    weeksBelowSafety: [], freeCash, warnings: [], events,
  };
}

// Moves every event of the lever's commitment. Every commitment here has one leg, so this matches the engine's
// one-leg chase/defer; multi-leg behavior is tested against the real simulate() in warnings.engine.test.ts.
function simulator(base: ForecastRun, records: Records): SimulateLevers {
  return (levers: Lever[]) => {
    const events = base.events.map((e) => {
      const lever = levers.find((l) => l.commitmentId === e.commitmentId);
      if (!lever) return e;
      if (lever.kind === "chase") return { ...e, date: lever.assumeDate };
      if (lever.kind === "defer") return { ...e, date: addDays(e.date, lever.days) };
      if (lever.kind === "pay_early") {
        const byDate = records.commitments.find((c) => c.id === e.commitmentId)?.discount?.byDate;
        return byDate ? { ...e, date: byDate } : e;
      }
      return e;
    });
    return { lowPointDelta: forecastOf(events, base.openingBalance).lowPoint.amount - base.lowPoint.amount };
  };
}

describe("warnings on the legacy fixture", () => {
  const { records, events } = fixture();
  const run = forecastOf(events);
  const candidates = runChecks(run, records, profile);
  const levers = candidates.flatMap((c) => (c.lever ? [c.lever] : []));

  it("finds the Oct 29 gap", () => {
    expect(run.lowPoint).toMatchObject({ date: "2026-10-29", amount: -500_000 });
    expect(run.firstBelowSafety).toBe("2026-10-29");
  });

  it("chases the late receivable from its due date and defers the bill, not payroll or the loan", () => {
    expect(levers).toEqual([
      { kind: "defer", commitmentId: "bill-0042", days: 10 },
      { kind: "chase", commitmentId: "inv-104", assumeDate: "2026-10-28" },
    ]);
    const chase = candidates.find((c) => c.lever?.kind === "chase")!;
    expect(chase.neededBy).toBe("2026-10-26");          // gap date minus 3 lead days
    expect(chase.evidenceRefs).toContain("evt-inv-104-0");
  });

  it("fires the explain-only warnings from profile thresholds", () => {
    const warnings = candidates.filter((c) => !c.lever).map((c) => [c.warning, c.neededBy]);
    expect(warnings).toEqual([
      ["idle_balance_over", "2026-11-02"],
      ["ar_concentration_risk", ASOF],
      ["payment_slip", ASOF],
    ]);
  });

  it("disables a check when its threshold is omitted", () => {
    const off: Profile = { ...profile, thresholds: { ...profile.thresholds, idleBalanceOver: undefined,
      arConcentrationPct: undefined } };
    const names = runChecks(run, records, off).map((c) => c.warning);
    expect(names).not.toContain("idle_balance_over");
    expect(names).not.toContain("ar_concentration_risk");
  });

  it("uses a confirmed flexibility rule instead of the default defer days", () => {
    const withRule: Records = { ...records, rules: [{ id: "r1", scope: { partyId: "ningbo" }, kind: "flexibility",
      params: { extraDays: 15 }, fromNote: "Ningbo will give us 15 more days", state: "confirmed" }] };
    const defer = runChecks(run, withRule, profile).find((c) => c.lever?.kind === "defer");
    expect(defer?.lever).toEqual({ kind: "defer", commitmentId: "bill-0042", days: 15 });
  });

  it("never offers a non-deferrable payment as a defer lever", () => {
    const early = fixture("2026-10-27");
    const r = forecastOf(early.events);
    const deferred = runChecks(r, early.records, profile).flatMap((c) =>
      c.lever?.kind === "defer" ? [c.lever.commitmentId] : []);
    expect(r.firstBelowSafety).toBe("2026-10-27");
    expect(deferred).not.toContain("payroll");
  });

  it("treats a bank-detected commitment in a non-deferrable category as non-deferrable", () => {
    const early = fixture("2026-10-27");
    early.records.commitments.push(commitment({ id: "payroll-bank", type: "recurring", amount: 100_000,
      category: "payroll" }));
    const r = forecastOf([...early.events, event("payroll-bank", "2026-10-27", 100_000, "out", 1)]);
    const deferred = runChecks(r, early.records, profile).flatMap((c) =>
      c.lever?.kind === "defer" ? [c.lever.commitmentId] : []);
    expect(deferred).not.toContain("payroll-bank");
  });

  it("chases an overdue receivable as soon as the owner can reach them", () => {
    const f = fixture();
    f.records.commitments.push(commitment({ id: "inv-90", type: "invoice", amount: 500_000, partyId: "evergreen",
      reference: "INV-90", anchors: { due: "2026-10-01" } }));
    const r = forecastOf([...f.events, event("inv-90", "2026-10-01", 500_000, "in", 0.7)]);
    const chase = runChecks(r, f.records, profile).find((c) => c.lever?.commitmentId === "inv-90");
    expect(chase?.lever).toEqual({ kind: "chase", commitmentId: "inv-90", assumeDate: "2026-10-28" });
  });

  it("applies an all-parties flexibility rule, and skips one the base run already applied", () => {
    const all = { id: "r-all", scope: { all: true as const }, kind: "flexibility" as const,
      params: { extraDays: 7 }, fromNote: "suppliers usually give a week", state: "confirmed" as const };
    const defer = runChecks(run, { ...records, rules: [all] }, profile).find((c) => c.lever?.kind === "defer");
    expect(defer?.lever).toEqual({ kind: "defer", commitmentId: "bill-0042", days: 7 });

    const applied = events.map((e) => (e.commitmentId === "bill-0042" ? { ...e, overriddenBy: ["r-all"] } : e));
    const again = runChecks(forecastOf(applied), { ...records, rules: [all] }, profile);
    expect(again.some((c) => c.lever?.kind === "defer")).toBe(false);
  });

  it("counts receivables with no party in the concentration total", () => {
    const f = fixture();
    f.records.commitments.push(commitment({ id: "inv-x", type: "invoice", amount: 3_000_000, anchors: {} }));
    const r = forecastOf([...f.events, event("inv-x", "2026-11-10", 3_000_000, "in", 1)]);
    // Evergreen: 1,200,000 of 4,200,000 = 29% <= 30%
    expect(runChecks(r, f.records, profile).some((c) => c.warning === "ar_concentration_risk")).toBe(false);
  });

  it("does not raise a payment slip when the new date is not later than the due date", () => {
    const f = fixture();
    f.records.signals[0]!.claim = { kind: "date_change", newDate: "2026-10-27" };
    expect(runChecks(forecastOf(f.events), f.records, profile).some((c) => c.warning === "payment_slip")).toBe(false);
  });
});

describe("rank", () => {
  const { records, events } = fixture();
  const run = forecastOf(events);
  const candidates = runChecks(run, records, profile);
  const brief = rank(candidates, run, records, profile, simulator(run, records));

  it("scores each lever from its simulated effect, urgency, confidence, and relationship", () => {
    const chase = brief.all.find((w) => w.lever?.kind === "chase")!;
    const defer = brief.all.find((w) => w.lever?.kind === "defer")!;
    // chase: low point -$5,000 -> $7,000; 1,200,000 × 1/(1 + 1/7) × 0.8 × 1
    expect(chase).toMatchObject({ cashEffect: 1_200_000, confidence: 0.8, score: 840_000 });
    // defer: low point -> $15,000; 2,000,000 × 0.875 × 0.9 × 0.5 (preferred supplier)
    expect(defer).toMatchObject({ cashEffect: 2_000_000, confidence: 0.9, score: 787_500 });
    expect(chase.why).toBe("Collecting it by 2026-10-28 raises your low point by $12,000.");
  });

  it("shows only lever items above the floor in today's list, best first, without padding", () => {
    expect(brief.today.map((w) => w.id)).toEqual([
      "wi-projected_cash_gap-chase-inv-104",
      "wi-projected_cash_gap-defer-bill-0042",
    ]);
    expect(brief.all).toHaveLength(5);
    expect(brief.all.find((w) => w.warning === "idle_balance_over")?.why)
      .toBe("About $24,000 stays free for 2 weeks from 2026-11-02.");
  });

  it("keeps completed items done across reruns", () => {
    const again = rank(candidates, run, records, profile, simulator(run, records),
      [{ id: "wi-projected_cash_gap-chase-inv-104", state: "done" }]);
    expect(again.today.map((w) => w.id)).toEqual(["wi-projected_cash_gap-defer-bill-0042"]);
    expect(again.all.find((w) => w.id === "wi-projected_cash_gap-chase-inv-104")?.state).toBe("done");
  });

  it("formats amounts in the profile's base currency and keeps the idle item id stable", () => {
    const eur = rank(candidates, run, records, { ...profile, baseCurrency: "EUR" }, simulator(run, records));
    expect(eur.all.find((w) => w.lever?.kind === "chase")?.why)
      .toBe("Collecting it by 2026-10-28 raises your low point by €12,000.");
    expect(eur.all.find((w) => w.warning === "idle_balance_over")?.id).toBe("wi-idle_balance_over");
  });

  it("drops levers that do not raise the low point", () => {
    const none = rank(candidates, run, records, profile, () => ({ lowPointDelta: 0 }));
    expect(none.today).toEqual([]);
    expect(none.all.every((w) => !w.lever)).toBe(true);
  });

  it("values an early-pay discount in dollars saved and respects the floor", () => {
    const records2: Records = { ...records, signals: [], commitments: [
      commitment({ id: "bill-9", type: "bill", amount: 1_000_000, reference: "BILL-9", anchors: { due: "2026-11-12" },
        discount: { pct: 2, byDate: "2026-11-05" } })] };
    const run2 = forecastOf([event("bill-9", "2026-11-12", 1_000_000, "out", 1)], 5_000_000);
    const b = rank(runChecks(run2, records2, profile), run2, records2, profile, simulator(run2, records2));
    const item = b.all.find((w) => w.warning === "early_pay_discount")!;
    expect(item).toMatchObject({ cashEffect: 20_000, neededBy: "2026-11-05", score: 7_778 });
    expect(b.today).toEqual([]);   // $200 saved, 11 days out: below rankFloor
  });
});
