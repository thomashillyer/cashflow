// File import: an uploaded CSV/XLSX becomes Evidence, a mapping preview, candidates for review, and
// ImportDiagnostics. Nothing here writes to the store or creates cash. Interpretation of the cells
// (amounts, dates, which column is what) is ai/extract/sheet.ts; this module reads the file, keeps the
// source, skips byte-identical re-imports, and reports every row that could not be used.

import type { IntakeCandidate } from "../../schema/intake";
import type { Evidence } from "../../schema/records";
import {
  classifySheet, documentToCandidate, tableToCandidates,
  type ColumnMapping, type ProposedMapping, type SheetContent,
} from "../../ai/extract/sheet";
import { dedupeEvidence } from "../core/dedupe";
import { summarize, type ImportDiagnostics, type RowError, type RowErrorCode } from "../core/diagnostics";
import { sha256Hex } from "../core/hash";
import { fileEvidenceId } from "../core/ids";
import { readCsv } from "./csv";
import { readXlsx } from "./xlsx";

export type FileInput = { fileName: string; bytes: Uint8Array; receivedAt: string; mime?: string };

export type ImportOptions = {
  business: { name: string };
  currency?: string;
  dayFirst?: boolean;
  columnMapping?: ColumnMapping;   // owner corrections from the mapping preview
  headerRow?: number;              // 1-based
  existingEvidence?: Evidence[];   // already in the store, for repeat detection
  now?: string;                    // ISO; start time reported in diagnostics
};

export type SheetPreview = {
  sheet: string;
  layout: "document" | "table" | "unknown";
  mapping?: ProposedMapping;       // what the owner confirms on the mapping preview
  candidates: IntakeCandidate[];
};

export type FileImport = {
  evidence: Evidence;
  sheets: SheetContent[];          // hand to ingest() as { kind: "sheet", sheets }
  previews: SheetPreview[];
  diagnostics: ImportDiagnostics;
  repeat: boolean;                 // byte-identical file already imported: no new cash, no candidates
};

const extOf = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

const MIME: Record<string, string> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function rowErrorCode(reason: string): RowErrorCode {
  if (/repeats with the same party/i.test(reason)) return "duplicate_in_file";
  if (/invoice number/i.test(reason)) return "missing_reference";
  return "unsupported";
}

const isTotals = (reason: string) => /^Totals row/i.test(reason);

function unsupported(input: FileInput, hash: string, now: string): FileImport {
  const evidence: Evidence = {
    id: fileEvidenceId("upload", hash), channel: "upload", format: "xlsx", receivedAt: input.receivedAt,
    fileName: input.fileName, fileHash: hash, extraction: "unsupported",
    sourceRef: { system: "generic_file", record: input.fileName },
  };
  const error: RowError = {
    row: 1, code: "unsupported",
    message: `"${input.fileName}" is not a CSV or XLSX file Neri can read.`,
    nextStep: "Save it as CSV or XLSX from your accounting tool and upload it again, or paste the invoice details.",
  };
  return {
    evidence, sheets: [], previews: [], repeat: false,
    diagnostics: summarize({ evidenceId: evidence.id, source: "generic_file", startedAt: now, rowsRead: 0, rowsImported: 0, rowsDuplicate: 0, errors: [error], warnings: [] }),
  };
}

