// Xero connector (read-only). Invoices and bills are one endpoint (Type ACCREC = we bill a customer,
// ACCPAY = a supplier bills us); payments arrive embedded in each invoice. The host is fixed. Tenant
// (organisation) is chosen from /connections when the caller names none and there is exactly one.
// Amounts are decimals in the document currency; a missing total is never zero.

import type { Evidence } from "../../schema/records";
import { buildAccounting, isoDate, str, type AccountingDoc, type AccountingImport, type AccountingPayment, type DocStatus } from "../accounting/common";
import { ConnectorFailure, getJson, type Fetch, type PullResult, type TokenProvider } from "../connector";

export const PAGE_SIZE = 100;
export const MAX_PAGES = 30;

export type XeroPullInput = {
  token: TokenProvider;
  now: string;
  tenantId?: string;
  fetch?: Fetch;
  existingEvidence?: Evidence[];
};

type Rec = Record<string, unknown>;

// Xero payment dates arrive as "/Date(1609459200000+0000)/" or as ISO text.
export function xeroDate(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = v.match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/);
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
  return isoDate(v);
}

function status(raw: string | undefined): DocStatus {
  switch (raw) {
    case "DRAFT": case "SUBMITTED": return "draft";
    case "PAID": return "paid";
    case "VOIDED": case "DELETED": return "void";
    default: return "open";   // AUTHORISED; partial payment is read from the balance
  }
}

export async function pullXero(input: XeroPullInput): Promise<PullResult<AccountingImport>> {
  try {
    return { ok: true, data: await pull(input) };
  } catch (err) {
    if (err instanceof ConnectorFailure) return { ok: false, error: err.error };
    return { ok: false, error: { kind: "unsupported", message: "Something in the Xero data could not be read.", nextStep: "Upload an export from Xero instead.", fallback: "file" } };
  }
}

async function pull(input: XeroPullInput): Promise<AccountingImport> {
  const f: Fetch = input.fetch ?? ((url, init) => fetch(url, init));
  const auth = async () => ({ Authorization: `Bearer ${await input.token("xero")}`, Accept: "application/json" });
  const get = async (url: string, extra: Record<string, string> = {}) => getJson({ fetch: f, url, headers: { ...(await auth()), ...extra }, provider: "Xero", fallback: "file" });

  let tenantId = input.tenantId;
  if (!tenantId) {
    const res = await getJson({ fetch: f, url: "https://api.xero.com/connections", headers: await auth(), provider: "Xero", fallback: "file" });
    // /connections returns a JSON array; the shared helper wraps non-objects, so accept both shapes.
    const list = Array.isArray(res) ? (res as Rec[]) : Array.isArray((res as Rec).connections) ? ((res as Rec).connections as Rec[]) : [];
    const ids = list.map((c) => str(c.tenantId)).filter((x): x is string => !!x);
    if (ids.length !== 1) {
      throw new ConnectorFailure({
        kind: "config",
        message: ids.length === 0 ? "No Xero organisation was found for this account." : "This Xero account has more than one organisation.",
        nextStep: ids.length === 0 ? "Check the account you connected, or upload an export instead." : "Pick which organisation to import.",
        fallback: "file",
      });
    }
    tenantId = ids[0]!;
  }

  const warnings: string[] = [];
  const docs: AccountingDoc[] = [];
  const payments = new Map<string, AccountingPayment>();
  let truncated = true;
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await get(`https://api.xero.com/api.xro/2.0/Invoices?${new URLSearchParams({ page: String(page) })}`, { "xero-tenant-id": tenantId });
    const rows = Array.isArray(body.Invoices) ? (body.Invoices as Rec[]) : [];
    for (const r of rows) {
      seen++;
      const kind = r.Type === "ACCPAY" ? "bill" : r.Type === "ACCREC" ? "invoice" : undefined;
      if (!kind) continue;
      const contact = (r.Contact ?? {}) as Rec;
      const pid = str(r.InvoiceID);
      const num = str(r.InvoiceNumber);
      const party = str(contact.ContactID);
      const name = str(contact.Name);
      const cur = str(r.CurrencyCode);
      const issued = isoDate(r.DateString) ?? xeroDate(r.Date);
      const due = isoDate(r.DueDateString) ?? xeroDate(r.DueDate);
      docs.push({
        kind, ...(pid ? { providerId: pid } : {}), ...(num ? { number: num } : {}),
        ...(party ? { partyId: party } : {}), ...(name ? { partyName: name } : {}), ...(cur ? { currency: cur } : {}),
        total: r.Total, balance: r.AmountDue, ...(issued ? { issued } : {}), ...(due ? { due } : {}),
        status: status(str(r.Status)), raw: r, sheet: "Invoices", row: seen,
      });
      for (const p of Array.isArray(r.Payments) ? (r.Payments as Rec[]) : []) {
        const providerId = str(p.PaymentID);
        const date = xeroDate(p.DateString) ?? xeroDate(p.Date);
        if (!providerId || !date || !pid) continue;
        const entry = payments.get(providerId) ?? { providerId, date, applied: [] };
        entry.applied.push({ kind, docProviderId: pid, amount: p.Amount });
        payments.set(providerId, entry);
      }
    }
    if (rows.length < PAGE_SIZE) { truncated = false; break; }
  }
  if (truncated) warnings.push(`Only the first ${seen} invoices and bills were read; import older ones from an export.`);
  return buildAccounting({ system: "xero", docs, payments: [...payments.values()], now: input.now, warnings, ...(input.existingEvidence ? { existingEvidence: input.existingEvidence } : {}) });
}
