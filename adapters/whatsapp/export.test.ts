import { readFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { parseWhatsApp } from "../../ai/extract/message";
import { importWhatsAppExport, normalizeChat, referencedFiles } from "./export";

const root = join(__dirname, "..", "..");
const AT = "2026-10-25T18:00:00Z";
const ios = readFileSync(join(root, "fixtures/cascade_trade/intake/whatsapp-evergreen.txt"));
const enc = (s: string) => new TextEncoder().encode(s);

async function xlsx(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("AR");
  ws.addRow(["Invoice #", "Customer", "Amount"]);
  ws.addRow(["INV-7", "Acme", 100]);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
async function zipOf(files: Record<string, Uint8Array | string>): Promise<Uint8Array> {
  const z = new JSZip();
  for (const [n, d] of Object.entries(files)) z.file(n, d);
  return z.generateAsync({ type: "uint8array" });
}

describe("WhatsApp export", () => {
  it("passes an iOS .txt export through as a whatsapp input with a stable evidence id", async () => {
    const r = await importWhatsAppExport({ fileName: "WhatsApp Chat - Evergreen.txt", bytes: new Uint8Array(ios), receivedAt: AT });
    expect(r.repeat).toBe(false);
    expect(r.input).toMatchObject({ kind: "whatsapp", source: { sourceRef: { system: "whatsapp" } } });
    expect(r.input!.source!.evidenceId).toMatch(/^ev-whatsapp-[0-9a-f]{16}$/);
    expect(r.diagnostics).toMatchObject({ rowsRead: 3, rowsImported: 3, completeness: 1 });
    expect(parseWhatsApp(r.input!.raw, { evidenceId: "x", receivedAt: AT }).messages).toHaveLength(3);
  });

  it("converts Android lines so the same parser reads them", async () => {
    const android = "11/28/26, 9:14 AM - Mei: Reminder INV-1187 due Dec 10.\n11/28/26, 9:31 AM - Dana: We will pay early January.\nsecond line of that message\n";
    expect(normalizeChat(android).split("\n")[0]).toBe("[11/28/26, 9:14 AM] Mei: Reminder INV-1187 due Dec 10.");
    const r = await importWhatsAppExport({ fileName: "chat.txt", bytes: enc(android), receivedAt: AT });
    const msgs = parseWhatsApp(r.input!.raw, { evidenceId: "x", receivedAt: AT }).messages!;
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.text).toContain("second line of that message");
  });

  it("reads a zip: chat text plus supported attachments, with sheets read", async () => {
    const chat = "[11/28/26, 9:14:02 AM] Dana: <attached: ar.xlsx>\n[11/28/26, 9:15:02 AM] Dana: <attached: inv.pdf>\n[11/28/26, 9:16:02 AM] Dana: <attached: IMG-1.jpg>\n[11/28/26, 9:17:02 AM] Dana: <attached: missing.pdf>\n";
    const z = await zipOf({ "_chat.txt": chat, "ar.xlsx": await xlsx(), "inv.pdf": enc("%PDF-1.4"), "IMG-1.jpg": enc("jpg") });
    const r = await importWhatsAppExport({ fileName: "chat.zip", bytes: z, receivedAt: AT });
    const atts = r.input!.attachments!;
    expect(atts.map((a) => a.fileName)).toEqual(["ar.xlsx", "inv.pdf"]);
    expect(atts[0]!.sheets![0]!.rows[1]).toEqual(["INV-7", "Acme", 100]);
    expect(atts[0]!.source!.evidenceId).toBe(`${r.input!.source!.evidenceId}-ar.xlsx`);
    expect(r.diagnostics.warnings.join(" ")).toMatch(/"missing.pdf" was mentioned in the chat but is not in the export/);
    expect(referencedFiles("x (file attached)")).toEqual([]);
    expect(referencedFiles("[1/1/26, 1:00 AM] Dana: ar.xlsx (file attached)")).toEqual(["ar.xlsx"]);
  });

  it("a byte-identical re-export is a repeat and adds nothing", async () => {
    const first = await importWhatsAppExport({ fileName: "chat.txt", bytes: new Uint8Array(ios), receivedAt: AT });
    const ev = { id: first.input!.source!.evidenceId!, channel: "whatsapp" as const, format: "text" as const, receivedAt: AT, fileHash: undefined as string | undefined, extraction: "ok" as const, sourceRef: { system: "whatsapp", record: "chat.txt" } };
    const { sha256Hex } = await import("../core/hash");
    ev.fileHash = sha256Hex(new Uint8Array(ios));
    const again = await importWhatsAppExport({ fileName: "renamed.txt", bytes: new Uint8Array(ios), receivedAt: "2026-10-26T00:00:00Z", existingEvidence: [ev] });
    expect(again.repeat).toBe(true);
    expect(again.input).toBeUndefined();
    expect(again.diagnostics).toMatchObject({ rowsImported: 0, rowsDuplicate: 3 });
  });

  it.each([
    ["notes.docx", new Uint8Array([1]), /not a WhatsApp export/],
    ["chat.txt", enc("hello there, no timestamps"), /No WhatsApp messages/],
    ["broken.zip", new Uint8Array([1, 2, 3]), /could not be opened/],
  ])("explains %s and keeps going without throwing", async (fileName, bytes, msg) => {
    const r = await importWhatsAppExport({ fileName, bytes, receivedAt: AT });
    expect(r.input).toBeUndefined();
    expect(r.diagnostics.errors[0]!.message).toMatch(msg);
    expect(r.diagnostics.errors[0]!.nextStep).toMatch(/paste|Export|WhatsApp/);
    expect(r.diagnostics.completeness).toBe(0);
  });

  it("refuses an oversized zip and never opens unreferenced files", async () => {
    const big = await importWhatsAppExport({ fileName: "x.zip", bytes: new Uint8Array(50_000_001), receivedAt: AT });
    expect(big.diagnostics.errors[0]!.message).toMatch(/too large/);
    const chat = "[11/28/26, 9:14:02 AM] Dana: <attached: ok.pdf>\n";
    const z = await zipOf({ "_chat.txt": chat, "ok.pdf": enc("%PDF"), "other.pdf": enc("%PDF-never-opened") });
    const r = await importWhatsAppExport({ fileName: "c.zip", bytes: z, receivedAt: AT });
    expect(r.input!.attachments!.map((a) => a.fileName)).toEqual(["ok.pdf"]);
  });

  it("flags day/month-ambiguous dates so a wrong order is not silent", async () => {
    const r = await importWhatsAppExport({ fileName: "c.txt", bytes: enc("[03/04/26, 9:14:02 AM] Dana: we pay on 10/11\n"), receivedAt: AT });
    expect(r.diagnostics.warnings.join(" ")).toMatch(/March 4 or April 3/);
    const clear = await importWhatsAppExport({ fileName: "c.txt", bytes: enc("[11/28/26, 9:14:02 AM] Dana: hi\n"), receivedAt: AT });
    expect(clear.diagnostics.warnings).toEqual([]);
  });

  it("infers day-first from a header date with a first part over 12, with no ambiguity warning", async () => {
    const chat = "[03/04/26, 9:14:02 AM] Mei: reminder\n[25/11/26, 9:31:00 AM] Dana: we pay on 05/12\n";
    const r = await importWhatsAppExport({ fileName: "c.txt", bytes: enc(chat), receivedAt: AT });
    expect(r.input!.dateOrder).toBe("DMY");
    expect(r.diagnostics.warnings).toEqual([]);
  });

  it("infers month-first from a second part over 12, and leaves the order unset when the data conflicts", async () => {
    const mdy = await importWhatsAppExport({ fileName: "c.txt", bytes: enc("[03/04/26, 9:14 AM] A: x\n[11/28/26, 9:15 AM] B: y\n"), receivedAt: AT });
    expect(mdy.input!.dateOrder).toBe("MDY");
    const mixed = await importWhatsAppExport({ fileName: "c.txt", bytes: enc("[25/11/26, 9:14 AM] A: x\n[11/28/26, 9:15 AM] B: y\n"), receivedAt: AT });
    expect(mixed.input!.dateOrder).toBeUndefined();
  });

  it("an all-ambiguous chat still warns and sets no order; an explicit order wins and silences the warning", async () => {
    const bytes = enc("[03/04/26, 9:14:02 AM] Dana: we pay on 10/11\n");
    const r = await importWhatsAppExport({ fileName: "c.txt", bytes, receivedAt: AT });
    expect(r.input!.dateOrder).toBeUndefined();
    expect(r.diagnostics.warnings.join(" ")).toMatch(/March 4 or April 3/);
    const given = await importWhatsAppExport({ fileName: "c.txt", bytes, receivedAt: AT, dateOrder: "DMY" });
    expect(given.input!.dateOrder).toBe("DMY");
    expect(given.diagnostics.warnings).toEqual([]);
    const over = await importWhatsAppExport({ fileName: "c.txt", bytes: enc("[25/11/26, 9:14 AM] A: x\n"), receivedAt: AT, dateOrder: "MDY" });
    expect(over.input!.dateOrder).toBe("MDY");
  });

  it("a zip with no chat text is explained", async () => {
    const r = await importWhatsAppExport({ fileName: "x.zip", bytes: await zipOf({ "a.pdf": enc("%PDF") }), receivedAt: AT });
    expect(r.diagnostics.errors[0]!.message).toMatch(/No chat text/);
  });
});
