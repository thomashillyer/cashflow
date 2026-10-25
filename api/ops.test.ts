// Readiness, request logs and FX validation (issue #187). Offline: injected hooks, in-memory store.

import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { cleanFxRates } from "./engine";
import { latestMigrationVersion, repoSchemaVersion } from "./schema-status";
import { MemoryStore } from "./store";

const verify = async () => null;
const make = (extra: Parameters<typeof buildApp>[0] extends infer O ? Partial<O> : never = {}) =>
  buildApp({ store: new MemoryStore(), verify, ...extra });

describe("GET /ready", () => {
  it("is 200 when the database matches the code", async () => {
    const app = await make({ schemaStatus: async () => ({ repo: "20261025210000", db: "20261025210000" }) });
    const r = await app.inject({ url: "/ready" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, schema: { repo: "20261025210000", db: "20261025210000" } });
  });

  it("is 503 when the database is behind or the function is missing", async () => {
    for (const db of ["20261025200000", null]) {
      const app = await make({ schemaStatus: async () => ({ repo: "20261025210000", db }) });
      const r = await app.inject({ url: "/ready" });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({
        ok: false, schema: { repo: "20261025210000", db },
        message: "Database is behind the code: run npx supabase db push.",
      });
    }
  });

  it("is always ready on the memory store (no hook)", async () => {
    const r = await (await make()).inject({ url: "/ready" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, schema: null });
  });

  it("caches the check for about 30 seconds", async () => {
    let calls = 0, t = 0;
    const app = await make({ now: () => new Date(t), schemaStatus: async () => ({ repo: "2", db: (++calls, "2") }) });
    await app.inject({ url: "/ready" });
    await app.inject({ url: "/ready" });
    expect(calls).toBe(1);
    t = 31_000;
    await app.inject({ url: "/ready" });
    expect(calls).toBe(2);
  });

  it("leaves /health at 200 when the schema is behind", async () => {
    const app = await make({ schemaStatus: async () => ({ repo: "2", db: null }) });
    expect((await app.inject({ url: "/ready" })).statusCode).toBe(503);
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
  });
});

describe("repo migration version", () => {
  it("is the highest version among filenames", () => {
    expect(latestMigrationVersion(["20261025120000_a.sql", "20261025200000_b.sql", "README.md", "20261025130000_c.sql"])).toBe("20261025200000");
    expect(latestMigrationVersion([])).toBe("");
  });
  it("reads the real migrations folder", () => {
    expect(repoSchemaVersion("supabase/migrations") >= "20261025210000").toBe(true);
  });
});

describe("request log line", () => {
  it("carries request id, method, route and status, and no body or token", async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    const app = await make({ logger: { stream } });
    await app.inject({ url: "/health", headers: { authorization: "Bearer secret-token" } });
    await app.inject({ url: "/brief" }); // 401: error code logged
    await app.close();
    const logs = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === "request");
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ reqId: "req-1", method: "GET", route: "/health", status: 200 });
    expect(typeof logs[0]!.ms).toBe("number");
    expect(logs[1]).toMatchObject({ method: "GET", route: "/brief", status: 401, errorCode: "UNAUTHENTICATED" });
    expect(lines.join("")).not.toContain("secret-token");
  });
});

describe("cleanFxRates", () => {
  it("drops bad rates with a warning and keeps good ones", () => {
    const warnings: string[] = [];
    const out = cleanFxRates({ EUR: 1.1, usd: 1, GBP: -2, JPY: 0, CNY: NaN, INR: "83", XYZW: 1 }, (m) => warnings.push(m));
    expect(out).toEqual({ EUR: 1.1 });
    expect(warnings).toHaveLength(6);
  });
  it("tolerates a missing map", () => {
    expect(cleanFxRates(undefined)).toEqual({});
  });
});
