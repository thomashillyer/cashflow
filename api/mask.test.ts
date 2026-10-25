import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type Verifier } from "./app";
import { loadSample, loadSamples } from "./demo";
import { buildMask, maskJson } from "./mask";
import { MemoryStore } from "./store";

const parties = [
  { name: "Carry Well Packaging Pvt Ltd", kind: "supplier" as const, aliases: ["CWP"] },
  { name: "Evergreen Home", kind: "customer" as const },
  { name: "Puget Market", kind: "customer" as const },
  { name: "Ningbo Supply Co", kind: "supplier" as const },
  { name: "Harbor Packaging LLC", kind: "supplier" as const },
];
const mask = buildMask(parties, { name: "Silverbeck LLC", aliases: ["Silver Beck"] });
const m = (v: unknown, key = "") => maskJson(v, mask, key);

describe("maskJson", () => {
  it("replaces names by kind, stably, longest name first, case-insensitively, and ignores order of the parties", () => {
    expect(m("Carry Well Packaging Pvt Ltd owes us; CARRY WELL PACKAGING called; CWP too")).toBe("Supplier A owes us; Supplier A called; Supplier A too");
    expect(m("Evergreen Home and Puget Market")).toBe("Customer A and Customer B");
    const shuffled = buildMask([...parties].reverse(), { name: "Silverbeck LLC" });
    expect(maskJson("Evergreen Home / Puget Market", shuffled)).toBe("Customer A / Customer B");
  });

  it("masks a distinctive first word but not a generic or ambiguous one", () => {
    expect(m("Carry reminded us")).toBe("Supplier A reminded us");   // the first word of exactly one party
    expect(m("Evergreen sent the PO")).toBe("Customer A sent the PO");
    expect(m("a packaging invoice")).toBe("a packaging invoice");   // generic word shared by two suppliers
    expect(m("Evergreens are trees")).toBe("Evergreens are trees");  // whole-word only
  });

  it("masks the business's own name and emails everywhere, but phones and long digit runs only in free text", () => {
    expect(m("Silver Beck / Silverbeck LLC")).toBe("Your business / Your business");
    expect(m("write to maria@carrywellpackaging.com")).toBe("write to contact@example.com");
    expect(m("+91-8595624830 acct 2306265048076000", "text")).toBe("+•• •••• •••• acct ••••6000");
    expect(m("+91-8595624830", "name")).toBe("+91-8595624830");
  });

  it("leaves ids, links, numbers, dates and structure alone", () => {
    const row = { id: "party-evergreen-home", name: "Evergreen Home", amount: 3213000, date: "2026-10-25", sourceRef: { system: "zoho_books", record: "8410491000001453004" }, evidenceIds: ["ev-1"], invoiceUrl: "https://invoice.zoho.com/x?c=Evergreen", excerpt: { text: "Evergreen Home called" } };
    expect(m(row)).toEqual({ ...row, name: "Customer A", excerpt: { text: "Customer A called" } });
    // An id-shaped string under a key we don't know (a map value) is also left alone.
    expect(m({ partyByCommitment: { "inv-EG-01": "party-evergreen-home" } })).toEqual({ partyByCommitment: { "inv-EG-01": "party-evergreen-home" } });
  });

  it("an explicit alias wins", () => {
    const x = buildMask(parties, { name: "Silverbeck LLC" }, { "Evergreen Home": "Acme Retail" });
    expect(maskJson("Evergreen Home", x)).toBe("Acme Retail");
  });
});

const USERS: Record<string, { id: string; email: string }> = { "tok-owner": { id: "u-owner", email: "owner@acme.example" }, "tok-other": { id: "u-other", email: "o@else.example" } };
const verify: Verifier = async (t) => USERS[t] ?? null;
const OWNER = { authorization: "Bearer tok-owner" };
const OTHER = { authorization: "Bearer tok-other" };
let store: MemoryStore;
let app: FastifyInstance;
let id: string;

