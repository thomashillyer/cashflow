// Layer 1 (P4.12): interpret already-read XLSX sheet content as intake candidates.
// Person 1 reads the workbook (ExcelJS) and hands over cached cell values; this module
// decides what the cells mean. Deterministic, no model calls. Cell contents are data.
//
// Rules (docs/TECHNICAL_PLAN.md section 5): one invoice per table row, a single-document
// sheet becomes one candidate, and line items + subtotal + total are never summed into
// the amount: the amount is the stated total, or missing.

import type { CandidateFields, Field, FieldEvidence, IntakeCandidate } from "../../schema/intake";
import { fieldFrom, minorUnitDigits, missing, parseAmount, parseDate } from "../normalize";

// Cached values; formulas already resolved. Dates arrive as ISO strings (or Excel serial numbers).
export type SheetCell = string | number | null;
// rows[0] is spreadsheet row 1; rows[r][c] is column c, 0-based (c = 0 is column A).
export type SheetContent = { evidenceId: string; sheet: string; rows: SheetCell[][] };

export const SHEET_MAX_ROWS = 500;
export const SHEET_MAX_COLUMNS = 50;
export const SHEET_EXTRACTION_VERSION = "sheet-1";

export type SheetLayout = "document" | "table" | "unknown";
export type SheetClassification = {
  layout: SheetLayout;
  headerRow?: number;           // 1-based spreadsheet row, for "table"
  reason: string;
};

export type ColumnKey = "reference" | "party" | "amount" | "currency" | "issueDate" | "dueDate" | "outstanding";
export type ColumnMapping = Partial<Record<ColumnKey, number>>;   // 0-based column indexes

export type ProposedMapping = {
  headerRow?: number;                                  // 1-based
  columns: ColumnMapping;                              // what was used (owner overrides win)
  headers: Partial<Record<ColumnKey, string>>;         // header text of each mapped column, for the confirm UI
  partyKind: "customer" | "vendor" | "unknown";
  source: "inferred" | "owner" | "mixed";
};

export type SheetOptions = {
  business: { name: string };
  currency?: string;            // fallback when the sheet states none; the candidate carries a note
  dayFirst?: boolean;           // ambiguous 03/04/2026 style dates
  idPrefix: string;             // candidate ids: `${idPrefix}-${row}` for tables, `${idPrefix}` for a document (`${idPrefix}-${row}` per document when a sheet is split)
};

export type TableOptions = SheetOptions & {
  columnMapping?: ColumnMapping;
  headerRow?: number;           // 1-based; owner-confirmed when the header could not be detected
};

export type TableResult = {
  candidates: IntakeCandidate[];
  rejectedRows: { row: number; reason: string }[];       // row is 1-based
  proposedMapping: ProposedMapping;
  reason?: string;              // set when nothing could be produced
};

// ---------- cell helpers ----------

const text = (c: SheetCell | undefined): string => (c === null || c === undefined ? "" : typeof c === "number" ? String(c) : c.trim());
const blankRow = (row: SheetCell[] | undefined) => !row || row.every((c) => text(c) === "");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim();

function trimmedRowCount(rows: SheetCell[][]): number {
  let n = rows.length;
  while (n > 0 && blankRow(rows[n - 1])) n--;
  return n;
}

function limitProblem(sheet: SheetContent): string | undefined {
  const n = trimmedRowCount(sheet.rows);
  if (n > SHEET_MAX_ROWS) return `Sheet "${sheet.sheet}" has ${n} rows (limit ${SHEET_MAX_ROWS}); split it or map a smaller range.`;
  let cols = 0;
  for (const r of sheet.rows.slice(0, n)) {
    let w = r.length;
    while (w > 0 && text(r[w - 1]) === "") w--;
    cols = Math.max(cols, w);
  }
  if (cols > SHEET_MAX_COLUMNS) return `Sheet "${sheet.sheet}" has ${cols} columns (limit ${SHEET_MAX_COLUMNS}); split it or map the needed columns.`;
  return undefined;
}

function numToMinor(n: number, currency: string): number | undefined {
  if (!Number.isFinite(n) || n < 0) return undefined;
  const scaled = n * 10 ** minorUnitDigits(currency);
  const r = Math.round(scaled);
  return Math.abs(scaled - r) < 1e-4 && Number.isSafeInteger(r) ? r : undefined;
}

function serialToIso(n: number): string | undefined {
  if (!Number.isFinite(n) || n < 20000 || n > 80000) return undefined;   // roughly years 1954-2118
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86_400_000).toISOString().slice(0, 10);
}

const evidenceFor = (sheet: SheetContent, row: number, cellText: string): FieldEvidence =>
  ({ evidenceId: sheet.evidenceId, sheet: sheet.sheet, row, text: cellText });

// Build a field from one cell via normalize.fieldFrom, then point its evidence at sheet/row.
// `shown` is the full cell text when the parsed value is only part of it ("Total due USD 31,200.00").
function cellField<T>(
  sheet: SheetContent, row: number, cell: SheetCell | undefined, parse: (v: string) => T | undefined, label: string, shown?: string,
): Field<T> {
  const t = text(cell);
  const f = fieldFrom({ value: t === "" ? null : t, quote: t }, [{ evidenceId: sheet.evidenceId, text: t }], parse, label);
  return f.state === "found" ? { state: "found", value: f.value, evidence: [evidenceFor(sheet, row, shown ?? t)] } : f;
}

