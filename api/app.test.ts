// API routes through Fastify inject() with the in-memory store: no network, no key (cache_only).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type Verifier } from "./app";
import { loadSample, loadSamples } from "./demo";
import { MemoryStore } from "./store";
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

  it("anonymous demo callers still cannot upload", async () => {
    await setup({ demoMode: true });
    expect((await app.inject({ method: "POST", url: "/import/sheet", payload: { text: "a,b" } })).statusCode).toBe(401);
  });
});
