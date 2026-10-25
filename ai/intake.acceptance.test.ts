// Acceptance tests for the intake pipeline (P4.13): ingest() over the cascade_trade intake fixtures,
// in cache_only mode (committed Claude responses, no network), asserting every case in
// fixtures/expected/intake/cases.json and the sheet cases. The forecast checks run the real engine's
// expand() so "events added" means forecast cash events, not a proxy.

import type Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expand } from "../engine/expand";
import { horizonEnd } from "../engine/forecast";
import type { Profile } from "../schema/profile";
import type { ChangeProposal } from "../schema/intake";
import type { Commitment, Records } from "../schema/records";
import { DEFAULT_CACHE_DIR } from "./cache";
import { ingest, mergeEvidence, type IntakeContext, type IntakeInput, type IntakeResult } from "./intake";
import type { SheetContent } from "./extract/sheet";
import { ApplyError, applyProposal } from "./reconcile/apply";
import { poRemaining } from "./reconcile/match";
import { baseRecords, cashView } from "./reconcile/testkit";

const root = join(import.meta.dirname, "..");
const dir = join(root, "fixtures/cascade_trade/intake");
const bytes = (name: string) => new Uint8Array(readFileSync(join(dir, name)));
const text = (name: string) => readFileSync(join(dir, name), "utf8");
const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(root, path), "utf8")) as T;

type Case = { id: string; inputs: string[]; receivedAt?: string; expect: Record<string, any> };
const cases = readJson<{ cases: Case[] }>("fixtures/expected/intake/cases.json").cases;
const expectOf = (id: string) => cases.find((c) => c.id === id)!.expect;
const sheetCases = readJson<{ business: string; cases: { id: string; input: string; expect: Record<string, any> }[] }>(
  "fixtures/expected/intake/sheet-cases.json");

const NOW = "2026-11-28T18:00:00Z";
const BUSINESS = { name: "Cascade Trade Co.", aliases: ["Cascade Trade"] };
const meta = readJson<{ profile: string; asOf: string; fxRates: Record<string, number> }>("fixtures/cascade_trade/fixture.json");
const profile = readJson<Profile>(meta.profile);

const ctx = (records: Records, over: Partial<IntakeContext> = {}): IntakeContext => ({
  records, storeRevision: 1, business: BUSINESS, mode: "cache_only", now: NOW, cacheDir: DEFAULT_CACHE_DIR, ...over,
});
const pdf = (name: string): IntakeInput => ({ kind: "pdf", bytes: bytes(name), fileName: name });
const email = (name: string, attachments: string[] = []): IntakeInput => ({
  kind: "email", raw: text(name), attachments: attachments.map((a) => ({ fileName: a, bytes: bytes(a) })),
});
const whatsapp = (name: string): IntakeInput => ({ kind: "whatsapp", raw: text(name) });
const run = (input: IntakeInput, records: Records = baseRecords(), over: Partial<IntakeContext> = {}) =>
  ingest(input, ctx(records, over));

// The owner confirms every proposal that has something to apply; Evidence is stored with it.
function confirmAll(records: Records, result: IntakeResult): Records {
  let r = mergeEvidence(records, result.evidence);
  for (const p of result.proposals) if (p.ops.length > 0) r = applyProposal(r, p, { now: NOW }).records;
  return r;
}

const forecastEvents = (r: Records) => expand(r, profile, meta.asOf, horizonEnd(profile, meta.asOf), meta.fxRates).events;
const eventsAdded = (before: Records, after: Records) => forecastEvents(after).length - forecastEvents(before).length;
const byId = (r: Records, id: string) => r.commitments.find((c) => c.id === id)!;
const proposalFor = (result: IntakeResult, candidateKind: string) =>
  result.proposals.find((p) => result.candidates.find((c) => c.id === p.candidateId)?.kind === candidateKind)!;
// Money still expected in from open commitments. A PO counts only the part no invoice covers yet.
// (Not the engine: the trading profile has no customer-PO payment pattern yet, so expand() schedules
// nothing for an inbound PO; see the PR notes.)
const forecastableInflow = (r: Records) => r.commitments
  .filter((c) => (c.direction ?? (c.type === "invoice" ? "in" : "out")) === "in" && (c.settlement ?? "open") !== "paid" && c.settlement !== "cancelled")
  .reduce((sum, c) => sum + (c.type === "purchase_order" ? poRemaining(r, c.id) ?? 0 : c.outstanding ?? c.amount), 0);

// ---------------------------------------------------------------------------

describe("dup-pdf: a PDF of an invoice already in the books", () => {
  const e = expectOf("dup-pdf");
  it("links to the existing invoice and changes no forecast-relevant field", async () => {
    const before = baseRecords();
    const result = await run(pdf("inv1187.pdf"), before);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ kind: e.kind, direction: e.direction, partyId: "party-evergreen-home" });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ action: e.action, targetCommitmentId: e.target, state: "proposed", expectedStoreRevision: 1 });
    expect(result.signals).toEqual([]);

    const after = confirmAll(before, result);
    expect(after.commitments).toHaveLength(before.commitments.length);
    expect(cashView(after)).toEqual(cashView(before));
    expect(byId(after, e.target).evidenceIds).toContain(result.evidence[0]!.id);
    expect(eventsAdded(before, after)).toBe(e.eventsAdded);
  });
});

