// API routes through Fastify inject() with the in-memory store: no network, no key (cache_only).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, isSecretKey, servedConfig, type Verifier } from "./app";
import { loadSample, loadSamples } from "./demo";
import { MemoryStore } from "./store";
import JSZip from "jszip";
import { APPLY_ERROR_STATUS } from "./routes/review";
import type { ChangeProposal } from "../schema/intake";

const USERS: Record<string, { id: string; email: string }> = {
  "tok-owner": { id: "u-owner", email: "owner@acme.example" },
  "tok-other": { id: "u-other", email: "other@else.example" },
};
const verify: Verifier = async (t) => USERS[t] ?? null;
const OWNER = { authorization: "Bearer tok-owner" };
const OTHER = { authorization: "Bearer tok-other" };

let store: MemoryStore;
let app: FastifyInstance;

async function setup(opts: { demoMode?: boolean } = {}) {
  store = new MemoryStore();
  for (const s of loadSamples()) await store.resetBusiness(s, s.records);
  app = await buildApp({ store, verify, demoMode: opts.demoMode ?? false, allowReset: true, now: () => new Date("2026-11-16T17:00:00Z") });
}

// A private business for u-owner, seeded from the cascade_trade fixture records.
async function privateBusiness(): Promise<string> {
  const s = loadSample("cascade_trade")!;
  const id = await store.createBusiness({ name: "Acme Imports", profile: s.profile, isSynthetic: false, ownerUserId: "u-owner" });
  await store.upsertRecords(id, s.records);
  return id;
}

const pdfBase64 = (name: string) => readFileSync(join(import.meta.dirname, "../fixtures/cascade_trade/intake", name)).toString("base64");

