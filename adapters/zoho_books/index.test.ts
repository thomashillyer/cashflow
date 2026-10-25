// Fake Zoho Books server shaped like the v3 REST API (from the public docs, not recorded from a live
// account). The probe against real data decides whether these shapes hold.
import { describe, expect, it } from "vitest";
import type { Fetch } from "../connector";
import { dedupeEvidence } from "../core/dedupe";
import { pullZoho, toMinor } from "./index";

const NOW = "2026-10-25T18:00:00Z";
const token = async () => "tok";

const invoices = [
  { invoice_id: "9001", invoice_number: "INV-1187", customer_id: "c1", customer_name: "Evergreen Home", date: "2026-10-10", due_date: "2026-11-10", total: 28000, balance: 28000, currency_code: "USD", status: "sent", invoice_url: "https://invoice.zoho.com/SecurePayment?CInvoiceID=abc" },
  { invoice_id: "9002", invoice_number: "INV-104", customer_id: "c2", customer_name: "Puget Market", date: "2026-08-30", due_date: "2026-09-30", total: 12000, balance: 0, currency_code: "USD", status: "paid" },
  { invoice_id: "9003", invoice_number: "INV-1190", customer_id: "c2", customer_name: "Puget Market", date: "2026-10-05", due_date: "2026-11-04", total: 6200.5, balance: 2200.5, currency_code: "USD", status: "partially_paid" },
  { invoice_id: "9004", invoice_number: "INV-1300", customer_id: "c2", customer_name: "Puget Market", date: "2026-10-06", due_date: "2026-11-05", currency_code: "USD", status: "sent" },
  { invoice_id: "9005", invoice_number: "INV-DRAFT", customer_id: "c2", customer_name: "Puget Market", total: 5, balance: 5, currency_code: "USD", status: "draft" },
  { invoice_id: "9006", invoice_number: "INV-1301", customer_id: "c1", customer_name: "Evergreen Home", date: "2026-10-06", total: 100, balance: 100, currency_code: "USD", status: "sent" },
];
const bills = [{ bill_id: "7001", bill_number: "BILL-0042", vendor_id: "v1", vendor_name: "Ningbo Supply", date: "2026-10-01", due_date: "2026-11-20", total: 15000, balance: 15000, currency_code: "USD", status: "open" }];
const customerpayments = [
  { payment_id: "p1", date: "2026-09-27", amount: 12000 },
  { payment_id: "p2", date: "2026-10-20", amount: 4000 },
];
const paymentDetail: Record<string, unknown> = {
  p1: { invoices: [{ invoice_id: "9002", invoice_number: "INV-104", amount_applied: 12000 }] },
  p2: { invoices: [{ invoice_id: "9003", invoice_number: "INV-1190", amount_applied: 4000 }, { invoice_id: "nope", invoice_number: "INV-X", amount_applied: 1 }] },
};

type Calls = { urls: string[]; methods: string[] };
function fakeZoho(over: { status?: number; orgs?: unknown[]; pages?: boolean; invoices?: unknown[] } = {}): { fetch: Fetch; calls: Calls } {
  const calls: Calls = { urls: [], methods: [] };
  const f: Fetch = async (url, init) => {
    calls.urls.push(url);
    calls.methods.push(init.method);
    if (over.status) return { status: over.status, json: async () => ({}) };
    const u = new URL(url);
    const path = u.pathname.replace("/books/v3/", "");
    const page = Number(u.searchParams.get("page") ?? 1);
    const ok = (body: unknown) => ({ status: 200, json: async () => body });
    if (path === "organizations") return ok({ organizations: over.orgs ?? [{ organization_id: "org1" }] });
    if (u.searchParams.get("organization_id") !== "org1") return { status: 400, json: async () => ({}) };
    if (path === "invoices") return ok({ invoices: over.pages ? [{ ...invoices[0], invoice_id: `x${page}`, invoice_number: `N${page}` }] : over.invoices ?? invoices, page_context: { has_more_page: !!over.pages } });
    if (path === "bills") return ok({ bills, page_context: { has_more_page: false } });
    if (path === "customerpayments") return ok({ customerpayments, page_context: { has_more_page: false } });
    if (path === "vendorpayments") return ok({ vendorpayments: [], page_context: { has_more_page: false } });
    const m = path.match(/^customerpayments\/(.+)$/);
    if (m) return ok({ payment: paymentDetail[m[1]!] });
    return { status: 404, json: async () => ({}) };
  };
  return { fetch: f, calls };
}