describe("dup-email-bundle: an email whose PDF attachment is the same invoice", () => {
  const e = expectOf("dup-email-bundle");
  it("carries the PDF as the candidate, keeps every child as evidence, and adds no cash", async () => {
    const before = baseRecords();
    const result = await run(email("email-inv1187.eml", ["inv1187.pdf"]), before);

    // The attachment is the candidate; the covering email is not a second commitment.
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ kind: e.kind, direction: e.direction });
    expect(result.candidates[0]!.fields.reference).toMatchObject({ state: "found", value: "INV-1187" });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ action: e.action, targetCommitmentId: e.target });

    // Evidence children: the attachment, and each distinct URL once.
    const parent = result.evidence.find((x) => x.format === "eml")!;
    const children = result.evidence.filter((x) => x.parentId === parent.id);
    expect(children.filter((c) => c.format === "pdf")).toHaveLength(1);
    expect(children.find((c) => c.format === "pdf")).toMatchObject({ fileName: "inv1187.pdf", extraction: "ok" });
    const urls = children.filter((c) => c.channel === "url").map((c) => c.url);
    expect(urls).toEqual([
      "https://books.zoho.example/portal/cascadetrade/invoice/2-INV-1187",   // invoiceUrl
      "https://checkout.stripe.example/c/pay/cs_live_inv1187_cascade",       // paymentUrl
    ]);
    expect(new Set(result.evidence.map((x) => x.id)).size).toBe(result.evidence.length);
    expect(result.proposals[0]!.evidenceIds).toEqual(expect.arrayContaining(children.map((c) => c.id)));
    expect(result.proposals[0]!.evidenceIds).toContain(parent.id);

    const after = confirmAll(before, result);
    expect(after.commitments).toHaveLength(before.commitments.length);
    expect(byId(after, e.target).evidenceIds).toEqual(expect.arrayContaining([parent.id, ...children.map((c) => c.id)]));
    expect(byId(after, e.target).settlement).toBe(e.settlement);
    expect(cashView(after)).toEqual(cashView(before));
    expect(eventsAdded(before, after)).toBe(e.eventsAdded);
  });

  it("the URL in the email never overrides the attachment's reference", async () => {
    // The email's link path says 2-INV-1187; here it says something else entirely.
    const raw = text("email-inv1187.eml").replaceAll("2-INV-1187", "2-INV-9999");
    const result = await run({ kind: "email", raw, attachments: [{ fileName: "inv1187.pdf", bytes: bytes("inv1187.pdf") }] });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.fields.reference).toMatchObject({ state: "found", value: "INV-1187" });
    expect(result.proposals[0]).toMatchObject({ action: "link", targetCommitmentId: "inv-INV-1187" });
  });
});

describe("whatsapp-promise: a customer's promise in a chat", () => {
  const e = expectOf("whatsapp-promise");
  it("proposes a date change the owner must complete, and nothing else", async () => {
    const before = baseRecords();
    const snapshot = JSON.stringify(before);
    const result = await run(whatsapp("whatsapp-evergreen.txt"), before);
    expect(JSON.stringify(before)).toBe(snapshot); // ingest never mutates the store

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ kind: e.kind });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ action: e.action, targetCommitmentId: e.target });
    // A promise is not a document: the only op is attaching the chat as evidence.
    expect(result.proposals[0]!.ops.map((o) => o.op)).toEqual(["linkEvidence"]);

    expect(result.signals).toHaveLength(1);
    const s = result.signals[0]!;
    expect(s).toMatchObject({ channel: "whatsapp", commitmentId: e.target, state: "proposed", claim: { kind: e.signal.kind } });
    expect(s.sourceRef.excerpt?.text).toContain(e.signal.resolvedFrom);
    // Conditional on the customer's own payment, so the owner supplies the date.
    const notes = result.notes.filter((n) => n.scope === s.id).map((n) => n.text.toLowerCase());
    expect(e.signal.requiresOwnerDate).toBe(true);
    expect(notes.some((n) => n.includes("owner must confirm the date"))).toBe(true);
    expect(notes.some((n) => n.includes("conditional"))).toBe(true);

    const after = confirmAll(before, result);
    expect(byId(after, e.target).settlement).toBe(e.settlement);
    expect(cashView(after)).toEqual(cashView(before));
    expect(eventsAdded(before, after)).toBe(e.eventsAdded);
  });
});

