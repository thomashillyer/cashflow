// POST /sources/:source/pull through Fastify inject with the in-memory store and a fake provider (no network).
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Fetch } from "../adapters/connector";
import { buildApp, type Verifier } from "./app";
import { loadSample, loadSamples } from "./demo";
import { MemoryStore } from "./store";
import { envSourceAccess } from "./sourceAccess";

const USERS: Record<string, { id: string; email: string }> = { "tok-owner": { id: "u-owner", email: "owner@acme.example" }, "tok-other": { id: "u-other", email: "o@else.example" } };
const verify: Verifier = async (t) => USERS[t] ?? null;
const OWNER = { authorization: "Bearer tok-owner" };
const OTHER = { authorization: "Bearer tok-other" };
const ok = (b: unknown) => ({ status: 200, json: async () => b });

let store: MemoryStore;
let app: FastifyInstance;
let bizId: string;
let behaviour: { status?: number; bills?: unknown[]; delay?: Promise<void>; bankStatus?: number; messages?: number };

const bill = (over: Record<string, unknown> = {}) => ({ bill_id: "B1", bill_number: "BILL-1", vendor_id: "V1", vendor_name: "Ningbo Supply", date: "2026-10-01", due_date: "2026-11-20", total: 15000, balance: 15000, currency_code: "USD", status: "open", ...over });
const msg = (id: string) => ({ id, internetMessageId: `<${id}@mail.example>`, subject: "Invoice INV-9 payment", receivedDateTime: "2026-10-24T15:00:00Z", from: { emailAddress: { name: "Maria", address: "maria@harbor.example" } }, toRecipients: [], body: { contentType: "text", content: "We will pay on Nov 20." }, hasAttachments: false });

const fake: Fetch = async (url) => {
  if (behaviour.delay) await behaviour.delay;
  if (behaviour.status) return { status: behaviour.status, json: async () => ({}) };
  const u = new URL(url);
  const path = u.pathname;
  if (u.hostname.startsWith("graph.")) return ok({ value: Array.from({ length: behaviour.messages ?? 2 }, (_, i) => msg(`m${i + 1}`)) });
  if (path.startsWith("/crm/v6/Deals")) return ok({ data: [{ id: "d1", Deal_Name: "Deal 1", Stage: "PO received", Probability: 100, Amount: 50000, Currency: "USD", Closing_Date: "2026-11-15", Account_Name: { name: "Harbor Foods", id: "a1" } }], info: { more_records: false } });
  const p = path.replace("/books/v3/", "");
  if (p === "organizations") return ok({ organizations: [{ organization_id: "org1" }] });
  if (p === "bills") return ok({ bills: behaviour.bills ?? [bill()], page_context: { has_more_page: false } });
  if (p === "bankaccounts") {
    if (behaviour.bankStatus) return { status: behaviour.bankStatus, json: async () => ({}) };
    return ok({ bankaccounts: [
      { account_id: "A1", account_name: "Operating", account_type: "bank", bank_balance: 41250.5, balance: 40000, currency_code: "USD", is_active: true },
      { account_id: "A2", account_name: "Visa", account_type: "credit_card", balance: -300, currency_code: "USD", is_active: true },
      { account_id: "A3", account_name: "Old account", account_type: "bank", bank_balance: 99, currency_code: "USD", is_active: false },
    ], page_context: { has_more_page: false } });
  }
  if (["invoices", "customerpayments", "vendorpayments"].includes(p)) return ok({ [p]: [], page_context: { has_more_page: false } });
  return { status: 404, json: async () => ({}) };
};

async function setup(opts: { access?: boolean } = {}) {
  behaviour = {};
  store = new MemoryStore();
  for (const s of loadSamples()) await store.resetBusiness(s, s.records);
  const sample = loadSample("cascade_trade")!;
  bizId = await store.createBusiness({ name: "Acme Imports", profile: { ...sample.profile, crm: { stageStatus: { Delivered: "skip" } } }, isSynthetic: false, ownerUserId: "u-owner" });
  app = await buildApp({
    store, verify, demoMode: false, allowReset: true, now: () => new Date("2026-10-25T18:00:00Z"), sourceFetch: fake,
    ...(opts.access === false ? {} : { sourceAccess: ({ business }, source) => (business.id === bizId ? { token: async () => "tok", region: "com", mailbox: "owner@acme.example", ...(source === "zoho_books" ? { organizationId: "org1" } : {}) } : undefined) }),
  });
}
const pull = (source: string, headers = OWNER, payload: Record<string, unknown> = {}) => app.inject({ method: "POST", url: `/sources/${source}/pull`, headers, payload });

