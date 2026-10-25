// Fake QuickBooks Online query endpoint shaped from the public API docs, not a live company.
import { describe, expect, it } from "vitest";
import type { Fetch } from "../connector";
import { dedupeEvidence } from "../core/dedupe";
import { pullQuickBooks } from "./index";

const NOW = "2026-10-25T18:00:00Z";
const token = async () => "tok";
const cur = { value: "USD" };
const invoices = [
  { Id: "101", DocNumber: "INV-1187", TxnDate: "2026-10-10", DueDate: "2026-11-10", TotalAmt: 28000, Balance: 28000, CurrencyRef: cur, CustomerRef: { value: "c1", name: "Evergreen Home" } },
  { Id: "102", DocNumber: "INV-104", TxnDate: "2026-08-30", DueDate: "2026-09-30", TotalAmt: 12000, Balance: 0, CurrencyRef: cur, CustomerRef: { value: "c2", name: "Puget Market" } },
  { Id: "103", DocNumber: "INV-1190", TxnDate: "2026-10-05", DueDate: "2026-11-04", TotalAmt: 6200.5, Balance: 2200.5, CurrencyRef: cur, CustomerRef: { value: "c2", name: "Puget Market" } },
  { Id: "104", DocNumber: "INV-VOID", TxnDate: "2026-10-05", DueDate: "2026-11-04", TotalAmt: 0, Balance: 0, CurrencyRef: cur, CustomerRef: { value: "c2", name: "Puget Market" } },
  { Id: "105", DocNumber: "INV-NOAMT", TxnDate: "2026-10-05", DueDate: "2026-11-04", Balance: 5, CurrencyRef: cur, CustomerRef: { value: "c2", name: "Puget Market" } },
];
const bills = [{ Id: "201", DocNumber: "BILL-42", TxnDate: "2026-10-01", DueDate: "2026-11-20", TotalAmt: 15000, Balance: 15000, CurrencyRef: cur, VendorRef: { value: "v1", name: "Ningbo Supply" } }];
const payments = [
  { Id: "p1", TxnDate: "2026-09-27", Line: [{ Amount: 12000, LinkedTxn: [{ TxnId: "102", TxnType: "Invoice" }] }] },
  { Id: "p2", TxnDate: "2026-10-20", Line: [{ Amount: 4000, LinkedTxn: [{ TxnId: "103", TxnType: "Invoice" }, { TxnId: "9", TxnType: "CreditMemo" }] }] },
];

function fake(over: { status?: number; invoices?: unknown[] } = {}): { fetch: Fetch; urls: string[]; methods: string[] } {
  const urls: string[] = [], methods: string[] = [];
  const f: Fetch = async (url, init) => {
    urls.push(url); methods.push(init.method);
    if (over.status) return { status: over.status, json: async () => ({}) };
    const q = new URL(url).searchParams.get("query") ?? "";
    const entity = q.match(/from (\w+)/)![1]!;
    const data: Record<string, unknown[]> = { Invoice: over.invoices ?? invoices, Bill: bills, Payment: payments, BillPayment: [] };
    return { status: 200, json: async () => ({ QueryResponse: { [entity]: data[entity] } }) };
  };
  return { fetch: f, urls, methods };
}