describe("owner-date-change: the owner pastes what a customer said", () => {
  const c = cases.find((x) => x.id === "owner-date-change")!;
  const e = c.expect;
  it("proposes the new date on the named invoice and leaves settlement open", async () => {
    const before = baseRecords();
    const result = await run({ kind: "paste", text: text(c.inputs[0]!), receivedAt: c.receivedAt! }, before);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({
      channel: "owner", commitmentId: e.target, state: "proposed", claim: { kind: e.signal.kind, newDate: e.signal.newDate },
    });
    expect(result.signals[0]!.sourceRef.excerpt?.text).toContain("November 3");
    // The message rides with a review item that only attaches it as evidence; nothing is a document change.
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ action: e.action, targetCommitmentId: e.target });

    const after = confirmAll(before, result);
    expect(byId(after, e.target).settlement).toBe(e.settlement);
    expect(byId(after, e.target).anchors.due).toBe("2026-10-30"); // the date moves only when the owner applies the signal
    expect(cashView(after)).toEqual(cashView(before));
    expect(eventsAdded(before, after)).toBe(e.eventsAdded);
  });
});

describe("all-four-sources: Zoho, PDF, email, and chat for one invoice", () => {
  const e = expectOf("all-four-sources");
  it("ends as one commitment with every source linked and no new cash", async () => {
    const before = baseRecords();
    let r = before;
    const emailResult = await run(email("email-inv1187.eml", ["inv1187.pdf"]), r, { storeRevision: 1 });
    r = confirmAll(r, emailResult);
    const chatResult = await run(whatsapp("whatsapp-evergreen.txt"), r, { storeRevision: 2 });
    r = confirmAll(r, chatResult);

    expect(r.commitments.filter((c) => c.reference === "INV-1187")).toHaveLength(e.commitments);
    expect(r.commitments).toHaveLength(before.commitments.length);
    const inv = byId(r, e.target);
    expect(inv.evidenceIds!.length).toBeGreaterThanOrEqual(4);
    const evidence = (id: string) => r.evidence.find((x) => x.id === id)!;
    const kinds = inv.evidenceIds!.map((id) => evidence(id)).map((x) => `${x.channel}/${x.format}`);
    expect(kinds).toEqual(expect.arrayContaining(["zoho_books/api", "email/pdf", "email/eml", "whatsapp/text"]));
    expect(cashView(r)).toEqual(cashView(before));
    expect(inv.settlement).toBe("open");
    expect(eventsAdded(before, r)).toBe(e.eventsAdded);
  });
});

describe("conflicts stay unresolved", () => {
  it.each(["conflict-currency", "conflict-total"])("%s: a conflict proposal that cannot be applied", async (id) => {
    const e = expectOf(id);
    const c = cases.find((x) => x.id === id)!;
    const before = baseRecords();
    const result = await run(pdf(c.inputs[0]!), before);
    expect(result.candidates[0]).toMatchObject({ kind: e.kind });
    expect(result.proposals).toHaveLength(1);
    const p = result.proposals[0]!;
    expect(p).toMatchObject({ action: e.action, targetCommitmentId: e.target, ops: [] });
    expect(p.conflicts.map((x) => x.field)).toEqual(e.conflictFields);
    // Both values shown, each with a source.
    for (const field of p.conflicts) {
      expect(field.values).toHaveLength(2);
      expect(field.values.every((v) => v.evidence.length > 0)).toBe(true);
    }
    expect(() => applyProposal(before, p, { now: NOW })).toThrow(ApplyError);
    expect(() => confirmAll(before, result)).not.toThrow();
    expect(cashView(confirmAll(before, result))).toEqual(cashView(before));
    expect(eventsAdded(before, confirmAll(before, result))).toBe(e.eventsAdded);
  });

  it("conflict-currency shows USD against CAD, conflict-total 28,000.00 against 29,500.00", async () => {
    const cad = (await run(pdf("inv1187-cad.pdf"))).proposals[0]!;
    expect(cad.conflicts[0]!.values.map((v) => v.value)).toEqual(["USD", "CAD"]);
    const total = (await run(pdf("inv1187-revised-total.pdf"))).proposals[0]!;
    expect(total.conflicts[0]!.values.map((v) => v.value)).toEqual([2800000, 2950000]);
  });
});

describe("same-number-other-vendor: a bill numbered like an existing one", () => {
  const e = expectOf("same-number-other-vendor");
  it("creates a bill for the other supplier and never links to bill-SC-0042", async () => {
    const before = baseRecords();
    const result = await run(pdf("ningbo-bill-0042.pdf"), before);
    expect(result.candidates[0]).toMatchObject({ kind: e.kind, direction: e.direction, partyId: e.party });
    const p = result.proposals[0]!;
    expect(p.action).toBe(e.action);
    expect(p.targetCommitmentId).not.toBe(e.notTarget);
    expect(p.ops.some((o) => o.op === "linkEvidence" && o.commitmentId === e.notTarget)).toBe(false);

    const after = confirmAll(before, result);
    expect(after.commitments).toHaveLength(before.commitments.length + 1);
    const created = after.commitments.find((c) => !before.commitments.some((b) => b.id === c.id))!;
    expect(created).toMatchObject({ type: "bill", direction: "out", partyId: e.party, reference: "0042", amount: 620000, currency: "USD" });
    expect(byId(after, e.notTarget)).toEqual(byId(before, e.notTarget));
    expect(created.evidenceIds).toEqual(result.candidates[0]!.evidenceIds);
  });
});

