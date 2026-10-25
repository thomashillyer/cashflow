// The downloadable starter pack (app/samples/): a signed-in owner with empty books uploads the files through the
// same route the app's "Upload a file" button uses, in the order README.txt lists, and gets the whole loop.
// Offline: aiMode is cache_only, so PDF and message reading come from the committed fixtures/cascade_trade/intake/cache.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { MemoryStore } from "./store";

const dir = join(import.meta.dirname, "../app/samples");
const H = { authorization: "Bearer owner" };
const ORDER = ["1-open-invoices.csv", "1-open-bills.csv", "2-invoice-INV-1187.pdf", "3-whatsapp-evergreen-chat.txt"];

let app: FastifyInstance;
let store: MemoryStore;
let businessId: string;
const get = async (url: string) => (await app.inject({ url, headers: H })).json();
const upload = async (fileName: string) => {
  const res = await app.inject({ method: "POST", url: "/import/upload", headers: H, payload: { fileName, base64: readFileSync(join(dir, fileName)).toString("base64") } });
  expect(res.statusCode, `${fileName}: ${res.body.slice(0, 300)}`).toBe(200);
  return res.json();
};
// What the owner does in Review: accept what was read from the books (not the signal; that is checked separately).
async function confirmAllProposals() {
  for (let guard = 0; guard < 20; guard++) {
    const { proposals } = await get("/review/proposals");
    const next = proposals.find((p: { proposal: { action: string } }) => p.proposal.action !== "link");
    if (!next) return;
    const res = await app.inject({ method: "POST", url: `/review/${next.proposal.id}/confirm`, headers: H, payload: {} });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  }
}

describe("sample files starter pack", () => {
  beforeAll(async () => {
    store = new MemoryStore();
    app = await buildApp({
      store, verify: async (t) => (t === "owner" ? { id: "owner", email: "owner@example.com" } : null),
      demoMode: false, aiMode: "cache_only", now: () => new Date("2026-10-25T17:00:00Z"),
    });
    const setup = await app.inject({ method: "POST", url: "/setup", headers: H, payload: { businessName: "Cascade Trade Co.", kind: "trading" } });
    businessId = setup.json().businessId;
    expect((await store.getBusiness(businessId))?.isSynthetic).toBe(false);
    // The committed extraction cache is keyed by business name plus aliases, so give this owner the fixture's alias.
    // (In production nothing is cached and Claude reads the PDF and chat live, so any business name works.)
    const biz = (await store.getBusiness(businessId))!;
    await store.saveProfile(businessId, { ...biz.profile, account: { ...biz.profile.account, aliases: ["Cascade Trade"] } });
  });

  it("README.txt lists every file, in upload order, and nothing else is in the pack", () => {
    const readme = readFileSync(join(dir, "README.txt"), "utf8");
    for (const f of ORDER) {
      expect(existsSync(join(dir, f))).toBe(true);
      expect(readme).toContain(f);
    }
    expect(ORDER.map((f) => readme.indexOf(f))).toEqual([...ORDER.map((f) => readme.indexOf(f))].sort((a, b) => a - b));
  });

  it("is served from the live app path as downloads (README.txt stays readable)", async () => {
    const web = await buildApp({ store: new MemoryStore(), verify: async () => null, staticDir: join(import.meta.dirname, "../app"), now: () => new Date("2026-10-25T17:00:00Z") });
    const csv = await web.inject({ url: "/samples/1-open-invoices.csv" });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-disposition"]).toBe('attachment; filename="1-open-invoices.csv"');
    expect(csv.body).toContain("INV-1187");
    expect((await web.inject({ url: "/samples/README.txt" })).headers["content-disposition"]).toBeUndefined();
    const index = await web.inject({ url: "/samples/" });
    expect(index.statusCode).toBe(200);
    for (const f of ORDER) expect(index.body).toContain(f);
    await web.close();
  });

  it("starts empty: no opening balance, nothing to do", async () => {
    expect((await get("/forecast")).openingBalance).toBe(0);
    expect((await get("/brief")).three).toEqual([]);
  });

  it("the owner types the bank balance, then the books exports wait in Review until confirmed", async () => {
    // The Upload button has no bank path (api/README.md: bank statements are chosen by the owner), so the balance is typed.
    const put = await app.inject({ method: "PUT", url: "/balance", headers: H, payload: { amount: 2577300, asOf: "2026-10-25", account: "main" } });
    expect(put.statusCode).toBe(200);
    expect((await get("/forecast")).openingBalance).toBe(2577300);
    for (const f of ["1-open-invoices.csv", "1-open-bills.csv"]) {
      const res = await upload(f);
      expect(res.diagnostics).toMatchObject({ rowsRejected: 0 });
    }
    await confirmAllProposals();
    const { records } = await store.load(businessId);
    const refs = records.commitments.map((c) => c.reference).sort();
    expect(refs).toEqual(["CC-2291", "INV-104", "INV-1187", "INV-1190", "INV-1203", "SC-0042"]);
  });

  it("the INV-1187 PDF links to the invoice already in the books instead of creating a second one", async () => {
    const before = (await store.load(businessId)).records.commitments.filter((c) => c.reference === "INV-1187");
    expect(before).toHaveLength(1);
    const res = await upload("2-invoice-INV-1187.pdf");
    expect(res.proposals.map((p: { action: string }) => p.action)).toEqual(["link"]);
    expect(res.proposals[0].targetCommitmentId).toBe(before[0]!.id);
    const confirm = await app.inject({ method: "POST", url: `/review/${res.proposals[0].id}/confirm`, headers: H, payload: {} });
    expect(confirm.statusCode).toBe(200);
    const { records } = await store.load(businessId);
    const inv = records.commitments.filter((c) => c.reference === "INV-1187");
    expect(inv).toHaveLength(1);
    expect(inv[0]!.evidenceIds?.length).toBeGreaterThanOrEqual(2); // the export and the PDF, one invoice
    expect(records.commitments.filter((c) => c.direction === "in" && c.amount === 2800000)).toHaveLength(1);
  });

  it("the WhatsApp chat puts Evergreen's 'early January' in Review with the words and the invoice", async () => {
    const res = await upload("3-whatsapp-evergreen-chat.txt");
    expect(res.evidence[0]).toMatchObject({ channel: "whatsapp" });
    const review = await get("/review");
    const evergreen = review.find((r: { commitmentId?: string; invoice?: unknown }) => JSON.stringify(r).includes("INV-1187"));
    expect(evergreen, JSON.stringify(review).slice(0, 600)).toBeTruthy();
    expect(JSON.stringify(evergreen)).toMatch(/early January/i);
    // Importing never moves cash by itself: the signal is still waiting for the owner.
    expect((await store.load(businessId)).records.signals.every((s) => s.state === "proposed")).toBe(true);
  });

  it("the brief gives at least two things to do, each with a dollar effect, and each can be drafted", async () => {
    const brief = await get("/brief");
    expect(brief.run.openingBalance).toBe(2577300);
    expect(brief.three.length).toBeGreaterThanOrEqual(2);
    for (const item of brief.three) {
      expect(typeof item.cashEffect).toBe("number");
      expect(item.cashEffect).not.toBe(0);
      expect(item.neededBy).toBeTruthy();
      const draft = await app.inject({ method: "POST", url: `/work-items/${item.id}/draft`, headers: H, payload: {} });
      expect(draft.statusCode, draft.body.slice(0, 300)).toBe(200);
      expect(JSON.stringify(draft.json()).length).toBeGreaterThan(50);
    }
  });
});
