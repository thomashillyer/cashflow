// Fake Zoho CRM v6 shaped from a live read (invented names and amounts): requires an explicit `fields` list
// like the real API, answers 204 for an empty module, pages with info.more_records.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expand } from "../../engine/expand";
import { horizonEnd } from "../../engine/forecast";
import type { Profile } from "../../schema/profile";
import type { Fetch } from "../connector";
import { dedupeEvidence } from "../core/dedupe";
import { pullZohoCrm } from "./index";

const NOW = "2026-10-25T18:00:00Z";
const token = async () => "tok";
const deal = (id: string, over: Record<string, unknown> = {}) => ({
  id, Deal_Name: `Deal ${id}`, Stage: "PO received", Probability: 100, Amount: 50000, Currency: "USD", Closing_Date: "2026-11-15",
  Account_Name: { name: "Harbor Foods", id: "acct1" }, Modified_Time: "2026-10-20T10:00:00-07:00", ...over,
});
const DEALS = [
  deal("d1"),
  deal("d2", { Stage: "Delivered", Amount: 80000 }),
  deal("d3", { Stage: "Supplier Qualified", Probability: 70, Amount: 100000, Account_Name: { name: "Maple Cafe", id: "acct2" } }),
  deal("d4", { Stage: "Qualification", Probability: 20, Amount: 30000 }),
  deal("d5", { Stage: "Closed Lost", Probability: 0, Amount: 9000 }),
  deal("d6", { Amount: null }),
  deal("d7", { Probability: null, Stage: "Custom Stage" }),
  deal("d8", { Closing_Date: null }),
];

function fake(over: { status?: number; deals?: unknown[]; pages?: boolean } = {}) {
  const urls: string[] = [], methods: string[] = [];
  const f: Fetch = async (url, init) => {
    urls.push(url); methods.push(init.method);
    if (over.status) return { status: over.status, json: async () => ({}) };
    const u = new URL(url);
    if (!u.searchParams.get("fields")) return { status: 400, json: async () => ({ code: "REQUIRED_PARAM_MISSING" }) };
    if (over.deals?.length === 0) return { status: 204, json: async () => { throw new Error("no body"); } };
    const page = Number(u.searchParams.get("page"));
    const data = over.pages ? Array.from({ length: 200 }, (_, i) => deal(`p${page}-${i}`)) : over.deals ?? DEALS;
    return { status: 200, json: async () => ({ data, info: { more_records: !!over.pages, page, per_page: 200 } }) };
  };
  return { fetch: f, urls, methods };
}
const pull = (over: Parameters<typeof fake>[0] = {}, mapping?: Parameters<typeof pullZohoCrm>[0]["mapping"]) =>
  pullZohoCrm({ region: "com", token, now: NOW, fetch: fake(over).fetch, ...(mapping ? { mapping } : {}) });