describe("toMinor", () => {
  it("converts decimals, honors currency digits, and never turns missing into zero", () => {
    expect(toMinor(6200.5, "USD")).toBe(620050);
    expect(toMinor("28,000", "USD")).toBeUndefined();
    expect(toMinor(1.15, "USD")).toBe(115);
    expect(toMinor(1200, "JPY")).toBe(1200);
    for (const bad of [undefined, null, "", "abc", NaN, true]) expect(toMinor(bad, "USD")).toBeUndefined();
    expect(toMinor(0, "USD")).toBe(0);
  });
});

describe("pullZoho", () => {
  it("maps invoices and bills to commitments with stable ids, amounts in minor units, and sources", async () => {
    const { fetch } = fakeZoho();
    const r = await pullZoho({ region: "com", token, now: NOW, fetch });
    if (!r.ok) throw new Error("expected ok");
    const c = Object.fromEntries(r.data.commitments.map((x) => [x.reference, x]));
    expect(c["INV-1187"]).toMatchObject({ id: "inv-INV-1187", type: "invoice", direction: "in", amount: 2800000, outstanding: 2800000, settlement: "open", status: "committed", anchors: { invoice: "2026-10-10", due: "2026-11-10" }, sourceRef: { system: "zoho_books", record: "9001" }, invoiceUrl: expect.stringContaining("invoice.zoho.com") });
    expect(c["INV-104"]).toMatchObject({ settlement: "paid", outstanding: 0 });
    expect(c["INV-1190"]).toMatchObject({ amount: 620050, outstanding: 220050, settlement: "partial" });
    expect(c["BILL-0042"]).toMatchObject({ id: "bill-BILL-0042", type: "bill", direction: "out", amount: 1500000 });
    expect(c["INV-DRAFT"]).toBeUndefined();
    expect(r.data.parties.map((p) => p.name).sort()).toEqual(["Evergreen Home", "Ningbo Supply", "Puget Market"]);
    expect(r.data.parties.find((p) => p.name === "Ningbo Supply")).toMatchObject({ kind: "supplier", sourceRefs: [{ system: "zoho_books", record: "v1" }] });
    for (const x of r.data.commitments) expect(x.evidenceIds).toHaveLength(1);
  });

  it("skips a document with no total instead of importing zero, and keeps a missing due date visible", async () => {
    const { fetch } = fakeZoho();
    const r = await pullZoho({ region: "com", token, now: NOW, fetch });
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.commitments.find((x) => x.reference === "INV-1300")).toBeUndefined();
    const codes = r.data.diagnostics.errors.map((e) => [e.code, e.message.includes("INV-1300") || e.message.includes("INV-1301")]);
    expect(codes).toContainEqual(["missing_amount", true]);
    expect(codes).toContainEqual(["missing_date", true]);
    const noDue = r.data.commitments.find((x) => x.reference === "INV-1301")!;
    expect(noDue.anchors.due).toBeUndefined();
    expect(r.data.diagnostics.warnings.join(" ")).toMatch(/1 draft document skipped/);
    for (const e of r.data.diagnostics.errors) expect(e.nextStep).not.toBe("");
  });

  it("turns payments into settlements and payment history for the lag model", async () => {
    const { fetch } = fakeZoho();
    const r = await pullZoho({ region: "com", token, now: NOW, fetch });
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.settlements).toEqual([
      expect.objectContaining({ id: "set-zoho-p1-inv-INV-104", commitmentId: "inv-INV-104", amount: 1200000, date: "2026-09-27", sourceRef: { system: "zoho_books", record: "p1" } }),
      expect.objectContaining({ id: "set-zoho-p2-inv-INV-1190", commitmentId: "inv-INV-1190", amount: 400000, date: "2026-10-20" }),
    ]);
    expect(r.data.paymentHistory).toEqual([expect.objectContaining({ invoiceId: "inv-INV-104", due: "2026-09-30", paid: "2026-09-27" })]);
  });

  it("a repeat pull is unchanged evidence, and an edited invoice supersedes", async () => {
    const first = await pullZoho({ region: "com", token, now: NOW, fetch: fakeZoho().fetch });
    if (!first.ok) throw new Error("expected ok");
    const again = await pullZoho({ region: "com", token, now: "2026-10-26T09:00:00Z", fetch: fakeZoho().fetch, existingEvidence: first.data.evidence });
    if (!again.ok) throw new Error("expected ok");
    expect(again.data.diagnostics.rowsDuplicate).toBe(again.data.commitments.length);
    expect(again.data.diagnostics.rowsImported).toBe(0);
    expect(dedupeEvidence(first.data.evidence, again.data.evidence).fresh).toEqual([]);
    // Same ids, so the store upserts and cash is unchanged.
    expect(again.data.commitments.map((x) => x.id)).toEqual(first.data.commitments.map((x) => x.id));

    const edited = invoices.map((i) => (i.invoice_id === "9001" ? { ...i, due_date: "2026-11-24" } : i));
    const changed = await pullZoho({ region: "com", token, now: "2026-10-27T09:00:00Z", fetch: fakeZoho({ invoices: edited }).fetch });
    if (!changed.ok) throw new Error("expected ok");
    const d = dedupeEvidence(first.data.evidence, changed.data.evidence);
    expect(d.superseded).toHaveLength(1);
    expect(d.superseded[0]!.next.sourceRef.record).toBe("9001");
  });

  it("only ever sends GET, to the fixed Zoho host for the chosen region", async () => {
    const { fetch, calls } = fakeZoho();
    await pullZoho({ region: "eu", token, now: NOW, fetch });
    expect(new Set(calls.methods)).toEqual(new Set(["GET"]));
    for (const u of calls.urls) expect(new URL(u).origin).toBe("https://www.zohoapis.eu");
    const bad = await pullZoho({ region: "evil.com/x" as never, token, now: NOW, fetch });
    expect(bad).toMatchObject({ ok: false, error: { kind: "config" } });
  });

  it.each([
    [401, "auth", /Reconnect Zoho Books/],
    [403, "auth", /allow read access/],
    [429, "rate_limit", /few minutes/],
    [500, "network", /upload an export/i],
  ])("status %s becomes a plain next step with the file fallback", async (status, kind, next) => {
    const r = await pullZoho({ region: "com", token, now: NOW, fetch: fakeZoho({ status }).fetch });
    expect(r).toMatchObject({ ok: false, error: { kind, fallback: "file" } });
    if (!r.ok) expect(r.error.nextStep).toMatch(next);
  });

  it("asks the owner to pick when the account has several organizations", async () => {
    const r = await pullZoho({ region: "com", token, now: NOW, fetch: fakeZoho({ orgs: [{ organization_id: "a" }, { organization_id: "b" }] }).fetch });
    expect(r).toMatchObject({ ok: false, error: { kind: "config" } });
    if (!r.ok) expect(r.error.nextStep).toMatch(/Pick which organization/);
  });

  it("a failing token provider and a network error do not throw", async () => {
    const t = await pullZoho({ region: "com", token: async () => { throw new Error("no token"); }, now: NOW, fetch: fakeZoho().fetch });
    expect(t.ok).toBe(false);
    const n = await pullZoho({ region: "com", token, now: NOW, fetch: async () => { throw new Error("ECONNRESET"); } });
    expect(n).toMatchObject({ ok: false, error: { kind: "network" } });
  });

  it("bounds paging and says when it stopped early", async () => {
    const r = await pullZoho({ region: "com", token, now: NOW, fetch: fakeZoho({ pages: true }).fetch });
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.commitments.filter((x) => x.type === "invoice")).toHaveLength(20);
    expect(r.data.diagnostics.warnings.join(" ")).toMatch(/Only the first 20 invoices were read/);
  });
});
