import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { MemoryStore } from "./store";
import { propose } from "../ai/reconcile/match";
import { candidate, f } from "../ai/reconcile/testkit";

const headers = { authorization: "Bearer owner" };
const today = "2026-11-16";
let store: MemoryStore;
let app: FastifyInstance;
let businessId: string;

beforeEach(async () => {
  store = new MemoryStore();
  app = await buildApp({ store, verify: async (token) => token === "owner" ? { id: "owner", email: "owner@example.com" } : token === "other" ? { id: "other" } : null,
    demoMode: false, now: () => new Date(`${today}T17:00:00Z`) });
  const setup = await app.inject({ method: "POST", url: "/setup", headers, payload: { businessName: "Owner Co", kind: "trading" } });
  businessId = setup.json().businessId;
});
afterEach(async () => { await app.close(); });

const put = (payload: unknown) => app.inject({ method: "PUT", url: "/balance", headers, payload: payload as Record<string, unknown> });

describe("owner-confirmed bank balance", () => {
  it("persists an owner snapshot and recomputes cash without inventing transactions", async () => {
    const before = (await app.inject({ url: "/forecast", headers })).json();
    expect(before.review.reasons.map((r: { code: string }) => r.code)).toContain("no_opening_balance");
    const response = await put({ amount: 123456, asOf: today });
    expect(response.statusCode).toBe(200);
    const { balance, storeRevision } = response.json();
    expect(balance).toMatchObject({ account: "main", amount: 123456, currency: "USD", asOf: today, sourceRef: { system: "owner", record: balance.id } });
    expect(storeRevision).toBeGreaterThan(0);
    const run = (await app.inject({ url: "/forecast", headers })).json();
    expect(run.openingBalance).toBe(123456);
    expect(run.events).toEqual([]);
    expect(run.review.reasons.map((r: { code: string }) => r.code)).not.toContain("no_opening_balance");
    expect(run.review.needed).toBe(true); // Balance alone does not imply books or receipts were imported.
    expect(run.review.reasons.map((r: { code: string }) => r.code)).toContain("no_data");
  });

  it("uses a stable account/date identity and preserves other records and dated snapshots", async () => {
    await store.upsertRecords(businessId, {
      commitments: [{ id: "invoice", type: "invoice", amount: 10000, currency: "USD", status: "committed", anchors: { due: "2026-11-20" }, sourceRef: { system: "owner", record: "invoice" } }],
      parties: [{ id: "party", name: "Customer", kind: "customer", tags: [], notes: [] }],
    });
    const original = await store.load(businessId);
    const first = (await put({ amount: 10000, asOf: today, account: " Checking " })).json();
    const corrected = (await put({ amount: 25000, asOf: today, account: "Checking" })).json();
    expect(corrected.balance.id).toBe(first.balance.id);
    const older = (await put({ amount: 5000, asOf: "2026-11-15", account: "Checking" })).json();
    expect(older.balance.id).not.toBe(first.balance.id);
    const saved = await store.load(businessId);
    expect(saved.records.balances).toHaveLength(2);
    expect(saved.records.commitments).toEqual(original.records.commitments);
    expect(saved.records.parties).toEqual(original.records.parties);
    expect((await app.inject({ url: "/forecast", headers })).json().openingBalance).toBe(25000);
    const context = (await app.inject({ url: "/context", headers })).json();
    expect(context.balanceAccounts).toEqual([{ account: "Checking", asOf: today, currency: "USD" }]);
    expect(context.balanceAccounts[0]).not.toHaveProperty("amount");
  });

  it("accepts a signed overdraft and takes currency from the business", async () => {
    const business = (await store.getBusiness(businessId))!;
    await store.saveProfile(businessId, { ...business.profile, baseCurrency: "EUR" });
    const response = await put({ amount: -250, asOf: today });
    expect(response.statusCode).toBe(200);
    expect(response.json().balance).toMatchObject({ amount: -250, currency: "EUR" });
  });

  it("corrects an imported snapshot for the same account and date without creating a competing balance", async () => {
    await store.upsertRecords(businessId, { balances: [{ id: "books-checking", account: "Checking", amount: 10000, currency: "USD", asOf: today, sourceRef: { system: "zoho_books", record: "bank-checking" } }] });
    const response = await put({ amount: 25000, asOf: today, account: "Checking" });
    expect(response.statusCode).toBe(200);
    expect(response.json().balance).toMatchObject({ id: "books-checking", amount: 25000, sourceRef: { system: "owner", record: "books-checking" } });
    expect((await store.load(businessId)).records.balances).toHaveLength(1);
    expect((await app.inject({ url: "/forecast", headers })).json().openingBalance).toBe(25000);
  });

  it.each([
    {}, { amount: "100", asOf: today }, { amount: 1.5, asOf: today }, { amount: Number.MAX_SAFE_INTEGER + 1, asOf: today },
    { amount: 100, asOf: "2026-02-30" }, { amount: 100, asOf: "2026-11-17" }, { amount: 100, asOf: "16/11/2026" },
    { amount: 100, asOf: today, account: "" }, { amount: 100, asOf: today, account: " " }, { amount: 100, asOf: today, account: "a".repeat(65) },
    { amount: 100, asOf: today, account: "bank\nmain" }, { amount: 100, asOf: today, account: null },
    { amount: 100, asOf: today, currency: "GBP" },
  ])("rejects invalid input without writing: %j", async (payload) => {
    const before = await store.load(businessId);
    expect((await put(payload)).statusCode).toBe(400);
    expect(await store.load(businessId)).toEqual(before);
  });

  it("requires a verified member and preserves another tenant's cash", async () => {
    const payload = { amount: 999999, asOf: today };
    expect((await app.inject({ method: "PUT", url: "/balance", payload })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/balance", headers: { authorization: "Bearer other", "x-neri-business": businessId }, payload })).statusCode).toBe(404);
    expect((await store.load(businessId)).records.balances).toEqual([]);
  });

  it("allows a clean forecast only after both owner cash and actual book data exist", async () => {
    await put({ amount: 500000, asOf: today });
    await store.upsertRecords(businessId, { commitments: [{ id: "invoice", type: "invoice", amount: 10000, currency: "USD", status: "committed", anchors: { due: "2026-11-20" }, sourceRef: { system: "zoho_books", record: "invoice" } }] });
    const run = (await app.inject({ url: "/forecast", headers })).json();
    expect(run.openingBalance).toBe(500000);
    expect(run.review).toEqual({ needed: false, reasons: [] });
  });

  it.each(["balance", "safety line"])("keeps a pending invoice confirmable after the owner updates the %s", async (setting) => {
    const source = "email-invoice";
    await store.upsertRecords(businessId, { parties: [{ id: "customer", name: "Customer", kind: "customer", tags: [], notes: [] }] });
    const invoice = candidate({ id: "pending-invoice", partyId: "customer", evidenceIds: [source], fields: {
      reference: f("INV-NEW", source), amount: f(10000, source), currency: f("USD", source),
      buyerName: f("Customer", source), dueDate: f("2026-11-20", source),
    } });
    const loaded = await store.load(businessId);
    const proposal = propose(invoice, loaded.records, { storeRevision: loaded.storeRevision, now: `${today}T17:00:00Z` });
    expect(proposal.action).toBe("create");
    await store.saveIntake(businessId, { evidence: [{ id: source, channel: "email", format: "eml", receivedAt: `${today}T17:00:00Z`, extraction: "ok", sourceRef: { system: "email", record: source } }],
      candidates: [invoice], proposals: [proposal], signals: [] });
    const response = setting === "balance" ? await put({ amount: 500000, asOf: today })
      : await app.inject({ method: "PUT", url: "/profile", headers, payload: { safetyLine: { kind: "fixed", amount: 50000 } } });
    expect(response.statusCode).toBe(200);
    const current = (await app.inject({ url: "/review/proposals", headers })).json();
    expect((await store.listProposals(businessId))[0]!.expectedStoreRevision).toBe(current.storeRevision);
    const confirmed = await app.inject({ method: "POST", url: `/review/${proposal.id}/confirm`, headers, payload: { expectedRevision: current.storeRevision } });
    expect(confirmed.statusCode).toBe(200);
    expect((await store.load(businessId)).records.commitments).toHaveLength(1);
  });
});