describe("pullQuickBooks", () => {
  it("maps invoices, bills, and derives status from balances", async () => {
    const r = await pullQuickBooks({ token, realmId: "123145", now: NOW, fetch: fake().fetch });
    if (!r.ok) throw new Error("expected ok");
    const c = Object.fromEntries(r.data.commitments.map((x) => [x.reference, x]));
    expect(c["INV-1187"]).toMatchObject({ id: "inv-INV-1187", amount: 2800000, outstanding: 2800000, settlement: "open", sourceRef: { system: "quickbooks", record: "101" }, anchors: { due: "2026-11-10" } });
    expect(c["INV-104"]).toMatchObject({ settlement: "paid", outstanding: 0 });
    expect(c["INV-1190"]).toMatchObject({ amount: 620050, outstanding: 220050, settlement: "partial" });
    expect(c["INV-VOID"]).toMatchObject({ settlement: "cancelled" });
    expect(c["BILL-42"]).toMatchObject({ type: "bill", direction: "out", amount: 1500000 });
    expect(c["INV-NOAMT"]).toBeUndefined();
    expect(r.data.diagnostics.errors.map((e) => e.code)).toContain("missing_amount");
    expect(r.data.evidence.every((e) => e.channel === "quickbooks")).toBe(true);
    expect(r.data.parties.map((p) => p.name).sort()).toEqual(["Evergreen Home", "Ningbo Supply", "Puget Market"]);
  });

  it("links payments to invoices only, and feeds payment history", async () => {
    const r = await pullQuickBooks({ token, realmId: "123145", now: NOW, fetch: fake().fetch });
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.settlements.map((s) => [s.commitmentId, s.amount, s.date])).toEqual([["inv-INV-104", 1200000, "2026-09-27"], ["inv-INV-1190", 400000, "2026-10-20"]]);
    expect(r.data.paymentHistory).toEqual([expect.objectContaining({ invoiceId: "inv-INV-104", due: "2026-09-30", paid: "2026-09-27" })]);
  });

  it("a repeat pull changes nothing and an edit supersedes", async () => {
    const a = await pullQuickBooks({ token, realmId: "1", now: NOW, fetch: fake().fetch });
    if (!a.ok) throw new Error("expected ok");
    const b = await pullQuickBooks({ token, realmId: "1", now: "2026-10-26T00:00:00Z", fetch: fake().fetch, existingEvidence: a.data.evidence });
    if (!b.ok) throw new Error("expected ok");
    expect(b.data.diagnostics.rowsImported).toBe(0);
    expect(dedupeEvidence(a.data.evidence, b.data.evidence).fresh).toEqual([]);
    const edited = invoices.map((i) => (i.Id === "101" ? { ...i, DueDate: "2026-12-01" } : i));
    const c = await pullQuickBooks({ token, realmId: "1", now: "2026-10-27T00:00:00Z", fetch: fake({ invoices: edited }).fetch });
    if (!c.ok) throw new Error("expected ok");
    expect(dedupeEvidence(a.data.evidence, c.data.evidence).superseded).toHaveLength(1);
  });

  it("uses the default currency only when told to, and says so", async () => {
    const noCur = [{ ...invoices[0]!, CurrencyRef: undefined }];
    const without = await pullQuickBooks({ token, realmId: "1", now: NOW, fetch: fake({ invoices: noCur }).fetch });
    if (!without.ok) throw new Error("expected ok");
    expect(without.data.commitments.find((x) => x.type === "invoice")).toBeUndefined();
    const withDefault = await pullQuickBooks({ token, realmId: "1", now: NOW, defaultCurrency: "USD", fetch: fake({ invoices: noCur }).fetch });
    if (!withDefault.ok) throw new Error("expected ok");
    expect(withDefault.data.commitments.find((x) => x.type === "invoice")?.currency).toBe("USD");
    expect(withDefault.data.diagnostics.warnings.join(" ")).toMatch(/company default USD/);
  });

  it("is GET-only against a fixed Intuit host and rejects a bad realm id", async () => {
    const g = fake();
    await pullQuickBooks({ token, realmId: "123145", now: NOW, environment: "sandbox", fetch: g.fetch });
    expect(new Set(g.methods)).toEqual(new Set(["GET"]));
    for (const u of g.urls) expect(new URL(u).origin).toBe("https://sandbox-quickbooks.api.intuit.com");
    const g2 = fake();
    const bad = await pullQuickBooks({ token, realmId: "1/../evil", now: NOW, fetch: g2.fetch });
    expect(bad).toMatchObject({ ok: false, error: { kind: "config", fallback: "file" } });
    expect(g2.urls).toEqual([]);
  });

  it.each([[401, "auth"], [403, "auth"], [429, "rate_limit"], [500, "network"]])("status %s is a plain next step with the file fallback", async (status, kind) => {
    const r = await pullQuickBooks({ token, realmId: "1", now: NOW, fetch: fake({ status }).fetch });
    expect(r).toMatchObject({ ok: false, error: { kind, fallback: "file" } });
    if (!r.ok) expect(r.error.nextStep).toMatch(/QuickBooks|upload an export/);
  });
});
