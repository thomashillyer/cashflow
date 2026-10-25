// POST /import/bank: a bank statement (CSV or XLSX) becomes actual cash events, the newest running balance, and
// recurring-payment PROPOSALS (adapters/bank_csv). Nothing here applies a proposal, marks an invoice paid, or
// changes a forecast by itself: the events are bank history, the balance is opening cash, and the proposals wait
// for the owner. Called from the /import/:adapter handler in review.ts for adapter "bank".

import type { BankMapping } from "../../adapters/bank_csv";
import { prepareBankImport } from "../../adapters/prepare";
import { HttpError } from "../http";
import type { Business, Store } from "../store";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const BANK_COLUMNS = ["date", "description", "amount", "debit", "credit", "balance", "currency"];

// The owner's column corrections: known columns only, small whole indexes. Anything else is ignored.
function bankMapping(v: unknown): BankMapping | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: BankMapping = {};
  for (const [k, n] of Object.entries(v)) {
    if (BANK_COLUMNS.includes(k) && typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 50) out[k as keyof BankMapping] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// `store` is the request's own view (storeFor(req)): on the public demo a visitor's statement goes to their private copy.
export async function importBank(store: Pick<Store, "load" | "upsertRecords">, b: Business, body: Record<string, unknown>, now: string) {
  const text = typeof body.text === "string" ? body.text : undefined;
  const fileName = typeof body.fileName === "string" && body.fileName.trim() !== "" ? body.fileName.slice(0, 200) : "statement.csv";
  let bytes: Uint8Array;
  if (text !== undefined) bytes = new TextEncoder().encode(text);
  else {
    if (typeof body.base64 !== "string") throw new HttpError(400, "INVALID_ARGUMENT", "Attach the bank statement (base64) or paste its rows.", { fieldIssues: [{ field: "base64", issue: "missing" }] });
    const buf = Buffer.from(body.base64, "base64");
    if (buf.length === 0) throw new HttpError(400, "INVALID_ARGUMENT", "That file is empty. Download the statement again and upload it.");
    if (buf.length > MAX_UPLOAD_BYTES) throw new HttpError(413, "TOO_LARGE", "That file is over 10 MB. Download a shorter date range from your bank and upload it again.");
    bytes = new Uint8Array(buf);
  }
  if (bytes.length > MAX_UPLOAD_BYTES) throw new HttpError(413, "TOO_LARGE", "That is over 10 MB. Paste fewer rows, or upload a shorter date range.");

  const currency = typeof body.currency === "string" && /^[A-Za-z]{3}$/.test(body.currency) ? body.currency.toUpperCase() : b.profile.baseCurrency;
  const account = typeof body.account === "string" && body.account.trim() !== "" ? body.account.trim().slice(0, 60) : undefined;
  const columnMapping = bankMapping(body.columnMapping);
  const headerRow = typeof body.headerRow === "number" && Number.isInteger(body.headerRow) && body.headerRow >= 1 ? body.headerRow : undefined;
  const dayFirst = typeof body.dayFirst === "boolean" ? body.dayFirst : undefined;
  // An owner correcting how the file is read is never told "already imported".
  const retry = ["columnMapping", "headerRow", "dayFirst", "currency", "account"].some((f) => body[f] !== undefined);

  const { records, storeRevision } = await store.load(b.id);
  const prep = await prepareBankImport({
    fileName, bytes, receivedAt: now, records, currency, retry,
    ...(account ? { account } : {}), ...(dayFirst !== undefined ? { dayFirst } : {}),
    ...(columnMapping ? { columnMapping } : {}), ...(headerRow ? { headerRow } : {}),
  });
  if (!prep.ok) throw new HttpError(422, "UNREADABLE", `${prep.message} ${prep.nextStep}`);
  const { bank } = prep;
  const summary = { events: bank.events.length, balances: bank.balances.length, recurring: bank.recurring.length };

  if (prep.repeat) {
    return { repeat: true, repeatOf: prep.evidenceId, written: false, storeRevision, diagnostics: bank.diagnostics, mapping: bank.mapping, recurring: [], unallocated: 0, balance: null, preview: { events: 0, balances: 0, recurring: 0 } };
  }
  // Nothing readable (wrong columns, every row rejected): write nothing, so the file is not remembered as imported
  // and the owner can fix the mapping and send it again.
  if (bank.events.length === 0 && bank.balances.length === 0) {
    return { repeat: false, written: false, storeRevision, diagnostics: bank.diagnostics, mapping: bank.mapping, recurring: [], unallocated: 0, balance: null, preview: summary };
  }
  // Events and balance first, the evidence (which carries the file hash that makes a later upload a repeat) last:
  // a failure partway through leaves the file importable again. All ids are stable, so a re-run upserts.
  await store.upsertRecords(b.id, { events: bank.events, balances: bank.balances });
  const revision = await store.upsertRecords(b.id, { evidence: [bank.evidence] });
  // The engine adds the latest balance of every account. A balance already on file under another name would be
  // counted on top of this one, so say so while the owner can still fix it (import again with the account's name).
  const savedAs = bank.balances[0]?.account;
  const others = [...new Set(records.balances.map((x) => x.account))].filter((a) => a !== savedAs);
  const diagnostics = savedAs && others.length > 0
    ? { ...bank.diagnostics, warnings: [...bank.diagnostics.warnings, `Your books already have a balance for ${others.map((a) => `"${a}"`).join(", ")}. This statement was saved as the account "${savedAs}", so both balances are added together. If they are the same account, import the statement again and give that account's name.`] }
    : bank.diagnostics;
  return {
    repeat: false, written: true, storeRevision: revision, evidence: bank.evidence, diagnostics, mapping: bank.mapping,
    recurring: bank.recurring, unallocated: bank.unallocated, balance: bank.balances[0] ?? null, preview: summary,
  };
}