describe("POST /sources/:source/pull", () => {
  beforeEach(() => setup());

  it("Zoho Books: persists bills and parties, and a repeat pull writes nothing", async () => {
    const first = await pull("zoho_books");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ source: "zoho_books", kind: "records", summary: { commitments: { added: 1 }, written: true }, diagnostics: { rowsRead: 1, rowsImported: 1 } });
    const { records, storeRevision } = await store.load(bizId);
    expect(records.commitments.find((c) => c.reference === "BILL-1")).toMatchObject({ type: "bill", amount: 1500000, direction: "out" });
    const again = (await pull("zoho_books")).json();
    expect(again.summary).toMatchObject({ written: false, commitments: { unchanged: 1, added: 0 } });
    expect(again.diagnostics.rowsDuplicate).toBe(1);
    expect((await store.load(bizId)).storeRevision).toBe(storeRevision);
  });

  it("an edited bill updates its one row", async () => {
    await pull("zoho_books");
    behaviour.bills = [bill({ due_date: "2026-12-05" })];
    const r = (await pull("zoho_books")).json();
    expect(r.summary).toMatchObject({ commitments: { updated: 1, added: 0 }, written: true });
    const rows = (await store.load(bizId)).records.commitments.filter((c) => c.reference === "BILL-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.anchors.due).toBe("2026-12-05");
  });

  it("Zoho CRM: deals become sales_deal commitments using the profile's CRM mapping", async () => {
    const r = await pull("zoho_crm");
    expect(r.statusCode).toBe(200);
    const deal = (await store.load(bizId)).records.commitments.find((c) => c.type === "sales_deal")!;
    expect(deal).toMatchObject({ status: "committed", amount: 5000000, direction: "in", sourceRef: { system: "crm" } });
  });

  it("Outlook: messages go through intake as Review items and change no cash", async () => {
    const before = (await store.load(bizId)).records.commitments.length;
    const r = await pull("outlook");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ kind: "messages", summary: { messages: 2 }, diagnostics: { rowsImported: 2 } });
    expect((await store.load(bizId)).records.commitments).toHaveLength(before);
    expect((await store.load(bizId)).records.evidence.some((e) => e.channel === "email")).toBe(true);
  });

  it("is refused for anonymous callers, other businesses, samples, and unknown sources", async () => {
    expect((await app.inject({ method: "POST", url: "/sources/zoho_books/pull" })).statusCode).toBe(401);
    expect((await pull("zoho_books", { ...OTHER, "x-neri-business": bizId } as never)).statusCode).toBe(404);
    const sample = await pull("zoho_books", { ...OWNER, "x-neri-business": "cascade_trade" } as never);
    expect([sample.statusCode, sample.json().error.code]).toEqual([404, "NOT_FOUND"]);
    expect((await pull("dropbox")).statusCode).toBe(404);
  });

  it("a business with no connection is told the next step", async () => {
    await setup({ access: false });
    const r = await pull("zoho_books");
    expect([r.statusCode, r.json().error.code]).toEqual([422, "SOURCE_NOT_SET_UP"]);
    expect(r.json().error.message).toMatch(/Connect it in Sources, or upload an export/);
  });

  it.each([[401, 424, "CONNECTION_NEEDS_ATTENTION", false], [429, 429, "SOURCE_RATE_LIMITED", true], [500, 502, "SOURCE_UNAVAILABLE", true]])(
    "provider status %s becomes HTTP %s with a plain next step", async (provider, http, code, retryable) => {
      behaviour.status = provider;
      const r = await pull("zoho_books");
      expect(r.statusCode).toBe(http);
      expect(r.json().error).toMatchObject({ code, retryable });
      expect(r.json().error.message).toMatch(/upload an export|Reconnect/i);
    });

  it("a second pull of the same source while one is running is refused, not doubled", async () => {
    let release!: () => void;
    behaviour.delay = new Promise<void>((res) => { release = res; });
    const first = pull("zoho_books");
    await new Promise((r) => setTimeout(r, 20));
    const second = await pull("zoho_books");
    expect([second.statusCode, second.json().error.code]).toEqual([409, "PULL_RUNNING"]);
    release();
    expect((await first).statusCode).toBe(200);
  });
});

