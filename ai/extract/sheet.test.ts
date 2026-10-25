import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IntakeCandidate } from "../../schema/intake";
import { validateCandidate } from "../normalize";
import {
  classifySheet, documentToCandidate, SHEET_MAX_COLUMNS, SHEET_MAX_ROWS, tableToCandidates,
  type SheetCell, type SheetContent,
} from "./sheet";

const root = join(import.meta.dirname, "../..");
const load = (name: string) => JSON.parse(readFileSync(join(root, "fixtures/cascade_trade/intake/sheets", name), "utf8")) as SheetContent;
const cases = JSON.parse(readFileSync(join(root, "fixtures/expected/intake/sheet-cases.json"), "utf8")) as {
  business: string;
  cases: { id: string; input: string; expect: Record<string, any> }[];
};
const expected = (id: string) => cases.cases.find((c) => c.id === id)!.expect;

const opts = { business: { name: cases.business }, idPrefix: "cand-xlsx" };
const sheet = (rows: SheetCell[][], name = "S"): SheetContent => ({ evidenceId: "ev-x", sheet: name, rows });
const val = <T>(f: { state: string; value?: T }) => (f.state === "found" ? f.value : undefined);

describe("classifySheet", () => {
  it.each(cases.cases)("$id", ({ input, expect: e }) => {
    const c = classifySheet(load(input));
    expect(c.layout).toBe(e.layout);
    expect(c.headerRow).toBe(e.headerRow);
    expect(c.reason.length).toBeGreaterThan(0);
  });

  it("is unknown for an empty sheet", () => {
    expect(classifySheet(sheet([])).layout).toBe("unknown");
  });

  it("does not call a line-item grid a table", () => {
    const c = classifySheet(sheet([["Description", "Qty", "Amount"], ["Mugs", 2, 20]]));
    expect(c.layout).toBe("unknown");
  });
});

describe("tableToCandidates: AR aging", () => {
  const e = expected("ar-aging-table");
  const r = tableToCandidates(load("ar-aging-table.json"), opts);

  it("makes one candidate per invoice row and reports the totals row", () => {
    expect(r.candidates).toHaveLength(e.candidates);
    expect(r.rejectedRows).toEqual([{ row: 10, reason: expect.stringContaining("Totals") }]);
    expect(r.candidates.every((c) => c.kind === e.kind && c.direction === e.direction)).toBe(true);
    expect(r.candidates.map((c) => c.id)).toEqual(["cand-xlsx-5", "cand-xlsx-6", "cand-xlsx-7", "cand-xlsx-8"]);
  });

  it("reads the expected fields with sheet/row evidence", () => {
    for (const [ref, x] of Object.entries<any>(e.byReference)) {
      const c = r.candidates.find((k) => val(k.fields.reference) === ref)!;
      expect(c, ref).toBeDefined();
      expect(val(c.fields.amount), ref).toBe(x.amount);
      expect(val(c.fields.buyerName), ref).toBe(x.party);
      expect(val(c.fields.dueDate), ref).toBe(x.dueDate);
      expect(val(c.fields.currency)).toBe("USD");
      const amount = c.fields.amount;
      if (amount.state !== "found") throw new Error("amount");
      expect(amount.evidence[0]).toMatchObject({ evidenceId: "ev-xlsx-ar-aging", sheet: "AR Aging", row: x.row });
      expect(c.fields.outstanding && val(c.fields.outstanding)).toBe(x.amount);
    }
    const inv1187 = r.candidates.find((k) => val(k.fields.reference) === "INV-1187")!;
    expect(inv1187.fields.amount).toMatchObject({ state: "found", value: 2800000, evidence: [{ text: "28,000.00", row: 5 }] });
  });

  it("finds the business on our side from the sheet title", () => {
    expect(val(r.candidates[0]!.fields.sellerName)).toBe("Cascade Trade Co.");
  });

  it("returns the mapping it used", () => {
    expect(r.proposedMapping).toMatchObject({
      headerRow: 4, partyKind: "customer", source: "inferred",
      columns: { reference: 0, party: 1, issueDate: 2, dueDate: 3, currency: 4, amount: 5, outstanding: 6 },
      headers: { reference: "Invoice #", amount: "Amount", outstanding: "Balance Due" },
    });
  });

  it("passes validateCandidate with no issues", () => {
    for (const c of r.candidates) expect(validateCandidate(c), c.id).toEqual([]);
    expect(r.candidates.every((c) => c.extraction === "ok")).toBe(true);
  });
});

