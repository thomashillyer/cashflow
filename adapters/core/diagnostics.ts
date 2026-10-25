// Import diagnostics: what person 3 shows after an import. Errors are data, never thrown
// away, and a missing value is reported as missing (never zero).

export type RowErrorCode =
  | "missing_amount"
  | "missing_date"
  | "missing_reference"
  | "missing_party"
  | "invalid_amount"
  | "invalid_date"
  | "invalid_currency"
  | "unmapped_column"
  | "duplicate_in_file"
  | "unsupported";

export type RowError = {
  row: number;               // 1-based spreadsheet/file row
  sheet?: string;
  column?: string;
  code: RowErrorCode;
  message: string;           // plain words for the owner
  nextStep: string;          // what the owner can do about it
  raw?: string;              // the offending cell text, kept for the Review screen
};

export type ImportDiagnostics = {
  evidenceId: string;
  source: string;            // SourceRef.system
  startedAt: string;         // ISO 8601 UTC
  rowsRead: number;
  rowsImported: number;
  rowsDuplicate: number;     // already in the store, left unchanged
  rowsRejected: number;      // listed in errors; they add no cash
  errors: RowError[];
  warnings: string[];
  completeness: number;      // rowsImported / (rowsRead - rowsDuplicate), 1 when nothing to import
  newestRecordAt?: string;   // freshness of the data itself
  syncedAt?: string;         // when this import finished
};

export function summarize(d: Omit<ImportDiagnostics, "completeness" | "rowsRejected">): ImportDiagnostics {
  const considered = d.rowsRead - d.rowsDuplicate;
  const rowsRejected = new Set(
    d.errors.filter((e) => e.code !== "unmapped_column").map((e) => `${e.sheet ?? ""}#${e.row}`),
  ).size;
  return {
    ...d,
    rowsRejected,
    completeness: considered <= 0 ? (d.errors.length > 0 ? 0 : 1) : Math.min(1, d.rowsImported / considered),
  };
}

// Plain-words status line for the intake screen.
export function describe(d: ImportDiagnostics): string {
  const base = `${d.rowsImported} of ${d.rowsRead} rows imported`;
  const parts = [base];
  if (d.rowsDuplicate) parts.push(`${d.rowsDuplicate} already known`);
  if (d.rowsRejected) parts.push(`${d.rowsRejected} need your attention`);
  return parts.join(", ");
}
