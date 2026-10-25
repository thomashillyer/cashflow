// Layer 1: embedded PDF text per page, with line structure for field evidence.
// No OCR: image-only PDFs come back "unreadable" and ask for manual completion.
// Limits from docs/TECHNICAL_PLAN.md section 5. Never throws on bad input.

import type { FieldEvidence } from "../../schema/intake";

export const PDF_MAX_BYTES = 5 * 1024 * 1024;
export const PDF_MAX_PAGES = 10;

export type PdfPage = { page: number; text: string; lines: string[] };

export type PdfText = {
  evidenceId: string;
  status: "ok" | "unreadable" | "too_large" | "encrypted" | "failed";
  pages: PdfPage[];
  reason?: string;
};

type TextItem = { str: string; transform: number[] };

type PdfDoc = {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
  destroy(): Promise<void>;
};

// Items within this many points vertically are treated as one line.
const LINE_TOLERANCE = 2;

function toLines(items: TextItem[]): string[] {
  const rows: { y: number; parts: { x: number; str: string }[] }[] = [];
  for (const it of items) {
    if (!it.str) continue;
    const x = it.transform[4] ?? 0;
    const y = it.transform[5] ?? 0;
    let row = rows.find((r) => Math.abs(r.y - y) <= LINE_TOLERANCE);
    if (!row) rows.push((row = { y, parts: [] }));
    row.parts.push({ x, str: it.str });
  }
  rows.sort((a, b) => b.y - a.y); // PDF y grows upward: top of page first
  return rows
    .map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.str).join(" ").replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function extractPdfText(bytes: Uint8Array, opts: { evidenceId: string }): Promise<PdfText> {
  const { evidenceId } = opts;
  if (bytes.byteLength > PDF_MAX_BYTES) {
    return { evidenceId, status: "too_large", pages: [], reason: `File is over ${PDF_MAX_BYTES / 1024 / 1024} MiB; split it or enter the fields manually.` };
  }
  let doc: PdfDoc;
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes), // copy: PDF.js may detach the buffer it is given
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
    });
    doc = (await task.promise) as unknown as PdfDoc;
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "PasswordException") {
      return { evidenceId, status: "encrypted", pages: [], reason: "PDF is password-protected; upload an unlocked copy or enter the fields manually." };
    }
    return { evidenceId, status: "failed", pages: [], reason: `Could not read PDF: ${message(err)}` };
  }
  try {
    if (doc.numPages > PDF_MAX_PAGES) {
      return { evidenceId, status: "too_large", pages: [], reason: `PDF has ${doc.numPages} pages (limit ${PDF_MAX_PAGES}); split it or enter the fields manually.` };
    }
    const pages: PdfPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const lines = toLines(content.items.filter((i): i is TextItem => typeof (i as TextItem).str === "string"));
      pages.push({ page: n, lines, text: lines.join("\n") });
    }
    if (pages.every((p) => p.text.length === 0)) {
      return { evidenceId, status: "unreadable", pages, reason: "No embedded text (likely a scan). Upload a text PDF or enter the fields manually." };
    }
    return { evidenceId, status: "ok", pages };
  } catch (err) {
    return { evidenceId, status: "failed", pages: [], reason: `Could not read PDF text: ${message(err)}` };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

// Locate a value in the extracted text so a field can point at its source.
// Exact match first, then case-insensitive; first occurrence wins.
export function findSpan(pdf: PdfText, needle: string): FieldEvidence | undefined {
  if (!needle) return undefined;
  for (const insensitive of [false, true]) {
    const n = insensitive ? needle.toLowerCase() : needle;
    for (const p of pdf.pages) {
      const start = (insensitive ? p.text.toLowerCase() : p.text).indexOf(n);
      if (start >= 0) {
        const end = start + needle.length;
        return { evidenceId: pdf.evidenceId, page: p.page, excerpt: { start, end }, text: p.text.slice(start, end) };
      }
    }
  }
  return undefined;
}
