// Every starter template in profiles/ must be a valid Profile and must forecast with zero code changes.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Anchor, Profile } from "./profile";
import type { CommitmentType, Records, Scenario } from "./records";
import { forecast } from "../engine/forecast";
import { diffDays } from "../engine/dates";

const dir = join(import.meta.dirname, "..", "profiles");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

const ANCHORS: Anchor[] = ["order", "ship", "delivery", "invoice", "due", "month_end", "weekday"];
const TYPES: CommitmentType[] = ["invoice", "bill", "recurring", "sales_deal", "purchase_order", "plan"];
const CADENCES = ["weekly", "biweekly", "semimonthly", "monthly", "quarterly"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

it("ships the four starter templates", () => {
  expect(files).toEqual(expect.arrayContaining(["trading.json", "restaurant.json", "agency.json", "contractor.json"]));
});

describe.each(files)("profile %s", (file) => {
  const p = JSON.parse(readFileSync(join(dir, file), "utf8")) as Profile;

  it("has the required top-level fields", () => {
    expect(p.id).toBe(file.replace(/\.json$/, ""));
    expect(p.baseCurrency).toMatch(/^[A-Z]{3}$/);
    expect(p.horizonWeeks).toBeGreaterThan(0);
    expect(p.defaultLagDays).toBeGreaterThanOrEqual(0);
    expect(["fixed", "weeksOfFixedCosts"]).toContain(p.safetyLine.kind);
    expect(typeof p.thresholds.signalAutoApplyConfidence).toBe("number");
    expect(typeof p.thresholds.rankFloor).toBe("number");
  });

  it("payment patterns: unique ids, valid anchors, shares sum to 1, one default per type, linked costs resolve", () => {
    const ids = p.paymentPatterns.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const pat of p.paymentPatterns) {
      expect(TYPES, pat.id).toContain(pat.appliesTo);
      expect(pat.legs.length, pat.id).toBeGreaterThan(0);
      expect(Math.abs(pat.legs.reduce((a, l) => a + l.share, 0) - 1), `${pat.id} shares`).toBeLessThan(1e-9);
      for (const l of pat.legs) {
        expect(ANCHORS, pat.id).toContain(l.anchor);
        expect(l.share, pat.id).toBeGreaterThan(0);
        expect(Number.isInteger(l.offsetDays), pat.id).toBe(true);
        expect(["in", "out"], pat.id).toContain(l.direction);
        if (l.anchor === "weekday") expect([0, 1, 2, 3, 4, 5, 6], `${pat.id} weekday`).toContain(l.weekday);
      }
      for (const lc of pat.linkedCosts ?? []) {
        expect(ids, `${pat.id} linked cost`).toContain(lc.patternId);
        expect(lc.share).toBeGreaterThan(0);
      }
    }
    for (const t of TYPES) expect(p.paymentPatterns.filter((x) => x.appliesTo === t && x.isDefault).length, t).toBeLessThanOrEqual(1);
  });

  it("recurring items: unique ids, known cadences, ISO anchors, semimonthly has secondDay", () => {
    const ids = p.recurring.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of p.recurring) {
      expect(CADENCES, r.id).toContain(r.cadence);
      expect(r.anchor, r.id).toMatch(ISO);
      expect(Number.isInteger(r.amount) && r.amount > 0, `${r.id} amount in cents`).toBe(true);
      if (r.cadence === "semimonthly") expect(r.secondDay, r.id).toBeGreaterThanOrEqual(1);
      if (r.secondDay !== undefined) expect(r.secondDay, r.id).toBeLessThanOrEqual(31);
    }
  });

  it("revenue model is well formed", () => {
    const m = p.revenueModel;
    if (m.kind === "dailySales") {
      expect(m.weekdayWeights).toHaveLength(7);
      expect(m.weekdayWeights.every((w) => w >= 0)).toBe(true);
      if (m.settleLagDays !== undefined) expect(Number.isInteger(m.settleLagDays) && m.settleLagDays >= 0).toBe(true);
    } else expect(["deals", "retainers"]).toContain(m.kind);
  });

  it("engine tunables, when set, are in range", () => {
    const e = p.engine ?? {};
    const unit = (x: number | undefined) => x === undefined || (x >= 0 && x <= 1);
    const days = (x: number | undefined) => x === undefined || (Number.isInteger(x) && x > 0);
    expect(Object.values(e.statusConfidence ?? {}).every(unit), "statusConfidence").toBe(true);
    expect(unit(e.dailySalesConfidence) && unit(e.lag?.noHistoryConfidence), "confidences").toBe(true);
    expect([e.salesHistoryDays, e.settlementMatchDays, e.staleFallbackDays, e.noSnapshotLookbackDays, e.deferDays, e.urgencyScaleDays, e.lag?.maxSamples].every(days), "day counts").toBe(true);
    expect(e.lag?.iqrScaleDays === undefined || e.lag.iqrScaleDays > 0, "iqrScaleDays").toBe(true);
    expect(e.affordabilityStep === undefined || (e.affordabilityStep > 0 && e.affordabilityStep <= 1), "affordabilityStep").toBe(true);
    for (const a of e.lag?.laggedAnchors ?? []) expect(ANCHORS).toContain(a);
    for (const t of e.lag?.laggedTypes ?? []) expect(TYPES).toContain(t);
  });

  it("forecasts a minimal book with zero code changes", () => {
    const src = { system: "test", record: "x" };
    const records: Records = {
      parties: [], events: [], signals: [], rules: [], settlements: [], evidence: [],
      balances: [{ id: "bal", account: "main", amount: 5_000_000, currency: p.baseCurrency, asOf: "2026-11-16", sourceRef: src }],
      commitments: [
        { id: "inv", type: "invoice", amount: 1_000_000, currency: p.baseCurrency, anchors: { invoice: "2026-11-02", due: "2026-12-02" }, status: "committed", sourceRef: src },
        { id: "deal", type: "sales_deal", amount: 2_000_000, currency: p.baseCurrency, anchors: { order: "2026-11-20", delivery: "2026-12-20", due: "2027-01-05" }, status: "likely", sourceRef: src },
        { id: "bill", type: "bill", amount: 300_000, currency: p.baseCurrency, anchors: { invoice: "2026-11-10", due: "2026-11-24" }, status: "committed", sourceRef: src },
      ],
    };
    const base: Scenario = { id: "base", kind: "base", overrides: [] };
    const run = forecast(records, p, base, "2026-11-16", {});
    let prev = run.openingBalance;
    for (const d of run.days) {
      expect(d.closing).toBe(prev + d.inflow - d.outflow);
      prev = d.closing;
    }
    // The default invoice pattern honors the imported due date: with no payment history, the invoice is forecast
    // in full within defaultLagDays (+1 for rounding) of it.
    const inv = run.events.filter((e) => e.commitmentId === "inv");
    expect(inv.reduce((a, e) => a + e.amount, 0)).toBe(1_000_000);
    for (const e of inv) {
      const days = diffDays(e.date, "2026-12-02");
      expect(days, `${p.id} invoice ${e.date}`).toBeGreaterThanOrEqual(0);
      expect(days, `${p.id} invoice ${e.date}`).toBeLessThanOrEqual(p.defaultLagDays + 1);
    }
    expect(run.warnings.join(" ")).not.toMatch(/not scheduled/);
  });
});
