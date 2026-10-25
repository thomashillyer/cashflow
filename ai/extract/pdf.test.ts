import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPdfText, findSpan, PDF_MAX_BYTES } from "./pdf";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dirname, "../../fixtures/cascade_trade/intake", name)));

describe("extractPdfText", () => {
  it("reads page-tagged lines from a text PDF", async () => {
    const out = await extractPdfText(fixture("inv1187.pdf"), { evidenceId: "ev-pdf-1187" });
    expect(out.status).toBe("ok");
    expect(out.pages).toHaveLength(1);
    const page = out.pages[0]!;
    expect(page.page).toBe(1);
    expect(page.lines[0]).toBe("CASCADE TRADE CO.");
    expect(page.lines).toContain("INVOICE INV-1187");
    expect(page.lines).toContain("Due date: December 10, 2026");
    expect(page.lines.some((l) => l.startsWith("TOTAL DUE (USD)") && l.endsWith("28,000.00"))).toBe(true);
    expect(page.text).toBe(page.lines.join("\n"));
  });

  it("marks an image-only PDF unreadable instead of returning empty text as ok", async () => {
    const out = await extractPdfText(fixture("scanned-bill.pdf"), { evidenceId: "ev-scan" });
    expect(out.status).toBe("unreadable");
    expect(out.reason).toMatch(/manually/);
  });

  it("returns failed for bytes that are not a PDF", async () => {
    const out = await extractPdfText(new TextEncoder().encode("not a pdf at all"), { evidenceId: "ev-bad" });
    expect(out.status).toBe("failed");
    expect(out.pages).toEqual([]);
  });

  it("rejects files over the size limit without parsing", async () => {
    const out = await extractPdfText(new Uint8Array(PDF_MAX_BYTES + 1), { evidenceId: "ev-big" });
    expect(out.status).toBe("too_large");
  });
});

describe("findSpan", () => {
  it("points at the page and offsets of a value", async () => {
    const out = await extractPdfText(fixture("inv1187.pdf"), { evidenceId: "ev-pdf-1187" });
    const span = findSpan(out, "INV-1187");
    expect(span).toMatchObject({ evidenceId: "ev-pdf-1187", page: 1, text: "INV-1187" });
    const text = out.pages[0]!.text;
    expect(text.slice(span!.excerpt!.start, span!.excerpt!.end)).toBe("INV-1187");
  });

  it("falls back to case-insensitive and returns undefined when absent", async () => {
    const out = await extractPdfText(fixture("inv1187.pdf"), { evidenceId: "ev" });
    expect(findSpan(out, "invoice inv-1187")?.text).toBe("INVOICE INV-1187");
    expect(findSpan(out, "INV-9999")).toBeUndefined();
    expect(findSpan(out, "")).toBeUndefined();
  });
});