describe("purchase orders", () => {
  it("po-accepted: creates a likely purchase order for 1,000,000", async () => {
    const e = expectOf("po-accepted");
    const before = baseRecords();
    const result = await run(pdf("harbor-po-552.pdf"), before);
    expect(result.candidates[0]).toMatchObject({ kind: e.kind, direction: e.direction, partyId: "party-harbor-hearth" });
    const p = result.proposals[0]!;
    expect(p.action).toBe(e.action);
    const op = p.ops.find((o) => o.op === "createCommitment");
    expect(op && op.op === "createCommitment" && op.draft).toMatchObject({
      type: "purchase_order", direction: "in", status: e.status, amount: e.amount, reference: "HH-PO-552",
    });
    const after = confirmAll(before, result);
    expect(after.commitments.find((c) => c.type === "purchase_order")).toMatchObject({ status: "likely", amount: 1000000, outstanding: 1000000 });
  });

  it("po-partial-invoice: the PO's remainder plus the invoice is 1,000,000 of inflow, never 1,400,000", async () => {
    const e = expectOf("po-partial-invoice");
    const before = baseRecords();
    const poResult = await run(pdf("harbor-po-552.pdf"), before);
    let r = confirmAll(before, poResult);
    const po = r.commitments.find((c) => c.type === "purchase_order")!;
    expect(poRemaining(r, po.id)).toBe(1000000);

    const invResult = await run(email("email-harbor-inv1203.eml"), r, { storeRevision: 2 });
    expect(invResult.candidates[0]).toMatchObject({ kind: "invoice", partyId: "party-harbor-hearth" });
    expect(invResult.candidates[0]!.fields.poReference).toMatchObject({ state: "found", value: e.invoice.linkedPo });
    const p = invResult.proposals[0]!;
    expect(p.action).toBe("create");
    expect(p.ops.find((o) => o.op === "linkCommitments")).toMatchObject({ toId: po.id, allocated: e.invoice.amount });
    r = confirmAll(r, invResult);

    const invoice = r.commitments.find((c) => c.reference === "INV-1203")!;
    expect(invoice).toMatchObject({ type: "invoice", amount: e.invoice.amount, outstanding: e.invoice.amount });
    expect(poRemaining(r, po.id)).toBe(e.poRemaining);
    expect(byId(r, po.id).outstanding).toBe(e.poRemaining);

    const newInflow = forecastableInflow(r) - forecastableInflow(before);
    expect(newInflow).toBe(e.totalForecastIn);
    expect(newInflow).not.toBe(1400000);
  });
});

describe("unreadable input", () => {
  it("unreadable-scan: evidence and a review item that says what to upload, never a zero amount", async () => {
    const e = expectOf("unreadable-scan");
    const before = baseRecords();
    const result = await run(pdf("scanned-bill.pdf"), before);
    expect(result.evidence[0]).toMatchObject({ format: "pdf", extraction: e.extraction });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ action: e.action, ops: [] });
    for (const c of result.candidates) {
      expect(c.extraction).toBe(e.extraction);
      expect(c.fields.amount.state).toBe("missing");
    }
    expect(e.noZeroAmount).toBe(true);
    expect(result.notes.some((n) => /upload a text pdf/i.test(n.text))).toBe(true);
    expect(() => applyProposal(before, result.proposals[0]!, { now: NOW })).toThrow(ApplyError);
    expect(eventsAdded(before, confirmAll(before, result))).toBe(e.eventsAdded);
  });

  it("an oversized or broken PDF becomes unreadable evidence plus a review item, and never throws", async () => {
    for (const data of [new Uint8Array(6 * 1024 * 1024), new Uint8Array([37, 80, 68, 70, 45, 1, 2, 3]), new Uint8Array(0)]) {
      const result = await run({ kind: "pdf", bytes: data, fileName: "big.pdf" });
      expect(result.evidence[0]).toMatchObject({ extraction: "unreadable" });
      expect(result.candidates.every((c) => c.fields.amount.state === "missing")).toBe(true);
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0]!.action).toBe("review");
      expect(result.notes.length).toBeGreaterThan(0);
    }
  });

  it("an attachment that cannot be read is evidence plus a review item that says what to upload", async () => {
    const result = await run({
      kind: "email", raw: text("email-inv1187.eml"),
      attachments: [{ fileName: "inv1187.pdf", bytes: bytes("scanned-bill.pdf") }],
    });
    const att = result.evidence.find((x) => x.format === "pdf")!;
    expect(att).toMatchObject({ extraction: "unreadable", parentId: expect.any(String) });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ action: "review", ops: [] });
    expect(result.candidates[0]!.fields.amount.state).toBe("missing");
  });

  it("an attachment named in the email but not provided asks the owner to upload it", async () => {
    const result = await run({ kind: "email", raw: text("email-inv1187.eml") });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.kind).toBe("none");
    expect(result.proposals[0]).toMatchObject({ action: "review", ops: [] });
    expect(result.notes.some((n) => /inv1187\.pdf.*not provided.*upload/i.test(n.text))).toBe(true);
  });

  it("an XLSX attachment whose cells were not read, and an image, are not guessed at", async () => {
    const result = await run({
      kind: "email", raw: "From: a@b.example\nSubject: files\nDate: Thu, 26 Nov 2026 16:42:10 -0800\n\nSee attached.\n",
      attachments: [
        { fileName: "ar.xlsx", bytes: new Uint8Array([80, 75, 3, 4]) },
        { fileName: "scan.png", bytes: new Uint8Array([137, 80, 78, 71]) },
      ],
    });
    expect(result.evidence.filter((x) => x.parentId).map((x) => [x.format, x.extraction]).sort()).toEqual([["image", "unsupported"], ["xlsx", "unsupported"]]);
    expect(result.proposals.map((p) => p.action)).toEqual(["review", "review"]);
    expect(result.candidates.every((c) => c.fields.amount.state === "missing")).toBe(true);
  });
});

