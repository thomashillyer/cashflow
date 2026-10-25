// Zoho Books connector: invoices, bills, contacts-as-parties, and payments -> shared records.
// Read-only. Output is an import preview (see docs/design/04-adapters.md): the coordinator decides
// what is stored, and the engine, not this module, creates future cash events. Owner overrides are
// separate records this module never emits, so a refresh cannot erase them.

import type { Evidence } from "../../schema/records";
import { buildAccounting, isoDate, str, toMinor, type AccountingDoc, type AccountingImport, type AccountingPayment, type DocStatus } from "../accounting/common";
import { ConnectorFailure, type Fetch, type PullResult, type TokenProvider } from "../connector";
import { ZohoClient, type ZohoRecord, type ZohoRegion } from "./client";

export type ZohoPullInput = {
  region: ZohoRegion;
  token: TokenProvider;
  now: string;                       // ISO instant; the clock is passed in
  organizationId?: string;
  fetch?: Fetch;
  existingEvidence?: Evidence[];     // to report repeats; the store still upserts by sourceRef
};

export type ZohoPull = AccountingImport;

export { toMinor };


const SPEC = {
  invoice: { path: "invoices", key: "invoices", idKey: "invoice_id", numKey: "invoice_number", partyIdKey: "customer_id", partyNameKey: "customer_name", label: "invoice" },
  bill: { path: "bills", key: "bills", idKey: "bill_id", numKey: "bill_number", partyIdKey: "vendor_id", partyNameKey: "vendor_name", label: "bill" },
} as const;

function status(raw: string | undefined): DocStatus {
  switch (raw) {
    case "draft": return "draft";
    case "paid": return "paid";
    case "void": case "write_off": return "void";
    case "partially_paid": return "partial";
    default: return "open";
  }
}

export async function pullZoho(input: ZohoPullInput): Promise<PullResult<ZohoPull>> {
  try {
    return { ok: true, data: await pull(input) };
  } catch (err) {
    if (err instanceof ConnectorFailure) return { ok: false, error: err.error };
    return { ok: false, error: { kind: "unsupported", message: "Something in the Zoho Books data could not be read.", nextStep: "Upload an export from Zoho Books instead.", fallback: "file" } };
  }
}

async function pull(input: ZohoPullInput): Promise<ZohoPull> {
  const client = new ZohoClient({ region: input.region, token: input.token, ...(input.fetch ? { fetch: input.fetch } : {}), ...(input.organizationId ? { organizationId: input.organizationId } : {}) });
  const warnings: string[] = [];
  const docs: AccountingDoc[] = [];
  for (const kind of ["invoice", "bill"] as const) {
    const s = SPEC[kind];
    const { records, truncated } = await client.list(s.path, s.key);
    if (truncated) warnings.push(`Only the first ${records.length} ${s.label}s were read; import older ones from an export.`);
    records.forEach((rec, i) => {
      const pid = str(rec[s.idKey]);
      const num = str(rec[s.numKey]);
      const party = str(rec[s.partyIdKey]);
      const name = str(rec[s.partyNameKey]);
      const cur = str(rec.currency_code);
      const issued = isoDate(rec.date);
      const due = isoDate(rec.due_date);
      const url = str(rec.invoice_url);
      docs.push({
        kind, ...(pid ? { providerId: pid } : {}), ...(num ? { number: num } : {}),
        ...(party ? { partyId: party } : {}), ...(name ? { partyName: name } : {}), ...(cur ? { currency: cur } : {}),
        total: rec.total, balance: rec.balance, ...(issued ? { issued } : {}), ...(due ? { due } : {}),
        status: status(str(rec.status)), ...(url ? { url } : {}), raw: rec, sheet: s.path, row: i + 1,
      });
    });
  }

  const payments: AccountingPayment[] = [];
  for (const kind of ["invoice", "bill"] as const) {
    const isIn = kind === "invoice";
    const path = isIn ? "customerpayments" : "vendorpayments";
    const appliedKey = isIn ? "invoices" : "bills";
    const { records } = await client.list(path, path);
    for (const pay of records) {
      const providerId = str(pay.payment_id);
      const date = isoDate(pay.date);
      if (!providerId || !date) continue;
      // The list names invoices; the detail says how much went to each.
      const detail = await client.detail(path, providerId, "payment");
      const applied = Array.isArray(detail?.[appliedKey]) ? (detail![appliedKey] as ZohoRecord[]) : [];
      payments.push({
        providerId, date,
        applied: applied.map((a) => ({
          kind, ...(str(a[isIn ? "invoice_id" : "bill_id"]) ? { docProviderId: str(a[isIn ? "invoice_id" : "bill_id"])! } : {}),
          ...(str(a[isIn ? "invoice_number" : "bill_number"]) ? { docNumber: str(a[isIn ? "invoice_number" : "bill_number"])! } : {}),
          amount: a.amount_applied,
        })),
      });
    }
  }
  return buildAccounting({ system: "zoho_books", docs, payments, now: input.now, warnings, ...(input.existingEvidence ? { existingEvidence: input.existingEvidence } : {}) });
}