describe("tableToCandidates: variations", () => {
  const header = ["Bill No", "Vendor", "Total", "Due"];

  it("treats a vendor column as bills (money out) and puts the business on the buyer side", () => {
    const r = tableToCandidates(sheet([header, ["B-1", "Shenzhen Ceramics Co.", "4,200.00", "12/14/2026"]]), { ...opts, currency: "USD" });
    const c = r.candidates[0]!;
    expect(c).toMatchObject({ kind: "bill", direction: "out" });
    expect(val(c.fields.sellerName)).toBe("Shenzhen Ceramics Co.");
    expect(c.fields.buyerName.state).toBe("missing");
    expect(val(c.fields.amount)).toBe(420000);
    expect(val(c.fields.dueDate)).toBe("2026-12-14");
    expect(val(c.fields.currency)).toBe("USD");
    expect(c.notes.join(" ")).toMatch(/business default USD/);
    expect(validateCandidate(c)).toEqual([]);
  });

  it("falls back to an invoice with a note when the party column is ambiguous", () => {
    const r = tableToCandidates(sheet([["Invoice #", "Name", "Amount"], ["INV-9", "Someone", 10]]), opts);
    expect(r.candidates[0]!.kind).toBe("invoice");
    expect(r.candidates[0]!.notes.join(" ")).toMatch(/does not say customer or vendor/);
  });

  it("a missing amount is missing, never 0, and the row stays a partial candidate", () => {
    const r = tableToCandidates(sheet([["Invoice #", "Customer", "Amount"], ["INV-1", "A", null], ["INV-2", "B", "n/a"], ["INV-3", "C", 0]]), { ...opts, currency: "USD" });
    expect(r.candidates).toHaveLength(3);
    expect(r.rejectedRows).toEqual([]);
    for (const c of r.candidates.slice(0, 2)) {
      expect(c.fields.amount.state).toBe("missing");
      expect(c.extraction).toBe("partial");
      expect(validateCandidate(c)).toEqual([]);
    }
    // A 0 in the sheet (often an uncached formula) is not a stated amount either.
    expect(r.candidates[2]!.fields.amount.state).toBe("missing");
    expect(r.candidates[2]!.extraction).toBe("partial");
  });

  it("refuses free text in an amount cell instead of scraping its digits", () => {
    const cells = ["28k", "10% of 28,000", "Net 30", "see inv 1187", "2 x 5,000", "1.2M", "maybe 28k?"];
    const r = tableToCandidates(sheet([["Invoice #", "Customer", "Amount"], ...cells.map((t, i) => [`INV-${i}`, `C${i}`, t] as SheetCell[])]), { ...opts, currency: "USD" });
    expect(r.candidates).toHaveLength(cells.length);
    for (const c of r.candidates) expect(c.fields.amount.state).toBe("missing");
    const ok = tableToCandidates(sheet([["Invoice #", "Customer", "Amount"], ["INV-1", "A", "USD 6,200.00"], ["INV-2", "B", "$4,000"], ["INV-3", "C", "(50.00)"]]), { ...opts, currency: "USD" });
    expect(ok.candidates.map((c) => val(c.fields.amount))).toEqual([620000, 400000, undefined]);
  });

  it("rejects footer rows that start with Total in the invoice column", () => {
    const r = tableToCandidates(sheet([
      ["Invoice #", "Customer", "Amount"], ["INV-1", "A", 10], ["Total (1 invoice)", null, 10], ["Total 10", null, 10], ["TOTAL USD", null, 10],
    ]), opts);
    expect(r.candidates).toHaveLength(1);
    expect(r.rejectedRows.map((x) => x.row)).toEqual([3, 4, 5]);
  });

  it("rejects repeated invoice numbers for the same party (line items), keeps same number for different parties", () => {
    const lines = tableToCandidates(sheet([["Invoice #", "Customer", "Amount"], ["INV-1", "A", 20], ["INV-1", "A", 30]]), opts);
    expect(lines.candidates).toEqual([]);
    expect(lines.rejectedRows).toHaveLength(2);
    const two = tableToCandidates(sheet([["Invoice #", "Customer", "Amount"], ["0042", "A", 20], ["0042", "B", 30]]), opts);
    expect(two.candidates).toHaveLength(2);
  });

  it("marks a candidate partial when no currency is known", () => {
    const c = tableToCandidates(sheet([["Invoice #", "Customer", "Amount"], ["INV-1", "A", 10]]), opts).candidates[0]!;
    expect(c.fields.currency.state).toBe("missing");
    expect(c.extraction).toBe("partial");
  });

  it("falls through to the document layout when the 'table' has no invoice-number data rows", () => {
    const s = sheet([["Invoice #", "INV-1", "Amount Due", "$500"], ["Bill to", "X"]]);
    expect(classifySheet(s).layout).not.toBe("table");
  });

  it("rejects rows with no reference, junk text in the reference column, and totals; skips blanks", () => {
    const r = tableToCandidates(sheet([
      ["Invoice #", "Customer", "Amount"],
      [null, "Orphan Co", 100],
      [null, null, null],
      ["Notes: all USD", null, null],
      ["INV-5", "Real Co", 50],
      ["Subtotal", null, 50],
      ["Grand total", null, 50],
    ]), opts);
    expect(r.candidates.map((c) => val(c.fields.reference))).toEqual(["INV-5"]);
    expect(r.rejectedRows.map((x) => x.row)).toEqual([2, 4, 6, 7]);
  });

  it("does not turn a customer called 'Total Wine' into a totals row", () => {
    const r = tableToCandidates(sheet([["Invoice #", "Customer", "Amount"], ["INV-5", "Total Wine", 50]]), opts);
    expect(r.candidates).toHaveLength(1);
  });

  it("uses the owner mapping over inferred columns and a given header row", () => {
    const rows: SheetCell[][] = [
      ["x", "y", "z"],
      ["code", "who", "cost", "when"],
      ["A-100", "Evergreen Home", "1,000.00", "2026-12-01"],
    ];
    const r = tableToCandidates(sheet(rows), { ...opts, currency: "USD", headerRow: 2, columnMapping: { reference: 0, party: 1, amount: 2, dueDate: 3 } });
    expect(r.proposedMapping).toMatchObject({ headerRow: 2, source: "owner", columns: { reference: 0, amount: 2 } });
    expect(val(r.candidates[0]!.fields.amount)).toBe(100000);
    expect(r.candidates[0]!.fields.amount).toMatchObject({ evidence: [{ sheet: "S", row: 3, text: "1,000.00" }] });
  });

  it("asks for a mapping when columns can't be inferred", () => {
    const r = tableToCandidates(load("messy.json"), opts);
    expect(r.candidates).toEqual([]);
    expect(r.reason).toMatch(/mapping/);
  });

  it("reads Excel serial dates and notes ambiguous text dates", () => {
    const r = tableToCandidates(sheet([
      ["Invoice #", "Customer", "Amount", "Due Date", "Invoice Date"],
      ["INV-1", "A", 10, 46366, "03/04/2026"],
    ]), opts);
    const c = r.candidates[0]!;
    expect(val(c.fields.dueDate)).toBe("2026-12-10");
    expect(val(c.fields.issueDate)).toBe("2026-03-04");
    expect(c.notes.join(" ")).toMatch(/ambiguous/);
    expect(val(tableToCandidates(sheet([["Invoice #", "Customer", "Amount", "Invoice Date"], ["INV-1", "A", 10, "03/04/2026"]]), { ...opts, dayFirst: true }).candidates[0]!.fields.issueDate)).toBe("2026-04-03");
  });

  it("does not turn negative amounts (credits) into candidates' amounts", () => {
    const r = tableToCandidates(sheet([["Invoice #", "Customer", "Amount"], ["CR-1", "A", -50]]), opts);
    expect(r.candidates[0]!.fields.amount.state).toBe("missing");
  });
});

