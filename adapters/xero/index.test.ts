// Fake Xero accounting API shaped from the public docs, not a live organisation.
import { describe, expect, it } from "vitest";
import type { Fetch } from "../connector";
import { dedupeEvidence } from "../core/dedupe";
import { pullXero, xeroDate } from "./index";

const NOW = "2026-10-25T18:00:00Z";
const token = async () => "tok";
const inv = (over: Record<string, unknown>) => ({
  InvoiceID: "i1", InvoiceNumber: "INV-1187", Type: "ACCREC", Contact: { ContactID: "c1", Name: "Evergreen Home" },
  DateString: "2026-10-10T00:00:00", DueDateString: "2026-11-10T00:00:00", Total: 28000, AmountDue: 28000, CurrencyCode: "USD", Status: "AUTHORISED", Payments: [], ...over,
});
const invoices = [
  inv({}),
  inv({ InvoiceID: "i2", InvoiceNumber: "INV-104", Contact: { ContactID: "c2", Name: "Puget Market" }, DueDateString: "2026-09-30T00:00:00", Total: 12000, AmountDue: 0, Status: "PAID", Payments: [{ PaymentID: "p1", Date: "/Date(1790467200000+0000)/", Amount: 12000 }] }),
  inv({ InvoiceID: "i3", InvoiceNumber: "INV-1190", Contact: { ContactID: "c2", Name: "Puget Market" }, Total: 6200.5, AmountDue: 2200.5, Payments: [{ PaymentID: "p2", DateString: "2026-10-20T00:00:00", Amount: 4000 }] }),
  inv({ InvoiceID: "b1", InvoiceNumber: "BILL-42", Type: "ACCPAY", Contact: { ContactID: "v1", Name: "Ningbo Supply" }, Total: 15000, AmountDue: 15000 }),
  inv({ InvoiceID: "d1", InvoiceNumber: "INV-DRAFT", Status: "DRAFT" }),
  inv({ InvoiceID: "v2", InvoiceNumber: "INV-VOID", Status: "VOIDED" }),
  inv({ InvoiceID: "n1", InvoiceNumber: "INV-NOAMT", Total: undefined }),
];

function fake(over: { status?: number; tenants?: unknown[]; pages?: boolean; invoices?: unknown[] } = {}): { fetch: Fetch; urls: string[]; methods: string[]; headers: Record<string, string>[] } {
  const urls: string[] = [], methods: string[] = [], headers: Record<string, string>[] = [];
  const f: Fetch = async (url, init) => {
    urls.push(url); methods.push(init.method); headers.push(init.headers);
    if (over.status) return { status: over.status, json: async () => ({}) };
    const u = new URL(url);
    if (u.pathname === "/connections") return { status: 200, json: async () => over.tenants ?? [{ tenantId: "t1" }] };
    if (u.pathname.endsWith("/Invoices")) {
      const page = Number(u.searchParams.get("page"));
      const rows = over.pages ? Array.from({ length: 100 }, (_, i) => inv({ InvoiceID: `p${page}-${i}`, InvoiceNumber: `N${page}-${i}` })) : page === 1 ? over.invoices ?? invoices : [];
      return { status: 200, json: async () => ({ Invoices: rows }) };
    }
    return { status: 404, json: async () => ({}) };
  };
  return { fetch: f, urls, methods, headers };
}

describe("xeroDate", () => {
  it("reads Microsoft JSON dates and ISO text", () => {
    expect(xeroDate("/Date(1790467200000+0000)/")).toBe("2026-09-27");
    expect(xeroDate("2026-10-20T00:00:00")).toBe("2026-10-20");
    expect(xeroDate(undefined)).toBeUndefined();
  });
});

