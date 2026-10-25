import { readFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { describe as describeImport } from "../core/diagnostics";
import { importFile } from "./import";
import { readCsv } from "./csv";
import { readXlsx } from "./xlsx";

const root = join(__dirname, "..", "..");
const csvBytes = () => new Uint8Array(readFileSync(join(root, "fixtures/cascade_trade/intake/files/ar-aging.csv")));
const opts = { business: { name: "Cascade Trade Co." } };
const at = "2026-10-25T18:00:00Z";

describe("CSV import", () => {
  it("reads the AR export into one candidate per invoice with a mapping preview", async () => {
    const r = await importFile({ fileName: "ar-aging.csv", bytes: csvBytes(), receivedAt: at }, opts);
    const table = r.previews[0]!;
    expect(table.layout).toBe("table");
    expect(table.mapping?.columns).toMatchObject({ reference: 0, party: 1, amount: 5 });
    expect(table.candidates.map((c) => c.id.split("-").pop())).toEqual(["2", "3", "4", "5"]);
    expect(r.evidence).toMatchObject({ channel: "upload", format: "csv", fileName: "ar-aging.csv", extraction: "partial" });
    expect(r.evidence.fileHash).toHaveLength(64);
  });

  it("never turns a missing amount into zero, and lists every unusable row", async () => {
    const r = await importFile({ fileName: "ar-aging.csv", bytes: csvBytes(), receivedAt: at }, opts);
    const blank = r.previews[0]!.candidates.find((c) => c.fields.reference.state === "found" && c.fields.reference.value === "INV-1203")!;
    expect(blank.fields.amount.state).toBe("missing");
    const codes = r.diagnostics.errors.map((e) => [e.row, e.code]);
    expect(codes).toContainEqual([4, "missing_amount"]);
    expect(codes).toContainEqual([6, "missing_reference"]);
    expect(r.diagnostics.rowsRead).toBe(5);
    expect(r.diagnostics.rowsImported).toBe(3);
    expect(r.diagnostics.rowsRejected).toBe(2);
    expect(describeImport(r.diagnostics)).toBe("3 of 5 rows imported, 2 need your attention");
    for (const e of r.diagnostics.errors) expect(e.nextStep.length).toBeGreaterThan(0);
  });

  it("a repeat import of the same bytes adds nothing", async () => {
    const first = await importFile({ fileName: "ar-aging.csv", bytes: csvBytes(), receivedAt: at }, opts);
    const again = await importFile(
      { fileName: "renamed.csv", bytes: csvBytes(), receivedAt: "2026-10-26T09:00:00Z" },
      { ...opts, existingEvidence: [first.evidence] },
    );
    expect(again.repeat).toBe(true);
    expect(again.evidence.id).toBe(first.evidence.id);
    expect(again.previews.flatMap((p) => p.candidates)).toEqual([]);
    expect(again.diagnostics).toMatchObject({ rowsImported: 0, rowsDuplicate: 5, rowsRejected: 0 });
  });

  it("treats an edited file with the same name as new content, not a repeat", async () => {
    const first = await importFile({ fileName: "ar-aging.csv", bytes: csvBytes(), receivedAt: at }, opts);
    const edited = new TextEncoder().encode("Invoice #,Customer,Amount\nINV-9,Acme,10.00\n");
    const again = await importFile({ fileName: "ar-aging.csv", bytes: edited, receivedAt: at }, { ...opts, existingEvidence: [first.evidence] });
    expect(again.repeat).toBe(false);
    expect(again.diagnostics.rowsImported).toBe(1);
  });

  it("stores an unsupported file with its own format", async () => {
    const r = await importFile({ fileName: "scan.pdf", bytes: new Uint8Array([1]), receivedAt: at }, opts);
    expect(r.evidence.format).toBe("pdf");
  });

  it("applies the owner's column mapping", async () => {
    const csv = "Ref,Who,Net\nA-1,Acme,100.00\nA-2,Beta,250.00\n";
    const r = await importFile({ fileName: "x.csv", bytes: new TextEncoder().encode(csv), receivedAt: at }, { ...opts, columnMapping: { reference: 0, party: 1, amount: 2 }, headerRow: 1, currency: "USD" });
    expect(r.previews[0]!.mapping?.source).not.toBe("inferred");
    expect(r.diagnostics).toMatchObject({ rowsRead: 2, rowsImported: 2 });
  });

  it("handles semicolon delimiters, BOM, and quoted commas", () => {
    const s = readCsv("﻿Invoice;Customer;Amount\nINV-1;\"Acme, Inc\";1.234,50\n", "ev-x");
    expect(s.rows).toEqual([["Invoice", "Customer", "Amount"], ["INV-1", "Acme, Inc", "1.234,50"]]);
  });

  it("explains an unreadable or unsupported file and keeps the source", async () => {
    const pdf = await importFile({ fileName: "scan.pdf", bytes: new Uint8Array([1, 2, 3]), receivedAt: at }, opts);
    expect(pdf.evidence.extraction).toBe("unsupported");
    expect(pdf.diagnostics.errors[0]!.nextStep).toMatch(/CSV or XLSX|paste/);
    expect(pdf.diagnostics.completeness).toBe(0);
    const broken = await importFile({ fileName: "bad.xlsx", bytes: new Uint8Array([1, 2, 3]), receivedAt: at }, opts);
    expect(broken.evidence.extraction).toBe("unreadable");
    expect(broken.diagnostics.errors[0]!.message).toMatch(/could not be opened/);
  });

  it("reports a file with no invoice columns instead of importing nothing silently", async () => {
    const r = await importFile({ fileName: "notes.csv", bytes: new TextEncoder().encode("a,b\nhello,world\n"), receivedAt: at }, opts);
    expect(r.diagnostics.rowsImported).toBe(0);
    expect(r.diagnostics.errors.length).toBeGreaterThan(0);
    expect(r.diagnostics.completeness).toBe(0);
  });
});

async function workbook(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("AR");
  ws.addRow(["Invoice #", "Customer", "Invoice Date", "Due Date", "Currency", "Amount"]);
  ws.addRow(["INV-1", "Acme", new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 10, 1)), "USD", 100]);
  ws.addRow(["INV-2", "Beta", new Date(Date.UTC(2026, 9, 2)), new Date(Date.UTC(2026, 10, 2)), "USD", { formula: "A1*2", result: 250 }]);
  ws.addRow(["INV-3", "Gamma", new Date(Date.UTC(2026, 9, 3)), new Date(Date.UTC(2026, 10, 3)), "USD", { formula: "SUM(Z1:Z2)" } as ExcelJS.CellValue]);
  const hidden = wb.addWorksheet("Hidden");
  hidden.addRow(["secret"]);
  hidden.state = "hidden";
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe("XLSX import", () => {
  it("reads cached values, ISO dates, and skips hidden sheets", async () => {
    const sheets = await readXlsx(await workbook(), "ev-w");
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.rows[1]).toEqual(["INV-1", "Acme", "2026-10-01", "2026-11-01", "USD", 100]);
    expect(sheets[0]!.rows[2]![5]).toBe(250);
    expect(sheets[0]!.rows[3]![5]).toBeNull();
  });

  it("an uncached formula amount is missing, not zero", async () => {
    const r = await importFile({ fileName: "ar.xlsx", bytes: await workbook(), receivedAt: at }, opts);
    expect(r.evidence.format).toBe("xlsx");
    const amounts = r.previews[0]!.candidates.map((c) => c.fields.amount.state);
    expect(amounts).toEqual(["found", "found", "missing"]);
    expect(r.diagnostics.errors.map((e) => e.code)).toEqual(["missing_amount"]);
  });
});