describe("pullZohoCrm", () => {
  it("maps deals to sales_deal commitments with certainty from the CRM's own probability", async () => {
    const r = await pull();
    if (!r.ok) throw new Error("expected ok");
    const c = Object.fromEntries(r.data.commitments.map((x) => [x.sourceRef.record, x]));
    expect(c.d1).toMatchObject({ id: "deal-d1", type: "sales_deal", direction: "in", amount: 5000000, currency: "USD", status: "committed", anchors: { order: "2026-11-15" }, settlement: "open" });
    expect(c.d1!.probability).toBeUndefined();
    expect(c.d2).toMatchObject({ status: "committed" });   // no stage rule: 100% is committed (the profile skips Delivered)
    expect(c.d3).toMatchObject({ status: "likely", probability: 0.7 });       // at or above the default 60% cut
    expect(c.d4).toMatchObject({ status: "possible", probability: 0.2 });
    expect(c.d5).toBeUndefined();                           // probability 0 = lost
    expect(r.data.skipped.map((s) => s.dealId)).toEqual(["d5"]);
    expect(r.data.parties.map((p) => p.name).sort()).toEqual(["Harbor Foods", "Maple Cafe"]);
    expect(r.data.commitments.every((x) => x.evidenceIds?.length === 1)).toBe(true);
  });

  it("the profile's stage rules and thresholds win: Delivered is skipped so invoiced money is not counted twice", async () => {
    const r = await pull({}, { stageStatus: { Delivered: "skip", "Supplier Qualified": "likely" }, probabilityStatus: { likelyAt: 0.15 } });
    if (!r.ok) throw new Error("expected ok");
    const c = Object.fromEntries(r.data.commitments.map((x) => [x.sourceRef.record, x]));
    expect(c.d2).toBeUndefined();
    expect(c.d3).toMatchObject({ status: "likely", probability: 0.7 });
    expect(c.d4).toMatchObject({ status: "likely" });
    expect(r.data.diagnostics.warnings.join(" ")).toMatch(/left out \(Delivered: 1/);
    // Skipped on purpose: not counted against completeness.
    expect(r.data.diagnostics.completeness).toBeGreaterThan(0);
  });

  it("never turns a missing amount, probability, or currency into a guess, and keeps a missing date visible", async () => {
    const r = await pull();
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.commitments.find((x) => x.sourceRef.record === "d6")).toBeUndefined();   // no amount
    expect(r.data.commitments.find((x) => x.sourceRef.record === "d7")).toBeUndefined();   // no probability, unmapped stage
    const noDate = r.data.commitments.find((x) => x.sourceRef.record === "d8")!;
    expect(noDate.anchors.order).toBeUndefined();
    const codes = r.data.diagnostics.errors.map((e) => e.code);
    expect(codes).toEqual(expect.arrayContaining(["missing_amount", "unsupported", "missing_date"]));
    for (const e of r.data.diagnostics.errors) expect(e.nextStep).not.toBe("");
    const noCur = await pull({ deals: [deal("x", { Currency: null })] });
    if (!noCur.ok) throw new Error("expected ok");
    expect(noCur.data.commitments).toEqual([]);
    expect(noCur.data.diagnostics.errors[0]!.code).toBe("invalid_currency");
    const withDefault = await pull({ deals: [deal("x", { Currency: null })] }, { defaultCurrency: "USD" });
    if (!withDefault.ok) throw new Error("expected ok");
    expect(withDefault.data.commitments[0]!.currency).toBe("USD");
  });

  it("a repeat pull is unchanged; a changed stage or amount supersedes", async () => {
    const a = await pull();
    if (!a.ok) throw new Error("expected ok");
    const b = await pullZohoCrm({ region: "com", token, now: "2026-10-26T00:00:00Z", fetch: fake().fetch, existingEvidence: a.data.evidence });
    if (!b.ok) throw new Error("expected ok");
    expect(b.data.diagnostics.rowsImported).toBe(0);
    expect(dedupeEvidence(a.data.evidence, b.data.evidence).fresh).toEqual([]);
    const edited = DEALS.map((d) => (d.id === "d1" ? { ...d, Amount: 55000 } : d));
    const c = await pullZohoCrm({ region: "com", token, now: "2026-10-27T00:00:00Z", fetch: fake({ deals: edited }).fetch });
    if (!c.ok) throw new Error("expected ok");
    expect(dedupeEvidence(a.data.evidence, c.data.evidence).superseded).toHaveLength(1);
  });

  it("warns about open deals whose closing date is already past, without changing them", async () => {
    const r = await pullZohoCrm({ region: "com", token, now: "2026-12-01T00:00:00Z", fetch: fake({ deals: [deal("old", { Closing_Date: "2026-04-30" }), deal("new", { Closing_Date: "2027-01-15" })] }).fetch });
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.diagnostics.warnings.join(" ")).toMatch(/1 open deal has a closing date in the past/);
    expect(r.data.commitments.find((c) => c.sourceRef.record === "old")!.anchors.order).toBe("2026-04-30");
  });

  it("warns that deals committed by probability alone may already be invoiced", async () => {
    const r = await pull();
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.diagnostics.warnings.join(" ")).toMatch(/committed because the CRM says 100%.*map that stage to "skip"/);
    const ruled = await pull({ deals: [deal("a")] }, { stageStatus: { "PO received": "committed" } });
    if (!ruled.ok) throw new Error("expected ok");
    expect(ruled.data.diagnostics.warnings.join(" ")).not.toMatch(/committed because the CRM says 100%/);
  });

  it("a stage named like an object property is not a rule, and a mistyped rule is a plain config error", async () => {
    const r = await pull({ deals: [deal("a", { Stage: "constructor" }), deal("b", { Stage: "__proto__" })] });
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.commitments.map((c) => c.status)).toEqual(["committed", "committed"]);
    const bad = await pull({}, { stageStatus: { Delivered: "won" as never } });
    expect(bad).toMatchObject({ ok: false, error: { kind: "config", fallback: "file" } });
    if (!bad.ok) expect(bad.error.nextStep).toMatch(/skip, committed, likely or possible/);
  });

  it("a deal with no closing date is imported unplaced and the engine puts no cash on the calendar for it", async () => {
    const r = await pull({ deals: [deal("nodate", { Closing_Date: null })] });
    if (!r.ok) throw new Error("expected ok");
    const profile = JSON.parse(readFileSync(join(__dirname, "../../profiles/trading.json"), "utf8")) as Profile;
    const records = { parties: r.data.parties, commitments: r.data.commitments, events: [], signals: [], rules: [], settlements: [], balances: [], evidence: r.data.evidence };
    const run = expand(records as never, profile, "2026-10-25", horizonEnd(profile, "2026-10-25"), {});
    expect(run.events.filter((e) => e.commitmentId === "deal-nodate")).toEqual([]);
  });

  it("an empty CRM (204) is zero deals, not an error", async () => {
    const r = await pull({ deals: [] });
    expect(r).toMatchObject({ ok: true, data: { commitments: [] } });
  });

  it("is GET-only against the fixed region host, sends an explicit fields list, and validates names", async () => {
    const g = fake();
    await pullZohoCrm({ region: "eu", token, now: NOW, fetch: g.fetch });
    expect(new Set(g.methods)).toEqual(new Set(["GET"]));
    for (const u of g.urls) { expect(new URL(u).origin).toBe("https://www.zohoapis.eu"); expect(new URL(u).searchParams.get("fields")).toContain("Deal_Name"); }
    for (const bad of [{ module: "Deals/../Leads" }, { module: "De als" }, { fields: { name: "Deal_Name,Secret" } }]) {
      const g2 = fake();
      const res = await pullZohoCrm({ region: "com", token, now: NOW, fetch: g2.fetch, mapping: bad });
      expect(res, JSON.stringify(bad)).toMatchObject({ ok: false, error: { kind: "config" } });
      expect(g2.urls).toEqual([]);
    }
    expect(await pullZohoCrm({ region: "evil.com/x" as never, token, now: NOW, fetch: g.fetch })).toMatchObject({ ok: false, error: { kind: "config" } });
  });

  it.each([[401, "auth", /Reconnect Zoho and allow CRM/], [403, "auth", /allow read access/], [429, "rate_limit", /few minutes/], [500, "network", /upload an export/i]])(
    "status %s is a plain next step with the file fallback", async (status, kind, next) => {
      const r = await pull({ status });
      expect(r).toMatchObject({ ok: false, error: { kind, fallback: "file" } });
      if (!r.ok) expect(r.error.nextStep).toMatch(next);
    });

  it("bounds paging and says when it stopped early", async () => {
    const r = await pull({ pages: true });
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.commitments).toHaveLength(2000);
    expect(r.data.diagnostics.warnings.join(" ")).toMatch(/Only the newest 2000 deals/);
  });

  it("the real engine turns the deals into forecast legs: committed in the main line, possible weighted", async () => {
    const r = await pull({}, { stageStatus: { Delivered: "skip" } });
    if (!r.ok) throw new Error("expected ok");
    const profile = JSON.parse(readFileSync(join(__dirname, "../../profiles/trading.json"), "utf8")) as Profile;
    const records = { parties: r.data.parties, commitments: r.data.commitments, events: [], signals: [], rules: [], settlements: [], balances: [], evidence: r.data.evidence };
    const run = expand(records as never, profile, "2026-10-25", horizonEnd(profile, "2026-10-25"), {});
    const mine = run.events.filter((e) => e.commitmentId?.startsWith("deal-"));
    expect(mine.length).toBeGreaterThan(0);
    expect(new Set(mine.map((e) => e.status))).toEqual(expect.objectContaining(new Set(["committed", "possible"])));
    expect(mine.every((e) => e.direction === "in" || e.direction === "out")).toBe(true);
  });
});