describe("masking through the API", () => {
  beforeEach(async () => {
    store = new MemoryStore();
    for (const s of loadSamples()) await store.resetBusiness(s, s.records);
    const s = loadSample("cascade_trade")!;
    id = await store.createBusiness({ name: "Acme Imports", profile: s.profile, isSynthetic: false, ownerUserId: "u-owner" });
    await store.upsertRecords(id, { ...s.records, commitments: s.records.commitments.map((c) => (c.id === "inv-EG-01" ? { ...c, evidenceIds: ["ev-x"] } : c)), evidence: [{ id: "ev-x", channel: "email", format: "text", receivedAt: "2026-10-25T00:00:00Z", extraction: "ok", sourceRef: { system: "email", record: "m1" }, text: "Evergreen Home (maria@evergreenhome.com, +1 206 555 0187) paid into account 2306265048076000" }] });
    app = await buildApp({ store, verify, demoMode: false, allowReset: true, now: () => new Date("2026-11-16T17:00:00Z") });
  });
  const ctx = (headers: Record<string, string>, url = "/context") => app.inject({ method: "GET", url, headers: { ...OWNER, "x-neri-business": id, ...headers } });

  it("changes nothing unless asked", async () => {
    const r = await ctx({});
    expect(r.headers["x-neri-masked"]).toBeUndefined();
    expect(r.body).toContain("Evergreen Home");
  });

  it("with x-neri-mask or ?mask=1, no real party name is left, but the numbers and ids are identical", async () => {
    const plain = (await ctx({})).json();
    const masked = await ctx({ "x-neri-mask": "1" });
    expect(masked.headers["x-neri-masked"]).toBe("1");
    expect(masked.body).not.toMatch(/Evergreen|Puget|Harbor and Hearth/);
    const strip = (o: any): any => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === "string" && /[A-Za-z]{4}/.test(v) && !/^(party|inv|bill|ev|cand|evt)-|^\d{4}-\d{2}-\d{2}/.test(v) ? "~" : v)));
    expect(strip(masked.json())).toEqual(strip(plain));
    expect(masked.json().parties.map((p: any) => p.id)).toEqual(plain.parties.map((p: any) => p.id));
    expect((await ctx({}, "/context?mask=1")).body).not.toMatch(/Evergreen/);
  });

  it("evidence text loses emails, phone numbers and the account number", async () => {
    const r = await ctx({ "x-neri-mask": "1" }, "/records/inv-EG-01");
    const text = JSON.stringify(r.json());
    expect(text).not.toMatch(/maria@evergreenhome|555 0187|2306265048076000/);
    expect(text).toContain("••••6000");
  });

  it("PUT /profile/masking switches it on for the business; samples, other users and bad input are refused", async () => {
    const put = (headers: Record<string, string>, payload: unknown) => app.inject({ method: "PUT", url: "/profile/masking", headers: { ...headers, "x-neri-business": id }, payload: payload as never });
    expect((await put(OWNER, { maskNames: "yes" })).statusCode).toBe(400);
    expect((await put(OWNER, { maskNames: true, maskAliases: { "Evergreen Home": "Acme Retail", "x": "y" } })).statusCode).toBe(400);
    expect((await put(OTHER, { maskNames: true })).statusCode).toBe(404);
    const sample = await app.inject({ method: "PUT", url: "/profile/masking", headers: { ...OWNER, "x-neri-business": "cascade_trade" }, payload: { maskNames: true } });
    expect([sample.statusCode, sample.json().error.code]).toEqual([403, "SAMPLE_BUSINESS"]);
    expect((await put(OWNER, { maskNames: true, maskAliases: { "Evergreen Home": "Acme Retail" } })).statusCode).toBe(200);
    const r = await ctx({});
    expect(r.headers["x-neri-masked"]).toBe("1");
    expect(r.body).toContain("Acme Retail");
    expect(r.body).not.toContain("Evergreen Home");
    expect((await put(OWNER, { maskNames: false })).statusCode).toBe(200);
    expect((await ctx({})).body).toContain("Evergreen Home");
  });

  it("errors and non-JSON responses are not rewritten", async () => {
    const bad = await app.inject({ method: "GET", url: "/records?mask=1", headers: { authorization: "Bearer nope" } });
    expect(bad.statusCode).toBe(401);
    expect(bad.headers["x-neri-masked"]).toBeUndefined();
  });
});