describe("pullXero", () => {
  it("separates invoices from bills, skips drafts and voids' cash, and never turns a missing total into zero", async () => {
    const r = await pullXero({ token, now: NOW, fetch: fake().fetch });
    if (!r.ok) throw new Error("expected ok");
    const c = Object.fromEntries(r.data.commitments.map((x) => [x.reference, x]));
    expect(c["INV-1187"]).toMatchObject({ type: "invoice", direction: "in", amount: 2800000, outstanding: 2800000, settlement: "open", anchors: { invoice: "2026-10-10", due: "2026-11-10" }, sourceRef: { system: "xero", record: "i1" } });
    expect(c["INV-1190"]).toMatchObject({ amount: 620050, outstanding: 220050, settlement: "partial" });
    expect(c["INV-104"]).toMatchObject({ settlement: "paid" });
    expect(c["BILL-42"]).toMatchObject({ type: "bill", direction: "out" });
    expect(c["INV-VOID"]).toMatchObject({ settlement: "cancelled" });
    expect(c["INV-DRAFT"]).toBeUndefined();
    expect(c["INV-NOAMT"]).toBeUndefined();
    expect(r.data.diagnostics.errors.map((e) => e.code)).toContain("missing_amount");
    expect(r.data.diagnostics.warnings.join(" ")).toMatch(/1 draft document skipped/);
    expect(r.data.evidence.every((e) => e.channel === "xero")).toBe(true);
  });

  it("reads payments embedded in invoices for settlements and lag history", async () => {
    const r = await pullXero({ token, now: NOW, fetch: fake().fetch });
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.settlements.map((s) => [s.commitmentId, s.amount, s.date])).toEqual([["inv-INV-104", 1200000, "2026-09-27"], ["inv-INV-1190", 400000, "2026-10-20"]]);
    expect(r.data.paymentHistory).toEqual([expect.objectContaining({ invoiceId: "inv-INV-104", due: "2026-09-30", paid: "2026-09-27" })]);
  });

  it("picks the only organisation, asks when there are several, and sends the tenant header", async () => {
    const g = fake();
    await pullXero({ token, now: NOW, fetch: g.fetch });
    expect(g.headers.at(-1)!["xero-tenant-id"]).toBe("t1");
    const many = await pullXero({ token, now: NOW, fetch: fake({ tenants: [{ tenantId: "a" }, { tenantId: "b" }] }).fetch });
    expect(many).toMatchObject({ ok: false, error: { kind: "config" } });
    if (!many.ok) expect(many.error.nextStep).toMatch(/Pick which organisation/);
    const given = fake();
    await pullXero({ token, now: NOW, tenantId: "t9", fetch: given.fetch });
    expect(given.urls.some((u) => u.includes("/connections"))).toBe(false);
  });

  it("repeat pull is unchanged; an edit supersedes", async () => {
    const a = await pullXero({ token, now: NOW, fetch: fake().fetch });
    if (!a.ok) throw new Error("expected ok");
    const b = await pullXero({ token, now: "2026-10-26T00:00:00Z", fetch: fake().fetch, existingEvidence: a.data.evidence });
    if (!b.ok) throw new Error("expected ok");
    expect(b.data.diagnostics.rowsImported).toBe(0);
    const edited = invoices.map((i) => (i.InvoiceID === "i1" ? { ...i, DueDateString: "2026-12-01T00:00:00" } : i));
    const c = await pullXero({ token, now: "2026-10-27T00:00:00Z", fetch: fake({ invoices: edited }).fetch });
    if (!c.ok) throw new Error("expected ok");
    expect(dedupeEvidence(a.data.evidence, c.data.evidence).superseded).toHaveLength(1);
  });

  it("is GET-only against api.xero.com and bounds paging", async () => {
    const g = fake({ pages: true });
    const r = await pullXero({ token, now: NOW, fetch: g.fetch });
    if (!r.ok) throw new Error("expected ok");
    expect(new Set(g.methods)).toEqual(new Set(["GET"]));
    for (const u of g.urls) expect(new URL(u).origin).toBe("https://api.xero.com");
    expect(r.data.commitments).toHaveLength(3000);
    expect(r.data.diagnostics.warnings.join(" ")).toMatch(/Only the first 3000/);
  });

  it.each([[401, "auth"], [403, "auth"], [429, "rate_limit"], [500, "network"]])("status %s is a plain next step with the file fallback", async (status, kind) => {
    const r = await pullXero({ token, now: NOW, tenantId: "t1", fetch: fake({ status }).fetch });
    expect(r).toMatchObject({ ok: false, error: { kind, fallback: "file" } });
  });
});