describe("tableToCandidates: limits", () => {
  const rowsOf = (n: number): SheetCell[][] => [
    ["Invoice #", "Customer", "Amount"],
    ...Array.from({ length: n - 1 }, (_, i) => [`INV-${i}`, "A", 10] as SheetCell[]),
  ];

  it("accepts exactly the row limit", () => {
    const r = tableToCandidates(sheet(rowsOf(SHEET_MAX_ROWS)), opts);
    expect(r.candidates).toHaveLength(SHEET_MAX_ROWS - 1);
  });

  it("over the row limit returns no candidates and a reason", () => {
    const s = sheet(rowsOf(SHEET_MAX_ROWS + 1));
    const r = tableToCandidates(s, opts);
    expect(r.candidates).toEqual([]);
    expect(r.reason).toMatch(/501 rows/);
    expect(classifySheet(s).layout).toBe("unknown");
  });

  it("ignores trailing blank rows when counting", () => {
    const rows = [...rowsOf(5), ...Array.from({ length: 1000 }, () => [null, null, null] as SheetCell[])];
    expect(tableToCandidates(sheet(rows), opts).candidates).toHaveLength(4);
  });

  it("over the column limit returns no candidates and a reason", () => {
    const wide = ["Invoice #", "Customer", "Amount", ...Array.from({ length: SHEET_MAX_COLUMNS - 2 }, (_, i) => `c${i}`)];
    const r = tableToCandidates(sheet([wide, ["INV-1", "A", 1]]), opts);
    expect(wide).toHaveLength(SHEET_MAX_COLUMNS + 1);
    expect(r.candidates).toEqual([]);
    expect(r.reason).toMatch(/51 columns/);
  });
});