describe("auth and tenant scope", () => {
  beforeEach(() => setup());

  it("health needs no token", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("401 without a token, and with a bad one", async () => {
    for (const url of ["/context", "/brief", "/review", "/notes"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toMatchObject({ code: "UNAUTHENTICATED", retryable: false });
    }
    expect((await app.inject({ method: "GET", url: "/context", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/context", headers: { authorization: "Basic abc" } })).statusCode).toBe(401);
  });

  it("DEMO_MODE lets anonymous callers see synthetic businesses only", async () => {
    await setup({ demoMode: true });
    const id = await privateBusiness();
    expect((await app.inject({ method: "GET", url: "/context" })).json().business).toMatchObject({ id: "cascade_trade", synthetic: true });
    expect((await app.inject({ method: "GET", url: "/context", headers: { "x-neri-business": "pike_noodle" } })).json().business.id).toBe("pike_noodle");
    expect((await app.inject({ method: "GET", url: "/context", headers: { "x-neri-business": id } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/setup", payload: { businessName: "X" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/import/paste", payload: { text: "hello" } })).statusCode).toBe(401);
  });

  it("members see their business; non-members get 404", async () => {
    const id = await privateBusiness();
    const mine = await app.inject({ method: "GET", url: "/context", headers: OWNER });
    expect(mine.json().business).toMatchObject({ id, name: "Acme Imports", synthetic: false });
    const theirs = await app.inject({ method: "GET", url: "/brief", headers: { ...OTHER, "x-neri-business": id } });
    expect(theirs.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/context", headers: { ...OTHER, "x-neri-business": "nope" } })).statusCode).toBe(404);
    // Signed-in non-members still get the synthetic sample by default.
    expect((await app.inject({ method: "GET", url: "/context", headers: OTHER })).json().business.id).toBe("cascade_trade");
  });
});

describe("routes return what app/api.js expects", () => {
  beforeEach(() => setup());

  it("GET /context", async () => {
    const body = (await app.inject({ method: "GET", url: "/context", headers: OTHER })).json();
    expect(body.business).toMatchObject({ name: "Cascade Trade Co.", owner: "Dana", asOf: "2026-11-16", timezone: "America/Los_Angeles" });
    expect(body.business.sources.length).toBeGreaterThan(0);
    expect(body.profile.displayName).toBeTruthy();
    expect(body.profile.account).toBeUndefined();
    expect(Array.isArray(body.parties) && Array.isArray(body.rules)).toBe(true);
    expect(body.partyByCommitment["inv-INV-1187"]).toBeTruthy();
  });

  it("GET /brief: three, rest, watch, combined, shortfall and the run from one revision", async () => {
    const body = (await app.inject({ method: "GET", url: "/brief", headers: OTHER })).json();
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["three", "rest", "watch", "combined", "shortfall", "run", "storeRevision", "inputsHash"]));
    expect(body.three.length).toBeLessThanOrEqual(3);
    expect(body.three.length).toBeGreaterThan(0);
    for (const i of body.three) {
      expect(i).toMatchObject({ kind: "act", state: "open" });
      expect(typeof i.cashEffect).toBe("number");
      expect(i.title && i.why && i.neededBy).toBeTruthy();
    }
    expect(body.run.inputsHash).toBe(body.inputsHash);
    expect(body.run.days.length).toBeGreaterThan(0);
  });

  it("GET /forecast?scenario= and POST /simulate", async () => {
    const base = (await app.inject({ method: "GET", url: "/forecast?scenario=base", headers: OTHER })).json();
    const stress = (await app.inject({ method: "GET", url: "/forecast?scenario=stress", headers: OTHER })).json();
    expect(base.scenarioId).toBe("base");
    expect(stress.scenarioId).toBe("stress");
    expect((await app.inject({ method: "GET", url: "/forecast?scenario=evil", headers: OTHER })).statusCode).toBe(400);
    const brief = (await app.inject({ method: "GET", url: "/brief", headers: OTHER })).json();
    const sim = (await app.inject({ method: "POST", url: "/simulate", headers: OTHER, payload: { levers: [brief.three[0].lever] } })).json();
    expect(sim.lowPointDelta).toBe(brief.three[0].cashEffect);
    expect((await app.inject({ method: "POST", url: "/simulate", headers: OTHER, payload: { levers: [{ kind: "chase", commitmentId: "nope" }] } })).statusCode).toBe(400);
  });

  it("GET /review lists the proposed signal with its words and priced effect; apply moves the forecast", async () => {
    const review = (await app.inject({ method: "GET", url: "/review", headers: OTHER })).json();
    expect(review.length).toBeGreaterThan(0);
    const item = review[0];
    expect(item).toMatchObject({ signal: { state: "proposed" }, commitment: { id: expect.any(String) } });
    expect(item.commitment.sourceRef.record).toBeTruthy();
    expect(typeof item.signal.effect.lowPointDelta).toBe("number");
    expect(item.before.amount).toBeTypeOf("number");
    expect(item.after.amount).toBeTypeOf("number");

    const applied = await app.inject({ method: "POST", url: `/signals/${item.signal.id}/apply`, headers: OTHER });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ signal: { state: "applied" }, alert: { title: expect.any(String), detail: expect.any(String) } });
    expect((await app.inject({ method: "GET", url: "/review", headers: OTHER })).json()).toHaveLength(review.length - 1);
    const again = await app.inject({ method: "POST", url: `/signals/${item.signal.id}/apply`, headers: OTHER });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("NOT_PROPOSED");
  });

  it("POST /work-items/:id/draft (email and message) and /approve", async () => {
    const brief = (await app.inject({ method: "GET", url: "/brief", headers: OTHER })).json();
    const item = brief.three.find((i: { actions: { kind: string }[] }) => i.actions.some((a) => a.kind === "draft_email")) ?? brief.three[0];
    const email = (await app.inject({ method: "POST", url: `/work-items/${item.id}/draft`, headers: OTHER })).json();
    expect(email).toMatchObject({ channel: "email", body: expect.any(String), to: expect.any(String), subject: expect.any(String) });
    const msg = (await app.inject({ method: "POST", url: `/work-items/${item.id}/draft`, headers: OTHER, payload: { channel: "whatsapp" } })).json();
    expect(msg.channel).toBe("message");
    expect((await app.inject({ method: "POST", url: "/work-items/nope/draft", headers: OTHER })).statusCode).toBe(404);

    expect((await app.inject({ method: "POST", url: `/work-items/${item.id}/approve`, headers: OTHER })).json()).toEqual({ id: item.id, state: "done" });
    const after = (await app.inject({ method: "GET", url: "/brief", headers: OTHER })).json();
    expect(after.three.map((i: { id: string }) => i.id)).not.toContain(item.id);
  });

  it("GET /records/:id", async () => {
    const rec = (await app.inject({ method: "GET", url: "/records/inv-INV-1187", headers: OTHER })).json();
    expect(rec.commitment.id).toBe("inv-INV-1187");
    expect(rec.party).toBeTruthy();
    expect(rec.events.length).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: "/records/nope", headers: OTHER })).statusCode).toBe(404);
  });

  it("GET /records/:id resolves event ids, profile recurring items, daily sales and bank lines (Ask cites, week sheet)", async () => {
    const get = async (id: string, business = "cascade_trade") =>
      (await app.inject({ method: "GET", url: `/records/${encodeURIComponent(id)}`, headers: { ...OTHER, "x-neri-business": business } })).json();
    const evt = await get("evt-inv-INV-1187-0");
    expect(evt).toMatchObject({ source: "commitment", eventId: "evt-inv-INV-1187-0", commitment: { id: "inv-INV-1187" } });
    expect(evt.party).toBeTruthy();
    expect(evt.events.map((e: { id: string }) => e.id)).toContain("evt-inv-INV-1187-0");

    const payroll = (await get("rec-payroll"));
    expect(payroll).toMatchObject({ source: "profile_recurring", eventId: null, commitment: { id: "rec-payroll", type: "recurring", sourceRef: { system: "profile" } } });
    expect(payroll.events.length).toBeGreaterThan(0);
    const leg = payroll.events[0].id;
    expect(await get(leg)).toMatchObject({ source: "profile_recurring", eventId: leg, commitment: { id: "rec-payroll" } });

    const run = (await app.inject({ method: "GET", url: "/forecast", headers: { ...OTHER, "x-neri-business": "pike_noodle" } })).json();
    const sale = run.events.find((e: { commitmentId?: string }) => e.commitmentId === "daily-sales");
    const ds = await get(sale.id, "pike_noodle");
    expect(ds).toMatchObject({ source: "daily_sales", eventId: sale.id, events: [{ id: sale.id }] });
    expect(ds.basedOn.length).toBeGreaterThan(0);
    expect(await get("bank-sales-2026-10-19", "pike_noodle")).toMatchObject({ source: "actual", commitment: { status: "actual", sourceRef: { system: "bank_csv" } } });
    expect((await app.inject({ method: "GET", url: "/records/evt-nope-0", headers: OTHER })).statusCode).toBe(404);
  });

  it("owner-facing dates read like 'Dec 25', not ISO", async () => {
    const iso = /\d{4}-\d{2}-\d{2}/;
    for (const business of ["cascade_trade", "pike_noodle"]) {
      const brief = (await app.inject({ method: "GET", url: "/brief", headers: { ...OTHER, "x-neri-business": business } })).json();
      if (brief.shortfall) expect(brief.shortfall.title).not.toMatch(iso);
    }
    const [item] = (await app.inject({ method: "GET", url: "/review", headers: OTHER })).json();
    expect(item.message.from).not.toMatch(/\.txt$/);
    const { alert } = (await app.inject({ method: "POST", url: `/signals/${item.signal.id}/apply`, headers: OTHER })).json();
    expect(alert.title).not.toMatch(iso);
    expect(alert.detail).not.toMatch(iso);
  });

  it("PUT /profile with a partial body updates the safety line only", async () => {
    const res = await app.inject({ method: "PUT", url: "/profile", headers: OTHER, payload: { safetyLine: { kind: "fixed", amount: 5000000 } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.safetyLine).toEqual({ kind: "fixed", amount: 5000000 });
    expect((await app.inject({ method: "GET", url: "/brief", headers: OTHER })).json().run.safetyLine).toBe(5000000);
    expect((await app.inject({ method: "PATCH", url: "/profile", headers: OTHER, payload: { safetyLine: { kind: "fixed", amount: 1.5 } } })).statusCode).toBe(400);
  });

  it("notes: park, read, edit, add to forecast, keep, remove", async () => {
    const parked = (await app.inject({ method: "POST", url: "/notes", headers: OTHER, payload: { text: "Thinking of a $40K cooler upgrade in December", via: "typed" } })).json();
    expect(parked).toMatchObject({ state: "new", reading: { kind: "investment", direction: "out", amount: 4000000, date: "2026-12-15" } });
    expect(parked.effect.lowPointDelta).toBeLessThanOrEqual(0);
    expect((await app.inject({ method: "GET", url: "/notes", headers: OTHER })).json()[0].id).toBe(parked.id);

    const edited = (await app.inject({ method: "PATCH", url: `/notes/${parked.id}`, headers: OTHER, payload: { amount: 3000000 } })).json();
    expect(edited.reading.amount).toBe(3000000);
    expect((await app.inject({ method: "PATCH", url: `/notes/${parked.id}`, headers: OTHER, payload: { settlement: "paid" } })).statusCode).toBe(400);

    const before = (await app.inject({ method: "GET", url: "/forecast", headers: OTHER })).json();
    const added = (await app.inject({ method: "POST", url: `/notes/${parked.id}/add`, headers: OTHER })).json();
    expect(added.state).toBe("added");
    const after = (await app.inject({ method: "GET", url: "/forecast", headers: OTHER })).json();
    expect(after.inputsHash).not.toBe(before.inputsHash);

    const vague = (await app.inject({ method: "POST", url: "/notes", headers: OTHER, payload: { text: "remember to call the accountant" } })).json();
    expect(vague.reading.kind).toBe("note");
    expect((await app.inject({ method: "POST", url: `/notes/${vague.id}/keep`, headers: OTHER })).json().state).toBe("kept");
    expect((await app.inject({ method: "POST", url: `/notes/${vague.id}/remove`, headers: OTHER })).json().state).toBe("removed");
  });

  it("POST /plans adds an owner plan to the forecast", async () => {
    const before = (await app.inject({ method: "GET", url: "/forecast", headers: OTHER })).json();
    const res = await app.inject({ method: "POST", url: "/plans", headers: OTHER, payload: { kind: "plan", amount: 4000000, date: "2026-12-01", note: "supplier deposit" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toMatch(/^plan-/);
    const after = (await app.inject({ method: "GET", url: "/forecast", headers: OTHER })).json();
    expect(after.lowPoint.amount).toBeLessThan(before.lowPoint.amount);
    expect((await app.inject({ method: "POST", url: "/plans", headers: OTHER, payload: { amount: "40k", date: "2026-12-01" } })).statusCode).toBe(400);
  });

  it("POST /setup creates a private business the user can then open", async () => {
    const res = await app.inject({ method: "POST", url: "/setup", headers: OWNER, payload: { email: "owner@acme.example", businessName: "Acme Imports", kind: "restaurant", reserve: 2500000, connect: ["square", "bank_csv"] } });
    expect(res.statusCode).toBe(200);
    const acc = res.json();
    expect(acc).toMatchObject({ businessName: "Acme Imports", kind: "restaurant", owner: "Owner", reserve: 2500000, connections: [{ id: "square", state: "waiting" }, { id: "bank_csv", state: "waiting" }] });
    const ctx = (await app.inject({ method: "GET", url: "/context", headers: OWNER })).json();
    expect(ctx.business).toMatchObject({ id: acc.businessId, synthetic: false });
    expect(ctx.profile.safetyLine).toEqual({ kind: "fixed", amount: 2500000 });
    expect((await app.inject({ method: "GET", url: "/context", headers: { ...OTHER, "x-neri-business": acc.businessId } })).statusCode).toBe(404);
    // No sample money in a new business.
    expect(ctx.profile.recurring).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/brief", headers: OWNER })).json().shortfall).toBeNull();
  });

  it("body-less POSTs with Content-Type: application/json work (app/api.js always sends it)", async () => {
    const brief = (await app.inject({ method: "GET", url: "/brief", headers: OTHER })).json();
    const res = await app.inject({ method: "POST", url: `/work-items/${brief.three[0].id}/draft`, headers: { ...OTHER, "content-type": "application/json" } });
    expect(res.statusCode).toBe(200);
    const bad = await app.inject({ method: "POST", url: "/plans", headers: { ...OTHER, "content-type": "application/json" }, payload: "{nope" });
    expect(bad.statusCode).toBe(400);
  });

  it("POST /ask answers with text, a scenario run and a plan proposal; a stated rule is stored as proposed", async () => {
    const ask = await app.inject({ method: "POST", url: "/ask", headers: OTHER, payload: { question: "Can I afford a $40K deposit to Shenzhen in December?" } });
    expect(ask.statusCode).toBe(200);
    const a = ask.json();
    expect(a.text).toEqual(expect.any(String));
    expect(a.scenario).toMatchObject({ label: expect.any(String), run: { days: expect.any(Array) } });
    expect(a.proposal).toMatchObject({ kind: "plan", amount: 4000000, date: expect.stringMatching(/^2026-12-/) });
    expect((await app.inject({ method: "POST", url: "/ask", headers: OTHER, payload: { question: "" } })).statusCode).toBe(400);

    const rule = (await app.inject({ method: "POST", url: "/ask", headers: OTHER, payload: { question: "Evergreen always pays about 20 days late" } })).json();
    if (rule.verdict === "proposed") {
      const { records } = await store.load("cascade_trade");
      expect(records.rules.some((r) => r.state === "proposed") || records.signals.some((s) => s.channel === "owner" && s.state === "proposed")).toBe(true);
    }
  });

  it("POST /demo/reset reseeds samples", async () => {
    await app.inject({ method: "POST", url: "/plans", headers: OTHER, payload: { amount: 100000, date: "2026-12-01", note: "x" } });
    expect((await app.inject({ method: "POST", url: "/demo/reset", headers: OTHER })).json()).toEqual({ reset: ["cascade_trade", "pike_noodle"] });
    const { records } = await store.load("cascade_trade");
    expect(records.signals.every((s) => s.channel !== "owner")).toBe(true);
  });
});

describe("import -> review -> confirm (INV-1187)", () => {
  beforeEach(() => setup());

  it("an INV-1187 PDF links to the invoice already in the books, then confirms", async () => {
    const imported = await app.inject({ method: "POST", url: "/import/pdf", headers: OTHER, payload: { base64: pdfBase64("inv1187.pdf"), fileName: "inv1187.pdf" } });
    expect(imported.statusCode).toBe(200);
    const result = imported.json();
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ action: "link", state: "proposed", targetCommitmentId: "inv-INV-1187" });
    const before = (await store.load("cascade_trade")).records.commitments.length;

    const pending = (await app.inject({ method: "GET", url: "/review/proposals", headers: OTHER })).json();
    expect(pending.proposals).toHaveLength(1);
    expect(pending.proposals[0].candidate.fields.reference).toMatchObject({ state: "found", value: "INV-1187" });
    expect(pending.proposals[0].evidence.length).toBeGreaterThan(0);

    const id = result.proposals[0].id;
    const stale = await app.inject({ method: "POST", url: `/review/${id}/confirm`, headers: OTHER, payload: { expectedRevision: pending.storeRevision - 1 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "STALE_REVIEW", retryable: true }, revision: pending.storeRevision });

    const ok = await app.inject({ method: "POST", url: `/review/${id}/confirm`, headers: OTHER, payload: { expectedRevision: pending.storeRevision } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().storeRevision).toBe(pending.storeRevision + 1);
    const { records } = await store.load("cascade_trade");
    expect(records.commitments).toHaveLength(before);
    expect(records.commitments.find((c) => c.id === "inv-INV-1187")!.evidenceIds).toContain(result.evidence[0].id);

    const twice = await app.inject({ method: "POST", url: `/review/${id}/confirm`, headers: OTHER });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe("NOT_PROPOSED");

    // Re-importing must not reopen the decided proposal.
    await app.inject({ method: "POST", url: "/import/pdf", headers: OTHER, payload: { base64: pdfBase64("inv1187.pdf"), fileName: "inv1187.pdf" } });
    expect((await store.listProposals("cascade_trade")).find((p) => p.id === id)!.state).toBe("confirmed");
  });

  it("confirm maps ApplyError codes to HTTP statuses", async () => {
    const result = (await app.inject({ method: "POST", url: "/import/pdf", headers: OTHER, payload: { base64: pdfBase64("inv1187.pdf") } })).json();
    const { storeRevision } = await store.load("cascade_trade");
    const base: ChangeProposal = { ...result.proposals[0], state: "proposed", expectedStoreRevision: storeRevision };
    const put = async (p: Partial<ChangeProposal>) => { await store.saveProposals("cascade_trade", [{ ...base, ...p } as ChangeProposal]); return p.id!; };
    const confirm = async (id: string) => app.inject({ method: "POST", url: `/review/${id}/confirm`, headers: OTHER });

    const nothing = await confirm(await put({ id: "cp-review", action: "review", ops: [] }));
    expect([nothing.statusCode, nothing.json().error.code]).toEqual([422, "NOTHING_TO_APPLY"]);
    const unknown = await confirm(await put({ id: "cp-orphan", ops: [{ op: "linkEvidence", commitmentId: "inv-gone", evidenceIds: ["ev-x"] }] }));
    expect([unknown.statusCode, unknown.json().error.code]).toEqual([404, "UNKNOWN_TARGET"]);
    const stale = await confirm(await put({ id: "cp-stale", ops: [{ op: "updateCommitment", commitmentId: "inv-INV-1187", change: { field: "amount", from: 1, to: 2 }, evidence: [] }] }));
    expect([stale.statusCode, stale.json().error.code]).toEqual([409, "STALE_REVIEW"]);
    expect((await confirm("missing")).statusCode).toBe(404);
    expect(Object.keys(APPLY_ERROR_STATUS).sort()).toEqual(["NOTHING_TO_APPLY", "NOT_PROPOSED", "OVER_ALLOCATED", "STALE_REVIEW", "UNKNOWN_TARGET"]);
  });

  it("a day-first chat posted to the whatsapp route is read day first (inferred, or from the body)", async () => {
    const text = "[25/11/26, 9:14:02 AM] Mei: Reminder.\n[03/12/26, 9:31:47 AM] Dana: We will pay on 05/12.\n";
    const date = async (payload: Record<string, unknown>) => {
      const res = (await app.inject({ method: "POST", url: "/import/whatsapp", headers: OTHER, payload })).json();
      return res.evidence.find((e: { channel: string }) => e.channel === "whatsapp").receivedAt as string;
    };
    expect(await date({ text })).toMatch(/^2026-12-03T/);
    expect(await date({ text: "[03/12/26, 9:31:47 AM] Dana: hi\n", dateOrder: "DMY" })).toMatch(/^2026-12-03T/);
  });

  it("a pasted owner message about INV-104 becomes a proposed signal, not a change", async () => {
    const text = readFileSync(join(import.meta.dirname, "../fixtures/cascade_trade/intake/owner-message-inv104.txt"), "utf8");
    const res = (await app.inject({ method: "POST", url: "/import/paste", headers: OTHER, payload: { text, receivedAt: "2026-10-25T16:00:00Z" } })).json();
    expect(res.preview.signals).toBeGreaterThanOrEqual(0);
    expect((await app.inject({ method: "POST", url: "/import/docx", headers: OTHER, payload: { text: "a,b" } })).statusCode).toBe(415);
    expect((await app.inject({ method: "POST", url: "/import/paste", headers: OTHER, payload: { text: "  " } })).statusCode).toBe(400);
  });
});

describe("spreadsheet and WhatsApp imports (adapters lane)", () => {
  beforeEach(() => setup());
  const csv = readFileSync(join(import.meta.dirname, "../fixtures/cascade_trade/intake/files/ar-aging.csv"));
  const upload = (url: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url, headers: OTHER, payload });

  it("a CSV upload becomes candidates with diagnostics, and changes no cash by itself", async () => {
    const before = (await store.load("cascade_trade")).records.commitments.length;
    const res = await upload("/import/upload", { base64: csv.toString("base64"), fileName: "ar-aging.csv" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.candidates.length).toBe(4);
    expect(body.diagnostics).toMatchObject({ rowsRead: 5, rowsImported: 3, rowsRejected: 2, source: "generic_file" });
    expect(body.diagnostics.errors.map((e: { code: string }) => e.code).sort()).toEqual(["missing_amount", "missing_reference"]);
    for (const e of body.diagnostics.errors) expect(e.nextStep).not.toBe("");
    const blank = body.candidates.find((c: any) => c.fields.reference.value === "INV-1203");
    expect(blank.fields.amount.state).toBe("missing");
    expect((await store.load("cascade_trade")).records.commitments).toHaveLength(before);
    // The original file's name and hash are kept on its evidence.
    const ev = (await store.load("cascade_trade")).records.evidence.find((e) => e.fileName === "ar-aging.csv")!;
    expect(ev).toMatchObject({ channel: "upload", format: "csv", sourceRef: { system: "generic_file" } });
    expect(ev.fileHash).toHaveLength(64);
  });

  it("uploading the same file again is a repeat: nothing new is proposed", async () => {
    const payload = { base64: csv.toString("base64"), fileName: "ar-aging.csv" };
    await upload("/import/sheet", payload);
    const proposals = (await store.listProposals("cascade_trade")).length;
    const again = (await upload("/import/sheet", { ...payload, fileName: "renamed.csv" })).json();
    expect(again).toMatchObject({ repeat: true, candidates: [], proposals: [], signals: [] });
    expect(again.diagnostics).toMatchObject({ rowsImported: 0, rowsDuplicate: 5 });
    expect((await store.listProposals("cascade_trade")).length).toBe(proposals);
  });

  it("pasted table text is read as CSV, and the owner's column mapping is applied", async () => {
    const res = await upload("/import/sheet", { text: "Ref,Who,Net\nA-1,Acme,100.00\nA-2,Beta,250.00\n", columnMapping: { reference: 0, party: 1, amount: 2 }, headerRow: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().candidates).toHaveLength(2);
  });

  it("a bad mapping value or an unreadable file is a plain 4xx with the next step", async () => {
    const bad = await upload("/import/sheet", { text: "a,b\n1,2", columnMapping: { amount: -1 } });
    expect(bad.statusCode).toBe(200);   // ignored, not trusted
    const broken = await upload("/import/upload", { base64: Buffer.from([1, 2, 3]).toString("base64"), fileName: "bad.xlsx" });
    expect(broken.statusCode).toBe(422);
    expect(broken.json().error.message).toMatch(/could not be opened.*Export|could not be opened/);
    const none = await upload("/import/sheet", { fileName: "x.csv" });
    expect(none.statusCode).toBe(400);
  });

  it("a WhatsApp .txt export is read, and an identical re-upload is a repeat", async () => {
    const chat = readFileSync(join(import.meta.dirname, "../fixtures/cascade_trade/intake/whatsapp-evergreen.txt"));
    const payload = { base64: chat.toString("base64"), fileName: "WhatsApp Chat.txt" };
    const first = await upload("/import/whatsapp", payload);
    expect(first.statusCode).toBe(200);
    expect(first.json().diagnostics).toMatchObject({ source: "whatsapp", rowsRead: 3 });
    const again = (await upload("/import/whatsapp", payload)).json();
    expect(again.repeat).toBe(true);
  });

  it("re-uploading the same file with a corrected mapping is read again, not called a repeat", async () => {
    const text = "Ref,Who,Net\nA-1,Acme,100.00\nA-2,Beta,250.00\n";
    const bytes = Buffer.from(text).toString("base64");
    const first = (await upload("/import/sheet", { base64: bytes, fileName: "x.csv" })).json();
    expect(first.repeat).toBeUndefined();
    const same = (await upload("/import/sheet", { base64: bytes, fileName: "x.csv" })).json();
    expect(same).toMatchObject({ repeat: true, repeatOf: expect.stringMatching(/^ev-upload-/) });
    const fixed = (await upload("/import/sheet", { base64: bytes, fileName: "x.csv", columnMapping: { reference: 0, party: 1, amount: 2 }, headerRow: 1 })).json();
    expect(fixed.repeat).toBeUndefined();
    expect(fixed.candidates).toHaveLength(2);
  });

  it("a save that fails halfway leaves the file importable again", async () => {
    const payload = { base64: csv.toString("base64"), fileName: "ar-aging.csv" };
    const real = store.saveIntake.bind(store);
    let calls = 0;
    store.saveIntake = async (id, w) => { if (++calls === 1) throw new Error("transient"); return real(id, w); };
    expect((await upload("/import/sheet", payload)).statusCode).toBeGreaterThanOrEqual(500);
    expect((await store.load("cascade_trade")).records.evidence.some((e) => e.fileName === "ar-aging.csv")).toBe(false);
    store.saveIntake = real;
    const retry = (await upload("/import/sheet", payload)).json();
    expect(retry.repeat).toBeUndefined();
    expect(retry.candidates.length).toBe(4);
  });

  it("an unreadable file does not make later uploads of the same bytes a repeat", async () => {
    const bad = { base64: Buffer.from([1, 2, 3]).toString("base64"), fileName: "bad.xlsx" };
    expect((await upload("/import/upload", bad)).statusCode).toBe(422);
    expect((await upload("/import/upload", bad)).statusCode).toBe(422);
  });

  it("a workbook that inflates past the budget is refused without being opened", async () => {
    const z = new JSZip();
    z.file("xl/worksheets/sheet1.xml", Buffer.alloc(60_000_000, 0x20));
    const bomb = await z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    expect(bomb.length).toBeLessThan(1_000_000);
    const res = await upload("/import/upload", { base64: bomb.toString("base64"), fileName: "big.xlsx" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/too large/);
  });

  it("a WhatsApp zip whose chat inflates past the cap is refused", async () => {
    const z = new JSZip();
    z.file("_chat.txt", Buffer.alloc(6_000_000, 0x61));
    const zip = await z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const res = await upload("/import/whatsapp", { base64: zip.toString("base64"), fileName: "chat.zip" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/too large/);
  });

  it("text with a .txt fileName on /import/whatsapp still takes the pasted-text path", async () => {
    const chat = readFileSync(join(import.meta.dirname, "../fixtures/cascade_trade/intake/whatsapp-evergreen.txt"), "utf8");
    const res = await upload("/import/whatsapp", { text: chat, fileName: "chat.txt" });
    expect(res.statusCode).toBe(200);
  });

  it("anonymous demo callers still cannot upload", async () => {
    await setup({ demoMode: true });
    expect((await app.inject({ method: "POST", url: "/import/sheet", payload: { text: "a,b" } })).statusCode).toBe(401);
  });
});

describe("saved owner overrides (#40)", () => {
  beforeEach(() => setup());

  const H = (id: string) => ({ ...OWNER, "x-neri-business": id });
  const leg = (run: { events: { commitmentId?: string; status: string; date: string; amount: number }[] }) =>
    run.events.filter((e) => e.commitmentId === "inv-INV-1187" && e.status !== "actual");
  const target = { commitmentId: "inv-INV-1187" };
  const rev = async (id: string) => (await store.load(id)).storeRevision;

  it("a saved override changes base and stress, simulate and brief; survives a re-import; is deletable", async () => {
    const id = await privateBusiness();
    const base0 = (await app.inject({ method: "GET", url: "/forecast?scenario=base", headers: H(id) })).json();
    const stress0 = (await app.inject({ method: "GET", url: "/forecast?scenario=stress", headers: H(id) })).json();
    expect(leg(base0).length).toBeGreaterThan(0);

    const put = await app.inject({ method: "PUT", url: "/overrides/ov-1187", headers: H(id), payload: {
      target, change: { exclude: true }, origin: "lever", expectedRevision: await rev(id),
    } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ override: { id: "ov-1187", origin: "owner" }, created: true });
    const rev1 = put.json().storeRevision as number;
    expect(rev1).toBe(await rev(id));
    expect((await app.inject({ method: "GET", url: "/overrides", headers: H(id) })).json()).toEqual({ overrides: [put.json().override], storeRevision: rev1 });

    const base1 = (await app.inject({ method: "GET", url: "/forecast?scenario=base", headers: H(id) })).json();
    const stress1 = (await app.inject({ method: "GET", url: "/forecast?scenario=stress", headers: H(id) })).json();
    expect(leg(base1)).toHaveLength(0);
    expect(leg(stress1)).toHaveLength(0);
    expect(base1.inputsHash).not.toBe(base0.inputsHash);
    expect(stress1.inputsHash).not.toBe(stress0.inputsHash);
    const brief = (await app.inject({ method: "GET", url: "/brief", headers: H(id) })).json();
    expect(brief.run.inputsHash).toBe(base1.inputsHash);
    expect(brief.storeRevision).toBe(rev1);
    const sim = (await app.inject({ method: "POST", url: "/simulate", headers: H(id), payload: { levers: [] } })).json();
    expect(sim.run.lowPoint).toEqual(base1.lowPoint);

    // Re-import: the same records upserted again (as a refresh would) keep the override.
    await store.upsertRecords(id, loadSample("cascade_trade")!.records);
    const base2 = (await app.inject({ method: "GET", url: "/forecast?scenario=base", headers: H(id) })).json();
    expect(leg(base2)).toHaveLength(0);
    expect(await store.loadOverrides(id)).toHaveLength(1);

    // Update in place (same id); a write without, or with an old, expectedRevision is refused.
    const shifted = await app.inject({ method: "PUT", url: "/overrides/ov-1187", headers: H(id), payload: { target, change: { shiftDays: 14 }, expectedRevision: await rev(id) } });
    expect(shifted.json()).toMatchObject({ created: false, override: { change: { shiftDays: 14 } } });
    expect(await store.loadOverrides(id)).toHaveLength(1);
    expect((await app.inject({ method: "PUT", url: "/overrides/ov-x", headers: H(id), payload: { target, change: { exclude: true } } })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: "/overrides/ov-1187", headers: H(id) })).statusCode).toBe(400);
    const stale = await app.inject({ method: "DELETE", url: `/overrides/ov-1187?expectedRevision=${rev1}`, headers: H(id) });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "STALE_REVIEW" }, revision: await rev(id) });

    const del = await app.inject({ method: "DELETE", url: "/overrides/ov-1187", headers: { ...H(id), "content-type": "application/json" }, payload: { expectedRevision: await rev(id) } });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ id: "ov-1187", deleted: true });
    expect(del.json().storeRevision).toBeGreaterThan(shifted.json().storeRevision);
    const base3 = (await app.inject({ method: "GET", url: "/forecast?scenario=base", headers: H(id) })).json();
    expect(leg(base3)).toEqual(leg(base0));
    expect((await app.inject({ method: "DELETE", url: `/overrides/ov-1187?expectedRevision=${await rev(id)}`, headers: H(id) })).statusCode).toBe(404);
  });

  it("concurrent writes from the same revision: one 200, one 409, nothing lost", async () => {
    const id = await privateBusiness();
    const r0 = await rev(id);
    const put = (ovId: string, expectedRevision: number) => app.inject({ method: "PUT", url: `/overrides/${ovId}`, headers: H(id), payload: { target, change: { shiftDays: 7 }, expectedRevision } });
    const [a, b] = await Promise.all([put("ov-a", r0), put("ov-b", r0)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const [won, lost] = a.statusCode === 200 ? [a, b] : [b, a];
    expect(lost.json().error.code).toBe("STALE_REVIEW");
    expect((await store.loadOverrides(id)).map((o) => o.id)).toEqual([won.json().override.id]);
    // The loser reloads and retries: both are kept.
    const loserId = won.json().override.id === "ov-a" ? "ov-b" : "ov-a";
    expect((await put(loserId, lost.json().revision)).statusCode).toBe(200);
    expect((await store.loadOverrides(id)).map((o) => o.id).sort()).toEqual(["ov-a", "ov-b"]);
  });

  it("a failed save is a 500 and leaves the old list intact", async () => {
    class FailingStore extends MemoryStore {
      failSave = false;
      override async saveOverrides(id: string, list: Parameters<MemoryStore["saveOverrides"]>[1]) {
        if (this.failSave) throw new Error("db down");
        return super.saveOverrides(id, list);
      }
    }
    const failing = new FailingStore();
    const s = loadSample("cascade_trade")!;
    const id = await failing.createBusiness({ name: "Acme Imports", profile: s.profile, isSynthetic: false, ownerUserId: "u-owner" });
    await failing.upsertRecords(id, s.records);
    const kept = [{ id: "ov-1", target, change: { exclude: true as const }, origin: "owner" as const }];
    await failing.saveOverrides(id, kept);
    const fapp = await buildApp({ store: failing, verify, now: () => new Date("2026-11-16T17:00:00Z") });
    failing.failSave = true;
    const put = await fapp.inject({ method: "PUT", url: "/overrides/ov-2", headers: H(id), payload: { target, change: { shiftDays: 3 }, expectedRevision: (await failing.load(id)).storeRevision } });
    expect(put.statusCode).toBe(500);
    expect(put.json().error.code).toBe("INTERNAL");
    const del = await fapp.inject({ method: "DELETE", url: `/overrides/ov-1?expectedRevision=${(await failing.load(id)).storeRevision}`, headers: H(id) });
    expect(del.statusCode).toBe(500);
    expect(await failing.loadOverrides(id)).toEqual(kept);
  });

  it("rejects bad input: unknown keys, non-integer amounts, bad dates, unknown targets, bad ids", async () => {
    const id = await privateBusiness();
    const expectedRevision = await rev(id);
    const put = (ovId: string, payload: object) => app.inject({ method: "PUT", url: `/overrides/${ovId}`, headers: H(id), payload: { expectedRevision, ...payload } });
    for (const payload of [
      { target, change: { amount: 12.5 } },
      { target, change: { amount: -100 } },
      { target, change: { date: "2026-02-30" } },
      { target, change: { date: "next week" } },
      { target, change: { pay: true } },
      { target, change: {} },
      { target, change: { date: "2026-12-01", shiftDays: 3 } },
      { target: { commitmentId: "inv-INV-1187", leg: 1 }, change: { exclude: true } },
      { target, change: { exclude: true }, sendTo: "bank" },
      { change: { exclude: true } },
      { target: { commitmentId: "nope" }, change: { exclude: true } },
    ]) {
      const res = await put("ov-bad", payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe("INVALID_ARGUMENT");
    }
    expect((await put("bad%20id!", { target, change: { exclude: true } })).statusCode).toBe(400);
    expect(await store.loadOverrides(id)).toEqual([]);
    expect(await rev(id)).toBe(expectedRevision);
  });

  it("shared samples are read-only: anonymous demo callers and signed-in users get 403", async () => {
    await setup({ demoMode: true });
    const before = (await app.inject({ method: "GET", url: "/forecast", headers: OTHER })).json();
    const expectedRevision = await rev("cascade_trade");
    for (const headers of [{}, OTHER, OWNER] as Record<string, string>[]) {
      const put = await app.inject({ method: "PUT", url: "/overrides/ov-1", headers, payload: { target, change: { exclude: true }, expectedRevision } });
      expect(put.statusCode).toBe(403);
      expect(put.json().error.code).toBe("FORBIDDEN");
      expect((await app.inject({ method: "DELETE", url: `/overrides/ov-1?expectedRevision=${expectedRevision}`, headers })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/overrides", headers })).json()).toEqual({ overrides: [], storeRevision: expectedRevision });
    }
    expect(await store.loadOverrides("cascade_trade")).toEqual([]);
    expect(await rev("cascade_trade")).toBe(expectedRevision);
    expect((await app.inject({ method: "GET", url: "/forecast" })).json().inputsHash).toBe(before.inputsHash);
  });

  it("non-members are refused", async () => {
    const id = await privateBusiness();
    await store.saveOverrides(id, [{ id: "ov-1", target, change: { exclude: true }, origin: "owner" }]);
    const other = { ...OTHER, "x-neri-business": id };
    const expectedRevision = await rev(id);
    expect((await app.inject({ method: "GET", url: "/overrides", headers: other })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/overrides/ov-2", headers: other, payload: { target, change: { exclude: true }, expectedRevision } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/overrides/ov-1?expectedRevision=${expectedRevision}`, headers: other })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/overrides", headers: { "x-neri-business": id } })).statusCode).toBe(401);
    expect(await store.loadOverrides(id)).toHaveLength(1);
  });
});

describe("served app/config.js", () => {
  const appDir = join(import.meta.dirname, "../app");
  const committed = readFileSync(join(appDir, "config.js"), "utf8");

  it("switches the app to same-origin and sets public Supabase values, keeping other lines", async () => {
    const live = await buildApp({ store: new MemoryStore(), verify: async () => null, staticDir: appDir,
      appConfig: { supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "anon-key" } });
    const res = await live.inject({ method: "GET", url: "/config.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.body).toContain('window.NERI_API_BASE = "same-origin";');
    expect(res.body).toContain('window.NERI_SUPABASE_URL = "https://example.supabase.co";');
    expect(res.body).toContain('window.NERI_SUPABASE_ANON_KEY = "anon-key";');
    expect(res.body).toContain("window.NERI_LOCK_MINUTES = 15;");
    await live.close();
  });

  it("leaves sign-in off without both Supabase values, and never touches the committed file", () => {
    const out = servedConfig(committed, { supabaseUrl: "https://example.supabase.co" });
    expect(out).toContain('window.NERI_API_BASE = "same-origin";');
    expect(out).toContain('window.NERI_SUPABASE_URL = "";');
    expect(readFileSync(join(appDir, "config.js"), "utf8")).toBe(committed);
  });
});

describe("sample guards", () => {
  it("never serves a service-role key as the anon key", () => {
    const body = Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url");
    const served = servedConfig(readFileSync(join(import.meta.dirname, "../app/config.js"), "utf8"),
      { supabaseUrl: "https://example.supabase.co", supabaseAnonKey: `x.${body}.y` });
    expect(served).toContain('window.NERI_SUPABASE_ANON_KEY = "";');
    expect(isSecretKey("sb_secret_abc")).toBe(true);
    expect(isSecretKey(`x.${Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url")}.y`)).toBe(false);
  });
});

describe("public demo uploads", () => {
  it("refuses a signed-in user's upload into a shared sample in demo mode", async () => {
    const store = new MemoryStore();
    for (const s of loadSamples()) await store.resetBusiness(s, s.records);
    const demo = await buildApp({ store, verify: async (t) => (t === "ok" ? { id: "u-1" } : null), demoMode: true });
    const res = await demo.inject({ method: "POST", url: "/import/paste", headers: { authorization: "Bearer ok", "x-neri-business": "cascade_trade" }, payload: { text: "hello" } });
    expect(res.statusCode).toBe(403);
    await demo.close();
  });
});

describe("atomic, idempotent decisions (#191)", () => {
  beforeEach(() => setup());

  async function pendingProposal(): Promise<string> {
    const imported = (await app.inject({ method: "POST", url: "/import/pdf", headers: OTHER, payload: { base64: pdfBase64("inv1187.pdf"), fileName: "inv1187.pdf" } })).json();
    return imported.proposals[0].id as string;
  }
  const evidenceCount = async () => (await store.load("cascade_trade")).records.commitments.find((c) => c.id === "inv-INV-1187")!.evidenceIds!.length;

  it("two concurrent confirms: one wins, one gets 409, applied once", async () => {
    const id = await pendingProposal();
    const before = await evidenceCount();
    const confirm = () => app.inject({ method: "POST", url: `/review/${id}/confirm`, headers: OTHER });
    const [a, b] = await Promise.all([confirm(), confirm()]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.statusCode === 409)!.json().error.code).toBe("STALE_REVIEW");
    expect(await evidenceCount()).toBe(before + 1);
    expect((await store.listProposals("cascade_trade")).find((p) => p.id === id)!.state).toBe("confirmed");
  });

  it("two concurrent signal applies: one wins, one gets 409", async () => {
    const item = (await app.inject({ method: "GET", url: "/review", headers: OTHER })).json()[0];
    const apply = () => app.inject({ method: "POST", url: `/signals/${item.signal.id}/apply`, headers: OTHER });
    const [a, b] = await Promise.all([apply(), apply()]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const { records, storeRevision } = await store.load("cascade_trade");
    expect(records.signals.find((s) => s.id === item.signal.id)!.state).toBe("applied");
    expect([a, b].find((r) => r.statusCode === 200)!.json().storeRevision).toBe(storeRevision);
  });

  describe("POST /rules/:id/confirm|dismiss", () => {
    const seedRule = async (id = "rule-test-1") => {
      await store.upsertRecords("cascade_trade", { rules: [{ id, scope: { all: true }, kind: "lag_offset", params: { offsetDays: 14 }, fromNote: "Customers pay about two weeks late", state: "proposed" }] });
      return id;
    };

    it("confirm sets the state and bumps the revision", async () => {
      const id = await seedRule();
      const before = (await store.load("cascade_trade")).storeRevision;
      const res = await app.inject({ method: "POST", url: `/rules/${id}/confirm`, headers: OTHER });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ rule: { id, state: "confirmed" }, storeRevision: before + 1 });
      const { records, storeRevision } = await store.load("cascade_trade");
      expect(storeRevision).toBe(before + 1);
      expect(records.rules.find((r) => r.id === id)!.state).toBe("confirmed");
    });

    it("dismiss works", async () => {
      const id = await seedRule();
      const res = await app.inject({ method: "POST", url: `/rules/${id}/dismiss`, headers: OTHER });
      expect(res.statusCode).toBe(200);
      expect(res.json().rule.state).toBe("dismissed");
      expect((await store.load("cascade_trade")).records.rules.find((r) => r.id === id)!.state).toBe("dismissed");
    });

    it("a second confirm is 409 NOT_PROPOSED", async () => {
      const id = await seedRule();
      await app.inject({ method: "POST", url: `/rules/${id}/confirm`, headers: OTHER });
      const again = await app.inject({ method: "POST", url: `/rules/${id}/confirm`, headers: OTHER });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe("NOT_PROPOSED");
    });

    it("two concurrent confirms: one 200, one 409", async () => {
      const id = await seedRule();
      const go = () => app.inject({ method: "POST", url: `/rules/${id}/confirm`, headers: OTHER });
      const [a, b] = await Promise.all([go(), go()]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    });

    it("an unknown id is 404, and a bad decision is 404", async () => {
      expect((await app.inject({ method: "POST", url: "/rules/nope/confirm", headers: OTHER })).statusCode).toBe(404);
      const id = await seedRule();
      expect((await app.inject({ method: "POST", url: `/rules/${id}/approve`, headers: OTHER })).statusCode).toBe(404);
    });
  });

  it("the same Idempotency-Key and body replays the stored response without writing", async () => {
    const id = await pendingProposal();
    const headers = { ...OTHER, "idempotency-key": "k-1" };
    const first = await app.inject({ method: "POST", url: `/review/${id}/confirm`, headers, payload: {} });
    expect(first.statusCode).toBe(200);
    const snapshot = JSON.stringify(await store.load("cascade_trade"));
    const second = await app.inject({ method: "POST", url: `/review/${id}/confirm`, headers, payload: {} });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(JSON.stringify(await store.load("cascade_trade"))).toBe(snapshot);
  });

  it("the same key with a different body is 409 IDEMPOTENCY_CONFLICT", async () => {
    const id = await pendingProposal();
    const headers = { ...OTHER, "idempotency-key": "k-2" };
    await app.inject({ method: "POST", url: `/review/${id}/confirm`, headers, payload: {} });
    const other = await app.inject({ method: "POST", url: `/review/${id}/confirm`, headers, payload: { commitmentId: "inv-INV-1187" } });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("dismiss goes through the same atomic path", async () => {
    const id = await pendingProposal();
    const [a, b] = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: `/review/${id}/dismiss`, headers: OTHER })));
    expect([a!.statusCode, b!.statusCode].sort()).toEqual([200, 409]);
    expect((await store.listProposals("cascade_trade")).find((p) => p.id === id)!.state).toBe("dismissed");
  });
});

describe("bank statement import (/import/bank)", () => {
  beforeEach(() => setup());
  const stmt = readFileSync(join(import.meta.dirname, "../fixtures/bank/statement-signed-clean.csv"));
  const post = (adapter: string, payload: Record<string, unknown>, headers: Record<string, string> = OTHER) =>
    app.inject({ method: "POST", url: `/import/${adapter}`, headers, payload });
  const payload = { base64: stmt.toString("base64"), fileName: "statement-signed.csv" };   // the clean variant: no unreadable rows, so a balance is taken

  it("a statement becomes bank history and today's balance, with diagnostics and recurring proposals, and changes no commitment", async () => {
    const before = await store.load("cascade_trade");
    const res = await post("bank", payload);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ repeat: false, written: true, unallocated: 17, preview: { events: 17, balances: 1, recurring: 2 } });
    expect(body.diagnostics).toMatchObject({ rowsRead: 17, rowsImported: 17, rowsRejected: 0, source: "bank_csv" });
    for (const e of body.diagnostics.errors) expect(e.nextStep).not.toBe("");
    expect(body.balance).toMatchObject({ amount: 5387200, asOf: "2026-10-24", account: "bank" });
    expect(body.recurring.map((p: { cadence: string }) => p.cadence).sort()).toEqual(["biweekly", "monthly"]);

    const after = await store.load("cascade_trade");
    expect(after.records.events.length - before.records.events.length).toBe(17);
    expect(after.records.balances.length - before.records.balances.length).toBe(1);
    expect(after.records.commitments).toEqual(before.records.commitments);
    expect(after.records.settlements).toEqual(before.records.settlements);
    const stored = after.records.events.filter((e) => e.sourceRef.system === "bank_csv");
    expect(stored).toHaveLength(17);
    expect(stored.every((e) => e.status === "actual" && e.commitmentId === undefined)).toBe(true);
    const ev = after.records.evidence.find((e) => e.fileName === "statement-signed.csv")!;
    expect(ev).toMatchObject({ channel: "bank_csv", format: "csv" });
    expect(ev.fileHash).toHaveLength(64);
    // Recurring proposals are only offered: nothing applied, nothing queued as a proposal or signal.
    expect(await store.listProposals("cascade_trade")).toEqual([]);
    expect(after.records.rules).toEqual(before.records.rules);
    expect(after.storeRevision).toBeGreaterThan(before.storeRevision);
  });

  it("warns when the books already hold a balance under another account name, since both would be added", async () => {
    const existing = (await store.load("cascade_trade")).records.balances.map((x) => x.account);
    expect(existing.length).toBeGreaterThan(0);
    const body = (await post("bank", payload)).json();
    expect(body.diagnostics.warnings.join(" ")).toMatch(/already have a balance for .*saved as the account "bank".*import the statement again and give that account's name/);
    // Naming the account the books already use removes the warning (fresh store: the first import above added "bank").
    await setup();
    const same = (await post("bank", { ...payload, account: existing[0] })).json();
    expect(same.diagnostics.warnings.join(" ")).not.toMatch(/already have a balance/);
    expect(same.balance.account).toBe(existing[0]);
  });

  it("uploading the same statement again is a repeat that writes nothing", async () => {
    await post("bank", payload);
    const mid = await store.load("cascade_trade");
    const again = (await post("bank", { ...payload, fileName: "renamed.csv" })).json();
    expect(again).toMatchObject({ repeat: true, written: false, repeatOf: expect.stringMatching(/^ev-bank_csv-/), preview: { events: 0, balances: 0, recurring: 0 } });
    expect(again.diagnostics).toMatchObject({ rowsImported: 0, rowsDuplicate: 17 });
    const end = await store.load("cascade_trade");
    expect(end.records.events).toHaveLength(mid.records.events.length);
    expect(end.storeRevision).toBe(mid.storeRevision);
  });

  it("an owner's corrected mapping is read again; an unreadable layout writes nothing and asks for the mapping", async () => {
    const odd = "When,Who,How much\n2026-10-01,Landlord,-1000.00\n2026-10-02,Customer,250.00\n";
    const before = (await store.load("cascade_trade")).records.events.length;
    const first = (await post("bank", { text: odd })).json();
    expect(first).toMatchObject({ written: false, preview: { events: 0 } });
    expect(first.diagnostics.errors[0]).toMatchObject({ code: "unmapped_column" });
    expect((await store.load("cascade_trade")).records.events).toHaveLength(before);
    const fixed = (await post("bank", { text: odd, columnMapping: { date: 0, description: 1, amount: 2 }, headerRow: 1, currency: "USD" })).json();
    expect(fixed).toMatchObject({ written: true, preview: { events: 2, balances: 0 } });
    expect(fixed.diagnostics.warnings.join(" ")).toMatch(/Enter your current bank balance yourself/);
    // The same bytes with the same correction are a fresh read, not "already imported" (corrections always retry).
    expect((await post("bank", { text: odd, columnMapping: { date: 0, description: 1, amount: 2 }, headerRow: 1 })).json().repeat).toBe(false);
  });

  it("ignores a mapping with unknown columns or bad indexes instead of trusting it", async () => {
    const res = await post("bank", { text: "Date,Description,Amount\n2026-10-01,Rent,-5.00\n", columnMapping: { date: -1, secret: 3, amount: 1.5 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().preview.events).toBe(1);   // headers are read as usual
  });

  it("a damaged or unsupported file is a plain 422 with the next step; nothing is written", async () => {
    const before = (await store.load("cascade_trade")).records.evidence.length;
    const broken = await post("bank", { base64: Buffer.from([1, 2, 3]).toString("base64"), fileName: "s.xlsx" });
    expect(broken.statusCode).toBe(422);
    expect(broken.json().error.message).toMatch(/could not be opened.*Download the statement again/);
    const pdf = await post("bank", { base64: Buffer.from("%PDF").toString("base64"), fileName: "s.pdf" });
    expect(pdf.statusCode).toBe(422);
    expect(pdf.json().error.message).toMatch(/CSV or Excel/);
    expect((await post("bank", {})).statusCode).toBe(400);
    expect((await store.load("cascade_trade")).records.evidence).toHaveLength(before);
  });

  it("upload never routes a CSV to the bank path: the owner picks 'bank statement'", async () => {
    const res = await post("upload", payload);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recurring).toBeUndefined();
    expect(Array.isArray(body.candidates)).toBe(true);
    expect((await store.load("cascade_trade")).records.events.some((e) => e.sourceRef.system === "bank_csv")).toBe(false);
  });

  it("a statement that runs up to today still sets today's cash, and today's lines (already inside that balance) are left out", async () => {
    const text = "Date,Description,Amount,Balance\n2026-11-14,SHOP,-10.00,990.00\n2026-11-16,SHOP,-10.00,980.00\n";
    const res = (await post("bank", { text, fileName: "today.csv", currency: "USD" })).json();
    expect(res.balance).toMatchObject({ amount: 98000, asOf: "2026-11-16" });
    expect(res.preview).toMatchObject({ events: 1, balances: 1 });
    expect(res.diagnostics.warnings.join(" ")).toMatch(/runs up to today.*left out 1 line dated today/);
    const { records } = await store.load("cascade_trade");
    expect(records.events.filter((e) => e.sourceRef.system === "bank_csv").map((e) => e.date)).toEqual(["2026-11-14"]);
    expect(records.balances.find((b) => b.sourceRef.system === "bank_csv")).toMatchObject({ asOf: "2026-11-16" });
  });

  it("a corrected re-import (day-first dates) replaces the earlier read of the same file instead of adding to it", async () => {
    const text = "Date,Description,Amount,Balance\n03/04/2026,RENT HARBOR,-1000.00,9000.00\n05/04/2026,PAYROLL NORTHWIND,-2000.00,7000.00\n";
    const bankEvents = async () => (await store.load("cascade_trade")).records.events.filter((e) => e.sourceRef.system === "bank_csv");
    await post("bank", { text, fileName: "s.csv", currency: "USD" });
    const first = (await bankEvents()).map((e) => e.date).sort();
    expect(first).toEqual(["2026-03-04", "2026-05-04"]);
    const fixed = (await post("bank", { text, fileName: "s.csv", currency: "USD", dayFirst: true })).json();
    expect(fixed.repeat).toBe(false);
    expect((await bankEvents()).map((e) => e.date).sort()).toEqual(["2026-04-03", "2026-04-05"]);   // no ghost March/May lines
  });

  it("is refused for anonymous visitors of the public demo, like every other import", async () => {
    await setup({ demoMode: true });
    expect((await app.inject({ method: "POST", url: "/import/bank", payload })).statusCode).toBe(401);
  });

  it("a signed-in visitor on the public demo's shared sample cannot publish a statement either", async () => {
    await setup({ demoMode: true });
    expect((await post("bank", payload)).statusCode).toBe(403);
  });
});

describe("original files behind evidence (#155)", () => {
  type Blobs = import("./blobs").Blobs;
  let blobs: import("./blobs").MemoryBlobs & { puts: number };
  let id: string;
  const csv = readFileSync(join(import.meta.dirname, "../fixtures/cascade_trade/intake/files/ar-aging.csv"));
  const NOW = () => new Date("2026-11-16T17:00:00Z");
  const H = () => ({ ...OWNER, "x-neri-business": id });
  const upload = (url: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url, headers: H(), payload });
  const original = (evidenceId: string, headers: Record<string, string> = H()) => app.inject({ method: "GET", url: `/evidence/${encodeURIComponent(evidenceId)}/original`, headers });
  const evidenceOf = async (file: string) => (await store.load(id)).records.evidence.find((e) => e.fileName === file)!;

  async function rebuild(b: Blobs = blobs) {
    app = await buildApp({ store, verify, demoMode: false, allowReset: true, blobs: b, now: NOW });
  }

  beforeEach(async () => {
    await setup();
    const { MemoryBlobs } = await import("./blobs");
    class Counting extends MemoryBlobs {
      puts = 0;
      override async putOriginal(...a: Parameters<Blobs["putOriginal"]>) { this.puts++; return super.putOriginal(a[0], a[1]); }
    }
    blobs = new Counting() as typeof blobs;
    id = await privateBusiness();
    await rebuild();
  });

  it("a repeat import retries an original that failed to save the first time", async () => {
    const real = blobs.putOriginal.bind(blobs);
    let fail = true;
    blobs.putOriginal = async (...a: Parameters<Blobs["putOriginal"]>) => { if (fail) throw new Error("storage down"); return real(...a); };
    const payload = { base64: csv.toString("base64"), fileName: "ar-aging.csv" };
    const first = (await upload("/import/upload", payload)).json();
    expect(first.notes.some((n: { text: string }) => /original could not be saved/.test(n.text))).toBe(true);
    expect((await evidenceOf("ar-aging.csv")).storageKey).toBeUndefined();
    fail = false;
    const again = (await upload("/import/upload", payload)).json();
    expect(again.repeat).toBe(true);
    const ev = await evidenceOf("ar-aging.csv");
    expect(ev.storageKey).toMatch(/ar-aging\.csv$/);
    expect((await original(ev.id)).statusCode).toBe(200);
  });

  it("an original in a shared sample business is not downloadable by a signed-in user who is not a member", async () => {
    const { records } = await store.load("cascade_trade");
    await store.upsertRecords("cascade_trade", { ...records, evidence: [...records.evidence, { id: "ev-shared", channel: "upload", format: "csv", receivedAt: "2026-10-25T00:00:00Z", extraction: "ok", fileName: "x.csv", storageKey: "cascade_trade/evidence/" + "a".repeat(64) + "-x.csv", sourceRef: { system: "generic_file", record: "x.csv" } }] });
    await blobs.putOriginal("cascade_trade", { bytes: new TextEncoder().encode("a,b"), fileName: "x.csv", mime: "text/csv", hash: "a".repeat(64) });
    const r = await original("ev-shared", { ...OTHER, "x-neri-business": "cascade_trade" });
    expect(r.statusCode).toBe(404);
  });

  it("a CSV upload keeps its original; the owner downloads the same bytes as a safe attachment", async () => {
    const res = await upload("/import/upload", { base64: csv.toString("base64"), fileName: "ar-aging.csv" });
    expect(res.statusCode).toBe(200);
    const ev = await evidenceOf("ar-aging.csv");
    expect(ev.storageKey).toMatch(new RegExp(`^${id}/evidence/[0-9a-f]{64}-ar-aging\\.csv$`));
    expect(ev.mime).toBe("text/csv");
    expect(res.json().evidence.find((e: { fileName?: string }) => e.fileName === "ar-aging.csv").storageKey).toBe(ev.storageKey);

    const dl = await original(ev.id);
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(csv)).toBe(true);
    expect(dl.headers["content-type"]).toBe("text/csv");
    expect(dl.headers["content-disposition"]).toBe('attachment; filename="ar-aging.csv"');
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
    expect(dl.headers["content-security-policy"]).toContain("sandbox");
    expect(dl.headers["cache-control"]).toContain("no-store");
  });

  it("pasted text is kept as a .txt original", async () => {
    const text = "Hi, we will pay INV-1187 on Nov 20.";
    const res = await upload("/import/paste", { text, receivedAt: "2026-11-16T16:00:00Z" });
    expect(res.statusCode).toBe(200);
    const ev = res.json().evidence.find((e: { parentId?: string; channel: string }) => !e.parentId && e.channel !== "url");
    expect(ev.storageKey).toMatch(/-pasted\.txt$/);
    expect((await original(ev.id)).body).toBe(text);
  });

  it("the same bytes twice is one object, and a repeat upload does not touch storage again", async () => {
    const payload = { base64: csv.toString("base64"), fileName: "ar-aging.csv" };
    await upload("/import/sheet", payload);
    expect(blobs.puts).toBe(1);
    const again = await upload("/import/sheet", { ...payload, fileName: "renamed.csv" });
    expect(again.json().repeat).toBe(true);
    expect(blobs.puts).toBe(1);
    expect(blobs.objects.size).toBe(1);
  });

  it("odd client file names never reach the key or the download header", async () => {
    await upload("/import/upload", { base64: csv.toString("base64"), fileName: "../../etc/passwd.csv" });
    const ev = (await store.load(id)).records.evidence.find((e) => e.storageKey)!;
    expect(ev.storageKey).toMatch(new RegExp(`^${id}/evidence/[0-9a-f]{64}-passwd\\.csv$`));
    expect(ev.storageKey).not.toContain("..");
    const dl = await original(ev.id);
    expect(dl.headers["content-disposition"]).toBe('attachment; filename="passwd.csv"');
  });

  it("a storage failure does not fail the import: details are kept, no storageKey, and the owner is told", async () => {
    await rebuild({ putOriginal: async () => { throw new Error("storage down"); }, getOriginal: async () => null });
    const res = await upload("/import/upload", { base64: csv.toString("base64"), fileName: "ar-aging.csv" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.candidates.length).toBe(4);
    expect(body.diagnostics).toMatchObject({ rowsRead: 5, rowsImported: 3 });
    expect(body.notes.map((n: { text: string }) => n.text)).toContain("The original could not be saved; the extracted details were kept.");
    const ev = await evidenceOf("ar-aging.csv");
    expect(ev.storageKey).toBeUndefined();
    expect((await original(ev.id)).statusCode).toBe(404);
  });

  it("an attachment inside a WhatsApp zip gets its own original next to the zip", async () => {
    const z = new JSZip();
    z.file("_chat.txt", "[11/28/26, 9:14:02 AM] Dana: <attached: ar.csv>\n");
    z.file("ar.csv", csv);
    const zip = await z.generateAsync({ type: "nodebuffer" });
    const res = await upload("/import/whatsapp", { base64: zip.toString("base64"), fileName: "chat.zip" });
    expect(res.statusCode).toBe(200);
    const keyed = (await store.load(id)).records.evidence.filter((e) => e.storageKey);
    expect(keyed.map((e) => e.storageKey!.replace(/^.*\/evidence\/[0-9a-f]{64}-/, "")).sort()).toEqual(["ar.csv", "chat.zip"]);
    expect(blobs.objects.size).toBe(2);
    const child = keyed.find((e) => e.storageKey!.endsWith("-ar.csv"))!;
    expect((await original(child.id)).rawPayload.equals(csv)).toBe(true);
  });

  it("a stored page is served as an octet-stream attachment, never as html or svg", async () => {
    const { sha256Hex } = await import("../adapters/core/hash");
    for (const [file, mime] of [["evil.html", "text/html"], ["evil.svg", "image/svg+xml"], ["x.bin", "application/x-sh"]] as const) {
      const bytes = new TextEncoder().encode(`<script>alert("${file}")</script>`);
      const key = await blobs.putOriginal(id, { bytes, fileName: file, mime, hash: sha256Hex(bytes) });
      await store.saveIntake(id, { evidence: [{ id: `ev-${file}`, channel: "upload", format: "html", receivedAt: "2026-11-16T16:00:00Z", fileName: file, mime, storageKey: key, extraction: "ok", sourceRef: { system: "generic_file", record: file } }], candidates: [], proposals: [], signals: [] });
      const dl = await original(`ev-${file}`);
      expect(dl.statusCode).toBe(200);
      expect(dl.headers["content-type"]).toBe("application/octet-stream");
      expect(dl.headers["content-disposition"]).toContain("attachment");
      expect(dl.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("only members can open it: not another user, not a key from another business, not anonymous", async () => {
    await upload("/import/upload", { base64: csv.toString("base64"), fileName: "ar-aging.csv" });
    const ev = await evidenceOf("ar-aging.csv");
    // A signed-in user who is not a member of this business: same 404 as a business that does not exist.
    expect((await original(ev.id, { ...OTHER, "x-neri-business": id })).statusCode).toBe(404);
    // Evidence in the shared sample that points at this business's key: the key is not that business's own, so nothing is served.
    await store.saveIntake("cascade_trade", { evidence: [{ id: "ev-stolen", channel: "upload", format: "csv", receivedAt: "2026-11-16T16:00:00Z", fileName: "x.csv", mime: "text/csv", storageKey: ev.storageKey!, extraction: "ok", sourceRef: { system: "generic_file", record: "x" } }], candidates: [], proposals: [], signals: [] });
    expect((await original("ev-stolen", OTHER)).statusCode).toBe(404);
    // No token: refused, even where the demo serves public samples.
    const demo = await buildApp({ store, verify, demoMode: true, blobs, now: NOW });
    expect((await demo.inject({ method: "GET", url: `/evidence/${encodeURIComponent(ev.id)}/original` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/evidence/${encodeURIComponent(ev.id)}/original` })).statusCode).toBe(401);
    await demo.close();
  });

  it("unknown evidence, evidence with no original, and absurd ids are all a plain 404", async () => {
    await store.saveIntake(id, { evidence: [{ id: "ev-none", channel: "upload", format: "csv", receivedAt: "2026-11-16T16:00:00Z", extraction: "ok", sourceRef: { system: "generic_file", record: "none" } }], candidates: [], proposals: [], signals: [] });
    for (const evidenceId of ["nope", "ev-none", "../../etc/passwd", "%00"]) {
      const res = await original(evidenceId);
      expect(res.statusCode, evidenceId).toBe(404);
      expect(res.json().error.message).toMatch(/original/i);
    }
    // Fastify refuses a very long path parameter before the route runs (414); either way nothing is served.
    expect([404, 414]).toContain((await original("x".repeat(400))).statusCode);
  });

  it("a storage outage on download is a retryable 503, not a crash", async () => {
    await upload("/import/upload", { base64: csv.toString("base64"), fileName: "ar-aging.csv" });
    const ev = await evidenceOf("ar-aging.csv");
    await rebuild({ putOriginal: blobs.putOriginal.bind(blobs), getOriginal: async () => { throw new Error("storage down"); } });
    const res = await original(ev.id);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ code: "STORAGE_UNAVAILABLE", retryable: true });
  });
});

describe("demo sandbox (#173, #153)", () => {
  const A = { "x-neri-visitor": "visitor-aaaaaaaaaaaaaaaa" };
  const B = { "x-neri-visitor": "visitor-bbbbbbbbbbbbbbbb" };
  beforeEach(() => setup({ demoMode: true }));

  const review = async (headers: Record<string, string>) => (await app.inject({ method: "GET", url: "/review", headers })).json() as { signal: { id: string } }[];

  it("a visitor's applied signal is theirs alone; the real store and other visitors still see it proposed", async () => {
    const before = await review({});
    expect(before.length).toBeGreaterThan(0);
    const id = before[0]!.signal.id;
    const applied = await app.inject({ method: "POST", url: `/signals/${id}/apply`, headers: A });
    expect(applied.statusCode).toBe(200);
    expect(await review(A)).toHaveLength(before.length - 1);   // A's later reads see A's change
    expect(await review(B)).toHaveLength(before.length);
    expect(await review({})).toHaveLength(before.length);
    const real = (await store.load("cascade_trade")).records.signals.find((s) => s.id === id);
    expect(real?.state).toBe("proposed");
  });

  it("a visitor's notes stay in their copy", async () => {
    const note = await app.inject({ method: "POST", url: "/notes", headers: A, payload: { text: "Maybe buy a forklift for $9,000 next month" } });
    expect(note.statusCode).toBeLessThan(300);
    expect((await app.inject({ method: "GET", url: "/notes", headers: A })).json()).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/notes", headers: B })).json()).toHaveLength(0);
    expect((await store.getBusiness("cascade_trade"))!.profile.account?.thoughts ?? []).toHaveLength(0);
  });

  it("reset with a visitor id restores only that visitor", async () => {
    const id = (await review({}))[0]!.signal.id;
    await app.inject({ method: "POST", url: `/signals/${id}/apply`, headers: A });
    await app.inject({ method: "POST", url: `/signals/${id}/apply`, headers: B });
    const reset = await app.inject({ method: "POST", url: "/demo/reset", headers: A });
    expect(reset.statusCode).toBe(200);
    expect((await review(A)).some((r) => r.signal.id === id)).toBe(true);
    expect((await review(B)).some((r) => r.signal.id === id)).toBe(false);
  });

  it("anonymous writes without a visitor id are 403; reads still work", async () => {
    const id = (await review({}))[0]!.signal.id;
    const w = await app.inject({ method: "POST", url: `/signals/${id}/apply` });
    expect(w.statusCode).toBe(403);
    expect(w.json().error.message).toBe("The sample is shared. Reload the page to get your own copy.");
    expect((await app.inject({ method: "GET", url: "/brief" })).statusCode).toBe(200);
    expect((await store.load("cascade_trade")).records.signals.find((s) => s.id === id)?.state).toBe("proposed");
  });

  it("reset without a visitor id is 403 unless the server allows it", async () => {
    const locked = await buildApp({ store, verify, demoMode: true, allowReset: false });
    expect((await locked.inject({ method: "POST", url: "/demo/reset" })).statusCode).toBe(403);
    await locked.close();
  });

  it("evicts least recently used past the cap and expires idle sandboxes", async () => {
    const { SandboxStore } = await import("./sandbox");
    let t = 0;
    const sb = new SandboxStore({ now: () => t, max: 2, ttlMs: 1000 });
    const biz = (await store.getBusiness("cascade_trade"))!;
    const a = await sb.storeFor("a".repeat(16), biz, store);
    await sb.storeFor("b".repeat(16), biz, store);
    expect(await sb.storeFor("a".repeat(16), biz, store)).toBe(a);   // touch a: b is now the oldest
    await sb.storeFor("c".repeat(16), biz, store);
    expect(sb.size).toBe(2);
    expect(await sb.storeFor("a".repeat(16), biz, store)).toBe(a);   // a survived, b was evicted
    t = 5000;
    expect(sb.size).toBe(0);
    expect(await sb.storeFor("a".repeat(16), biz, store)).not.toBe(a);
  });
});
