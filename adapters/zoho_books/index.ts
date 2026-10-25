// Zoho Books connector: invoices, bills, contacts-as-parties, and payments -> shared records.
// Read-only. Output is an import preview (see docs/design/04-adapters.md): the coordinator decides
// what is stored, and the engine, not this module, creates future cash events. Owner overrides are
// separate records this module never emits, so a refresh cannot erase them.

import type { BalanceSnapshot, Evidence } from "../../schema/records";
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

// `balances`: the bank and cash accounts' balances as of today, the forecast's opening cash. Empty when Zoho did not
// allow it (the Banking permission), with a warning in the diagnostics.
export type ZohoPull = AccountingImport & { balances: BalanceSnapshot[] };

export { toMinor };


const MAX_PAYMENT_DETAILS = 150;

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
  let detailCalls = 0;
  // Balances already give what is outstanding; payments only add lag history. A rate limit or an
  // unreadable payment must not throw away the invoices and bills already read.
  try {
  for (const kind of ["invoice", "bill"] as const) {
    const isIn = kind === "invoice";
    const path = isIn ? "customerpayments" : "vendorpayments";
    const appliedKey = isIn ? "invoices" : "bills";
    const { records } = await client.list(path, path);
    for (const pay of records) {
      const providerId = str(pay.payment_id);
      const date = isoDate(pay.date);
      if (!providerId || !date) continue;
      if (++detailCalls > MAX_PAYMENT_DETAILS) { warnings.push(`Only the first ${MAX_PAYMENT_DETAILS} payments were read for payment history.`); break; }
      // The list names invoices; the detail says how much went to each.
      const detail = await client.detail(path, providerId, isIn ? "payment" : "vendorpayment");
      const applied = Array.isArray(detail?.[appliedKey]) ? (detail![appliedKey] as ZohoRecord[]) : [];
      const pcur = str(pay.currency_code) ?? str(detail?.currency_code);
      const pparty = str(pay[isIn ? "customer_id" : "vendor_id"]);
      const pname = str(pay[isIn ? "customer_name" : "vendor_name"]);
      payments.push({
        providerId, date, kind, amount: detail?.amount ?? pay.amount, appliedKnown: detail !== undefined,
        ...(detail?.unused_amount !== undefined || pay.unused_amount !== undefined ? { unapplied: detail?.unused_amount ?? pay.unused_amount } : {}),
        ...(pcur ? { currency: pcur } : {}),
        ...(pparty ? { partyId: pparty } : {}), ...(pname ? { partyName: pname } : {}),
        applied: applied.map((a) => ({
          kind, ...(str(a[isIn ? "invoice_id" : "bill_id"]) ? { docProviderId: str(a[isIn ? "invoice_id" : "bill_id"])! } : {}),
          ...(str(a[isIn ? "invoice_number" : "bill_number"]) ? { docNumber: str(a[isIn ? "invoice_number" : "bill_number"])! } : {}),
          amount: a.amount_applied,
        })),
      });
    }
  }
  } catch (err) {
    if (!(err instanceof ConnectorFailure) || err.error.kind === "auth") throw err;
    warnings.push("Payment history could not be fully read (Zoho Books asked us to slow down). Invoices and bills are complete; import again later for payment history.");
  }
  const { balances, warning } = await readBalances(client, input.now);
  if (warning) warnings.push(warning);
  const built = buildAccounting({ system: "zoho_books", docs, payments, now: input.now, warnings, ...(input.existingEvidence ? { existingEvidence: input.existingEvidence } : {}) });
  return { ...built, balances };
}

// Bank and cash accounts -> opening cash. Read-only; a missing permission or a hiccup is a plain warning, never a
// failed pull: invoices and bills are still useful without it.
async function readBalances(client: ZohoClient, now: string): Promise<{ balances: BalanceSnapshot[]; warning?: string }> {
  const asOf = now.slice(0, 10);
  try {
    const { records } = await client.list("bankaccounts", "bankaccounts");
    const balances: BalanceSnapshot[] = [];
    let unreadable = 0;
    for (const a of records) {
      const type = str(a.account_type);
      if (a.is_active === false || (type !== "bank" && type !== "cash")) continue;
      const id = str(a.account_id);
      const currency = str(a.currency_code);
      const amount = currency ? toMinor(a.bank_balance ?? a.balance, currency) : undefined;
      if (!id || !currency || amount === undefined) { unreadable++; continue; }
      balances.push({ id: `bal-zoho_books-${id}`, account: str(a.account_name) ?? id, amount, currency, asOf, sourceRef: { system: "zoho_books", record: `bankaccount:${id}` } });
    }
    const note = unreadable ? ` ${unreadable} account${unreadable === 1 ? " was" : "s were"} skipped because its balance could not be read.` : "";
    if (balances.length === 0) return { balances, warning: `No bank balance was found in Zoho Books.${note} Enter your balance, or upload a bank statement.` };
    return { balances, ...(unreadable ? { warning: note.trim() } : {}) };
  } catch (err) {
    if (err instanceof ConnectorFailure && err.error.kind === "auth") {
      return { balances: [], warning: "Bank balances were not read: Zoho Books needs the Banking permission. Reconnect Zoho Books with it, enter your balance, or upload a bank statement." };
    }
    return { balances: [], warning: "Bank balances could not be read just now. Enter your balance, or upload a bank statement." };
  }
}
