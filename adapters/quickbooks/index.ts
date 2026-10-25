// QuickBooks Online connector (read-only). Queries Invoice, Bill, Payment, and BillPayment through the
// QBO query endpoint and hands the fields to the shared accounting import. The realm (company) id is
// supplied by the caller; the host is one of two fixed values; the query text is built from constants.
// QBO has no status field, so state is derived: balance 0 = paid, 0 < balance < total = partial,
// and a zero total is a voided document that adds no cash.

import type { Evidence } from "../../schema/records";
import { buildAccounting, isoDate, str, type AccountingDoc, type AccountingImport, type AccountingPayment, type DocStatus } from "../accounting/common";
import { ConnectorFailure, getJson, type Fetch, type PullResult, type TokenProvider } from "../connector";

export const PAGE_SIZE = 500;
export const MAX_PAGES = 10;

export type QuickBooksPullInput = {
  token: TokenProvider;
  realmId: string;
  now: string;
  environment?: "production" | "sandbox";
  defaultCurrency?: string;          // used only when a document names no currency; noted in the warnings
  fetch?: Fetch;
  existingEvidence?: Evidence[];
};

type Rec = Record<string, unknown>;
const ref = (v: unknown): { value?: string; name?: string } => (typeof v === "object" && v !== null ? (v as { value?: string; name?: string }) : {});

function derive(total: unknown, balance: unknown): DocStatus {
  const t = typeof total === "number" ? total : Number(total);
  const b = typeof balance === "number" ? balance : Number(balance);
  if (!Number.isFinite(t) || !Number.isFinite(b)) return "open";
  if (t === 0) return "void";
  if (b <= 0) return "paid";
  return b < t ? "partial" : "open";
}

export async function pullQuickBooks(input: QuickBooksPullInput): Promise<PullResult<AccountingImport>> {
  try {
    if (!/^\d{1,20}$/.test(input.realmId)) {
      throw new ConnectorFailure({ kind: "config", message: "The QuickBooks company id is missing or not valid.", nextStep: "Reconnect QuickBooks, or upload an export instead.", fallback: "file" });
    }
    return { ok: true, data: await pull(input) };
  } catch (err) {
    if (err instanceof ConnectorFailure) return { ok: false, error: err.error };
    return { ok: false, error: { kind: "unsupported", message: "Something in the QuickBooks data could not be read.", nextStep: "Upload an export from QuickBooks instead.", fallback: "file" } };
  }
}

async function pull(input: QuickBooksPullInput): Promise<AccountingImport> {
  const base = input.environment === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
  const f: Fetch = input.fetch ?? ((url, init) => fetch(url, init));
  const warnings: string[] = [];
  const query = async (entity: "Invoice" | "Bill" | "Payment" | "BillPayment"): Promise<{ records: Rec[]; truncated: boolean }> => {
    const records: Rec[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = `select * from ${entity} startposition ${page * PAGE_SIZE + 1} maxresults ${PAGE_SIZE}`;
      const body = await getJson({
        fetch: f, provider: "QuickBooks", fallback: "file",
        url: `${base}/v3/company/${input.realmId}/query?${new URLSearchParams({ query: q, minorversion: "70" })}`,
        headers: { Authorization: `Bearer ${await input.token("quickbooks")}`, Accept: "application/json" },
      });
      const rows = (body.QueryResponse as Rec | undefined)?.[entity];
      const list = Array.isArray(rows) ? (rows as Rec[]) : [];
      records.push(...list);
      if (list.length < PAGE_SIZE) return { records, truncated: false };
    }
    return { records, truncated: true };
  };

  const docs: AccountingDoc[] = [];
  let assumedCurrency = 0;
  for (const kind of ["invoice", "bill"] as const) {
    const entity = kind === "invoice" ? "Invoice" : "Bill";
    const { records, truncated } = await query(entity);
    if (truncated) warnings.push(`Only the first ${records.length} ${kind}s were read; import older ones from an export.`);
    records.forEach((r, i) => {
      const party = ref(kind === "invoice" ? r.CustomerRef : r.VendorRef);
      const pid = str(r.Id);
      const num = str(r.DocNumber);
      let cur = str(ref(r.CurrencyRef).value);
      if (!cur && input.defaultCurrency) { cur = input.defaultCurrency; assumedCurrency++; }
      const issued = isoDate(r.TxnDate);
      const due = isoDate(r.DueDate);
      docs.push({
        kind, ...(pid ? { providerId: pid } : {}), ...(num ? { number: num } : {}),
        ...(party.value ? { partyId: party.value } : {}), ...(party.name ? { partyName: party.name } : {}), ...(cur ? { currency: cur } : {}),
        total: r.TotalAmt, balance: r.Balance, ...(issued ? { issued } : {}), ...(due ? { due } : {}),
        status: derive(r.TotalAmt, r.Balance), raw: r, sheet: `${entity}s`, row: i + 1,
      });
    });
  }
  if (assumedCurrency) warnings.push(`${assumedCurrency} document${assumedCurrency === 1 ? "" : "s"} named no currency; the company default ${input.defaultCurrency} was used.`);

  const payments: AccountingPayment[] = [];
  for (const [entity, kind, txnType] of [["Payment", "invoice", "Invoice"], ["BillPayment", "bill", "Bill"]] as const) {
    const { records } = await query(entity);
    for (const p of records) {
      const providerId = str(p.Id);
      const date = isoDate(p.TxnDate);
      if (!providerId || !date) continue;
      const applied: AccountingPayment["applied"] = [];
      for (const line of Array.isArray(p.Line) ? (p.Line as Rec[]) : []) {
        for (const l of Array.isArray(line.LinkedTxn) ? (line.LinkedTxn as Rec[]) : []) {
          const id = str(l.TxnId);
          if (l.TxnType === txnType && id) applied.push({ kind, docProviderId: id, amount: line.Amount });
        }
      }
      payments.push({ providerId, date, applied });
    }
  }
  return buildAccounting({ system: "quickbooks", docs, payments, now: input.now, warnings, ...(input.existingEvidence ? { existingEvidence: input.existingEvidence } : {}) });
}
