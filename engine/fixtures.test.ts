// The genericity loop: every check runs over every fixture directory with zero code changes.
// Fixtures are fixtures/<name>/{fixture.json,records.json,forecast_run.json}; expectations live in fixtures/expected/engine/<name>.json.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Override, Records, Scenario } from "../schema/records";
import type { Profile } from "../schema/profile";
import { forecast } from "./forecast";
import { simulate } from "./simulate";
import { partyLag } from "./lag";
import { mondayOf } from "./dates";
import { resolveEventSource } from "./resolve";
import { signalEffect } from "./signal_effect";

const root = join(import.meta.dirname, "..");
const read = <T>(path: string): T => JSON.parse(readFileSync(join(root, path), "utf8")) as T;

type Meta = { name: string; profile: string; asOf: string; fxRates: Record<string, number> };
const names = readdirSync(join(root, "fixtures")).filter((n) => existsSync(join(root, "fixtures", n, "fixture.json")));

const base: Scenario = { id: "base", kind: "base", overrides: [] };
const stress: Scenario = { id: "stress", kind: "stress", overrides: [] };

function load(name: string) {
  const meta = read<Meta>(`fixtures/${name}/fixture.json`);
  return { meta, records: read<Records>(`fixtures/${name}/records.json`), profile: read<Profile>(meta.profile) };
}

it("finds the fixtures", () => {
  expect(names).toEqual(expect.arrayContaining(["demo_runway", "cascade_trade", "pike_noodle"]));
});

