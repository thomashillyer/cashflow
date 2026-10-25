// Live Ask Neri, offline: a stub Anthropic client, temp cache dirs, no network, no key.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppOptions } from "./app";
import { loadSamples } from "./demo";
import { MemoryStore } from "./store";

const NOVEL = "Can I afford $12K for new shelving next Friday?";
const SUGGESTED = "Can I afford a $40K deposit to Shenzhen in December?"; // answered from the committed caches
const intentJson = JSON.stringify({
  kind: "afford", partyPhrase: null, referencePhrase: null, amountPhrase: "$12K", datePhrase: "next Friday", windowPhrase: null,
  commitmentType: "plan", direction: "out", ruleKind: null, ruleParamPhrase: null, containsInstructions: false,
});
const reply = { stop_reason: "end_turn", content: [{ type: "text", text: intentJson }], usage: { input_tokens: 10, output_tokens: 5 } };

const stub = (impl: (...a: unknown[]) => Promise<unknown>) => {
  const create = vi.fn(impl);
  return { create, client: { messages: { create } } as unknown as Anthropic };
};

type Opts = Partial<AppOptions> & { tempCache?: boolean };

async function appWith({ tempCache, ...opts }: Opts) {
  const store = new MemoryStore();
  for (const s of loadSamples()) await store.resetBusiness(s, s.records);
  const dir = mkdtempSync(join(tmpdir(), "ask-live-"));
  return buildApp({
    store, verify: async () => null, demoMode: true, now: () => new Date("2026-11-16T17:00:00Z"),
    askLive: { log: () => {} }, ...opts,
    // Miss tests redirect the live cache to a temp dir (no committed entries, nothing leaks between runs).
    ...(tempCache ? { askCacheDirs: { intent: join(dir, "i"), voice: join(dir, "v") } } : {}),
  });
}
const ask = (app: Awaited<ReturnType<typeof appWith>>, question: string) =>
  app.inject({ method: "POST", url: "/ask", headers: { "x-neri-visitor": "visitor-aaaaaaaaaaaa" }, payload: { question } });

describe("live Ask Neri", () => {
  it("cache hit: no client call", async () => {
    const s = stub(async () => reply);
    const app = await appWith({ aiMode: "cache_only", askMode: "live", askClient: s.client });
    const res = await ask(app, SUGGESTED);
    expect(res.statusCode).toBe(200);
    expect(res.json().verdict).not.toBe("decline");
    expect(s.create).not.toHaveBeenCalled();
  });

  it("cache miss: the client is called and the answer is used", async () => {
    const s = stub(async () => reply);
    const app = await appWith({ aiMode: "cache_only", askMode: "live", askClient: s.client, tempCache: true });
    const res = await ask(app, NOVEL);
    expect(res.statusCode).toBe(200);
    expect(s.create).toHaveBeenCalled();
    expect(res.json().proposal).toMatchObject({ kind: "plan", amount: 1200000 });
  });

  it("client throws: deterministic answer, status 200", async () => {
    const s = stub(async () => { throw new Error("overloaded"); });
    const app = await appWith({ askMode: "live", askClient: s.client, tempCache: true });
    const res = await ask(app, NOVEL);
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toEqual(expect.any(String));
    expect(res.json().text).not.toMatch(/investment|loan/);
  });

  it("client times out: deterministic answer, status 200", async () => {
    const s = stub(() => new Promise(() => {}));
    const app = await appWith({ askMode: "live", askClient: s.client, tempCache: true, askLive: { timeoutMs: 20, log: () => {} } });
    const res = await ask(app, NOVEL);
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toEqual(expect.any(String));
  });

  it("rate limit reached: cache_only behaviour, no client call", async () => {
    const s = stub(async () => reply);
    const app = await appWith({ askMode: "live", askClient: s.client, tempCache: true, askLive: { maxPerHour: 1, log: () => {} } });
    await ask(app, NOVEL); // uses the budget
    const calls = s.create.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    const res = await ask(app, "Can I afford $9K for a forklift next Thursday?");
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toMatch(/demo mode/);
    expect(s.create.mock.calls.length).toBe(calls);
  });

  it("logs one line per live request without the question", async () => {
    const lines: string[] = [];
    const s = stub(async () => reply);
    const app = await appWith({ askMode: "live", askClient: s.client, tempCache: true, askLive: { log: (l) => lines.push(l) } });
    await ask(app, NOVEL);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/cache=miss/);
    expect(lines[0]).not.toContain("shelving");
  });

  it("question over 500 characters is a 400", async () => {
    const app = await appWith({ askMode: "live", askClient: stub(async () => reply).client });
    expect((await ask(app, "x".repeat(501))).statusCode).toBe(400);
  });

  it("/health shows askMode next to aiMode; askMode defaults to aiMode", async () => {
    const a = await appWith({ aiMode: "cache_only", askMode: "live" });
    expect((await a.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ aiMode: "cache_only", askMode: "live" });
    const b = await appWith({ aiMode: "live" });
    expect((await b.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ aiMode: "live", askMode: "live" });
  });

  it("brief still follows aiMode, not askMode", async () => {
    const s = stub(async () => reply);
    const app = await appWith({ aiMode: "cache_only", askMode: "live", askClient: s.client });
    const res = await app.inject({ method: "GET", url: "/brief", headers: { "x-neri-visitor": "visitor-aaaaaaaaaaaa" } });
    expect(res.statusCode).toBe(200);
    expect(s.create).not.toHaveBeenCalled();
  });
});
