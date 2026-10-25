// Bank statement import (CSV or XLSX): lines become actual CashEvents, the newest running balance becomes a
// BalanceSnapshot, and regular payments become recurring PROPOSALS. Read-only, deterministic, no model calls.
//
// What this never does:
//  - guess which invoice or bill a bank line pays. Lines carry no commitmentId, so they stay visible as plain
//    bank activity ("unallocated") and cannot duplicate a Settlement from the books; matching is the owner's
//    decision in Review (docs/TECHNICAL_PLAN.md, bank statement row).
//  - turn a missing or unreadable amount or date into zero or drop the row quietly: every such row is a RowError.
//  - apply a recurring proposal. The owner confirms those later.
//
// Opening cash (engine/forecast.ts openingCash): latest snapshot on or before asOf, plus actuals dated on or after
// the snapshot and before asOf. A statement's running balance is end of day, so the snapshot is dated the day AFTER
// the newest row: that day's lines are already inside the balance and are not rolled forward a second time.

import type { SheetCell, SheetContent } from "../../ai/extract/sheet";
import { fmtMoney } from "../../ai/money";
import { parseAmount, parseDate } from "../../ai/normalize";
import type { BalanceSnapshot, CashEvent, Evidence } from "../../schema/records";
import { summarize, type ImportDiagnostics, type RowError } from "../core/diagnostics";
import { sha256Hex } from "../core/hash";
import { fileEvidenceId } from "../core/ids";
import { ZipTooLarge } from "../core/zip";
import { readCsv } from "../generic_file/csv";
import { readXlsx } from "../generic_file/xlsx";
import { addDaysUtc, proposeRecurring, type BankLine, type RecurringProposal } from "./recurring";

export type BankColumn = "date" | "description" | "amount" | "debit" | "credit" | "balance" | "currency";
export type BankMapping = Partial<Record<BankColumn, number>>;   // 0-based column indexes

export type BankImportOptions = {
  currency: string;                // used when the statement has no currency column (the profile's base currency)
  account?: string;                // which bank account these lines belong to; default "bank"
  dayFirst?: boolean;              // ambiguous 03/04/2026 style dates
  columnMapping?: BankMapping;     // the owner's corrections from the mapping preview
  headerRow?: number;              // 1-based
  existingEvidence?: Evidence[];   // already in the store, to recognise a byte-identical repeat
  now?: string;
};

export type BankMappingPreview = {
  headerRow?: number;              // 1-based
  columns: BankMapping;
  headers: Partial<Record<BankColumn, string>>;
  source: "inferred" | "owner" | "mixed";
};

export type BankImport = {
  readable: boolean;               // false: the file could not be opened at all
  repeat: boolean;                 // byte-identical file already imported: nothing new
  evidence: Evidence;
  events: CashEvent[];
  balances: BalanceSnapshot[];
  recurring: RecurringProposal[];
  mapping: BankMappingPreview;
  unallocated: number;             // bank lines not linked to any invoice or bill (all of them: we never guess)
  diagnostics: ImportDiagnostics;
};

export const DEFAULT_ACCOUNT = "bank";
const HEADER_SCAN_ROWS = 20;
const MAX_DESCRIPTION = 200;

// ---------------------------------------------------------------- columns

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const text = (c: SheetCell | undefined): string => (c === null || c === undefined ? "" : typeof c === "number" ? String(c) : c.trim());

// Per column, patterns in priority order; the first unused header that matches wins.
const PATTERNS: [BankColumn, RegExp[]][] = [
  ["date", [/^(transaction |posting |posted |booking |trans )?date$/, /\bdate\b/]],
  ["balance", [/balance/]],
  ["debit", [/\b(debit|debits|withdrawal|withdrawals|paid out|money out|outflow)\b/]],
  ["credit", [/\b(credit|credits|deposit|deposits|paid in|money in|inflow)\b/]],
  ["currency", [/^(currency|ccy|cur)$/]],
  ["amount", [/^(transaction )?(amount|amt|value)$/, /\bamount\b/]],
  ["description", [/^(transaction )?(description|details|narrative|payee|memo|particulars)$/, /(description|details|narrative|payee|memo|particulars)/, /\breference\b/]],
];