describe("documentToCandidate: single invoice", () => {
  const e = expected("single-invoice");
  const s = load("single-invoice.json");
  const c = documentToCandidate(s, opts);

  it("reads the form's labels", () => {
    expect(c).toMatchObject({ id: "cand-xlsx", kind: e.kind, direction: e.direction, extraction: "ok", evidenceIds: ["ev-xlsx-single-invoice"] });
    expect(val(c.fields.reference)).toBe(e.reference);
    expect(val(c.fields.buyerName)).toBe(e.party);
    expect(val(c.fields.sellerName)).toBe("Cascade Trade Co.");
    expect(val(c.fields.currency)).toBe(e.currency);
    expect(val(c.fields.dueDate)).toBe(e.dueDate);
    expect(val(c.fields.issueDate)).toBe("2026-10-20");
    expect(val(c.fields.poReference!)).toBe(e.poReference);
    expect(val(c.fields.terms!)).toBe(e.terms);
  });

  it("takes the stated total, not the sum of line items, with sheet/row evidence", () => {
    expect(c.fields.amount).toMatchObject({
      state: "found", value: e.amount,
      evidence: [{ evidenceId: "ev-xlsx-single-invoice", sheet: "Invoice", row: 15, text: "USD 31,200.00" }],
    });
  });

  it("adds no reconciliation note when line items + freight match the total", () => {
    expect(c.notes.some((n) => /does not match/.test(n))).toBe(e.noteAboutTotalMismatch);
  });

  it("passes validateCandidate", () => {
    expect(validateCandidate(c)).toEqual([]);
  });
});

