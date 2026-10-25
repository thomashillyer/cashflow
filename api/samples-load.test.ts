// One-click sample: POST /samples/load and /samples/clear on a private business.

import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { loadSample, shiftSample } from "./demo";
import { MemoryStore } from "./store";

const H = { authorization: "Bearer owner" };
let app: FastifyInstance;
let store: MemoryStore;
const get = async (url: string, headers = H) => (await app.inject({ url, headers })).json();
const post = (url: string, headers = H) => app.inject({ method: "POST", url, headers, payload: {} });

beforeEach(async () => {
  store = new MemoryStore();
  app = await buildApp({
    store, demoMode: false, aiMode: "cache_only", now: () => new Date("2026-10-25T17:00:00Z"),
    verify: async (t) => (t === "owner" ? { id: "owner", email: "o@example.com" } : t === "other" ? { id: "other", email: "x@example.com" } : null),
  });
  await app.inject({ method: "POST", url: "/setup", headers: H, payload: { businessName: "My Shop", kind: "trading" } });
});

describe("sample load", () => {
  it("fills an empty private business: Review has Evergreen, brief has drafts, name kept", async () => {
    const res = await post("/samples/load");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().commitments).toBeGreaterThan(0);
    const ctx = await get("/context");
    expect(ctx.business.name).toBe("My Shop");
    expect(ctx.business.sampleLoaded).toBe(true);
    expect(JSON.stringify(await get("/review"))).toContain("sig-ev-whatsapp-evergreen-2");
    const brief = await get("/brief");
    expect(brief.three.length).toBeGreaterThanOrEqual(2);
    expect(brief.three.filter((i: { actions: { kind: string }[] }) => i.actions.some((a) => a.kind === "draft_email")).length).toBeGreaterThanOrEqual(2);
  });

  it("a second load is 409", async () => {
    await post("/samples/load");
    const again = await post("/samples/load");
    expect(again.statusCode).toBe(409);
    expect(again.json().error?.message ?? again.body).toContain("Your business already has data.");
  });

  it("clear empties it, and only works when a sample is loaded", async () => {
    expect((await post("/samples/clear")).statusCode).toBe(409);
    await post("/samples/load");
    expect((await post("/samples/clear")).statusCode).toBe(200);
    expect((await get("/brief")).three).toEqual([]);
    const ctx = await get("/context");
    expect(ctx.business.sampleLoaded).toBe(false);
    expect(ctx.business.name).toBe("My Shop");
  });

  it("rejects a non-member and no token", async () => {
    expect([401, 403, 404]).toContain((await post("/samples/load", { authorization: "Bearer other" })).statusCode);
    expect((await post("/samples/load", {} as typeof H)).statusCode).toBe(401);
  });

  it("the date shift keeps the low point inside the 13 weeks", async () => {
    const sample = shiftSample(loadSample("cascade_trade")!, "2026-10-25");
    expect(sample.records.balances[0]!.asOf).toBe("2026-10-25");
    await post("/samples/load");
    const run = (await get("/brief")).run;
    const low = run.lowPoint ?? run.low ?? run.summary?.lowPoint;
    const date: string | undefined = low?.date;
    expect(date).toBeDefined();
    expect(date! >= "2026-10-25" && date! <= "2027-01-24").toBe(true);
  });
});