export async function importFile(input: FileInput, opts: ImportOptions): Promise<FileImport> {
  const now = opts.now ?? input.receivedAt;
  const hash = sha256Hex(input.bytes);
  const id = fileEvidenceId("upload", hash);
  const ext = extOf(input.fileName);
  if (ext !== "csv" && ext !== "xlsx") return unsupported(input, hash, now);

  let sheets: SheetContent[];
  try {
    sheets = ext === "csv" ? [readCsv(input.bytes, id, input.fileName)] : await readXlsx(input.bytes, id);
  } catch {
    const u = unsupported(input, hash, now);
    return { ...u, evidence: { ...u.evidence, format: ext, extraction: "unreadable" },
      diagnostics: { ...u.diagnostics, errors: [{ ...u.diagnostics.errors[0]!, message: `"${input.fileName}" could not be opened; it may be damaged or password protected.` }] } };
  }

  const evidence: Evidence = {
    id, channel: "upload", format: ext, receivedAt: input.receivedAt, fileName: input.fileName,
    mime: input.mime ?? MIME[ext]!, fileHash: hash, extraction: "ok",
    sourceRef: { system: "generic_file", record: input.fileName },
  };

  const { unchanged } = dedupeEvidence(opts.existingEvidence ?? [], [evidence]);
  const repeat = unchanged.length > 0;

  const previews: SheetPreview[] = [];
  const errors: RowError[] = [];
  const warnings: string[] = [];
  let rowsRead = 0;
  let rowsImported = 0;

  for (const sheet of sheets) {
    const idPrefix = `cand-${id}-${sheet.sheet.replace(/[^A-Za-z0-9]+/g, "-")}`;
    const base = { business: opts.business, idPrefix, ...(opts.currency ? { currency: opts.currency } : {}), ...(opts.dayFirst !== undefined ? { dayFirst: opts.dayFirst } : {}) };
    const layout = classifySheet(sheet);
    // An owner-confirmed mapping means "this is a table", whatever the header detection thought.
    if (layout.layout === "table" || (opts.columnMapping && layout.layout === "unknown")) {
      const r = tableToCandidates(sheet, { ...base, ...(opts.columnMapping ? { columnMapping: opts.columnMapping } : {}), ...(opts.headerRow ? { headerRow: opts.headerRow } : {}) });
      previews.push({ sheet: sheet.sheet, layout: "table", mapping: r.proposedMapping, candidates: r.candidates });
      if (r.reason) {
        errors.push({ row: r.proposedMapping.headerRow ?? 1, sheet: sheet.sheet, code: "unmapped_column", message: r.reason, nextStep: "Pick the invoice number and amount columns in the mapping preview, then import again." });
      }
      for (const row of r.rejectedRows) {
        if (isTotals(row.reason)) continue;
        rowsRead++;
        errors.push({ row: row.row, sheet: sheet.sheet, code: rowErrorCode(row.reason), message: row.reason, nextStep: "Fix this row in the file and upload it again, or add the invoice by hand." });
      }
      for (const c of r.candidates) {
        rowsRead++;
        const row = Number(c.id.split("-").pop());
        if (c.fields.amount.state === "found") { rowsImported++; continue; }
        errors.push({ row, sheet: sheet.sheet, code: "missing_amount", message: `Row ${row} has no readable amount; it was kept for review and adds no cash.`, nextStep: "Enter the amount on the Review screen." });
      }
    } else if (layout.layout === "document") {
      const c = documentToCandidate(sheet, base);
      previews.push({ sheet: sheet.sheet, layout: "document", candidates: [c] });
      rowsRead++;
      if (c.fields.amount.state === "found") rowsImported++;
      else errors.push({ row: 1, sheet: sheet.sheet, code: "missing_amount", message: `"${sheet.sheet}" has no stated total; it was kept for review and adds no cash.`, nextStep: "Enter the amount on the Review screen." });
    } else {
      previews.push({ sheet: sheet.sheet, layout: "unknown", candidates: [] });
      warnings.push(`${sheet.sheet}: ${layout.reason}`);
    }
  }

  if (repeat) {
    return {
      evidence: unchanged[0]!, sheets, previews: previews.map((p) => ({ ...p, candidates: [] })), repeat: true,
      diagnostics: summarize({ evidenceId: unchanged[0]!.id, source: "generic_file", startedAt: now, rowsRead, rowsImported: 0, rowsDuplicate: rowsRead, errors: [], warnings: ["This file was already imported; nothing changed."] }),
    };
  }
  if (rowsRead === 0 && errors.length === 0) {
    evidence.extraction = "partial";
    errors.push({ row: 1, code: "unsupported", message: "No invoices were found in this file.", nextStep: "Check that the file has an invoice number and amount column, or paste the invoice text instead." });
  } else if (errors.length > 0 || warnings.length > 0) {
    evidence.extraction = "partial";
  }
  return {
    evidence, sheets, previews, repeat: false,
    diagnostics: summarize({ evidenceId: id, source: "generic_file", startedAt: now, rowsRead, rowsImported, rowsDuplicate: 0, errors, warnings }),
  };
}
