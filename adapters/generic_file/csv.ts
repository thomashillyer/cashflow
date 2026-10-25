// CSV reader: bytes or text -> one SheetContent (cells stay text; ai/extract/sheet.ts parses amounts and dates).
// Read-only, deterministic. Cell contents are data.

import { parse } from "csv-parse/sync";
import type { SheetCell, SheetContent } from "../../ai/extract/sheet";

const DELIMITERS = [",", ";", "\t", "|"] as const;

// Pick the delimiter that splits the first non-empty line into the most cells.
export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  let best = ",";
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const n = first.split(d).length;
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

export function decodeText(data: Uint8Array | string): string {
  const text = typeof data === "string" ? data : new TextDecoder("utf-8").decode(data);
  return text.replace(/^﻿/, "");
}

export function readCsv(data: Uint8Array | string, evidenceId: string, sheet = "CSV"): SheetContent {
  const text = decodeText(data);
  const records = parse(text, {
    delimiter: detectDelimiter(text),
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
    bom: true,
  }) as string[][];
  const rows: SheetCell[][] = records.map((r) => r.map((c) => (c.trim() === "" ? null : c.trim())));
  return { evidenceId, sheet, rows };
}