type Ctx = { sheet: SheetContent; dayFirst?: boolean; notes: string[] };

const nonNegative = (n: number | undefined) => (n !== undefined && n >= 0 ? n : undefined);

// A money literal: digits with separators, optionally a currency symbol or ISO code. parseAmount strips every
// non-digit, so free text ("28k", "Net 30", "10% of 28,000") must be refused here first.
function looksLikeMoney(v: string): boolean {
  if (v.length > 64) return false;   // also keeps the regex cheap on hostile cells
  const m = /^\(?-?\s*(?:([A-Za-z]{3})\s*)?[$€£¥]?\s*(\d[\d.,\s]*)\)?\s*(?:([A-Za-z]{3}))?-?$/.exec(v.trim());
  return !!m && (!m[1] || !!currencyCode(m[1])) && (!m[3] || !!currencyCode(m[3]));
}

// A currency written inside an amount cell ("EUR 5,000", "5,000 JPY", "€1,200"). A bare "$" says nothing (USD, CAD, AUD...),
// and "¥" is JPY or CNY: ambiguous unless something else settles it.
function embeddedCurrency(v: string): { code?: string; ambiguous?: boolean } {
  if (v.length > 200) return {};
  for (const m of v.matchAll(/\b[A-Za-z]{3}\b/g)) {
    const c = currencyCode(m[0]);
    if (c) return { code: c };
  }
  if (v.includes("€")) return { code: "EUR" };
  if (v.includes("£")) return { code: "GBP" };
  if (v.includes("¥")) return { ambiguous: true };
  return {};
}

function amountField(ctx: Ctx, row: number, cell: SheetCell | undefined, currency: string, label: string, shown?: string): Field<number> {
  return cellField(ctx.sheet, row, cell, (v) => {
    if (typeof cell === "number") return numToMinor(cell, currency);
    if (!looksLikeMoney(v)) return undefined;
    // Never let a default or another column override the currency written in the cell itself.
    const e = embeddedCurrency(v);
    if ((e.code && e.code !== currency) || (e.ambiguous && currency !== "JPY" && currency !== "CNY")) {
      ctx.notes.push(`${label} "${v}" (row ${row}) is written in ${e.code ?? "JPY or CNY"} but the currency is ${currency}; amount left blank. Pick the currency.`);
      return undefined;
    }
    return nonNegative(parseAmount(v, currency));
  }, label, shown);
}

function dateField(ctx: Ctx, row: number, cell: SheetCell | undefined, label: string, shown?: string): Field<string> {
  return cellField(ctx.sheet, row, cell, (v) => {
    if (typeof cell === "number") return serialToIso(cell);
    const p = parseDate(v, { ...(ctx.dayFirst !== undefined ? { dayFirst: ctx.dayFirst } : {}) });
    if (p?.ambiguous) ctx.notes.push(`${label} "${v}" (row ${row}) is ambiguous; read as ${p.date}. Check day/month order.`);
    return p?.date;
  }, label, shown);
}

const isCurrency = (code: string) => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("currency").includes(code);
  } catch {
    return true;
  }
};
const currencyCode = (s: string): string | undefined => {
  const t = s.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(t) && isCurrency(t) ? t : undefined;
};

// Loose name match: punctuation and legal suffixes ("Co", "LLC", "Inc") do not matter.
const bareName = (s: string) => ` ${norm(s).replace(/\b(co|company|llc|inc|incorporated|ltd|limited|corp|corporation|gmbh)\b/g, " ").replace(/\s+/g, " ").trim()} `;
const mentions = (haystack: string, name: string) => {
  const n = bareName(name);
  return n.trim() !== "" && bareName(haystack).includes(n);
};

// Our own side of the document: found only when the sheet actually names the business.
const firstContentRow = (rows: SheetCell[][]): number => {
  const i = rows.findIndex((r) => !blankRow(r));
  return i < 0 ? 0 : i;
};

function businessField(sheet: SheetContent, name: string): Field<string> {
  const s = firstContentRow(sheet.rows);
  for (let r = s; r < Math.min(sheet.rows.length, s + 30); r++) {
    for (const c of sheet.rows[r] ?? []) {
      const t = text(c);
      if (typeof c === "string" && t && mentions(t, name)) return { state: "found", value: name, evidence: [evidenceFor(sheet, r + 1, t)] };
    }
  }
  return missing("the sheet does not name the business");
}

const letterhead = (sheet: SheetContent, name: string): boolean =>
  sheet.rows.slice(firstContentRow(sheet.rows), firstContentRow(sheet.rows) + 5).some((row) => row.some((c) => typeof c === "string" && mentions(c, name)));

// ---------- table layout ----------

