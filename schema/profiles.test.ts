// Every starter template in profiles/ must be a valid Profile and must forecast with zero code changes.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Anchor, Profile } from "./profile";
import type { CommitmentType, Records, Scenario } from "./records";
import { forecast } from "../engine/forecast";
import { diffDays } from "../engine/dates";
import { smallestUpfrontShare } from "../engine/affordability";
import { legGetsLag } from "../engine/expand";
import { engineSettings } from "../engine/settings";

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
        if (l.lagged !== undefined) expect(typeof l.lagged, `${pat.id} lagged`).toBe("boolean");
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

// #121: both milestones_50_50 legs are client invoices (net 60 from order, net 60 from delivery), so both wait on the
// client: with no payment history each lands defaultLagDays (15) after its offset date, and the basis says so.
it("agency.json: both milestone legs get the client's lag", () => {
  const p = JSON.parse(readFileSync(join(dir, "agency.json"), "utf8")) as Profile;
  const src = { system: "test", record: "x" };
  const records: Records = {
    parties: [], events: [], signals: [], rules: [], settlements: [], evidence: [],
    balances: [{ id: "bal", account: "main", amount: 0, currency: "USD", asOf: "2026-11-16", sourceRef: src }],
    commitments: [{ id: "sow", type: "sales_deal", partyId: "client", amount: 2_000_000, currency: "USD", anchors: { order: "2026-10-20", delivery: "2026-11-01" }, status: "likely", sourceRef: src }],
  };
  const run = forecast(records, p, { id: "base", kind: "base", overrides: [] }, "2026-11-16", {});
  const legs = run.events.filter((e) => e.commitmentId === "sow");
  // order Oct 20 + 60 = Dec 19, + 15 = Jan 3; delivery Nov 1 + 60 = Dec 31, + 15 = Jan 15; $20,000 split 50/50
  expect(legs.map((e) => `${e.legIndex}:${e.date}:${e.amount}`)).toEqual(["0:2027-01-03:1000000", "1:2027-01-15:1000000"]);
  for (const e of legs) expect(e.basis).toMatch(/\+ 15 days \(profile default; no payment history\)/);
});

// #137: a leg's own `lagged` flag decides whether it gets the party's lag, overriding engine.lag.laggedAnchors and
// laggedTypes for that leg only. No payment history, so a lagged leg lands defaultLagDays after its offset date.
describe("per-leg lagged flag", () => {
  const src = { system: "test", record: "x" };
  const agency = () => JSON.parse(readFileSync(join(dir, "agency.json"), "utf8")) as Profile;
  const deal = (anchors: Record<string, string>, patternId: string): Records => ({
    parties: [], events: [], signals: [], rules: [], settlements: [], evidence: [],
    balances: [{ id: "bal", account: "main", amount: 0, currency: "USD", asOf: "2026-11-16", sourceRef: src }],
    commitments: [{ id: "d", type: "sales_deal", partyId: "client", amount: 1_000_000, currency: "USD", anchors, status: "likely", patternId, sourceRef: src }],
  });
  const withPattern = (p: Profile, legs: Profile["paymentPatterns"][number]["legs"]): Profile => ({
    ...p, paymentPatterns: [...p.paymentPatterns, { id: "t", appliesTo: "sales_deal", legs }],
  });
  const dates = (r: Records, p: Profile) =>
    forecast(r, p, { id: "base", kind: "base", overrides: [] }, "2026-11-16", {}).events.filter((e) => e.commitmentId === "d").map((e) => e.date);

  it("agency no longer lags order legs profile-wide", () => {
    expect(agency().engine?.lag?.laggedAnchors).toBeUndefined();
  });

  it("lagged: true on a non-lagged anchor gets the lag", () => {
    const p = withPattern(agency(), [{ share: 1, anchor: "order", offsetDays: 0, direction: "in", lagged: true }]);
    expect(dates(deal({ order: "2026-11-20" }, "t"), p)).toEqual(["2026-12-05"]);
  });

  it("lagged: false on a lagged anchor does not", () => {
    const p = withPattern(agency(), [{ share: 1, anchor: "delivery", offsetDays: 30, direction: "in", lagged: false }]);
    expect(dates(deal({ delivery: "2026-11-20" }, "t"), p)).toEqual(["2026-12-20"]);
  });

  it("an agency order-day deposit leg without the flag is not lagged and stays upfront", () => {
    const legs = [
      { share: 0.3, anchor: "order" as const, offsetDays: 0, direction: "in" as const },
      { share: 0.7, anchor: "delivery" as const, offsetDays: 60, direction: "in" as const, lagged: true },
    ];
    const p = withPattern(agency(), legs);
    const r = deal({ order: "2026-11-20", delivery: "2026-12-01" }, "t");
    expect(dates(r, p)).toEqual(["2026-11-20", "2027-02-14"]);
    expect(smallestUpfrontShare(r, p, [], "d", "2026-11-16", {}).upfrontLegs).toEqual([0]);
    // The same order-day leg flagged lagged waits on the client, so it is not money in hand at signing.
    const q = withPattern(agency(), [{ ...legs[0]!, lagged: true }, legs[1]!]);
    expect(dates(r, q)).toEqual(["2026-12-05", "2027-02-14"]);
    expect(smallestUpfrontShare(r, q, [], "d", "2026-11-16", {}).note).toMatch(/no deposit leg/);
  });
});

describe("lagged flag stored with the wrong type (review of #137)", () => {
  it("a non-boolean lagged is ignored and flagged; lagged on a payment is flagged", () => {
    const base = JSON.parse(readFileSync(join(import.meta.dirname, "..", "profiles", "trading.json"), "utf8"));
    const profile = {
      ...base,
      paymentPatterns: [
        ...base.paymentPatterns,
        { id: "bad_flag", appliesTo: "plan", legs: [{ share: 1, anchor: "due", offsetDays: 0, direction: "in", lagged: "false" }] },
        { id: "flag_on_payment", appliesTo: "plan", legs: [{ share: 1, anchor: "due", offsetDays: 0, direction: "out", lagged: true }] },
      ],
    };
    const leg = profile.paymentPatterns.at(-2).legs[0];
    const c = { id: "x", type: "invoice", amount: 100, currency: "USD", anchors: { due: "2026-11-02" }, status: "committed", sourceRef: { system: "t", record: "x" } };
    // the string "false" is not honored as true: falls back to the lists (invoice + due anchor -> lagged by default)
    expect(legGetsLag({ ...leg, anchor: "order" }, c as never, engineSettings(profile))).toBe(false);
    const empty = { parties: [], commitments: [], events: [], signals: [], rules: [], settlements: [], balances: [{ id: "b", account: "a", amount: 0, currency: "USD", asOf: "2026-10-26", sourceRef: { system: "t", record: "b" } }], evidence: [] };
    const run = forecast(empty as never, profile, { id: "base", kind: "base", overrides: [] }, "2026-10-26", {});
    const msgs = (run.review?.reasons ?? []).filter((r) => r.code === "invalid_profile").map((r) => r.message).join(" ");
    expect(msgs).toMatch(/bad_flag leg 1: lagged must be true or false/);
    expect(msgs).toMatch(/flag_on_payment leg 1: lagged applies only to money coming in/);
  });
});
