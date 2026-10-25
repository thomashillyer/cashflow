import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { loadSamples } from "./demo";
import { MemoryStore } from "./store";

const token = { authorization: "Bearer owner" };
let app: FastifyInstance;
let store: MemoryStore;

beforeEach(async () => {
  store = new MemoryStore();
  for (const s of loadSamples()) await store.resetBusiness(s, s.records);
  app = await buildApp({ store, verify: async (t) => t === "owner" ? { id: "owner", email: "owner@example.com" } : null,
    demoMode: false, allowReset: true, now: () => new Date("2026-11-16T17:00:00Z") });
});
afterEach(async () => { await app.close(); });

describe("private production tenant isolation", () => {
  it("returns onboarding instead of sample cash for a signed-in newcomer", async () => {
    for (const url of ["/context", "/brief", "/forecast", "/notes"]) {
      const response = await app.inject({ url, headers: token });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("NO_BUSINESS");
      expect(response.body).not.toContain("Cascade");
    }
    const setup = await app.inject({ method: "POST", url: "/setup", headers: token, payload: { businessName: "My business", kind: "trading" } });
    expect(setup.statusCode).toBe(200);
    expect((await app.inject({ url: "/context", headers: token })).json().business).toMatchObject({ name: "My business", synthetic: false });
  });

  it("never resolves synthetic IDs from a header or query, even if that user is a member", async () => {
    store.addMember("cascade_trade", "owner");
    for (const id of ["cascade_trade", "pike_noodle"]) {
      for (const request of [{ url: "/context", headers: { ...token, "x-neri-business": id } }, { url: `/context?business=${id}`, headers: token }]) {
        const response = await app.inject(request);
        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe("NOT_FOUND");
      }
    }
  });

  it("blocks writes and resets to samples without changing the shared data", async () => {
    const before = await store.load("cascade_trade");
    for (const url of ["/profile", "/notes", "/plans"]) {
      const response = await app.inject({ method: url === "/profile" ? "PATCH" : "POST", url,
        headers: { ...token, "x-neri-business": "cascade_trade" }, payload: { text: "change it", amount: 10000 } });
      expect(response.statusCode).toBe(404);
    }
    const reset = await app.inject({ method: "POST", url: "/demo/reset", headers: token });
    expect(reset.statusCode).toBe(403); // allowReset cannot turn production into a demo.
    expect(await store.load("cascade_trade")).toEqual(before);
  });

  it("requires a verified session for both reads and writes", async () => {
    for (const [method, url] of [["GET", "/context"], ["POST", "/setup"], ["POST", "/notes"], ["POST", "/demo/reset"]] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(401);
    }
  });

  it.each(["trading", "restaurant", "services", "contractor"])("starts %s with no fixture cash, revenue or reserve", async (kind) => {
    const setup = await app.inject({ method: "POST", url: "/setup", headers: token, payload: { businessName: "My business", kind } });
    expect(setup.statusCode).toBe(200);
    const context = (await app.inject({ url: "/context", headers: token })).json();
    expect(context.profile.recurring).toEqual([]);
    expect(context.profile.safetyLine).toEqual({ kind: "fixed", amount: 0 });
    const run = (await app.inject({ url: "/forecast", headers: token })).json();
    expect(run.openingBalance).toBe(0);
    expect(run.events).toEqual([]);
    expect(run.review.needed).toBe(true);
    expect(run.review.reasons.map((r: { code: string }) => r.code)).toContain("no_opening_balance");
    expect((await store.load(setup.json().businessId)).records.balances).toEqual([]);
  });

  it("honors an explicitly entered reserve without inventing a bank balance", async () => {
    const setup = await app.inject({ method: "POST", url: "/setup", headers: token,
      payload: { businessName: "My business", kind: "trading", reserve: 123400 } });
    expect(setup.statusCode).toBe(200);
    const run = (await app.inject({ url: "/forecast", headers: token })).json();
    expect(run.safetyLine).toBe(123400);
    expect(run.openingBalance).toBe(0);
    expect(run.review.needed).toBe(true);
  });
});

describe("runtime demo capability", () => {
  it.each([false, true])("serves an authoritative boolean demo flag %s", async (demoMode) => {
    const server = await buildApp({ store: new MemoryStore(), verify: async () => null, demoMode,
      staticDir: join(import.meta.dirname, "../app") });
    const response = await server.inject({ url: "/config.js" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`window.NERI_DEMO_MODE = ${demoMode};`);
    expect(response.body).toContain('window.NERI_API_BASE = "same-origin";');
    await server.close();
  });
});
