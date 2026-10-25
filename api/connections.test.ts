import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { buildAccounting } from "../adapters/accounting/common";
import type { IntakeInput, IntakeContext, IntakeResult } from "../ai/intake";
import { reviewCandidate } from "../ai/extract/document";
import { propose } from "../ai/reconcile/match";
import type { ZohoPullInput } from "../adapters/zoho_books";
import { buildConnectionService } from "./connections";
import { sendError, type NeriRequest } from "./http";
import { connectionRoutes } from "./routes/connections";
import { MemoryStore, type Business, type StoredProfile } from "./store";

const profile = JSON.parse(readFileSync(new URL("../profiles/trading.json", import.meta.url), "utf8")) as StoredProfile;
const env = {
  NERI_CONNECTOR_BUSINESS_ID: "private-owner", ZOHO_API_DOMAIN: "https://www.zohoapis.com",
  ZOHO_CLIENT_ID: "test-client", ZOHO_CLIENT_SECRET: "test-secret", ZOHO_REFRESH_TOKEN: "test-refresh",
  ZOHO_ORGANIZATION_ID: "test-org",
};
const now = () => new Date("2026-10-25T22:00:00Z");
const output = (at: string) => buildAccounting({
  system: "zoho_books", now: at, payments: [], docs: [{
    kind: "invoice", providerId: "source-1", number: "INV-1", partyId: "customer-1", partyName: "Example Customer",
    currency: "USD", total: 100, balance: 100, issued: "2026-10-20", due: "2026-11-20", status: "open", raw: { revision: 1 }, sheet: "invoices", row: 1,
  }],
});

const microsoft = { ...env, MICROSOFT_TENANT_ID: "00000000-0000-0000-0000-000000000001", MICROSOFT_CLIENT_ID: "fake-ms-client", MICROSOFT_CLIENT_SECRET: "fake-ms-secret", MICROSOFT_MAILBOX_UPN: "owner@example.com" };
const email = (id: string): Extract<IntakeInput, { kind: "email" }> => ({ kind: "email", raw: `From: supplier@example.com\nTo: owner@example.com\nSubject: Invoice update\nMessage-ID: <${id}>\n\nPlease review the invoice.`, source: { evidenceId: `email-${id}`, sourceRef: { system: "email", record: id } } });
const readEmail = async (input: IntakeInput, ctx: IntakeContext): Promise<IntakeResult> => {
  const id = input.source!.evidenceId!;
  const candidate = { ...reviewCandidate({ candidateId: `candidate-${id}`, revision: 1, evidenceIds: [id] }, "partial", ["Review the invoice."]), extraction: "ok" as const };
  return {
    evidence: [{ id, channel: "email", format: "eml", receivedAt: ctx.now, extraction: "ok", sourceRef: input.source!.sourceRef! }],
    candidates: [candidate], proposals: [propose(candidate, ctx.records, { storeRevision: ctx.storeRevision, now: ctx.now })],
    signals: [{ id: `signal-${id}`, channel: "email", receivedAt: ctx.now, claim: { kind: "date_change", newDate: "2026-12-01" }, confidence: 0.8, state: "applied", sourceRef: input.source!.sourceRef! }], notes: [],
  };
};