describe("what Connect shows the owner", () => {
  beforeEach(() => setup());
  const sourcesOf = async () => (await app.inject({ method: "GET", url: "/context", headers: { ...OWNER, "x-neri-business": bizId } })).json().business.sources as { id: string; state: string; detail: string }[];

  it("Zoho Books also reads the bank balances: that is the forecast's opening cash", async () => {
    const r = (await pull("zoho_books")).json();
    expect(r.summary.balances).toBe(1);
    const { records } = await store.load(bizId);
    expect(records.balances).toEqual([expect.objectContaining({ account: "Operating", amount: 4125050, currency: "USD", asOf: "2026-10-25" })]);   // bank balance, active bank accounts only
    expect((await sourcesOf()).find((s) => s.id === "zoho_books")).toMatchObject({ state: "ok" });
  });

  it("without the Banking permission the books still import, and the owner is told what to do", async () => {
    behaviour.bankStatus = 401;
    const r = await pull("zoho_books");
    expect(r.statusCode).toBe(200);
    expect(r.json().summary.balances).toBe(0);
    expect(r.json().diagnostics.warnings.join(" ")).toMatch(/Banking permission.*enter your balance, or upload a bank statement/);
    expect((await store.load(bizId)).records.commitments.some((c) => c.reference === "BILL-1")).toBe(true);
  });

  it("a failed connection shows as an error with its plain reason on the Sources screen", async () => {
    behaviour.status = 401;
    expect((await pull("zoho_books")).statusCode).toBe(424);
    const row = (await sourcesOf()).find((s) => s.id === "zoho_books")!;
    expect(row.state).toBe("error");
    expect(row.detail).toMatch(/Reconnect Zoho Books/);
  });

  it("the app's id m365 reads Outlook, and the Sources screen shows it connected once mail is in", async () => {
    await store.saveProfile(bizId, { ...(await store.getBusiness(bizId))!.profile, account: { ...(await store.getBusiness(bizId))!.profile.account, connections: [{ id: "m365", name: "Microsoft 365", state: "waiting" }] } });
    const r = await pull("m365");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ source: "outlook", kind: "messages" });
    const rows = await sourcesOf();
    expect(rows.filter((s) => s.id === "m365" && s.state === "waiting")).toEqual([]);
    expect(rows.find((s) => s.id === "email")).toMatchObject({ state: "ok" });   // the mail's own system name, labelled with the app
  });

  it("Outlook: messages already read are skipped, and the ones past the cap are reached on the next pull", async () => {
    behaviour.messages = 20;
    const first = (await pull("outlook")).json();
    expect(first.summary).toMatchObject({ messages: 15, waiting: 5, alreadyRead: 0 });
    const second = (await pull("outlook")).json();
    expect(second.summary).toMatchObject({ messages: 5, waiting: 0, alreadyRead: 15 });
    const third = (await pull("outlook")).json();
    expect(third.summary).toMatchObject({ messages: 0, waiting: 0, alreadyRead: 20 });
  });
});

