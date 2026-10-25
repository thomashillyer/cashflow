// Keep the original behind each imported source (issue #155): after ingest, store the uploaded file, the
// pasted text, or the email/zip attachment bytes, and set Evidence.storageKey (and a mime when the evidence
// has none) so Review can show where a number came from. Failing to store never fails the import: the
// evidence keeps its extracted details, has no storageKey, and the owner gets a plain note.
//
// Called once per import, after ingest and before evidence is saved. A repeat upload returns earlier in the
// route and never reaches this, so nothing is re-uploaded.

import type { IntakeInput, IntakeNote } from "../ai/intake";
import type { Evidence } from "../schema/records";
import { sha256Hex } from "../adapters/core/hash";
import { MAX_ORIGINAL_BYTES, type Blobs } from "./blobs";

export const ORIGINAL_NOTE = "The original could not be saved; the extracted details were kept.";

// Content types the download route may send as such. Anything else (html, svg, unknown) goes out as
// application/octet-stream, always as an attachment, so an uploaded page can never run in the app's origin.
export const DOWNLOAD_MIMES = new Set([
  "application/pdf", "text/csv", "text/plain", "message/rfc822",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf", csv: "text/csv", txt: "text/plain", eml: "message/rfc822",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const mimeFor = (name: string): string => MIME_BY_EXT[name.toLowerCase().split(".").pop() ?? ""] ?? "application/octet-stream";

const DEFAULT_NAME: Record<IntakeInput["kind"], string> = {
  pdf: "document.pdf", email: "message.eml", whatsapp: "chat.txt", sheet: "pasted.csv", paste: "pasted.txt",
};

type Result = { evidence: Evidence[]; notes: IntakeNote[] };

// The bytes the owner handed over: the decoded file, else the pasted text.
function requestBytes(body: unknown): Uint8Array | undefined {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.base64 === "string") return new Uint8Array(Buffer.from(b.base64, "base64"));
  if (typeof b.text === "string") return new TextEncoder().encode(b.text);
  return undefined;
}

export async function attachOriginals<T extends Result>(
  ctx: { blobs: Blobs; businessId: string; body: unknown; input: IntakeInput },
  result: T,
): Promise<T> {
  const keys = new Map<string, { key: string; mime: string }>();   // evidence id -> stored original
  const failed: string[] = [];

  const store = async (evidenceId: string, bytes: Uint8Array | undefined, fileName: string) => {
    if (!bytes || bytes.length === 0 || bytes.length > MAX_ORIGINAL_BYTES) { failed.push(evidenceId); return; }
    const mime = mimeFor(fileName);
    try {
      const key = await ctx.blobs.putOriginal(ctx.businessId, { bytes, fileName, mime, hash: sha256Hex(bytes) });
      keys.set(evidenceId, { key, mime });
    } catch {
      failed.push(evidenceId);
    }
  };

  // The source itself: the first evidence that is not an attachment or a link.
  const primary = result.evidence.find((e) => !e.parentId && e.channel !== "url");
  if (primary) {
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const name = primary.fileName ?? (typeof b.fileName === "string" ? b.fileName : undefined) ?? DEFAULT_NAME[ctx.input.kind];
    await store(primary.id, requestBytes(ctx.body), name);
  }
  // Attachments inside an email or a WhatsApp zip whose bytes the adapter handed over.
  if (ctx.input.kind === "email" || ctx.input.kind === "whatsapp") {
    for (const a of ctx.input.attachments ?? []) {
      const id = a.source?.evidenceId;
      if (id && id !== primary?.id && result.evidence.some((e) => e.id === id)) await store(id, a.bytes, a.fileName);
    }
  }

  const evidence = result.evidence.map((e) => {
    const s = keys.get(e.id);
    return s ? { ...e, storageKey: s.key, ...(e.mime ? {} : { mime: s.mime }) } : e;
  });
  const notes = [...result.notes, ...[...new Set(failed)].map((scope) => ({ scope, text: ORIGINAL_NOTE }))];
  return { ...result, evidence, notes };
}