describe("tenant-bound Outlook review intake", () => {
  it("keeps email results proposed, preserves accepted records, and skips already-read messages", async () => {
    const { store, business, other } = await setup();
    const pull = vi.fn(async () => ({ ok: true as const, data: { inputs: [email("one")], diagnostics: output(now().toISOString()).diagnostics } }));
    const ingest = vi.fn(readEmail);
    const service = buildConnectionService(microsoft, { outlookPull: pull, ingest, aiMode: "live" });
    expect(service.list(business).connections[1]).toMatchObject({ id: "outlook", available: true, state: "waiting" });
    await expect(service.sync(other, store, now, "outlook")).rejects.toMatchObject({ status: 403 });
    expect(pull).not.toHaveBeenCalled();
    const first = await service.sync(business, store, now, "outlook");
    expect(first).toMatchObject({ counts: { evidence: 1, proposals: 1, signals: 1 }, storeRevision: 0 });
    expect(ingest.mock.calls[0]?.[1].mode).toBe("live");
    const saved = await store.load(business.id);
    expect(saved.records.commitments).toEqual([]);
    expect(saved.records.settlements).toEqual([]);
    expect(saved.records.balances).toEqual([]);
    expect(saved.records.signals[0]?.state).toBe("proposed");
    expect((await store.listProposals(business.id))[0]?.state).toBe("proposed");
    const second = await service.sync((await store.getBusiness(business.id))!, store, now, "outlook");
    expect(second.counts.duplicates).toBe(1);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect((await store.load(other.id)).records.evidence).toEqual([]);
  });

  it("uses only the fixed Microsoft token host and bounds real adapter reads to ten messages", async () => {
    const { store, business } = await setup();
    const fetch = vi.fn<typeof globalThis.fetch>(async (raw) => {
      const url = new URL(String(raw));
      if (url.hostname === "login.microsoftonline.com") return new Response(JSON.stringify({ access_token: "ms-private-token", expires_in: 3600 }));
      expect(url.origin).toBe("https://graph.microsoft.com");
      expect(url.searchParams.get("$top")).toBe("10");
      return new Response(JSON.stringify({ value: [{ id: "m1", internetMessageId: "one", subject: "Invoice update", body: { content: "Please check the invoice." }, from: { emailAddress: { address: "supplier@example.com" } }, receivedDateTime: now().toISOString(), hasAttachments: false }], "@odata.nextLink": "https://graph.microsoft.com/private-next-page" }));
    });
    const service = buildConnectionService(microsoft, { fetch, ingest: readEmail });
    const result = await service.sync(business, store, now, "outlook");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe(`https://login.microsoftonline.com/${microsoft.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    expect(JSON.stringify(result)).not.toMatch(/ms-private-token|fake-ms-secret|owner@example.com/);
    expect(result.counts.messages).toBe(1);
  });

  it("reports per-message failure while retaining successful pending intake", async () => {
    const { store, business } = await setup();
    const service = buildConnectionService(microsoft, { outlookPull: async () => ({ ok: true, data: { inputs: [email("good"), email("bad")], diagnostics: output(now().toISOString()).diagnostics } }), ingest: async (input, ctx) => { if (input.source?.evidenceId === "email-bad") throw new Error("private source body"); return readEmail(input, ctx); } });
    const result = await service.sync(business, store, now, "outlook");
    expect(result.connection.state).toBe("error");
    expect(result.counts).toMatchObject({ failed: 1, evidence: 1, proposals: 1 });
    expect((await store.load(business.id)).records.evidence).toHaveLength(1);
    expect(result.connection.message).not.toContain("private source body");
    expect(service.list((await store.getBusiness(business.id))!).connections[1]?.state).toBe("error");
  });

  it("validates Microsoft configuration and does not leak failed authorization details", async () => {
    const { store, business } = await setup();
    const invalid = buildConnectionService({ ...microsoft, MICROSOFT_TENANT_ID: "../attacker" });
    await expect(invalid.sync(business, store, now, "outlook")).rejects.toMatchObject({ status: 503 });
    const service = buildConnectionService(microsoft, { fetch: async () => { throw new Error("fake-ms-secret"); }, outlookPull: async (input) => { await input.token("outlook"); return { ok: true, data: { inputs: [], diagnostics: output(now().toISOString()).diagnostics } }; } });
    await expect(service.sync(business, store, now, "outlook")).rejects.toMatchObject({ status: 502 });
    expect(JSON.stringify(service.list(business))).not.toContain("fake-ms-secret");
    expect((await store.getBusiness(business.id))!.profile.account?.connections).toBeUndefined();
  });

  it("keeps partial interpretation retryable instead of permanently deduplicating it", async () => {
    const { store, business } = await setup();
    const ingest = vi.fn(async (input: IntakeInput, ctx: IntakeContext) => {
      const result = await readEmail(input, ctx);
      return { ...result, notes: [{ scope: input.source!.evidenceId!, text: "Could not check this message for payment claims." }] };
    });
    const service = buildConnectionService(microsoft, { outlookPull: async () => ({ ok: true, data: { inputs: [email("partial")], diagnostics: output(now().toISOString()).diagnostics } }), ingest });
    expect((await service.sync(business, store, now, "outlook")).connection.state).toBe("error");
    expect((await store.load(business.id)).records.evidence[0]?.extraction).toBe("partial");
    await service.sync(business, store, now, "outlook");
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(await store.listProposals(business.id)).toHaveLength(1);
  });
});
async function setup() {
  const store = new MemoryStore();
  await store.createBusiness({ id: env.NERI_CONNECTOR_BUSINESS_ID, name: "Private Company", profile, isSynthetic: false, ownerUserId: "owner" });
  await store.createBusiness({ id: "private-other", name: "Other Company", profile, isSynthetic: false, ownerUserId: "other" });
  const business = (await store.getBusiness(env.NERI_CONNECTOR_BUSINESS_ID))!;
  const other = (await store.getBusiness("private-other"))!;
  return { store, business, other };
}
const goodPull = () => vi.fn(async (input: ZohoPullInput) => ({ ok: true as const, data: output(input.now) }));

describe("tenant-bound Zoho Books connection", () => {
  it("never pulls on discovery or when the business binding is missing", async () => {
    const { store, business } = await setup();
    const pull = goodPull();
    const service = buildConnectionService({ ...env, NERI_CONNECTOR_BUSINESS_ID: undefined }, { pull });
    expect(service.list(business).connections[0]).toMatchObject({ available: false, state: "waiting" });
    await expect(service.sync(business, store, now)).rejects.toMatchObject({ status: 503, code: "CONNECTOR_NOT_CONFIGURED" });
    expect(pull).not.toHaveBeenCalled();
    expect((await store.load(business.id)).storeRevision).toBe(0);
  });

  it.each(["http://www.zohoapis.com", "https://www.zohoapis.com.attacker.example", "https://www.zohoapis.com/private", "https://user:secret@www.zohoapis.com", "https://www.zohoapis.com?redirect=bad"])("rejects an unsafe provider domain: %s", async (domain) => {
    const { store, business } = await setup();
    const fetch = vi.fn();
    const service = buildConnectionService({ ...env, ZOHO_API_DOMAIN: domain }, { fetch });
    expect(service.list(business).connections[0]?.available).toBe(false);
    await expect(service.sync(business, store, now)).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("denies another tenant and synthetic samples without reading the provider", async () => {
    const { store, business, other } = await setup();
    const pull = goodPull();
    const service = buildConnectionService(env, { pull });
    for (const b of [other, { ...business, isSynthetic: true }]) {
      expect(service.list(b).connections[0]).toMatchObject({ available: false, state: "waiting" });
      await expect(service.sync(b, store, now)).rejects.toMatchObject({ status: 403 });
    }
    expect(pull).not.toHaveBeenCalled();
    expect(JSON.stringify(service.list(other))).not.toContain(env.ZOHO_ORGANIZATION_ID);
  });

  it("persists real results once, retains overrides, and creates no bank balances", async () => {
    const { store, business } = await setup();
    await store.saveOverrides(business.id, [{ id: "owner-date", target: { commitmentId: "inv-INV-1" }, change: { shiftDays: 5 }, origin: "owner" }]);
    const pull = goodPull();
    const pending = vi.spyOn(store, "listProposals");
    const service = buildConnectionService(env, { pull });
    expect(service.list(business).connections[0]?.state).toBe("waiting");
    const first = await service.sync(business, store, now);
    expect(first).toMatchObject({ counts: { commitments: 1, parties: 1 }, summary: { written: true }, storeRevision: 1 });
    expect(pull.mock.calls[0]?.[0]).toMatchObject({ region: "com", organizationId: "test-org" });
    const again = await service.sync((await store.getBusiness(business.id))!, store, () => new Date("2026-10-26T22:00:00Z"));
    expect(again).toMatchObject({ summary: { written: false }, storeRevision: 1 });
    expect(pending).toHaveBeenCalledTimes(1);
    const saved = await store.load(business.id);
    expect(saved.records.commitments).toHaveLength(1);
    expect(saved.records.balances).toEqual([]);
    expect(saved.records.events).toEqual([]);
    expect(await store.loadOverrides(business.id)).toHaveLength(1);
    const current = (await store.getBusiness(business.id))!;
    expect(service.list(current).connections[0]).toMatchObject({ state: "ok", lastSyncedAt: "2026-10-26T22:00:00.000Z" });
    expect((await store.getBusiness("private-other"))!.profile.account?.connections).toBeUndefined();
  });

  it("renews a token only on sync and reuses it across requests", async () => {
    const { store, business } = await setup();
    const tokenFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ access_token: "private-token", expires_in: 3600 }), { status: 200 }));
    const pull = vi.fn(async (input: ZohoPullInput) => {
      expect(await input.token("zoho_books")).toBe("private-token");
      expect(await input.token("zoho_books")).toBe("private-token");
      return { ok: true as const, data: output(input.now) };
    });
    const service = buildConnectionService(env, { pull, fetch: tokenFetch });
    service.list(business);
    expect(tokenFetch).not.toHaveBeenCalled();
    const result = await service.sync(business, store, now);
    await service.sync(business, store, now);
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    expect(tokenFetch.mock.calls[0]?.[0]).toBe("https://accounts.zoho.com/oauth/v2/token");
    expect(tokenFetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.stringify(result)).not.toMatch(/private-token|test-secret|test-refresh|test-org/);
  });

  it("fails safely when token renewal fails, without persisting success", async () => {
    const { store, business } = await setup();
    const tokenFetch = vi.fn(async () => new Response("private provider response", { status: 401 }));
    const pull = vi.fn(async (input: ZohoPullInput) => { await input.token("zoho_books"); return { ok: true as const, data: output(input.now) }; });
    const service = buildConnectionService(env, { pull, fetch: tokenFetch });
    await expect(service.sync(business, store, now)).rejects.toMatchObject({ status: 502, code: "CONNECTOR_UNAVAILABLE" });
    const result = service.list((await store.getBusiness(business.id))!);
    expect(result.connections[0]?.state).toBe("error");
    expect(JSON.stringify(result)).not.toContain("private provider response");
    expect((await store.getBusiness(business.id))!.profile.account?.syncedAt).toBeUndefined();
    expect((await store.load(business.id)).storeRevision).toBe(0);
  });

  it("does not mark success after a provider or persistence failure", async () => {
    const { store, business } = await setup();
    const broken = buildConnectionService(env, { pull: async () => ({ ok: false, error: { kind: "network", message: "private URL", nextStep: "private", fallback: "file" } }) });
    await expect(broken.sync(business, store, now)).rejects.toMatchObject({ status: 502 });
    const service = buildConnectionService(env, { pull: goodPull() });
    vi.spyOn(store, "upsertRecords").mockRejectedValue(new Error("private database diagnostic"));
    await expect(service.sync(business, store, now)).rejects.not.toThrow("private database diagnostic");
    expect((await store.getBusiness(business.id))!.profile.account?.connections).toBeUndefined();
  });

  it("coalesces concurrent syncs instead of duplicating writes", async () => {
    const { store, business } = await setup();
    const pull = goodPull();
    const service = buildConnectionService(env, { pull });
    const results = await Promise.all([service.sync(business, store, now), service.sync(business, store, now)]);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.storeRevision)).toEqual([1, 1]);
    expect((await store.load(business.id)).records.commitments).toHaveLength(1);
  });
});

describe("connection HTTP contract", () => {
  it("requires authentication, hides another tenant's connection, and rejects client account settings", async () => {
    const { store, business, other } = await setup();
    const pull = goodPull();
    const app = Fastify();
    app.setErrorHandler((error, _req, reply) => sendError(reply, error));
    app.addHook("preHandler", async (req) => {
      if (!req.headers.authorization) return;
      const r = req as NeriRequest;
      r.user = { id: req.headers.authorization === "owner" ? "owner" : "other" };
      r.business = req.headers.authorization === "owner" ? business : other;
      r.store = store;
    });
    await app.register(connectionRoutes({ connections: buildConnectionService(env, { pull }), now }));
    try {
      expect((await app.inject({ method: "GET", url: "/connections" })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/connections/zoho_books/sync" })).statusCode).toBe(401);
      const hidden = await app.inject({ method: "GET", url: "/connections", headers: { authorization: "other" } });
      expect(hidden.json().connections[0]).toMatchObject({ available: false, state: "waiting" });
      expect((await app.inject({ method: "POST", url: "/connections/zoho_books/sync", headers: { authorization: "other" } })).statusCode).toBe(403);
      const override = await app.inject({ method: "POST", url: "/connections/zoho_books/sync", headers: { authorization: "owner" }, payload: { accessToken: "client-secret", apiDomain: "https://attacker.example" } });
      expect(override.statusCode).toBe(400);
      expect(override.body).not.toContain("client-secret");
      expect(pull).not.toHaveBeenCalled();
      const success = await app.inject({ method: "POST", url: "/connections/zoho_books/sync", headers: { authorization: "owner" }, payload: {} });
      expect(success.statusCode).toBe(200);
      expect(success.json()).toMatchObject({ connection: { id: "zoho_books", state: "ok" }, counts: { commitments: 1 }, storeRevision: 1 });
    } finally { await app.close(); }
  });
});
