// XLSX reader: workbook bytes -> one SheetContent per sheet, cached cell values only.
// Dates become YYYY-MM-DD (UTC), uncached formulas become null, blank edge rows/columns are trimmed.
// Sheets over the row/column limit are still returned; ai/extract/sheet.ts reports the limit problem.

import ExcelJS from "exceljs";
import type { SheetCell, SheetContent } from "../../ai/extract/sheet";

function cellValue(v: ExcelJS.CellValue): SheetCell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "object") {
    if ("result" in v) return v.result === undefined ? null : cellValue(v.result as ExcelJS.CellValue);   // formula: cached value or null
    if ("richText" in v) return v.richText.map((t) => t.text).join("").trim() || null;
    if ("text" in v && typeof v.text === "string") return v.text.trim() || null;                           // hyperlink
    if ("error" in v) return null;
  }
  return null;
}

function trim(rows: SheetCell[][]): SheetCell[][] {
  let n = rows.length;
  while (n > 0 && rows[n - 1]!.every((c) => c === null)) n--;
  let w = 0;
  for (const r of rows.slice(0, n)) {
    let k = r.length;
    while (k > 0 && r[k - 1] === null) k--;
    w = Math.max(w, k);
  }
  return rows.slice(0, n).map((r) => Array.from({ length: w }, (_, i) => r[i] ?? null));
}

export async function readXlsx(bytes: Uint8Array, evidenceId: string): Promise<SheetContent[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const out: SheetContent[] = [];
  for (const ws of wb.worksheets) {
    if (ws.state !== "visible") continue;
    const rows: SheetCell[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const cells: SheetCell[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = cellValue(cell.value); });
      for (let i = 0; i < cells.length; i++) cells[i] ??= null;
      rows[rowNumber - 1] = cells;
    });
    for (let i = 0; i < rows.length; i++) rows[i] ??= [];
    out.push({ evidenceId, sheet: ws.name, rows: trim(rows) });
  }
  return out;
}