describe("envSourceAccess", () => {
  const env = { NERI_SOURCE_BUSINESS: "mine", ZOHO_API_DOMAIN: "https://www.zohoapis.com", ZOHO_CLIENT_ID: "c", ZOHO_CLIENT_SECRET: "s", ZOHO_REFRESH_TOKEN: "r", MICROSOFT_TENANT_ID: "t", MICROSOFT_CLIENT_ID: "c", MICROSOFT_CLIENT_SECRET: "s", MICROSOFT_MAILBOX_UPN: "a@b.co" };
  const ctx = (id: string, email?: string, isSynthetic = false) => ({ business: { id, isSynthetic }, ...(email ? { user: { id: "u", email } } : {}) });

  it("is off unless a business or an email is named, and gives other businesses nothing", () => {
    expect(envSourceAccess({ ...env, NERI_SOURCE_BUSINESS: undefined })).toBeUndefined();
    const access = envSourceAccess(env)!;
    expect(access(ctx("someone-else"), "zoho_books")).toBeUndefined();
    expect(access(ctx("someone-else"), "outlook")).toBeUndefined();
    expect(access(ctx("mine"), "zoho_books")).toMatchObject({ region: "com" });
    expect(access(ctx("mine"), "outlook")).toMatchObject({ mailbox: "a@b.co" });
    expect(access(ctx("mine"), "quickbooks")).toBeUndefined();
    expect(access(ctx("mine", undefined, true), "zoho_books")).toBeUndefined();   // never for a shared sample
  });

  it("the operator's VERIFIED email may use the server's credentials in any business of theirs; nobody else may", () => {
    const access = envSourceAccess({ ...env, NERI_SOURCE_BUSINESS: undefined, NERI_SOURCE_EMAIL: "Ops@Acme.example" })!;
    expect(access(ctx("any-id", "ops@acme.example"), "zoho_books")).toMatchObject({ region: "com" });
    expect(access(ctx("any-id", "OPS@ACME.EXAMPLE"), "outlook")).toMatchObject({ mailbox: "a@b.co" });
    expect(access(ctx("any-id", "other@acme.example"), "zoho_books")).toBeUndefined();
    expect(access(ctx("any-id"), "zoho_books")).toBeUndefined();   // no verified user, no access
  });

  it("NERI_SOURCE_EMAIL may list several operator emails; a similar-looking one is still refused", () => {
    const access = envSourceAccess({ ...env, NERI_SOURCE_BUSINESS: undefined, NERI_SOURCE_EMAIL: " a@x.example , B@y.example " })!;
    expect(access(ctx("1", "a@x.example"), "zoho_books")).toMatchObject({ region: "com" });
    expect(access(ctx("2", "b@y.example"), "zoho_books")).toMatchObject({ region: "com" });
    expect(access(ctx("3", "ab@x.example"), "zoho_books")).toBeUndefined();
    expect(access(ctx("4", "a@x.example.evil.io"), "zoho_books")).toBeUndefined();
    expect(envSourceAccess({ ...env, NERI_SOURCE_BUSINESS: undefined, NERI_SOURCE_EMAIL: " , " })).toBeUndefined();
  });

  it("caches the access token until it nearly expires", async () => {
    let calls = 0;
    let clock = 0;
    const f = (async () => { calls++; return { json: async () => ({ access_token: `t${calls}`, expires_in: 3600 }) } as Response; }) as unknown as typeof fetch;
    const access = (await envSourceAccess(env, () => clock, f)!(ctx("mine"), "zoho_books"))!;
    expect(await access.token("zoho_books")).toBe("t1");
    expect(await access.token("zoho_books")).toBe("t1");
    clock = 3_600_000;
    expect(await access.token("zoho_books")).toBe("t2");
    expect(calls).toBe(2);
  });

  it("a refused or failed token exchange is an auth or network problem, with no provider text in the message", async () => {
    const refused = (async () => ({ json: async () => ({ error: "invalid_client", error_description: "secret-detail" }) } as Response)) as unknown as typeof fetch;
    const a = (await envSourceAccess(env, Date.now, refused)!(ctx("mine"), "zoho_books"))!;
    await expect(a.token("zoho_books")).rejects.toMatchObject({ error: { kind: "auth", fallback: "file" } });
    await a.token("zoho_books").catch((e) => expect(JSON.stringify(e.error)).not.toMatch(/secret-detail|invalid_client/));
    const down = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const m = (await envSourceAccess(env, Date.now, down)!(ctx("mine"), "outlook"))!;
    await expect(m.token("outlook")).rejects.toMatchObject({ error: { kind: "network", fallback: "paste" } });
  });
});