describe("documentToCandidate: edge cases", () => {
  const form = (items: number[], summary: SheetCell[][]): SheetCell[][] => [
    ["Invoice #", "INV-77", null, "Bill to", "Puget Market"],
    ["Due date", "2026-11-30", null, null, null],
    [null, null, null, null, null],
    ["Description", "Qty", "Amount"],
    ...items.map((n, i) => [`Item ${i + 1}`, 1, n] as SheetCell[]),
    [null, null, null],
    ...summary,
  ];

  it("keeps the stated total and notes when line items + charges do not reconcile", () => {
    const c = documentToCandidate(sheet(form([1000, 2000], [[null, "Subtotal", 3000], [null, "Freight", 100], [null, "Total due", 3500]])), { ...opts, currency: "USD" });
    expect(val(c.fields.amount)).toBe(350000);
    expect(c.notes.join(" ")).toMatch(/Line items sum to 3000\.00 and charges\/discounts to 100\.00.*stated total 3500\.00/);
    expect(validateCandidate(c)).toEqual([]);
  });

  it("does not note when a discount makes it reconcile", () => {
    const c = documentToCandidate(sheet(form([1000, 2000], [[null, "Discount", 500], [null, "Total", 2500]])), { ...opts, currency: "USD" });
    expect(val(c.fields.amount)).toBe(250000);
    expect(c.notes.some((n) => /does not match/.test(n))).toBe(false);
  });

  it("prefers Total due over Subtotal and never uses the subtotal as the amount", () => {
    const c = documentToCandidate(sheet(form([100], [[null, "Subtotal", 100], [null, "Total due", "USD 110.00"]])), opts);
    expect(val(c.fields.amount)).toBe(11000);
  });

  it("amount is missing, never 0 or a sum, when there is no total line", () => {
    const c = documentToCandidate(sheet(form([1000, 2000], [[null, "Subtotal", 3000]])), { ...opts, currency: "USD" });
    expect(c.fields.amount).toEqual({ state: "missing", reason: "no total line; line items not summed" });
    expect(c.extraction).toBe("partial");
    expect(validateCandidate(c)).toEqual([]);
  });

  it("reads an inline 'Total due USD 31,200.00' cell", () => {
    const c = documentToCandidate(sheet(form([100], [["Total due USD 31,200.00", null, null]])), opts);
    expect(c.fields.amount).toMatchObject({ state: "found", value: 3120000, evidence: [{ text: "Total due USD 31,200.00" }] });
    expect(val(c.fields.currency)).toBe("USD");
  });

  it("does not read the line-item 'Total' column header as the document total", () => {
    const rows: SheetCell[][] = [
      ["Invoice #", "INV-1", null, "Bill to", "Puget Market"],
      ["Description", "Qty", "Total"],
      ["Mugs", 2, 500],
      [null, null, null],
    ];
    expect(documentToCandidate(sheet(rows), opts).fields.amount.state).toBe("missing");
  });

  it("does not read a SKU grid's Total header, or 'Total Qty 400', as the document total", () => {
    const rows: SheetCell[][] = [
      ["Invoice #", "INV-1", null, "Bill to", "Puget Market"],
      ["SKU", "Qty", "Unit price", "Total"],
      ["M-1", 2, 50, 100],
      [null, null, null, null],
      ["Total Qty 400", null, null, null],
    ];
    const c = documentToCandidate(sheet(rows), opts);
    expect(c.fields.amount.state).toBe("missing");
    const withTotal = documentToCandidate(sheet([...rows, ["Total due USD 31,200.00"]]), opts);
    expect(val(withTotal.fields.amount)).toBe(3120000);
  });

  it("does not take an address under a title as the invoice number", () => {
    const rows: SheetCell[][] = [["INVOICE"], ["123 Main Street, Seattle"], ["Bill to", "Puget Market"], ["Total", "USD 10.00"]];
    expect(documentToCandidate(sheet(rows), opts).fields.reference.state).toBe("missing");
  });

  it("a balance-only sheet keeps the balance as amount with a note and as outstanding", () => {
    const c = documentToCandidate(sheet(form([100], [[null, "Balance due", "USD 60.00"]])), opts);
    expect(val(c.fields.amount)).toBe(6000);
    expect(c.fields.outstanding && val(c.fields.outstanding)).toBe(6000);
    expect(c.notes.join(" ")).toMatch(/Only a balance/);
  });

  it("a conflicting total does not also claim the amount is missing", () => {
    const c = documentToCandidate(sheet(form([100], [[null, "Total", 100], [null, "Total due", 120]])), { ...opts, currency: "USD" });
    expect(c.notes.join(" ")).not.toMatch(/Amount is missing/);
    expect(c.extraction).toBe("partial");
  });

  it("flags differing totals as a conflict instead of choosing", () => {
    const c = documentToCandidate(sheet(form([100], [[null, "Total", 100], [null, "Total due", 120]])), { ...opts, currency: "USD" });
    expect(c.fields.amount.state).toBe("conflict");
    expect(validateCandidate(c)).toEqual([]);
  });

  it("reads a balance due next to the total as outstanding", () => {
    const c = documentToCandidate(sheet(form([100], [[null, "Total", 100], [null, "Balance due", 40]])), { ...opts, currency: "USD" });
    expect(val(c.fields.amount)).toBe(10000);
    expect(c.fields.outstanding && val(c.fields.outstanding)).toBe(4000);
  });

  it("treats a vendor/supplier sheet that names us as buyer as a bill", () => {
    const rows: SheetCell[][] = [
      ["Invoice #", "SC-0042", null, "From", "Shenzhen Ceramics Co."],
      ["Bill to", "Cascade Trade Co.", null, null, null],
      ["Total", "42,000.00"],
    ];
    const c = documentToCandidate(sheet(rows), { ...opts, currency: "USD" });
    expect(c).toMatchObject({ kind: "bill", direction: "out" });
    expect(val(c.fields.sellerName)).toBe("Shenzhen Ceramics Co.");
    expect(val(c.fields.buyerName)).toBe("Cascade Trade Co.");
  });
});

describe("messy sheet", () => {
  it("is unknown and yields nothing", () => {
    const e = expected("messy");
    const s = load("messy.json");
    expect(classifySheet(s).layout).toBe(e.layout);
    expect(tableToCandidates(s, opts).candidates).toHaveLength(e.candidates);
  });
});

describe("candidates never invent cash", () => {
  it("every produced candidate has no zero amount unless the sheet said 0", () => {
    const all: IntakeCandidate[] = [
      ...tableToCandidates(load("ar-aging-table.json"), opts).candidates,
      documentToCandidate(load("single-invoice.json"), opts),
    ];
    for (const c of all) expect(val(c.fields.amount)).toBeGreaterThan(0);
  });
});