describe("injection: a message that talks to the assistant", () => {
  const e = expectOf("injection");
  it("changes nothing: no signal, no applicable proposal, settlement and outstanding unchanged", async () => {
    const before = baseRecords();
    const result = await run(email("email-injection.eml"), before);
    expect(result.signals).toEqual([]);
    expect(e.kindIn).toContain(result.candidates[0]!.kind);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ action: e.action, ops: [] });
    expect(() => applyProposal(before, result.proposals[0]!, { now: NOW })).toThrow(ApplyError);

    const after = confirmAll(before, result);
    expect(cashView(after)).toEqual(cashView(before));
    for (const c of after.commitments) {
      const was = byId(before, c.id);
      expect(c.settlement).toBe(was.settlement ?? c.settlement);
      expect(c.outstanding).toBe(was.outstanding);
    }
    expect(byId(after, "inv-INV-1187")).toMatchObject({ settlement: e.settlement, outstanding: 2800000 });
    expect(after.settlements).toEqual([]);
    expect(eventsAdded(before, after)).toBe(e.eventsAdded);
    expect(result.notes.some((n) => /instructions/i.test(n.text))).toBe(true);
  });
});

describe("idempotent re-import", () => {
  const inputs: [string, () => IntakeInput][] = [
    ["a PDF", () => pdf("inv1187.pdf")],
    ["an email with its attachment", () => email("email-inv1187.eml", ["inv1187.pdf"])],
    ["a chat", () => whatsapp("whatsapp-evergreen.txt")],
    ["an owner note", () => ({ kind: "paste", text: text("owner-message-inv104.txt"), receivedAt: "2026-10-25T16:00:00Z" })],
    ["a new bill", () => pdf("ningbo-bill-0042.pdf")],
    ["a sheet", () => ({ kind: "sheet", sheets: [readJson<SheetContent>("fixtures/cascade_trade/intake/sheets/ar-aging-table.json")] })],
  ];

  it.each(inputs)("ingesting %s twice yields identical evidence, candidate, proposal, and signal ids", async (_n, make) => {
    const a = await run(make());
    const b = await run(make());
    expect(b).toEqual(a);
    expect(a.proposals.length).toBeGreaterThan(0);
  });

  it("the same bytes get the same ids whether uploaded alone or attached to an email", async () => {
    const alone = await run(pdf("inv1187.pdf"));
    const attached = await run(email("email-inv1187.eml", ["inv1187.pdf"]));
    expect(attached.candidates[0]!.id).toBe(alone.candidates[0]!.id);
    expect(attached.evidence.find((e) => e.format === "pdf")!.id).toBe(alone.evidence[0]!.id);
  });

  it("applying a proposal twice changes nothing the second time", async () => {
    for (const make of [() => pdf("inv1187.pdf"), () => pdf("ningbo-bill-0042.pdf"), () => pdf("harbor-po-552.pdf"), () => email("email-inv1187.eml", ["inv1187.pdf"])]) {
      const result = await run(make());
      const once = confirmAll(baseRecords(), result);
      const twice = confirmAll(once, result);
      expect(twice).toEqual(once);
    }
  });

  it("re-importing after confirming proposes the same link with nothing new to attach", async () => {
    const first = await run(email("email-inv1187.eml", ["inv1187.pdf"]));
    const stored = confirmAll(baseRecords(), first);
    const again = await run(email("email-inv1187.eml", ["inv1187.pdf"]), stored, { storeRevision: 2 });
    expect(again.proposals[0]).toMatchObject({ id: first.proposals[0]!.id, action: "link", targetCommitmentId: "inv-INV-1187" });
    expect(again.proposals[0]!.ops).toEqual([]);
    expect(confirmAll(stored, again)).toEqual(stored);
  });
});

