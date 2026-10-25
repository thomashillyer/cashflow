// WhatsApp chat export (the no-setup path; WhatsApp has no personal-account login to connect).
// The owner exports a chat from the phone ("Export chat", with or without media) and uploads the .txt
// or .zip. We keep the original as evidence, normalise the two phone formats to the one the parser
// reads, and pass supported attachments (PDF, XLSX, CSV) through with their sheets read. Message text
// is data: nothing here interprets it.

import JSZip from "jszip";
import type { Attachment, IntakeInput } from "../../ai/intake";
import { summarize, type ImportDiagnostics, type RowError } from "../core/diagnostics";
import { sha256Hex } from "../core/hash";
import { readCapped } from "../core/zip";
import { childEvidenceId, fileEvidenceId } from "../core/ids";
import { readCsv, decodeText } from "../generic_file/csv";
import { readXlsx } from "../generic_file/xlsx";
import type { Evidence } from "../../schema/records";

export const MAX_ZIP_ENTRIES = 500;
export const MAX_ENTRY_BYTES = 10_000_000;
export const MAX_CHAT_BYTES = 5_000_000;
export const MAX_ZIP_BYTES = 50_000_000;
export const MAX_TOTAL_BYTES = 50_000_000;   // everything inflated from one zip

export type WhatsAppExportInput = { fileName: string; bytes: Uint8Array; receivedAt: string; existingEvidence?: Evidence[]; now?: string; dateOrder?: "MDY" | "DMY" };

export type WhatsAppImport = {
  input?: Extract<IntakeInput, { kind: "whatsapp" }>;
  repeat: boolean;
  diagnostics: ImportDiagnostics;
};

const ANDROID = /^‎?(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:[\s ]?[AaPp]\.?[Mm]\.?)?)\s+-\s+([^:\n]+):[ \t]?/;
const SUPPORTED = /\.(pdf|xlsx|csv)$/i;
// iOS: "<attached: name>"; Android: "name (file attached)".
const ATTACHED = [/<attached:\s*([^>\n]+)>/gi, /^\[[^\]\n]+\]\s+[^:\n]+:\s*(.+?)\s+\(file attached\)\s*$/gim];

// Android "11/28/26, 9:14 AM - Name: text" -> iOS "[11/28/26, 9:14 AM] Name: text".
export function normalizeChat(raw: string): string {
  return raw.replace(/\r\n/g, "\n").split("\n").map((line) => {
    const m = ANDROID.exec(line);
    return m ? `[${m[1]}, ${m[2]!.replace(/\./g, "")}] ${m[3]!.trim()}: ${line.slice(m[0].length)}` : line;
  }).join("\n");
}

export function referencedFiles(text: string): string[] {
  const names = new Set<string>();
  const normalized = normalizeChat(text);
  for (const re of ATTACHED) for (const m of normalized.matchAll(re)) names.add(m[1]!.trim());
  return [...names];
}

const fail = (message: string, nextStep: string, now: string, evidenceId: string, code: RowError["code"] = "unsupported"): WhatsAppImport => ({
  repeat: false,
  diagnostics: summarize({ evidenceId, source: "whatsapp", startedAt: now, rowsRead: 0, rowsImported: 0, rowsDuplicate: 0, errors: [{ row: 1, code, message, nextStep }], warnings: [] }),
});

