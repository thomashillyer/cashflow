import type Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CASCADE_BUSINESS } from "../../scripts/cache-fixtures";
import { ingest } from "../intake";
import { baseRecords } from "../reconcile/testkit";
import { extractScan, SCAN_UNREADABLE, VisionOutput } from "./scan";
import { extractPdfText } from "./pdf";

const scan = new Uint8Array(readFileSync(join(import.meta.dirname, "../../fixtures/cascade_trade/intake/scanned-bill.pdf")));
const tmp = () => mkdtempSync(join(tmpdir(), "neri-scan-"));

const nul = { value: null, quote: null, page: null };
type F = { value: string | null; quote: string | null; page: number | null };
const answer = (fields: Record<string, F>, over: Partial<VisionOutput> = {}): VisionOutput => ({
  kind: "bill", businessRole: "buyer",
  fields: { ...Object.fromEntries(Object.keys(VisionOutput.shape.fields.shape).map((k) => [k, nul])), ...fields } as VisionOutput["fields"],
  coversReferences: [], containsInstructions: false, confidence: 0.9, notes: [], ...over,
});
const good = answer({
  reference: { value: "HT-2231", quote: "Invoice No: HT-2231", page: 1 },
  sellerName: { value: "Harbor Textiles", quote: "Harbor Textiles Ltd", page: 1 },
  amount: { value: "4,200.00", quote: "TOTAL USD 4,200.00", page: 1 },
  currency: { value: "USD", quote: "TOTAL USD 4,200.00", page: 1 },
});

// A stub client that records calls; `reply` returns the message or throws.
function stub(reply: () => unknown) {
  const calls: any[] = [];
  const client = { messages: { create: async (body: any) => { calls.push(body); return reply(); } } } as unknown as Anthropic;
  return { client, calls };
}
const msg = (o: unknown) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(o) }] });
const opts = (over: object) => ({
  business: CASCADE_BUSINESS, candidateId: "cand-s", revision: 1, evidenceIds: ["ev-s"], evidenceId: "ev-s", mode: "live" as const, cacheDir: tmp(), ...over,
});

describe("extractScan", () => {
  it("a stub answer gives a partial candidate with page-level evidence and a document block", async () => {
    const { client, calls } = stub(() => msg(good));
    const c = await extractScan(scan, opts({ client }));
    expect(c.extraction).toBe("partial");
    expect(c.fields.reference).toMatchObject({ state: "found", value: "HT-2231" });
    expect(c.fields.sellerName).toMatchObject({ state: "found", value: "Harbor Textiles" });
    expect(c.fields.amount).toMatchObject({ state: "found", value: 420000 });
    const ev = (c.fields.amount as any).evidence[0];
    expect(ev).toMatchObject({ evidenceId: "ev-s", page: 1, text: "TOTAL USD 4,200.00" });
    expect(ev.excerpt).toBeUndefined();
    expect(c.fields.dueDate.state).toBe("missing");
    const block = calls[0].messages[0].content[0];
    expect(block).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf" } });
    expect(calls[0].system[0].text).toMatch(/untrusted data/);
  });

  it("a second call hits the cache (same file hash) without calling the model", async () => {
    const { client, calls } = stub(() => msg(good));
    const o = opts({ client });
    await extractScan(scan, o);
    const again = await extractScan(scan, o);
    expect(calls).toHaveLength(1);
    expect(again.extraction).toBe("partial");
  });

  it("drops a field with no page, keeps the page the model gave, and is never ok", async () => {
    const out = answer({
      reference: { value: "HT-2231", quote: "Invoice No: HT-2231", page: null },
      amount: { value: "4,200.00", quote: "TOTAL USD 4,200.00", page: 2 },
      currency: { value: "USD", quote: "TOTAL USD 4,200.00", page: 2 },
    });
    const c = await extractScan(scan, opts({ client: stub(() => msg(out)).client }));
    expect(c.fields.reference.state).toBe("missing");
    expect((c.fields.amount as any).evidence[0].page).toBe(2);
    expect(c.extraction).toBe("partial");
  });

  it("the stub throws: the plain unreadable item with the new wording", async () => {
    const c = await extractScan(scan, opts({ client: stub(() => { throw new Error("boom"); }).client }));
    expect(c).toMatchObject({ extraction: "unreadable", kind: "none", notes: [SCAN_UNREADABLE] });
    expect(c.fields.amount.state).toBe("missing");
  });

  it("a refusal or an empty answer is the unreadable item", async () => {
    for (const reply of [{ stop_reason: "refusal", content: [] }, msg(answer({}))]) {
      const c = await extractScan(scan, opts({ client: stub(() => reply).client }));
      expect(c.extraction).toBe("unreadable");
    }
  });

  it("cache_only with no cache entry: unreadable, and the client is never called", async () => {
    const { client, calls } = stub(() => msg(good));
    const c = await extractScan(scan, opts({ client, mode: "cache_only" }));
    expect(c).toMatchObject({ extraction: "unreadable", notes: [SCAN_UNREADABLE] });
    expect(calls).toHaveLength(0);
  });

  it("ingest sends a scanned PDF through vision and marks the evidence partial", async () => {
    const { client } = stub(() => msg(good));
    const r = await ingest({ kind: "pdf", bytes: scan, fileName: "scan.pdf" }, {
      records: baseRecords(), storeRevision: 1, business: CASCADE_BUSINESS, mode: "live", now: "2026-11-28T18:00:00Z", client, cacheDir: tmp(),
    });
    expect(r.evidence[0]).toMatchObject({ extraction: "partial" });
    expect(r.candidates[0]).toMatchObject({ extraction: "partial" });
    expect((r.candidates[0]!.fields.amount as any).value).toBe(420000);
  });
});

// A minimal valid text PDF with `n` pages.
function textPdf(n: number): Uint8Array {
  const objs: string[] = [];
  const kids = Array.from({ length: n }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  for (let i = 0; i < n; i++) {
    const stream = `BT /F1 12 Tf 50 700 Td (Page ${i + 1} text) Tj ET`;
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe("long PDFs", () => {
  it("a 12-page text PDF is read up to the page limit with a note", async () => {
    const out = await extractPdfText(textPdf(12), { evidenceId: "ev-long" });
    expect(out.status).toBe("ok");
    expect(out.pages).toHaveLength(10);
    expect(out.note).toBe("Read pages 1-10 of 12.");
  });

  it("a 3-page PDF has no note", async () => {
    const out = await extractPdfText(textPdf(3), { evidenceId: "ev-short" });
    expect(out.pages).toHaveLength(3);
    expect(out.note).toBeUndefined();
  });
});