export function inferColumns(headerCells: SheetCell[]): BankMapping {
  const headers = headerCells.map((c) => norm(text(c)));
  const used = new Set<number>();
  const out: BankMapping = {};
  for (const [col, patterns] of PATTERNS) {
    for (const re of patterns) {
      const i = headers.findIndex((h, idx) => !used.has(idx) && h !== "" && re.test(h));
      if (i >= 0) { out[col] = i; used.add(i); break; }
    }
  }
  // Separate debit/credit columns win over a stray "amount" (for example "Debit Amount" already matched above).
  if (out.debit !== undefined || out.credit !== undefined) delete out.amount;
  return out;
}

const usable = (c: BankMapping) => c.date !== undefined && (c.amount !== undefined || c.debit !== undefined || c.credit !== undefined);

function findHeader(rows: SheetCell[][]): { headerRow: number; columns: BankMapping } | undefined {
  for (let r = 0; r < Math.min(rows.length - 1, HEADER_SCAN_ROWS); r++) {
    const columns = inferColumns(rows[r] ?? []);
    if (usable(columns)) return { headerRow: r + 1, columns };
  }
  return undefined;
}

// ---------------------------------------------------------------- rows

export type Line = { row: number; date: string; signed: number; currency: string; description: string; balance?: number; balanceUnreadable?: boolean };

const excelSerialDate = (n: number): string | undefined =>
  n >= 20_000 && n <= 80_000 ? new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86_400_000).toISOString().slice(0, 10) : undefined;

const SUMMARY_ROW = /^(opening|closing|beginning|ending|balance (brought|carried)|brought forward|carried forward|b\/f|c\/f|total)/i;

function parseRows(sheet: SheetContent, columns: BankMapping, headerRow: number, opts: BankImportOptions) {
  const errors: RowError[] = [];
  const lines: Line[] = [];
  let summarySkipped = 0;
  let zeroSkipped = 0;
  let ambiguousDates = 0;
  let rowsRead = 0;
  for (let r = headerRow; r < sheet.rows.length; r++) {
    const cells = sheet.rows[r] ?? [];
    if (cells.every((c) => text(c) === "")) continue;
    const row = r + 1;
    const description = (columns.description !== undefined ? text(cells[columns.description]) : "").replace(/\s+/g, " ").slice(0, MAX_DESCRIPTION);
    const dateCell = columns.date !== undefined ? cells[columns.date] : undefined;
    const dateText = text(dateCell);
    if (dateText === "" && SUMMARY_ROW.test(description)) { summarySkipped++; continue; }   // "Opening balance", "Total": not a transaction
    rowsRead++;
    const fail = (code: RowError["code"], message: string, nextStep: string, column?: string, raw?: string) => {
      errors.push({ row, sheet: sheet.sheet, code, message, nextStep, ...(column ? { column } : {}), ...(raw ? { raw } : {}) });
    };

    // Date
    if (dateText === "") { fail("missing_date", `Row ${row} has no date, so it was not imported.`, "Add the date to that row in the file and upload it again.", "date"); continue; }
    let date: string | undefined;
    if (typeof dateCell === "number") date = excelSerialDate(dateCell);
    if (!date) {
      const p = parseDate(dateText, opts.dayFirst === undefined ? {} : { dayFirst: opts.dayFirst });
      if (p) { date = p.date; if (p.ambiguous) ambiguousDates++; }
    }
    if (!date) { fail("invalid_date", `Row ${row}: "${dateText.slice(0, 40)}" is not a date Neri can read, so it was not imported.`, "Write the date like 2026-10-25 in the file, or tell Neri which column holds the date.", "date", dateText.slice(0, 60)); continue; }

    // Currency
    const curText = columns.currency !== undefined ? text(cells[columns.currency]).toUpperCase() : "";
    const currency = curText === "" ? opts.currency : curText;
    if (!/^[A-Z]{3}$/.test(currency)) { fail("invalid_currency", `Row ${row}: "${curText.slice(0, 10)}" is not a currency code, so it was not imported.`, "Use a three-letter code like USD in the currency column.", "currency", curText.slice(0, 10)); continue; }

    // Amount: one signed column, or separate debit and credit columns.
    let signed: number | undefined;
    if (columns.debit !== undefined || columns.credit !== undefined) {
      const d = columns.debit !== undefined ? text(cells[columns.debit]) : "";
      const c = columns.credit !== undefined ? text(cells[columns.credit]) : "";
      const pd = d !== "" ? parseAmount(d, currency) : undefined;
      const pc = c !== "" ? parseAmount(c, currency) : undefined;
      if (d === "" && c === "") { fail("missing_amount", `Row ${row} has no amount, so it was not imported and adds no cash.`, "Add the amount to that row in the file and upload it again.", "amount"); continue; }
      if ((d !== "" && pd === undefined) || (c !== "" && pc === undefined)) { fail("invalid_amount", `Row ${row}: the amount "${(d || c).slice(0, 30)}" could not be read, so it was not imported.`, "Write the amount as a plain number like 1234.50 in the file.", "amount", (d || c).slice(0, 40)); continue; }
      if ((pd ?? 0) !== 0 && (pc ?? 0) !== 0) { fail("invalid_amount", `Row ${row} has both a debit and a credit, so it was not imported.`, "Put the amount in one column only.", "amount"); continue; }
      signed = (pd ?? 0) !== 0 ? -Math.abs(pd!) : Math.abs(pc ?? 0);
    } else if (columns.amount !== undefined) {
      const a = text(cells[columns.amount]);
      if (a === "") { fail("missing_amount", `Row ${row} has no amount, so it was not imported and adds no cash.`, "Add the amount to that row in the file and upload it again.", "amount"); continue; }
      signed = parseAmount(a, currency);
      if (signed === undefined) { fail("invalid_amount", `Row ${row}: the amount "${a.slice(0, 30)}" could not be read, so it was not imported.`, "Write the amount as a plain number like -1234.50 in the file.", "amount", a.slice(0, 40)); continue; }
    }
    if (signed === undefined) continue;
    if (signed === 0) { zeroSkipped++; continue; }   // a real zero line moves no cash

    const line: Line = { row, date, signed, currency, description };
    if (columns.balance !== undefined) {
      const b = text(cells[columns.balance]);
      const pb = b === "" ? undefined : parseAmount(b, currency);
      if (pb === undefined) line.balanceUnreadable = true; else line.balance = pb;
    }
    lines.push(line);
  }
  return { lines, errors, summarySkipped, zeroSkipped, ambiguousDates, rowsRead };
}