// Footer rows: in the reference cell any text that starts with "Total" ("Total (4 invoices)", "Total 50,200");
// in other cells only the bare word, so a customer called "Total Wine" survives.
const TOTAL_REF = /^\s*(grand |sub[ -]?|report )?totals?\b/i;
const TOTAL_CELL = /^(grand |sub[ -]?|report )?totals?\s*:?$/i;
// A footer label in any cell of the row: "Total outstanding", "Grand total: 3,000", "Balance carried forward". Still not
// "Total Wine": after the word the label must end, carry a figure, or continue with a money word.
const TOTAL_LABEL = /^\s*(?:(?:grand\s+|sub[ -]?)?totals?(?=\s*(?:[:(-]|\d|$)|\s+(?:due|outstanding|amount|balance|payable|open|owing|receivable|invoiced|usd|eur|gbp|cad|aud|jpy|cny|inr|mxn|chf)\b)|balance\s+carried\b)/i;
const isTotalsRow = (row: SheetCell[], refCol: number): boolean =>
  TOTAL_REF.test(text(row[refCol])) || row.some((c) => typeof c === "string" && (TOTAL_CELL.test(c.trim()) || TOTAL_LABEL.test(c)));

const HEADER_PATTERNS: Record<ColumnKey, RegExp[]> = {
  reference: [/^(invoice|inv|bill|document|doc|reference|ref)( (#|no|num|number|id))?$/, /^(number|no|#|id)$/],
  party: [/^(customer|client|vendor|supplier|buyer|seller|payee|bill to|billed to|sold to|pay to|party|account|name)( name)?$/],
  currency: [/^(currency|ccy|cur)( code)?$/],
  issueDate: [/^(invoice|issue|bill|doc|document) date$/, /^(issued|date issued|date)$/],
  dueDate: [/^(due date|payment due|payment due date|due on|pay by|due)$/],
  outstanding: [/^(amount due|balance due|balance|outstanding|open balance|amount outstanding|amount remaining|remaining|open amount)$/],
  amount: [/^(invoice total|invoice amount|total amount|total|amount|gross amount|gross)$/],
};
const COLUMN_ORDER: ColumnKey[] = ["reference", "party", "currency", "issueDate", "dueDate", "outstanding", "amount"];

function inferColumns(row: SheetCell[]): ColumnMapping {
  const out: ColumnMapping = {};
  const used = new Set<number>();
  for (const key of COLUMN_ORDER) {
    let best: { prio: number; col: number } | undefined;
    row.forEach((c, col) => {
      if (typeof c !== "string" || used.has(col)) return;
      const h = norm(c);
      const prio = HEADER_PATTERNS[key].findIndex((re) => re.test(h));
      if (prio >= 0 && (!best || prio < best.prio)) best = { prio, col };
    });
    if (best) { out[key] = best.col; used.add(best.col); }
  }
  // "Amount due" / "Balance due" with no total or amount column: it is all there is for the amount (see amountIsBalance).
  if (out.amount === undefined && out.outstanding !== undefined) out.amount = out.outstanding;
  return out;
}

const amountIsBalance = (c: ColumnMapping) => c.amount !== undefined && c.amount === c.outstanding;

function findTableHeader(rows: SheetCell[][]): { headerRow: number; columns: ColumnMapping } | undefined {
  const n = trimmedRowCount(rows);
  for (let r = 0; r < Math.min(n, 25); r++) {
    const columns = inferColumns(rows[r] ?? []);
    if (columns.reference === undefined || columns.amount === undefined) continue;
    // At least one data row must carry an invoice-number-like value, or this is a header block of a single document.
    if (rows.slice(r + 1, n).some((x) => /\d/.test(text(x[columns.reference!])) && !TOTAL_REF.test(text(x[columns.reference!])))) return { headerRow: r + 1, columns };
  }
  return undefined;
}

// ---------- document layout ----------

type LabelKey =
  | "subtotal" | "totalDue" | "grandTotal" | "total" | "amountDue" | "charge" | "issueDate" | "dueDate"
  | "terms" | "buyer" | "seller" | "currency" | "po" | "reference";

// Full-cell matches are tried first, then "Label value" inline cells. Order matters.
const LABELS: [LabelKey, string][] = [
  ["subtotal", "sub ?total"],
  ["totalDue", "total due"],
  ["grandTotal", "grand total|invoice total|total amount|total payable"],
  ["amountDue", "amount due|balance due|balance|outstanding|amount outstanding|open balance"],
  ["total", "total"],
  ["charge", "freight|shipping( and handling)?|delivery|handling|(sales )?tax( [0-9.]+ ?%?)?|vat|gst|hst|discount|surcharge"],
  ["issueDate", "invoice date|issue date|date issued|bill date|date"],
  ["dueDate", "due date|payment due|due by|due on|due"],
  ["terms", "payment terms|terms"],
  ["po", "customer po|purchase order( #| no| number)?|po( #| no| number)?"],
  ["reference", "invoice ?(#|no|number|num|id)|bill ?(#|no|number|num|id)|inv ?(#|no)|document ?(#|no|number)|invoice"],
  ["buyer", "bill to|billed to|sold to|customer( name)?|client|buyer"],
  ["seller", "vendor( name)?|supplier( name)?|seller|from"],
  ["currency", "currency|ccy"],
];
const FULL = LABELS.map(([k, src]) => [k, new RegExp(`^(?:${src})$`)] as const);
const INLINE = LABELS.map(([k, src]) => [k, new RegExp(`^(?:${src})\\s*#?\\s+(.*\\d.*)$`)] as const);
const INLINE_OK = new Set<LabelKey>(["subtotal", "totalDue", "grandTotal", "amountDue", "total", "reference", "issueDate", "dueDate", "po"]);
const AMOUNT_LABELS = new Set<LabelKey>(["subtotal", "totalDue", "grandTotal", "amountDue", "total", "charge"]);

type LabelHit = { key: LabelKey; label: string; inline?: string };

function labelOf(cell: SheetCell | undefined): LabelHit | undefined {
  if (typeof cell !== "string") return undefined;
  const t = norm(cell);
  if (!t) return undefined;
  for (const [key, re] of FULL) if (re.test(t)) return { key, label: t };
  const lowered = cell.trim().replace(/\s+/g, " ").toLowerCase().replace(/^([a-z ]+?):\s*/, "$1 ");
  for (const [key, re] of INLINE) {
    if (!INLINE_OK.has(key)) continue;
    const m = re.exec(lowered);
    if (!m) continue;
    const inline = cell.trim().slice(cell.trim().length - m[1]!.length).trim();
    if (AMOUNT_LABELS.has(key) && !looksLikeMoney(inline)) continue;
    return { key, label: norm(cell.trim().slice(0, cell.trim().length - m[1]!.length)), inline };
  }
  return undefined;
}

type LineBlock = { header: number; descCol: number; amountCol?: number; rows: number[] };

const SUMMARY_CELL = /^(sub ?-?total|grand total|total( due| amount)?|amount due|balance( due)?)\s*:?$/i;

function lineHeader(row: SheetCell[] | undefined): { heads: string[]; descCol: number } | undefined {
  const heads = (row ?? []).map((c) => (typeof c === "string" ? norm(c) : ""));
  const descCol = heads.findIndex((h) => /^(description|item|items|product|service|details|item description)$/.test(h));
  const numeric = heads.filter((h, i) => i !== descCol && /^(qty|quantity|unit price|price|rate|amount|line total|total)$/.test(h));
  const hasUnits = numeric.some((h) => /^(qty|quantity|unit price|price|rate)$/.test(h));
  // A grid headed "SKU | Qty | Unit price | Total" is a line block too; its "Total" is not the document total.
  return (descCol >= 0 ? numeric.length >= 1 : hasUnits && numeric.length >= 2) ? { heads, descCol } : undefined;
}

function findLineItems(rows: SheetCell[][]): LineBlock | undefined {
  const n = trimmedRowCount(rows);
  for (let r = 0; r < n; r++) {
    const head = lineHeader(rows[r]);
    if (!head) continue;
    const { heads, descCol } = head;
    const amountCol = heads.findIndex((h) => /^(amount|line total|total|extended( amount| price)?|ext amount|ext price)$/.test(h));
    const items: number[] = [];
    for (let i = r + 1; i < n; i++) {
      const x = rows[i] ?? [];
      if (blankRow(x)) break;
      if (x.some((c) => typeof c === "string" && SUMMARY_CELL.test(c.trim()))) break;
      items.push(i);
    }
    return { header: r, descCol, ...(amountCol >= 0 ? { amountCol } : {}), rows: items };
  }
  return undefined;
}

type Found = { key: LabelKey; label: string; r: number; c: number; cell: SheetCell; shown: string };

// Value for a label: inline text, else the next non-blank cell to the right, else the cell below.
function valueFor(rows: SheetCell[][], r: number, c: number, hit: LabelHit): Found | undefined {
  const found = valueNear(rows, r, c, hit);
  // A bare "Invoice" is usually the page title; it only labels an id-like value beside it (not an address below it).
  if (found && hit.label === "invoice") {
    const idLike = /^[A-Za-z0-9][A-Za-z0-9\-/_.]+$/.test(text(found.cell)) && /\d/.test(text(found.cell));
    if (!idLike || (hit.inline === undefined && found.r !== r)) return undefined;
  }
  return found;
}

function valueNear(rows: SheetCell[][], r: number, c: number, hit: LabelHit): Found | undefined {
  const base = { key: hit.key, label: hit.label, r, c };
  if (hit.inline !== undefined) return { ...base, cell: hit.inline, shown: text(rows[r]?.[c]) };
  const row = rows[r] ?? [];
  for (let cc = c + 1; cc < row.length; cc++) {
    if (text(row[cc]) === "") continue;
    if (labelOf(row[cc])) break;
    return { ...base, c: cc, cell: row[cc] ?? null, shown: text(row[cc]) };
  }
  const below = rows[r + 1]?.[c];
  if (below !== undefined && below !== null && text(below) !== "" && !labelOf(below)) return { ...base, r: r + 1, cell: below, shown: text(below) };
  return undefined;
}

// ---------- stacked documents ----------

const DOC_TITLE = /^(tax |sales |vendor )?(invoice|bill)$/;
const TOTAL_KEYS = new Set<LabelKey>(["totalDue", "grandTotal", "total", "amountDue"]);

// A row that states a total, ignoring a line-item grid's own "Total" header.
function statesTotal(rows: SheetCell[][], r: number): boolean {
  if (lineHeader(rows[r])) return false;
  return (rows[r] ?? []).some((cell, c) => {
    const hit = labelOf(cell);
    return !!hit && TOTAL_KEYS.has(hit.key) && !!valueFor(rows, r, c, hit);
  });
}

// The invoice number a row labels, if any ("Invoice # INV-2", or "Invoice" beside an id).
function referenceIn(rows: SheetCell[][], r: number): string | undefined {
  for (const [c, cell] of (rows[r] ?? []).entries()) {
    const hit = labelOf(cell);
    if (hit?.key !== "reference") continue;
    const v = valueFor(rows, r, c, hit);
    if (v) return text(v.cell).toLowerCase();
  }
  return undefined;
}

// First row (0-based) of each document on a sheet. A new document starts at a second "Invoice"/"Bill" title, or at
// a different invoice-number label after the previous one already stated a total. Rows right above that label
// (letterhead, our name) belong to the new document.
export function documentStarts(rows: SheetCell[][]): number[] {
  const n = trimmedRowCount(rows);
  let cur = firstContentRow(rows);
  const starts = [cur];
  let sawTotal = false;
  let sawBody = false;
  let curRef: string | undefined;
  for (let r = cur; r < n; r++) {
    const row = rows[r] ?? [];
    if (blankRow(row)) continue;
    const filled = row.filter((c) => text(c) !== "");
    const title = filled.length === 1 && typeof filled[0] === "string" && DOC_TITLE.test(norm(filled[0]));
    const ref = referenceIn(rows, r);
    let start: number | undefined;
    if (title && r > cur && sawBody) start = r;
    else if (!title && ref !== undefined && sawTotal && ref !== curRef) {
      start = r;
      while (start - 1 > cur && !blankRow(rows[start - 1]) && !statesTotal(rows, start - 1)) start--;
    }
    if (start !== undefined) {
      starts.push(start);
      cur = start;
      sawTotal = false;
      sawBody = false;
      curRef = undefined;
    }
    if (!title) sawBody = true;
    if (ref !== undefined && curRef === undefined) curRef = ref;
    if (statesTotal(rows, r)) sawTotal = true;
  }
  return starts;
}

// Only rows start..end-1 of the sheet, with row numbers (and so evidence) unchanged.
const blockOf = (sheet: SheetContent, start: number, end: number): SheetContent =>
  ({ ...sheet, rows: sheet.rows.map((row, i) => (i >= start && i < end ? row : [])) });

export function classifySheet(sheet: SheetContent): SheetClassification {
  const problem = limitProblem(sheet);
  if (problem) return { layout: "unknown", reason: problem };
  const header = findTableHeader(sheet.rows);
  if (header) {
    return { layout: "table", headerRow: header.headerRow, reason: `Header row ${header.headerRow} has an invoice number column and an amount column, with data rows below.` };
  }
  const block = findLineItems(sheet.rows);
  const seen = new Set<LabelKey>();
  sheet.rows.forEach((row, r) => row.forEach((cell, c) => {
    if (block && r === block.header) return;
    const hit = labelOf(cell);
    if (hit && valueFor(sheet.rows, r, c, hit)) seen.add(hit.key);
  }));
  const hasTotal = (["totalDue", "grandTotal", "total", "amountDue"] as LabelKey[]).some((k) => seen.has(k));
  const support = [seen.has("reference"), seen.has("buyer") || seen.has("seller"), seen.has("dueDate"), seen.has("issueDate"), !!block].filter(Boolean).length;
  if (hasTotal && support >= 2) {
    return { layout: "document", reason: `Label/value pairs for a single document (total${seen.has("reference") ? ", invoice number" : ""}${block ? ", line items" : ""}).` };
  }
  return { layout: "unknown", reason: "No invoice table header (invoice number plus amount) and not enough invoice labels (total, invoice number, bill to, dates); needs the owner to map it." };
}

// ---------- shared candidate assembly ----------

type PartyKind = "customer" | "vendor" | "unknown";
const CUSTOMER_HEADER = /^(customer|client|bill(ed)? to|sold to|buyer)\b/;
const VENDOR_HEADER = /^(vendor|supplier|payee|seller|pay to)\b/;

function partyKind(header: string | undefined): PartyKind {
  const h = norm(header ?? "");
  return CUSTOMER_HEADER.test(h) ? "customer" : VENDOR_HEADER.test(h) ? "vendor" : "unknown";
}

function assemble(args: {
  id: string; sheet: SheetContent; kind: "invoice" | "bill"; counterparty: Field<string>; business: Field<string>;
  fields: Omit<CandidateFields, "sellerName" | "buyerName">; notes: string[]; base: number; partial?: boolean;
  assumedCurrency?: string;     // currency came from the profile default, not the sheet
}): IntakeCandidate {
  const { kind, counterparty, business, fields } = args;
  const full: CandidateFields = {
    sellerName: kind === "invoice" ? business : counterparty,
    buyerName: kind === "invoice" ? counterparty : business,
    ...fields,
  };
  const notes = [...args.notes];
  if (full.amount.state === "found" && full.amount.value === 0) {
    full.amount = missing("amount is 0; check the source");
    notes.push("The sheet shows an amount of 0 (possibly an uncalculated formula); treated as missing.");
  }
  if (full.amount.state === "missing") notes.push("Amount is missing; enter it manually before this can be confirmed.");
  if (full.currency.state !== "found") notes.push("Currency is missing; amounts were read assuming 2 decimal places.");
  if (args.assumedCurrency) notes.push(`currency assumed from profile default (${args.assumedCurrency}); confirm`);
  const ok = full.amount.state === "found" && full.currency.state === "found" && !args.partial && !args.assumedCurrency;
  const lacking = [full.reference, full.amount, full.dueDate, counterparty].filter((f) => f.state !== "found").length;
  return {
    id: args.id,
    revision: 1,
    extractionVersion: SHEET_EXTRACTION_VERSION,
    evidenceIds: [args.sheet.evidenceId],
    kind,
    direction: kind === "invoice" ? "in" : "out",
    fields: full,
    confidence: Math.max(0.3, Math.round((args.base - 0.1 * lacking) * 100) / 100),
    extraction: ok ? "ok" : "partial",
    notes,
  };
}

// ---------- tableToCandidates ----------


export function tableToCandidates(sheet: SheetContent, opts: TableOptions): TableResult {
  const empty = (reason: string, mapping: ProposedMapping): TableResult => ({ candidates: [], rejectedRows: [], proposedMapping: mapping, reason });
  const problem = limitProblem(sheet);
  if (problem) return empty(problem, { columns: {}, headers: {}, partyKind: "unknown", source: "inferred" });

  const detected = findTableHeader(sheet.rows);
  const headerRow = opts.headerRow ?? detected?.headerRow ?? (opts.columnMapping ? 1 : undefined);
  const inferred = headerRow !== undefined ? inferColumns(sheet.rows[headerRow - 1] ?? []) : {};
  const columns: ColumnMapping = { ...inferred, ...opts.columnMapping };
  const owner = Object.keys(opts.columnMapping ?? {}).length > 0;
  const headerCells = headerRow !== undefined ? sheet.rows[headerRow - 1] ?? [] : [];
  const headers: ProposedMapping["headers"] = {};
  for (const [k, col] of Object.entries(columns) as [ColumnKey, number][]) {
    const h = text(headerCells[col]);
    if (h) headers[k] = h;
  }
  const kindHint = partyKind(headers.party);
  const proposedMapping: ProposedMapping = {
    ...(headerRow !== undefined ? { headerRow } : {}),
    columns, headers, partyKind: kindHint,
    source: !owner ? "inferred" : Object.keys(inferred).length === 0 ? "owner" : "mixed",
  };
  if (headerRow === undefined || columns.reference === undefined || columns.amount === undefined) {
    return empty("Could not find an invoice number column and an amount column; confirm the column mapping.", proposedMapping);
  }

  const refHeader = norm(headers.reference ?? "");
  const kind: "invoice" | "bill" = kindHint === "vendor" || (kindHint === "unknown" && /^bill\b/.test(refHeader)) ? "bill" : "invoice";
  const baseNotes: string[] = [];
  if (kindHint === "unknown") {
    baseNotes.push(columns.party === undefined
      ? "No customer or vendor column; treated as an invoice (money in). Check the direction."
      : `Party column "${headers.party ?? ""}" does not say customer or vendor; treated as ${kind === "bill" ? "a bill (money out)" : "an invoice (money in)"}. Check the direction.`);
  }
  const business = businessField(sheet, opts.business.name);
  const defaultCurrency = opts.currency ? currencyCode(opts.currency) : undefined;

  if (amountIsBalance(columns)) {
    baseNotes.push(`The only money column is headed "${headers.outstanding ?? headers.amount ?? ""}" (no total or amount column); used as the amount and as outstanding, but after part payments a balance is less than the invoice total.`);
  }

  const candidates: IntakeCandidate[] = [];
  const rejectedRows: TableResult["rejectedRows"] = [];
  const n = trimmedRowCount(sheet.rows);
  // The same invoice number twice for the same party is a line-item listing, not two invoices.
  const refKey = (row: SheetCell[]) => `${text(row[columns.reference!]).toLowerCase()}|${columns.party !== undefined ? text(row[columns.party]).toLowerCase() : ""}`;
  const refCounts = new Map<string, number>();
  for (let r = headerRow; r < n; r++) {
    const row = sheet.rows[r] ?? [];
    const ref = text(row[columns.reference]);
    if (blankRow(row) || !/\d/.test(ref) || isTotalsRow(row, columns.reference)) continue;
    refCounts.set(refKey(row), (refCounts.get(refKey(row)) ?? 0) + 1);
  }
  for (let r = headerRow; r < n; r++) {
    const row = sheet.rows[r] ?? [];
    const rowNo = r + 1;
    if (blankRow(row)) continue;
    const refText = text(row[columns.reference]);
    if (isTotalsRow(row, columns.reference)) {
      rejectedRows.push({ row: rowNo, reason: "Totals row; not an invoice." });
      continue;
    }
    if (refText === "") { rejectedRows.push({ row: rowNo, reason: "No invoice number." }); continue; }
    if (!/\d/.test(refText)) { rejectedRows.push({ row: rowNo, reason: `"${refText}" does not look like an invoice number.` }); continue; }

    if ((refCounts.get(refKey(row)) ?? 0) > 1) {
      rejectedRows.push({ row: rowNo, reason: `Invoice number "${refText}" repeats with the same party; looks like line items, not separate invoices.` });
      continue;
    }

    const notes = [...baseNotes];
    const ctx: Ctx = { sheet, ...(opts.dayFirst !== undefined ? { dayFirst: opts.dayFirst } : {}), notes };
    const reference = cellField(sheet, rowNo, row[columns.reference], (v) => v, "Invoice number");
    const party = columns.party !== undefined ? cellField(sheet, rowNo, row[columns.party], (v) => v, "Party name") : missing<string>("no party column");

    let assumedCurrency: string | undefined;
    let currency: Field<string> = columns.currency !== undefined
      ? cellField(sheet, rowNo, row[columns.currency], currencyCode, "Currency")
      : missing("no currency column");
    const amountText = text(row[columns.amount]);
    const embedded = typeof row[columns.amount] === "string" ? embeddedCurrency(amountText) : {};
    if (currency.state !== "found" && embedded.code) {
      currency = { state: "found", value: embedded.code, evidence: [evidenceFor(sheet, rowNo, amountText)] };
    } else if (currency.state !== "found" && defaultCurrency && amountText && !embedded.ambiguous) {
      currency = { state: "found", value: defaultCurrency, evidence: [evidenceFor(sheet, rowNo, `${amountText} (currency assumed from profile default ${defaultCurrency})`)] };
      assumedCurrency = defaultCurrency;
    }
    const cur = currency.state === "found" ? currency.value : "USD";
    const fields: Omit<CandidateFields, "sellerName" | "buyerName"> = {
      reference,
      amount: amountField(ctx, rowNo, row[columns.amount], cur, "Amount"),
      currency,
      issueDate: columns.issueDate !== undefined ? dateField(ctx, rowNo, row[columns.issueDate], "Issue date") : missing("no issue date column"),
      dueDate: columns.dueDate !== undefined ? dateField(ctx, rowNo, row[columns.dueDate], "Due date") : missing("no due date column"),
      ...(columns.outstanding !== undefined ? { outstanding: amountField(ctx, rowNo, row[columns.outstanding], cur, "Outstanding") } : {}),
    };
    candidates.push(assemble({
      id: `${opts.idPrefix}-${rowNo}`, sheet, kind, counterparty: party, business, fields, notes,
      base: owner ? 0.9 : 0.85, ...(assumedCurrency ? { assumedCurrency } : {}),
    }));
  }
  return { candidates, rejectedRows, proposedMapping };
}

// ---------- documentToCandidate ----------

// One document per sheet. If the sheet stacks several, only the first is read, flagged partial with a note;
// totals are never merged across documents. documentsToCandidates splits them.
export function documentToCandidate(sheet: SheetContent, opts: SheetOptions): IntakeCandidate {
  const starts = documentStarts(sheet.rows);
  if (starts.length <= 1) return buildDocument(sheet, opts, {});
  return buildDocument(blockOf(sheet, starts[0]!, starts[1]!), opts, { stackedNote: stackedNote(starts) });
}

const stackedNote = (starts: number[]) =>
  `This sheet appears to hold ${starts.length} documents (the next starts at row ${starts[1]! + 1}); only the first was read and nothing was added across them. Check the sheet.`;

// Every document on the sheet, in order. One document keeps id `${idPrefix}`; several get `${idPrefix}-${firstRow}`.
// When a later block has no invoice number and no total (a stray second title), the split is unclear: return the first
// document only, flagged partial.
export function documentsToCandidates(sheet: SheetContent, opts: SheetOptions): IntakeCandidate[] {
  const starts = documentStarts(sheet.rows);
  if (starts.length <= 1) return [buildDocument(sheet, opts, {})];
  const n = trimmedRowCount(sheet.rows);
  const blocks = starts.map((s, i) => blockOf(sheet, s, starts[i + 1] ?? n));
  const real = (b: SheetContent) => b.rows.some((_, r) => referenceIn(b.rows, r) !== undefined || statesTotal(b.rows, r));
  if (!blocks.slice(1).every(real)) {
    return [buildDocument(blocks[0]!, opts, { stackedNote: stackedNote(starts) })];
  }
  return blocks.map((b, i) => buildDocument(b, { ...opts, idPrefix: `${opts.idPrefix}-${starts[i]! + 1}` }, {}));
}

function buildDocument(sheet: SheetContent, opts: SheetOptions, extra: { stackedNote?: string }): IntakeCandidate {
  const rows = sheet.rows;
  const block = findLineItems(rows);
  const notes: string[] = ["Interpreted as a single document from label/value pairs; confirm before it creates anything."];
  if (extra.stackedNote) notes.push(extra.stackedNote);
  const ctx: Ctx = { sheet, ...(opts.dayFirst !== undefined ? { dayFirst: opts.dayFirst } : {}), notes };
  const lineRows = new Set(block?.rows ?? []);

  const found = new Map<LabelKey, Found[]>();
  rows.forEach((row, r) => row.forEach((cell, c) => {
    if (block && (r === block.header || lineRows.has(r))) return;
    const hit = labelOf(cell);
    const v = hit ? valueFor(rows, r, c, hit) : undefined;
    if (v) found.set(v.key, [...(found.get(v.key) ?? []), v]);
  }));
  const first = (k: LabelKey) => found.get(k)?.[0];
  const ev = (f: Found) => evidenceFor(sheet, f.r + 1, f.shown);

  const tierA = (["totalDue", "grandTotal", "total"] as LabelKey[]).flatMap((k) => found.get(k) ?? []);
  const tierB = found.get("amountDue") ?? [];
  const totalCells = tierA.length > 0 ? tierA : tierB;

  // Currency: explicit label, else a code written next to a total, else the business default.
  let currency: Field<string> = missing("currency not stated");
  let yen = false;
  let assumedCurrency: string | undefined;
  const curLabel = first("currency");
  const fromLabel = curLabel ? currencyCode(text(curLabel.cell)) : undefined;
  if (curLabel && fromLabel) currency = { state: "found", value: fromLabel, evidence: [ev(curLabel)] };
  else {
    for (const f of [...totalCells, ...(found.get("subtotal") ?? [])]) {
      const e = embeddedCurrency(f.shown);
      if (e.ambiguous) yen = true;
      const parsed = e.code;
      if (parsed) { currency = { state: "found", value: parsed, evidence: [ev(f)] }; break; }
    }
  }
  const defaultCurrency = opts.currency ? currencyCode(opts.currency) : undefined;
  if (currency.state !== "found" && defaultCurrency && totalCells[0] && !yen) {
    currency = { state: "found", value: defaultCurrency, evidence: [evidenceFor(sheet, totalCells[0].r + 1, `${totalCells[0].shown} (currency assumed from profile default ${defaultCurrency})`)] };
    assumedCurrency = defaultCurrency;
  }
  const cur = currency.state === "found" ? currency.value : "USD";
  const asAmount = (f: Found, label: string) => amountField(ctx, f.r + 1, f.cell, cur, label, f.shown);

  // Amount: the stated total. Never a sum. Differing totals are a conflict for the owner.
  let amount: Field<number> = missing("no total line; line items not summed");
  const stated = totalCells.flatMap((f) => {
    const a = asAmount(f, "Total");
    return a.state === "found" ? [{ value: a.value, evidence: a.evidence }] : [];
  });
  if (stated.length > 0) {
    const distinct = [...new Set(stated.map((s) => s.value))];
    if (distinct.length === 1) amount = { state: "found", value: distinct[0]!, evidence: stated.flatMap((s) => s.evidence) };
    else {
      amount = { state: "conflict", values: distinct.map((v) => ({ value: v, evidence: stated.filter((s) => s.value === v).flatMap((s) => s.evidence) })) };
      notes.push("The sheet states more than one different total; the owner must pick the document total.");
    }
  } else if (totalCells.length > 0) {
    amount = missing(`total "${totalCells[0]!.shown}" could not be read`);
  }

  // Outstanding: a balance/amount-due line. Alone, it is also all we have for the amount, so say so.
  let outstanding: Field<number> | undefined;
  if (tierB[0]) {
    const o = asAmount(tierB[0], "Outstanding");
    if (o.state === "found") outstanding = o;
    if (tierA.length === 0) notes.push("Only a balance/amount due line is stated; used as the amount, but after part payments it is less than the invoice total.");
  }

  // Reconciliation note only: line items + charges vs the stated total. Never overrides it.
  const total = amount.state === "found" ? amount.value : undefined;
  const amountCol = block?.amountCol;
  if (total !== undefined && block && amountCol !== undefined && block.rows.length > 0) {
    const items = block.rows.flatMap((i) => {
      const f = amountField(ctx, i + 1, rows[i]?.[amountCol], cur, "Line amount");
      return f.state === "found" ? [f.value] : [];
    });
    if (items.length > 0) {
      const lineSum = items.reduce((a, b) => a + b, 0);
      let adjust = 0;
      for (const f of found.get("charge") ?? []) {
        const a = asAmount(f, "Charge");
        if (a.state === "found") adjust += /discount/.test(f.label) ? -a.value : a.value;
      }
      const sub = first("subtotal") ? asAmount(first("subtotal")!, "Subtotal") : undefined;
      const subtotal = sub?.state === "found" ? sub.value : undefined;
      const reconciles = [lineSum, subtotal].some((b) => b !== undefined && (b + adjust === total || b === total));
      if (!reconciles) {
        const digits = minorUnitDigits(cur);
        const fmt = (n: number) => (n / 10 ** digits).toFixed(digits);
        notes.push(`Line items sum to ${fmt(lineSum)}${adjust ? ` and charges/discounts to ${fmt(adjust)}` : ""}, which does not match the stated total ${fmt(total)}. Kept the stated total; check the document.`);
      }
    }
  }

  const refF = first("reference");
  const buyerF = first("buyer");
  const sellerF = first("seller");
  const name = opts.business.name;
  let kind: "invoice" | "bill" | undefined;
  if (sellerF && mentions(text(sellerF.cell), name)) kind = "invoice";
  else if (buyerF && mentions(text(buyerF.cell), name)) kind = "bill";
  else if (sellerF && /^(vendor|supplier)/.test(sellerF.label)) kind = "bill";
  // Our name as the letterhead (top rows) above a "Bill to" someone else: we issued it.
  else if (buyerF && letterhead(sheet, name)) kind = "invoice";
  // The direction is a guess unless the sheet names the business or labels a vendor; a guess is never "ok".
  const directionGuessed = !kind;
  if (!kind) {
    kind = "invoice";
    notes.push("Could not tell whether the business issued or received this document; treated as an invoice (money in). Check the direction.");
  }
  const counterF = kind === "invoice" ? buyerF : sellerF;
  const str = (f: Found | undefined, label: string, absent: string): Field<string> =>
    f ? cellField(sheet, f.r + 1, f.cell, (v) => v, label, f.shown) : missing(absent);
  const dateOf = (k: LabelKey, label: string): Field<string> => {
    const f = first(k);
    return f ? dateField(ctx, f.r + 1, f.cell, label, f.shown) : missing(`no ${label.toLowerCase()} label`);
  };
  const termsF = first("terms");
  const poF = first("po");
  const fields: Omit<CandidateFields, "sellerName" | "buyerName"> = {
    reference: str(refF, "Invoice number", "no invoice number label"),
    amount,
    currency,
    issueDate: dateOf("issueDate", "Issue date"),
    dueDate: dateOf("dueDate", "Due date"),
    ...(outstanding ? { outstanding } : {}),
    ...(termsF ? { terms: str(termsF, "Terms", "") } : {}),
    ...(poF ? { poReference: str(poF, "PO reference", "") } : {}),
  };
  return assemble({
    id: opts.idPrefix, sheet, kind, counterparty: str(counterF, "Party name", "no party label"),
    business: businessField(sheet, name), fields, notes, base: 0.8,
    partial: directionGuessed || extra.stackedNote !== undefined, ...(assumedCurrency ? { assumedCurrency } : {}),
  });
}