describe.each(names)("fixture %s", (name) => {
  const { meta, records, profile } = load(name);
  const run = () => forecast(records, profile, base, meta.asOf, meta.fxRates);
  const expected = existsSync(join(root, `fixtures/expected/engine/${name}.json`)) ? read<Record<string, any>>(`fixtures/expected/engine/${name}.json`) : {};

  it("forecast_run.json matches the engine (regenerate with scripts/make-engine-fixtures.ts)", () => {
    expect(JSON.parse(JSON.stringify(run()))).toEqual(read(`fixtures/${name}/forecast_run.json`));
  });

  it("is deterministic and does not mutate its inputs", () => {
    const before = JSON.stringify(records);
    expect(run()).toEqual(run());
    expect(JSON.stringify(records)).toBe(before);
  });

  it("daily closing = previous closing + inflow - outflow, starting from opening cash", () => {
    const r = run();
    let prev = r.openingBalance;
    for (const d of r.days) {
      expect(d.closing).toBe(prev + d.inflow - d.outflow);
      prev = d.closing;
    }
  });

  it("weeks summarize days and cannot hide a daily dip", () => {
    const r = run();
    for (const w of r.weeks) {
      const ds = r.days.filter((d) => mondayOf(d.date) === w.start);
      expect(w.closing).toBe(ds.at(-1)!.closing);
      expect(w.minClosing).toBe(Math.min(...ds.map((d) => d.closing)));
      expect(w.inflow).toBe(ds.reduce((a, d) => a + d.inflow, 0));
    }
    expect(r.lowPoint.amount).toBe(Math.min(...r.days.map((d) => d.closing)));
    expect(r.lowPoint.week).toBe(mondayOf(r.lowPoint.date));
  });

  it("every event has a basis and source, integer money, and possible money stays out of the main line", () => {
    const r = run();
    const inDays = new Set(r.days.flatMap((d) => d.eventIds));
    for (const e of r.events) {
      expect(e.basis.length, e.id).toBeGreaterThan(0);
      expect(e.sourceRef.system.length, e.id).toBeGreaterThan(0);
      expect(Number.isInteger(e.amount) && Number.isInteger(e.amountBase), e.id).toBe(true);
      if (e.status === "possible") expect(inDays.has(e.id), e.id).toBe(false);
    }
  });

  it("every event in the base run resolves to a source record", () => {
    const unresolved = run().events.filter((e) => resolveEventSource(e, records, profile, meta.asOf).kind === "unresolved").map((e) => e.id);
    expect(unresolved).toEqual([]);
  });

  it("stress never reduces a payment and changes the run hash", () => {
    const b = run();
    const s = forecast(records, profile, stress, meta.asOf, meta.fxRates);
    expect(s.inputsHash).not.toBe(b.inputsHash);
    const outs = (x: typeof b) => x.events.filter((e) => e.direction === "out" && e.status !== "possible").map((e) => `${e.id}@${e.date}`).sort();
    expect(outs(s)).toEqual(outs(b));
    expect(s.lowPoint.amount).toBeLessThanOrEqual(b.lowPoint.amount);
  });

  it("simulate leaves the base untouched", () => {
    const c = records.commitments.find((x) => x.direction === "out" && x.settlement !== "paid");
    if (!c) return;
    const sim = simulate(records, profile, [], [{ kind: "defer", commitmentId: c.id, days: 7 }], meta.asOf, meta.fxRates);
    expect(sim.base).toEqual(run());
    expect(sim.run.scenarioId).not.toBe("base");
  });

  it("matches the golden checks", () => {
    for (const c of (expected.checks ?? []) as { name: string; scenario: string; overrides?: Override[]; day: string; closing: number }[]) {
      const s: Scenario = { id: c.scenario, kind: c.scenario === "stress" ? "stress" : "base", overrides: c.overrides ?? [] };
      const r = forecast(records, profile, s, meta.asOf, meta.fxRates);
      expect(r.days.find((d) => d.date === c.day)?.closing, c.name).toBe(c.closing);
    }
    if (expected.lowPoint) {
      const lp = expected.lowPoint;
      const r = run();
      expect(Math.abs(r.lowPoint.amount - lp.amount), "low point amount").toBeLessThanOrEqual(lp.tolerance);
      if (lp.week) expect(r.lowPoint.week).toBe(lp.week);
      if (lp.date) expect(r.lowPoint.date).toBe(lp.date);
    }
    if (expected.freeCash) {
      const f = run().freeCash.find((x) => x.week === expected.freeCash.week);
      expect(Math.abs((f?.amount ?? 0) - expected.freeCash.amount)).toBeLessThanOrEqual(expected.freeCash.tolerance);
    }
  });

  if (expected.lag) {
    it("learns the expected lag and dates the receivable with it", () => {
      const l = partyLag(records, profile, expected.lag.partyId);
      expect(l.n).toBeGreaterThanOrEqual(3);
      expect(run().events.find((e) => e.commitmentId === expected.lag.commitmentId)?.date).toBe(expected.lag.date);
    });
  }

  if (expected.signal) {
    it("a proposed signal changes nothing; applying it moves the invoice and cites the message", () => {
      const sig = records.signals.find((s) => s.id === expected.signal.id)!;
      expect(sig.state).toBe("proposed");
      const moved = (r: Records) => forecast(r, profile, base, meta.asOf, meta.fxRates).events.find((e) => e.commitmentId === expected.signal.commitmentId)!;
      expect(moved(records).overriddenBy ?? []).not.toContain(sig.id);
      const applied = moved({ ...records, signals: records.signals.map((s) => (s.id === sig.id ? { ...s, state: "applied" as const } : s)) });
      expect(applied.date).toBe(expected.signal.newDate);
      expect(applied.overriddenBy).toContain(sig.id);
      expect(sig.sourceRef.excerpt?.text).toBeTruthy();
      const eff = signalEffect(records, profile, [], sig.id, meta.asOf, meta.fxRates)!;
      const appliedRun = forecast({ ...records, signals: records.signals.map((s) => (s.id === sig.id ? { ...s, state: "applied" as const } : s)) }, profile, base, meta.asOf, meta.fxRates);
      expect(eff).toEqual({ lowPointDelta: appliedRun.lowPoint.amount - run().lowPoint.amount, week: appliedRun.lowPoint.week });
    });
  }

  if (expected.possibleOutsideMainLine) {
    it("possible deals feed only the pipeline band", () => {
      const r = run();
      const p = r.events.filter((e) => e.commitmentId?.startsWith(expected.possibleOutsideMainLine));
      expect(p.length).toBeGreaterThan(0);
      // The deal has linked supplier costs that land before its receipts, so the band can sit below the main line; it must differ.
      expect(r.weeks.at(-1)!.pipelineClosing).not.toBe(r.weeks.at(-1)!.closing);
      const inDays = new Set(r.days.flatMap((d) => d.eventIds));
      for (const e of p) expect(inDays.has(e.id)).toBe(false);
    });
  }

  if (expected.noReceivableEvents) {
    it("has no receivable events, only recurring items and daily sales", () => {
      expect(records.commitments.every((c) => c.direction === "out")).toBe(true);
    });
  }
  if (expected.hasDailySales) {
    it("forecasts daily sales from history, shaped by weekday", () => {
      const sales = run().events.filter((e) => e.commitmentId === "daily-sales");
      expect(sales.length).toBe(run().days.length);
      const byDow = (d: number) => sales.find((e) => new Date(e.date + "T00:00:00Z").getUTCDay() === d)!.amount;
      expect(byDow(6)).toBeGreaterThan(byDow(1)); // Saturday beats Monday
    });
  }
});