// The running balance after the newest day's last line, or undefined when that is not unambiguous.
// One line on the newest date: that line. Several: the one no other line follows, where line B follows A when
// A.balance + B.amount = B.balance. Statements list newest first or last, so file order alone proves nothing.
export function newestBalance(lines: Line[]): { date: string; amount: number; currency: string } | undefined {
  if (lines.length === 0) return undefined;
  const newest = lines.reduce((m, l) => (l.date > m ? l.date : m), "");
  const group = lines.filter((l) => l.date === newest);
  if (group.some((l) => l.balance === undefined)) return undefined;
  if (new Set(group.map((l) => l.currency)).size !== 1) return undefined;
  let last: Line | undefined;
  if (group.length === 1) last = group[0];
  else {
    const terminal = group.filter((a) => !group.some((b) => b !== a && a.balance! + b.signed === b.balance));
    if (terminal.length === 1) last = terminal[0];
  }
  return last ? { date: newest, amount: last.balance!, currency: last.currency } : undefined;
}

// ---------------------------------------------------------------- import

const MIME: Record<string, string> = { csv: "text/csv", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
const emptyMapping = (): BankMappingPreview => ({ columns: {}, headers: {}, source: "inferred" });

function failed(evidence: Evidence, message: string, nextStep: string, now: string): BankImport {
  return {
    readable: false, repeat: false, evidence, events: [], balances: [], recurring: [], mapping: emptyMapping(), unallocated: 0,
    diagnostics: summarize({ evidenceId: evidence.id, source: "bank_csv", startedAt: now, rowsRead: 0, rowsImported: 0, rowsDuplicate: 0, errors: [{ row: 1, code: "unsupported", message, nextStep }], warnings: [] }),
  };
}

export async function importBankStatement(
  input: { fileName: string; bytes: Uint8Array; receivedAt: string },
  opts: BankImportOptions,
): Promise<BankImport> {
  const now = opts.now ?? input.receivedAt;
  const hash = sha256Hex(input.bytes);
  const id = fileEvidenceId("bank_csv", hash);
  const ext = input.fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const evidence: Evidence = {
    id, channel: "bank_csv", format: ext === "xlsx" ? "xlsx" : "csv", receivedAt: input.receivedAt, fileName: input.fileName,
    mime: MIME[ext] ?? "text/csv", fileHash: hash, extraction: "ok",
    // Unique per file (the store keys evidence on system + record), so two statements never share a key.
    sourceRef: { system: "bank_csv", record: `file-${hash.slice(0, 16)}` },
  };
  if (ext !== "csv" && ext !== "xlsx") {
    return failed({ ...evidence, extraction: "unsupported" }, `"${input.fileName}" is not a CSV or XLSX file Neri can read.`, "Download the statement as CSV or Excel from your bank and upload it again.", now);
  }
  let sheets: SheetContent[];
  try {
    sheets = ext === "csv" ? [readCsv(input.bytes, id, input.fileName)] : await readXlsx(input.bytes, id);
  } catch (err) {
    const big = err instanceof ZipTooLarge;
    return failed({ ...evidence, extraction: "unreadable" },
      big ? `"${input.fileName}" is too large to read.` : `"${input.fileName}" could not be opened; it may be damaged or password protected.`,
      big ? "Download a shorter date range from your bank and upload it again." : "Download the statement again from your bank and upload it.", now);
  }

  // Header and columns: the owner's mapping over what the headers say; the first sheet that has a header.
  const owner = opts.columnMapping ?? {};
  const ownerGave = Object.keys(owner).length > 0;
  let sheet = sheets[0]!;
  let found: { headerRow: number; columns: BankMapping } | undefined;
  for (const s of sheets) {
    const h = opts.headerRow !== undefined
      ? { headerRow: opts.headerRow, columns: inferColumns(s.rows[opts.headerRow - 1] ?? []) }
      : findHeader(s.rows);
    if (h && (usable(h.columns) || ownerGave)) { sheet = s; found = h; break; }
  }
  const headerRow = found?.headerRow ?? opts.headerRow ?? (ownerGave ? 1 : undefined);
  const inferred = found?.columns ?? {};
  const columns: BankMapping = { ...inferred, ...owner };
  if (headerRow !== undefined) {
    // An owner who maps debit or credit means those columns, not a leftover inferred "amount".
    if ((owner.debit !== undefined || owner.credit !== undefined) && owner.amount === undefined) delete columns.amount;
    if (owner.amount !== undefined && owner.debit === undefined && owner.credit === undefined) { delete columns.debit; delete columns.credit; }
  }
  const headerCells = headerRow !== undefined ? sheet.rows[headerRow - 1] ?? [] : [];
  const headers: BankMappingPreview["headers"] = {};
  for (const [k, col] of Object.entries(columns) as [BankColumn, number][]) { const h = text(headerCells[col]); if (h) headers[k] = h; }
  const mapping: BankMappingPreview = {
    ...(headerRow !== undefined ? { headerRow } : {}), columns, headers,
    source: !ownerGave ? "inferred" : Object.keys(inferred).length === 0 ? "owner" : "mixed",
  };

  const empty = (message: string, nextStep: string): BankImport => ({
    readable: true, repeat: false, evidence: { ...evidence, extraction: "partial" }, events: [], balances: [], recurring: [], mapping, unallocated: 0,
    diagnostics: summarize({ evidenceId: id, source: "bank_csv", startedAt: now, rowsRead: 0, rowsImported: 0, rowsDuplicate: 0, errors: [{ row: headerRow ?? 1, sheet: sheet.sheet, code: "unmapped_column", message, nextStep }], warnings: [] }),
  });
  if (headerRow === undefined || !usable(columns)) {
    return empty("Neri could not find the date and amount columns in this statement.", "Pick which columns hold the date, the description, and the amount (or the debit and credit), then import again.");
  }

  const parsed = parseRows(sheet, columns, headerRow, opts);
  const account = opts.account && opts.account.trim() !== "" ? opts.account.trim() : DEFAULT_ACCOUNT;

  // Events: stable ids so a re-import (or an overlapping later statement) upserts the same rows.
  const seen = new Map<string, number>();
  const events: CashEvent[] = [];
  const bankLines: BankLine[] = [];
  for (const l of [...parsed.lines].sort((a, b) => a.row - b.row)) {
    const descKey = l.description.toLowerCase();
    const k = `${account}|${l.date}|${l.signed}|${l.currency}|${descKey}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    const hash16 = sha256Hex(`${k}|${n}`).slice(0, 16);
    const eventId = `evt-bank-${hash16}`;
    const direction = l.signed < 0 ? "out" : "in";
    const amount = Math.abs(l.signed);
    events.push({
      id: eventId, legIndex: 0, date: l.date, amount, currency: l.currency, amountBase: amount, direction, status: "actual", confidence: 1,
      basis: `bank line ${l.date}${l.description ? `: ${l.description}` : ""} (${direction === "out" ? "-" : "+"}${fmtMoney(amount, l.currency)}); not matched to an invoice or bill`,
      account, sourceRef: { system: "bank_csv", record: hash16 },
    });
    bankLines.push({ eventId, row: l.row, date: l.date, amount, direction, currency: l.currency, description: l.description });
  }

  // Balance: only when the newest row's balance is unambiguous.
  const balances: BalanceSnapshot[] = [];
  const warnings: string[] = [];
  const nb = columns.balance !== undefined ? newestBalance(parsed.lines) : undefined;
  if (nb) {
    const asOf = addDaysUtc(nb.date, 1);   // end-of-day balance -> start of the next day (see the header comment)
    balances.push({ id: `bal-bank-${account.replace(/[^A-Za-z0-9._-]+/g, "-")}-${asOf}`, account, amount: nb.amount, currency: nb.currency, asOf, sourceRef: { system: "bank_csv", record: `${account}:${nb.date}` } });
  } else if (events.length > 0) {
    warnings.push(columns.balance === undefined
      ? "This statement has no running-balance column, so Neri cannot set your current cash from it. Enter your current bank balance yourself."
      : "Neri could not tell which balance is the latest (several rows share the newest date, or a balance could not be read), so it did not set your current cash. Enter your current bank balance yourself.");
  }

  // Repeat: the same bytes are already in the store, read successfully.
  const known = (opts.existingEvidence ?? []).find((e) => e.fileHash === hash && (e.extraction === "ok" || e.extraction === "partial"));
  if (known) {
    return {
      readable: true, repeat: true, evidence: known, events: [], balances: [], recurring: [], mapping, unallocated: 0,
      diagnostics: summarize({ evidenceId: known.id, source: "bank_csv", startedAt: now, rowsRead: parsed.rowsRead, rowsImported: 0, rowsDuplicate: parsed.rowsRead, errors: [], warnings: ["This statement was already imported; nothing changed."], syncedAt: now }),
    };
  }

  const recurring = proposeRecurring(bankLines);
  if (events.length > 0) warnings.push(`${events.length} bank line${events.length === 1 ? " is" : "s are"} not linked to any invoice or bill. Neri does not guess which invoice a payment settles, so they stay as plain bank activity.`);
  if (recurring.length > 0) warnings.push(`${recurring.length} payment${recurring.length === 1 ? " looks" : "s look"} regular. Confirm ${recurring.length === 1 ? "it" : "them"} before ${recurring.length === 1 ? "it is" : "they are"} added to the forecast.`);
  if (parsed.summarySkipped) warnings.push(`${parsed.summarySkipped} summary row${parsed.summarySkipped === 1 ? "" : "s"} (opening balance, totals) skipped.`);
  if (parsed.zeroSkipped) warnings.push(`${parsed.zeroSkipped} zero-amount line${parsed.zeroSkipped === 1 ? "" : "s"} skipped; they move no cash.`);
  if (parsed.ambiguousDates > 0 && opts.dayFirst === undefined) warnings.push("Some dates, like 03/04/26, could be read as March 4 or April 3. Neri read them month first; tell Neri if your bank writes the day first.");

  const newest = events.reduce((m, e) => (e.date > m ? e.date : m), "");
  return {
    readable: true, repeat: false, evidence: { ...evidence, extraction: parsed.errors.length > 0 ? "partial" : "ok" }, events, balances, recurring, mapping,
    unallocated: events.length,
    diagnostics: summarize({
      evidenceId: id, source: "bank_csv", startedAt: now, rowsRead: parsed.rowsRead, rowsImported: events.length, rowsDuplicate: 0,
      errors: parsed.errors, warnings, syncedAt: now, ...(newest ? { newestRecordAt: `${newest}T00:00:00Z` } : {}),
    }),
  };
}
