// The one call the API makes for an uploaded file: bytes -> an IntakeInput for ingest(), plus the
// diagnostics the Sources screen shows. Spreadsheets (CSV/XLSX) go through generic_file; WhatsApp zip
// or text exports through the whatsapp adapter. A byte-identical file already in the store is a repeat:
// nothing is ingested, so cash cannot change. Nothing here writes to the store.

import type { IntakeInput } from "../ai/intake";
import type { ColumnMapping } from "../ai/extract/sheet";
import type { Evidence, Records } from "../schema/records";
import type { ImportDiagnostics } from "./core/diagnostics";
import { importFile } from "./generic_file/import";
import { importWhatsAppExport } from "./whatsapp/export";

export type PrepareOptions = {
  kind: "sheet" | "whatsapp";
  fileName: string;
  bytes: Uint8Array;
  receivedAt: string;
  records: Pick<Records, "evidence">;
  business: { name: string };
  currency?: string;
  dayFirst?: boolean;
  columnMapping?: ColumnMapping;
  headerRow?: number;
  retry?: boolean;       // the owner supplied corrections: never answer "already imported"
};

// Only evidence that was actually read can make a later identical upload a repeat. A file that came
// back unreadable or unsupported, or an owner correcting how it was read, is always worth trying again.
const readable = (e: Evidence) => e.extraction === "ok" || e.extraction === "partial";

export type PreparedImport =
  | { ok: true; repeat: false; input: IntakeInput; diagnostics: ImportDiagnostics; fileEvidence?: Evidence }
  | { ok: true; repeat: true; diagnostics: ImportDiagnostics; evidenceId: string }
  | { ok: false; message: string; nextStep: string; diagnostics: ImportDiagnostics };

export async function prepareFileImport(o: PrepareOptions): Promise<PreparedImport> {
  const known = o.retry ? [] : o.records.evidence.filter(readable);
  if (o.kind === "whatsapp") {
    const r = await importWhatsAppExport({ fileName: o.fileName, bytes: o.bytes, receivedAt: o.receivedAt, existingEvidence: known });
    if (r.repeat) return { ok: true, repeat: true, diagnostics: r.diagnostics, evidenceId: r.diagnostics.evidenceId };
    if (!r.input) {
      const e = r.diagnostics.errors[0]!;
      return { ok: false, message: e.message, nextStep: e.nextStep, diagnostics: r.diagnostics };
    }
    return { ok: true, repeat: false, input: r.input, diagnostics: r.diagnostics };
  }

  const r = await importFile(
    { fileName: o.fileName, bytes: o.bytes, receivedAt: o.receivedAt },
    {
      business: o.business, existingEvidence: known,
      ...(o.currency ? { currency: o.currency } : {}), ...(o.dayFirst !== undefined ? { dayFirst: o.dayFirst } : {}),
      ...(o.columnMapping ? { columnMapping: o.columnMapping } : {}), ...(o.headerRow ? { headerRow: o.headerRow } : {}),
    },
  );
  if (r.repeat) return { ok: true, repeat: true, diagnostics: r.diagnostics, evidenceId: r.evidence.id };
  if (r.sheets.length === 0) {
    const e = r.diagnostics.errors[0]!;
    return { ok: false, message: e.message, nextStep: e.nextStep, diagnostics: r.diagnostics };
  }
  return {
    ok: true, repeat: false, diagnostics: r.diagnostics, fileEvidence: r.evidence,
    input: {
      kind: "sheet", sheets: r.sheets,
      source: { evidenceId: r.evidence.id, receivedAt: o.receivedAt, sourceRef: r.evidence.sourceRef },
      ...(o.currency ? { currency: o.currency } : {}), ...(o.dayFirst !== undefined ? { dayFirst: o.dayFirst } : {}),
      ...(o.columnMapping ? { columnMapping: o.columnMapping } : {}), ...(o.headerRow ? { headerRow: o.headerRow } : {}),
    },
  };
}

// ingest() builds a sparse Evidence for a sheet. Keep its extraction state, add what the adapter knows
// (file name, hash, real format) so the Review screen can show the original and repeats are detectable.
export function enrichEvidence(evidence: Evidence[], fileEvidence: Evidence | undefined): Evidence[] {
  if (!fileEvidence) return evidence;
  const rank: Record<Evidence["extraction"], number> = { ok: 0, partial: 1, unreadable: 2, unsupported: 3 };
  return evidence.map((e) => (e.id === fileEvidence.id
    ? { ...fileEvidence, extraction: rank[e.extraction] >= rank[fileEvidence.extraction] ? e.extraction : fileEvidence.extraction, ...(e.parentId ? { parentId: e.parentId } : {}) }
    : e));
}