export async function importWhatsAppExport(input: WhatsAppExportInput): Promise<WhatsAppImport> {
  const now = input.now ?? input.receivedAt;
  const hash = sha256Hex(input.bytes);
  const evidenceId = fileEvidenceId("whatsapp", hash);
  const isZip = /\.zip$/i.test(input.fileName);
  if (!isZip && !/\.txt$/i.test(input.fileName)) {
    return fail(`"${input.fileName}" is not a WhatsApp export.`, "In WhatsApp open the chat, choose Export chat, and upload the .txt or .zip file, or paste the messages.", now, evidenceId);
  }
  const repeat = (input.existingEvidence ?? []).some((e) => e.fileHash === hash);

  let chatText: string;
  const files = new Map<string, Uint8Array>();
  const errors: RowError[] = [];
  const warnings: string[] = [];
  try {
    if (isZip) {
      if (input.bytes.length > MAX_ZIP_BYTES) return fail("This export is too large to read.", "Export the chat without media, or upload the PDF or spreadsheet on its own.", now, evidenceId);
      const zip = await JSZip.loadAsync(input.bytes);
      const entries = Object.values(zip.files).filter((f) => !f.dir);
      if (entries.length > MAX_ZIP_ENTRIES) return fail("This export has too many files.", "Export the chat without media, or paste the messages.", now, evidenceId);
      const base = (n: string) => n.split("/").pop()!;
      // The size the zip declares for an entry, read before anything is inflated.
      const declared = (e: JSZip.JSZipObject) => (e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
      const chat = entries.find((e) => /(^|\/)_chat\.txt$/i.test(e.name)) ?? entries.find((e) => /\.txt$/i.test(e.name));
      if (!chat) return fail("No chat text was found in this zip.", "Export the chat again from WhatsApp, or paste the messages.", now, evidenceId);
      // Declared sizes are only a hint (the header can lie); every read below is capped on real bytes.
      const chatSize = declared(chat);
      if (chatSize !== undefined && chatSize > MAX_CHAT_BYTES) return fail("This chat is too large to read in one go.", "Export a shorter period, or paste the messages that matter.", now, evidenceId);
      const chatBytes = await readCapped(chat, MAX_CHAT_BYTES);
      if (!chatBytes) return fail("This chat is too large to read in one go.", "Export a shorter period, or paste the messages that matter.", now, evidenceId);
      chatText = decodeText(chatBytes);
      // Only files the chat names are opened, within one total budget.
      let budget = MAX_TOTAL_BYTES - chatBytes.length;
      for (const name of referencedFiles(chatText)) {
        if (!SUPPORTED.test(name)) continue;
        const e = entries.find((x) => base(x.name) === name);
        if (!e) continue;
        const bytes = await readCapped(e, Math.min(MAX_ENTRY_BYTES, budget));
        if (!bytes) {
          errors.push({ row: 1, code: "unsupported", message: `"${name}" is too large to read.`, nextStep: "Upload that file on the import screen." });
          continue;
        }
        budget -= bytes.length;
        files.set(name, bytes);
      }
    } else {
      if (input.bytes.length > MAX_CHAT_BYTES) return fail("This chat is too large to read in one go.", "Export a shorter period, or paste the messages that matter.", now, evidenceId);
      chatText = decodeText(input.bytes);
    }
  } catch {
    return fail(`"${input.fileName}" could not be opened.`, "Export the chat again from WhatsApp, or paste the messages.", now, evidenceId, "unsupported");
  }

  const raw = normalizeChat(chatText);
  const messageCount = raw.split("\n").filter((l) => /^\[\d/.test(l)).length;
  if (messageCount === 0) return fail("No WhatsApp messages were found in this file.", "Check that it is a chat exported from WhatsApp, or paste the messages.", now, evidenceId);

  // Day-first or month-first: an explicit order wins; otherwise a header date with a first part over 12
  // means day first, and one with a second part over 12 means month first. Both at once is inconsistent
  // data, so the default stays. With no evidence either way every date is ambiguous: say so.
  let dayFirst = false, monthFirst = false, ambiguous = false;
  for (const l of raw.split("\n")) {
    const m = /^\[(\d{1,2})\/(\d{1,2})\//.exec(l);
    if (!m) continue;
    const [x, y] = [Number(m[1]), Number(m[2])];
    if (x > 12) dayFirst = true; else if (y > 12) monthFirst = true; else if (x !== y) ambiguous = true;
  }
  const dateOrder: "MDY" | "DMY" | undefined = input.dateOrder ?? (dayFirst && !monthFirst ? "DMY" : monthFirst && !dayFirst ? "MDY" : undefined);
  if (!input.dateOrder && !dayFirst && !monthFirst && ambiguous) {
    warnings.push("Some dates, like 03/04/26, could be read as March 4 or April 3. Neri reads them month first; check any payment date the chat mentions.");
  }

  const attachments: Attachment[] = [];
  const referenced = referencedFiles(chatText);
  for (const name of referenced) {
    const bytes = files.get(name);
    if (!bytes) {
      if (SUPPORTED.test(name)) warnings.push(`"${name}" was mentioned in the chat but is not in the export. Export again with media, or upload it on the import screen.`);
      continue;
    }
    const id = childEvidenceId(evidenceId, name);
    let sheets: Attachment["sheets"];
    try {
      if (/\.xlsx$/i.test(name)) sheets = await readXlsx(bytes, id);
      else if (/\.csv$/i.test(name)) sheets = [readCsv(bytes, id, name)];
    } catch {
      errors.push({ row: 1, code: "unsupported", message: `"${name}" could not be opened.`, nextStep: "Open it in Excel, save it again, and upload it on the import screen." });
    }
    attachments.push({ fileName: name, bytes, ...(sheets ? { sheets } : {}), source: { evidenceId: id, receivedAt: input.receivedAt, sourceRef: { system: "whatsapp", record: `${input.fileName}#${name}` } } });
  }

  const diagnostics = summarize({
    evidenceId, source: "whatsapp", startedAt: now, rowsRead: repeat ? messageCount : messageCount,
    rowsImported: repeat ? 0 : messageCount, rowsDuplicate: repeat ? messageCount : 0, errors,
    warnings: repeat ? ["This chat was already imported; nothing changed."] : warnings, syncedAt: now,
  });
  if (repeat) return { repeat: true, diagnostics };
  return {
    repeat: false, diagnostics,
    input: { kind: "whatsapp", raw, attachments, ...(dateOrder ? { dateOrder } : {}), source: { evidenceId, receivedAt: input.receivedAt, sourceRef: { system: "whatsapp", record: input.fileName } } },
  };
}