describe("sheets flow through ingest", () => {
  const load = (name: string) => readJson<SheetContent>(`fixtures/cascade_trade/intake/sheets/${name}`);
  const sheetCase = (id: string) => sheetCases.cases.find((c) => c.id === id)!;

  it("ar-aging-table: one candidate and proposal per invoice row, linked or created by reference", async () => {
    const e = sheetCase("ar-aging-table").expect;
    const before = baseRecords();
    const result = await run({ kind: "sheet", sheets: [load("ar-aging-table.json")] }, before);
    expect(result.candidates).toHaveLength(e.candidates);
    expect(result.proposals).toHaveLength(e.candidates);
    expect(result.notes.some((n) => /row 10.*totals/i.test(n.text))).toBe(true);
    for (const [ref, want] of Object.entries(e.byReference) as [string, any][]) {
      const c = result.candidates.find((x) => x.fields.reference.state === "found" && x.fields.reference.value === ref)!;
      expect(c.fields.amount).toMatchObject({ state: "found", value: want.amount });
      expect(c.fields.dueDate).toMatchObject({ state: "found", value: want.dueDate });
    }
    const actions = Object.fromEntries(result.proposals.map((p) => {
      const c = result.candidates.find((x) => x.id === p.candidateId)!;
      return [(c.fields.reference as { value: string }).value, p.action];
    }));
    expect(actions).toEqual({ "INV-1187": "link", "INV-104": "link", "INV-1203": "create", "INV-1190": "create" });

    const after = confirmAll(before, result);
    expect(after.commitments).toHaveLength(before.commitments.length + 2); // INV-1203 and INV-1190
    expect(cashView(after).filter((c) => before.commitments.some((b) => b.id === c.id))).toEqual(cashView(before));
  });

  it("single-invoice: one document candidate that creates the invoice and names its PO", async () => {
    const e = sheetCase("single-invoice").expect;
    const result = await run({ kind: "sheet", sheets: [load("single-invoice.json")] });
    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0]!;
    expect(c).toMatchObject({ kind: e.kind, direction: e.direction, partyId: "party-harbor-hearth" });
    expect(c.fields.reference).toMatchObject({ value: e.reference });
    expect(c.fields.amount).toMatchObject({ value: e.amount });
    expect(c.fields.poReference).toMatchObject({ value: e.poReference });
    expect(result.proposals[0]!.action).toBe("create");
  });

  it("messy: nothing is invented; a review item says to map the columns", async () => {
    const e = sheetCase("messy").expect;
    const result = await run({ kind: "sheet", sheets: [load("messy.json")] });
    expect(e.candidates).toBe(0);
    expect(result.candidates.every((c) => c.kind === "none" && c.fields.amount.state === "missing")).toBe(true);
    expect(result.proposals.map((p) => p.action)).toEqual(["review"]);
    expect(result.notes.some((n) => /column mapping/i.test(n.text))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bundle assembly rules that the committed cache cannot show. A stand-in client plays the model, so
// these run in live mode without a network; the temp directory keeps the committed cache untouched.

type Call = { kind: "document" | "signal"; content: string };

function fakeClient(document: object): { client: Anthropic; calls: Call[] } {
  const calls: Call[] = [];
  const none = { claim: "none", reference: null, partyName: null, amountMentioned: null, newDatePhrase: null, newAmount: null, dependsOn: null, containsInstructions: false, confidence: 0.9 };
  const client = {
    messages: {
      create: async (req: { messages: { content: string }[] }) => {
        const content = req.messages[0]!.content;
        const isDoc = content.includes("<document");
        calls.push({ kind: isDoc ? "document" : "signal", content });
        return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(isDoc ? document : none) }] };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const NULL = { value: null, quote: null };
const q = (value: string, quote: string = value) => ({ value, quote });
const invoiceOutput = (fields: Record<string, unknown>) => ({
  kind: "invoice", businessRole: "seller", containsInstructions: false, confidence: 0.9, notes: [], coversReferences: [],
  fields: {
    sellerName: NULL, buyerName: NULL, reference: NULL, poReference: NULL, amount: NULL, outstanding: NULL, currency: NULL,
    issueDate: NULL, dueDate: NULL, terms: NULL, invoiceUrl: NULL, paymentUrl: NULL, statedStatus: NULL, paidAmount: NULL, paidDate: NULL,
    ...fields,
  },
});
const live = () => ({ mode: "live" as const, cacheDir: mkdtempSync(join(tmpdir(), "neri-intake-")) });
const EMAIL_HEAD = "From: Dana Whitfield <accounts@evergreenhome.example>\nTo: billing@cascadetrade.example\nSubject: Invoice\nDate: Thu, 26 Nov 2026 16:42:10 -0800\nMessage-ID: <t-1@evergreenhome.example>\n";

describe("bundle assembly rules", () => {
  it("a covering email with an attachment is never extracted as a commitment", async () => {
    const { client, calls } = fakeClient(invoiceOutput({
      reference: q("INV-1187", "INVOICE INV-1187"), amount: q("28,000.00", "TOTAL DUE (USD) 28,000.00"), currency: q("USD", "TOTAL DUE (USD)"),
      buyerName: q("Evergreen Home LLC", "Bill to: Evergreen Home LLC"),
    }));
    const raw = `${EMAIL_HEAD}X-Attachments: inv1187.pdf\n\nInvoice INV-1187 for USD 28,000.00 is attached.\n`;
    const result = await run({ kind: "email", raw, attachments: [{ fileName: "inv1187.pdf", bytes: bytes("inv1187.pdf") }] },
      baseRecords(), { ...live(), client });
    expect(calls.filter((c) => c.kind === "document")).toHaveLength(1);       // the PDF only
    expect(calls.find((c) => c.kind === "document")!.content).toContain("TOTAL DUE (USD)");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.evidenceIds[0]).toBe(result.evidence.find((e) => e.format === "pdf")!.id);
    expect(result.proposals[0]).toMatchObject({ action: "link", targetCommitmentId: "inv-INV-1187" });
  });

  it("a message with no attachment states the document itself or it is only a review item", async () => {
    // Reference only inside a link path.
    const urlOnly = fakeClient(invoiceOutput({
      reference: q("INV-9999", "https://books.example/portal/invoice/INV-9999"), amount: q("500.00", "Total USD 500.00"), currency: q("USD", "Total USD 500.00"),
      buyerName: q("Evergreen Home LLC", "Evergreen Home LLC"),
    }));
    const raw = `${EMAIL_HEAD}\nEvergreen Home LLC\nTotal USD 500.00\nView invoice: https://books.example/portal/invoice/INV-9999\n`;
    const r1 = await run({ kind: "email", raw }, baseRecords(), { ...live(), client: urlOnly.client });
    expect(r1.candidates[0]).toMatchObject({ kind: "none", extraction: "partial" });
    expect(r1.candidates[0]!.fields.reference.state).toBe("missing");
    expect(r1.proposals[0]).toMatchObject({ action: "review", ops: [] });

    // Reference and amount written in the body.
    const stated = fakeClient(invoiceOutput({
      reference: q("INV-9999", "Invoice: INV-9999"), amount: q("500.00", "Total USD 500.00"), currency: q("USD", "Total USD 500.00"),
      buyerName: q("Evergreen Home LLC", "Evergreen Home LLC"),
    }));
    const raw2 = `${EMAIL_HEAD}\nEvergreen Home LLC\nInvoice: INV-9999\nTotal USD 500.00\n`;
    const r2 = await run({ kind: "email", raw: raw2 }, baseRecords(), { ...live(), client: stated.client });
    expect(r2.candidates[0]).toMatchObject({ kind: "invoice", partyId: "party-evergreen-home" });
    expect(r2.proposals[0]).toMatchObject({ action: "create" });
  });

  it("dedupes link children by URL and fills the attachment's fields only where it states none", async () => {
    const link = "https://pay.example/inv/123";
    const raw = `${EMAIL_HEAD}X-Attachments: ningbo.pdf\n\nView invoice: ${link}\nPay now: ${link}\nAgain: ${link}\n`;
    const result = await run({ kind: "email", raw, attachments: [{ fileName: "ningbo.pdf", bytes: bytes("ningbo-bill-0042.pdf") }] });
    expect(result.evidence.filter((e) => e.channel === "url")).toHaveLength(1);
    const c = result.candidates[0]!;
    // The strongest label wins: the one URL is the payment link, so it is not also an invoice link.
    expect(c.fields.paymentUrl).toMatchObject({ state: "found", value: link });
    expect(c.fields.invoiceUrl).toBeUndefined();
    expect(result.evidence.find((e) => e.url === link)!.id).toMatch(/#url-1$/);
  });

  it("a payment URL is never read as payment", async () => {
    const result = await run(email("email-inv1187.eml", ["inv1187.pdf"]));
    const ops = result.proposals.flatMap((p) => p.ops.map((o) => o.op));
    expect(ops).not.toContain("createSettlement");
    expect(confirmAll(baseRecords(), result).settlements).toEqual([]);
  });

  it("caller-supplied ids and times are used as given", async () => {
    const result = await run({
      kind: "pdf", bytes: bytes("inv1187.pdf"), fileName: "inv1187.pdf",
      source: { evidenceId: "ev-niru-42", receivedAt: "2026-11-27T09:00:00Z", sourceRef: { system: "generic_file", record: "upload-42" } },
    });
    expect(result.evidence[0]).toMatchObject({ id: "ev-niru-42", receivedAt: "2026-11-27T09:00:00Z", sourceRef: { system: "generic_file", record: "upload-42" } });
    expect(result.candidates[0]!.evidenceIds).toEqual(["ev-niru-42"]);
  });

  it("a message claiming a payment is a review item, never a settlement proposal", async () => {
    const output = {
      kind: "payment_evidence", businessRole: "seller", containsInstructions: false, confidence: 0.9, notes: [],
      coversReferences: ["INV-1187"],
      fields: {
        sellerName: NULL, buyerName: NULL, reference: NULL, poReference: NULL, amount: NULL, outstanding: NULL,
        currency: q("USD", "USD 28,000.00"), issueDate: NULL, dueDate: NULL, terms: NULL, invoiceUrl: NULL, paymentUrl: NULL,
        statedStatus: NULL, paidAmount: q("28,000.00", "USD 28,000.00"), paidDate: q("November 20, 2026", "on November 20, 2026"),
      },
    };
    const raw = `${EMAIL_HEAD}\nWe paid INV-1187, USD 28,000.00 on November 20, 2026.\n`;
    const result = await run({ kind: "email", raw }, baseRecords(), { ...live(), client: fakeClient(output).client });
    expect(result.proposals.flatMap((p) => p.ops.map((o) => o.op))).not.toContain("createSettlement");
    expect(result.proposals[0]).toMatchObject({ action: "review" });
    expect(result.notes.some((n) => /not a remittance/i.test(n.text))).toBe(true);
  });

  it("ids differ for the same pasted words received at different times", async () => {
    const a = await run({ kind: "paste", text: "Evergreen will pay next Friday", receivedAt: "2026-11-02T10:00:00Z" });
    const b = await run({ kind: "paste", text: "Evergreen will pay next Friday", receivedAt: "2026-11-09T10:00:00Z" });
    expect(a.evidence[0]!.id).not.toBe(b.evidence[0]!.id);
  });

  it("a message over the size limit is a review item with a note, not a partial read", async () => {
    const result = await run({ kind: "paste", text: "x ".repeat(30_000), receivedAt: NOW });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ action: "review", ops: [] });
    expect(result.notes.some((n) => /split it/i.test(n.text))).toBe(true);
  });

  it("every sheet of a workbook is read, whatever the sheets are called", async () => {
    const one = readJson<SheetContent>("fixtures/cascade_trade/intake/sheets/single-invoice.json");
    const result = await run({ kind: "sheet", sheets: [{ ...one, sheet: "一月" }, { ...one, sheet: "二月" }] });
    expect(result.candidates).toHaveLength(2);
    expect(new Set(result.candidates.map((c) => c.id)).size).toBe(2);
  });

  it("never throws on bad input and says what to do", async () => {
    for (const input of [
      { kind: "email", raw: "" }, { kind: "whatsapp", raw: "no chat lines here" }, { kind: "paste", text: "   ", receivedAt: NOW },
      { kind: "sheet", sheets: [] }, { kind: "sheet", sheets: [{ evidenceId: "e", sheet: "S", rows: [] }] },
      { kind: "nonsense" }, { kind: "pdf", bytes: "not bytes" },
    ] as unknown as IntakeInput[]) {
      const result = await run(input);
      expect(result.proposals.every((p) => p.ops.length === 0 || p.action !== "create")).toBe(true);
      expect(result.candidates.every((c) => c.fields.amount.state !== "found")).toBe(true);
    }
  });
});

describe("what a proposal can do", () => {
  it("nothing in any fixture's result applies a settlement, cancels, or changes an amount unprompted", async () => {
    const all: IntakeInput[] = [
      pdf("inv1187.pdf"), pdf("inv1187-cad.pdf"), pdf("inv1187-revised-total.pdf"), pdf("ningbo-bill-0042.pdf"), pdf("harbor-po-552.pdf"),
      pdf("scanned-bill.pdf"), email("email-inv1187.eml", ["inv1187.pdf"]), email("email-harbor-inv1203.eml"), email("email-injection.eml"),
      whatsapp("whatsapp-evergreen.txt"),
    ];
    for (const input of all) {
      const result = await run(input);
      for (const p of result.proposals as ChangeProposal[]) {
        expect(p.state).toBe("proposed");
        // The store refuses to confirm review/conflict items (PROPOSAL_UNRESOLVED), so they must carry no ops.
        if (p.action === "review" || p.action === "conflict") expect(p.ops).toEqual([]);
        for (const op of p.ops) {
          expect(op.op).not.toBe("createSettlement");
          if (op.op === "updateCommitment") expect(["amount", "outstanding", "currency"]).not.toContain(op.change.field);
        }
      }
      expect(result.signals.every((s) => s.state === "proposed")).toBe(true);
    }
    const c: Commitment[] = baseRecords().commitments;
    expect(c.every((x) => x.settlement === "open")).toBe(true);
  });
});
