// Synthetic statements only (fixtures/bank): invented payees and amounts, no real data.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { openingCash } from "../../engine/forecast";
import { Notes } from "../../engine/review";
import type { Profile } from "../../schema/profile";
import type { Records } from "../../schema/records";
import { describe as describeImport } from "../core/diagnostics";
import { importBankStatement, newestBalance, type Line } from "./statement";

const root = join(__dirname, "..", "..");
const fixture = (name: string) => new Uint8Array(readFileSync(join(root, "fixtures/bank", name)));
const enc = (s: string) => new TextEncoder().encode(s);
const AT = "2026-10-25T18:00:00Z";
const opts = { currency: "USD" };
const run = (name: string, o = {}) => importBankStatement({ fileName: name, bytes: fixture(name), receivedAt: AT }, { ...opts, ...o });
const csv = (text: string, o = {}) => importBankStatement({ fileName: "s.csv", bytes: enc(text), receivedAt: AT }, { ...opts, ...o });

describe("bank statement: signed amount layout", () => {
  it("imports every readable line as an actual event and keeps each unreadable row visible", async () => {
    const r = await run("statement-signed.csv");
    expect(r.readable).toBe(true);
    expect(r.events).toHaveLength(17);
    expect(r.diagnostics).toMatchObject({ rowsRead: 20, rowsImported: 17, rowsRejected: 3, source: "bank_csv", newestRecordAt: "2026-10-23T00:00:00Z" });
    expect(r.diagnostics.errors.map((e) => e.code).sort()).toEqual(["invalid_amount", "invalid_date", "missing_amount"]);
    for (const e of r.diagnostics.errors) { expect(e.nextStep).not.toBe(""); expect(e.row).toBeGreaterThan(1); }
    expect(r.diagnostics.warnings.join(" ")).toMatch(/1 summary row/);
    expect(describeImport(r.diagnostics)).toBe("17 of 20 rows imported, 3 need your attention");
    expect(r.evidence).toMatchObject({ channel: "bank_csv", format: "csv", extraction: "partial", fileName: "statement-signed.csv" });
    expect(r.evidence.sourceRef.record).toMatch(/^file-[0-9a-f]{16}$/);
  });

  it("a missing or unreadable amount is never zero and never an event", async () => {
    const r = await run("statement-signed.csv");
    expect(r.events.every((e) => e.amount > 0)).toBe(true);
    expect(r.events.some((e) => /UNREADABLE|MISSING|CORRUPT/.test(e.basis))).toBe(false);
  });

  it("events are actual bank history with money in minor units, direction from the sign, and no guessed invoice match", async () => {
    const r = await run("statement-signed.csv");
    const rent = r.events.find((e) => /RENT/.test(e.basis) && e.date === "2026-10-01")!;
    expect(rent).toMatchObject({ status: "actual", direction: "out", amount: 420000, currency: "USD", account: "bank", legIndex: 0, confidence: 1 });
    expect(rent.basis).toMatch(/not matched to an invoice or bill/);
    expect(r.events.find((e) => /EVERGREEN/.test(e.basis))).toMatchObject({ direction: "in", amount: 2800000 });
    expect(r.events.every((e) => e.commitmentId === undefined && e.sourceRef.system === "bank_csv")).toBe(true);
    expect(r.unallocated).toBe(17);
    expect(r.diagnostics.warnings.join(" ")).toMatch(/17 bank lines are not linked to any invoice or bill/);
  });

  it("sets today's cash from the newest running balance, dated the day after the newest line", async () => {
    const r = await run("statement-signed-clean.csv");
    expect(r.balances).toEqual([expect.objectContaining({ amount: 5387200, currency: "USD", account: "bank", asOf: "2026-10-24" })]);
  });

  it("opening cash in the engine equals the statement balance: the last day's lines are not counted twice", async () => {
    const r = await run("statement-signed-clean.csv");
    const profile = JSON.parse(readFileSync(join(root, "profiles/trading.json"), "utf8")) as Profile;
    const records = { parties: [], commitments: [], events: r.events, signals: [], rules: [], settlements: [], balances: r.balances, evidence: [] } as Records;
    const notes = new Notes();
    expect(openingCash(records, profile, "2026-10-25", { USD: 1 }, notes).opening).toBe(5387200);
    // A line dated after the statement is rolled forward on top of the balance.
    const later = { ...r.events[0]!, id: "evt-later", date: "2026-10-24", amount: 100000, direction: "out" as const };
    expect(openingCash({ ...records, events: [...r.events, later] }, profile, "2026-10-25", { USD: 1 }, new Notes()).opening).toBe(5287200);
  });

  it("proposes the payroll and the rent, and leaves the near-misses alone", async () => {
    const r = await run("statement-signed.csv");
    const names = r.recurring.map((p) => [p.payee.replace(/ #\d+$/, ""), p.cadence, p.typicalAmount, p.occurrences]);
    expect(names).toEqual(expect.arrayContaining([
      ["ACH DEBIT NORTHWIND PAYROLL", "biweekly", 1400000, 6],
      ["RENT HARBOR PROPERTIES LLC", "monthly", 420000, 3],
    ]));
    const proposed = r.recurring.map((p) => p.payee).join("|");
    expect(proposed).not.toMatch(/PACIFIC SUPPLY|STREAMLINE|CITY UTILITIES|EVERGREEN/);   // irregular, only two, amounts vary, one-off
    expect(r.recurring).toHaveLength(2);
    expect(r.diagnostics.warnings.join(" ")).toMatch(/2 payments look regular\. Confirm them/);
  });
});

describe("bank statement: debit/credit layout with title rows", () => {
  it("finds the header below the title rows and reads debit and credit columns", async () => {
    const r = await run("statement-debit-credit.csv");
    expect(r.mapping).toMatchObject({ headerRow: 3, source: "inferred", columns: { date: 0, description: 1, debit: 2, credit: 3, balance: 4 } });
    expect(r.events).toHaveLength(17);
    expect(r.diagnostics.errors).toEqual([]);
    expect(r.diagnostics.warnings.join(" ")).toMatch(/2 summary rows/);   // beginning balance and totals
    expect(r.balances[0]).toMatchObject({ amount: 5387200, asOf: "2026-10-24" });
  });

  it("the same lines in either layout get the same event ids, so statements overlap cleanly", async () => {
    const a = await run("statement-signed.csv");
    const b = await run("statement-debit-credit.csv");
    expect(new Set(b.events.map((e) => e.id))).toEqual(new Set(a.events.map((e) => e.id)));
    expect(new Set(a.events.map((e) => e.id)).size).toBe(17);
  });

  it("a line with both a debit and a credit is rejected, not guessed", async () => {
    const r = await csv("Date,Description,Debit,Credit\n2026-10-01,Odd line,10.00,10.00\n2026-10-02,Fine,5.00,\n");
    expect(r.events).toHaveLength(1);
    expect(r.diagnostics.errors[0]).toMatchObject({ code: "invalid_amount" });
  });
});

describe("bank statement: repeat and idempotent ids", () => {
  it("the same bytes again are a repeat: no events, no balance, nothing proposed", async () => {
    const first = await run("statement-signed.csv");
    const again = await run("statement-signed.csv", { existingEvidence: [first.evidence] });
    expect(again.repeat).toBe(true);
    expect(again.events).toEqual([]);
    expect(again.balances).toEqual([]);
    expect(again.recurring).toEqual([]);
    expect(again.diagnostics).toMatchObject({ rowsImported: 0, rowsDuplicate: 20, rowsRejected: 0 });
    expect(again.evidence.id).toBe(first.evidence.id);
  });

  it("an owner correction is read again, and an unreadable earlier evidence is not a repeat", async () => {
    const first = await run("statement-signed.csv");
    const fixed = await run("statement-signed.csv", { existingEvidence: [{ ...first.evidence, extraction: "unreadable" }] });
    expect(fixed.repeat).toBe(false);
    expect(fixed.events).toHaveLength(17);
  });

  it("re-importing gives the same ids; row order does not matter; identical lines on one day stay distinct", async () => {
    const text = "Date,Description,Amount\n2026-10-01,COFFEE BAR,-4.50\n2026-10-01,COFFEE BAR,-4.50\n2026-10-02,RENT,-1000.00\n";
    const a = await csv(text);
    const b = await csv(text);
    const shuffled = await csv("Date,Description,Amount\n2026-10-02,RENT,-1000.00\n2026-10-01,COFFEE BAR,-4.50\n2026-10-01,COFFEE BAR,-4.50\n");
    expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id));
    expect(new Set(a.events.map((e) => e.id)).size).toBe(3);
    expect(new Set(shuffled.events.map((e) => e.id))).toEqual(new Set(a.events.map((e) => e.id)));
  });

  it("a different account gives different ids for the same lines", async () => {
    const text = "Date,Description,Amount\n2026-10-01,RENT,-1000.00\n";
    const a = await csv(text, { account: "checking" });
    const b = await csv(text, { account: "savings" });
    expect(a.events[0]!.id).not.toBe(b.events[0]!.id);
    expect(a.events[0]!.account).toBe("checking");
  });
});

describe("bank statement: mapping", () => {
  const odd = "When,Who,How much,Left\n2026-10-01,Landlord,-1000.00,9000.00\n2026-10-02,Customer,250.00,9250.00\n";
  it("an unrecognised layout asks for a mapping instead of importing nothing silently", async () => {
    const r = await csv(odd);
    expect(r.events).toEqual([]);
    expect(r.diagnostics.errors[0]).toMatchObject({ code: "unmapped_column" });
    expect(r.diagnostics.errors[0]!.nextStep).toMatch(/Pick which columns/);
    expect(r.diagnostics.completeness).toBe(0);
    expect(r.evidence.extraction).toBe("partial");
  });

  it("the owner's column mapping reads it", async () => {
    const r = await csv(odd, { columnMapping: { date: 0, description: 1, amount: 2, balance: 3 }, headerRow: 1 });
    expect(r.mapping.source).toBe("owner");
    expect(r.events.map((e) => [e.direction, e.amount])).toEqual([["out", 100000], ["in", 25000]]);
    expect(r.balances[0]).toMatchObject({ amount: 925000, asOf: "2026-10-03" });
  });

  it("an owner who maps debit and credit does not keep a leftover amount column", async () => {
    const text = "Date,Memo,Amount,Out,In\n2026-10-01,Rent,999.00,1000.00,\n";
    const r = await csv(text, { columnMapping: { date: 0, description: 1, debit: 3, credit: 4 }, headerRow: 1 });
    expect(r.events[0]).toMatchObject({ direction: "out", amount: 100000 });
  });
});

describe("bank statement: the balance only when it is unambiguous", () => {
  const line = (date: string, signed: number, balance: number | undefined, row = 1): Line => ({ row, date, signed, currency: "USD", description: "x", ...(balance === undefined ? {} : { balance }) });

  it("no running-balance column: no snapshot, and the owner is told to enter the balance", async () => {
    const r = await csv("Date,Description,Amount\n2026-10-01,RENT,-1000.00\n");
    expect(r.balances).toEqual([]);
    expect(r.diagnostics.warnings.join(" ")).toMatch(/no running-balance column.*Enter your current bank balance yourself/);
  });

  it("several lines on the newest day: the chain of balances finds the last one, in either file order", async () => {
    const asc = await csv("Date,Description,Amount,Balance\n2026-10-01,A,-100.00,900.00\n2026-10-01,B,-50.00,850.00\n");
    const desc = await csv("Date,Description,Amount,Balance\n2026-10-01,B,-50.00,850.00\n2026-10-01,A,-100.00,900.00\n");
    expect(asc.balances[0]).toMatchObject({ amount: 85000, asOf: "2026-10-02" });
    expect(desc.balances[0]).toMatchObject({ amount: 85000, asOf: "2026-10-02" });
  });

  it("balances that do not chain on the newest day: no snapshot, with a plain explanation", async () => {
    const r = await csv("Date,Description,Amount,Balance\n2026-10-01,A,-100.00,900.00\n2026-10-01,B,-50.00,1234.00\n");
    expect(r.balances).toEqual([]);
    expect(r.events).toHaveLength(2);
    expect(r.diagnostics.warnings.join(" ")).toMatch(/could not tell which balance is the latest/);
  });

  it("an unreadable newest balance gives no snapshot; an older unreadable one does not matter", async () => {
    const bad = await csv("Date,Description,Amount,Balance\n2026-10-01,A,-100.00,900.00\n2026-10-02,B,-50.00,n/a\n");
    expect(bad.balances).toEqual([]);
    const ok = await csv("Date,Description,Amount,Balance\n2026-10-01,A,-100.00,n/a\n2026-10-02,B,-50.00,850.00\n");
    expect(ok.balances[0]).toMatchObject({ amount: 85000 });
  });

  it("newestBalance: one currency only, and every newest line needs a balance", () => {
    expect(newestBalance([])).toBeUndefined();
    expect(newestBalance([line("2026-10-01", -1, 5)])).toMatchObject({ amount: 5, date: "2026-10-01" });
    expect(newestBalance([line("2026-10-01", -1, 5), line("2026-10-01", -1, undefined, 2)])).toBeUndefined();
    expect(newestBalance([line("2026-10-01", -1, 5), { ...line("2026-10-01", -1, 4, 2), currency: "EUR" }])).toBeUndefined();
  });
});

describe("bank statement: other inputs", () => {
  it("reads a per-row currency column and an ambiguous date warning", async () => {
    const r = await csv("Date,Description,Amount,Currency\n03/04/2026,EU supplier,-100.00,EUR\n2026-10-02,US rent,-50.00,\n");
    expect(r.events.map((e) => [e.currency, e.amount])).toEqual([["EUR", 10000], ["USD", 5000]]);
    expect(r.diagnostics.warnings.join(" ")).toMatch(/March 4 or April 3/);
    const dayFirst = await csv("Date,Description,Amount\n03/04/2026,x,-1.00\n", { dayFirst: true });
    expect(dayFirst.events[0]!.date).toBe("2026-04-03");
    expect(dayFirst.diagnostics.warnings.join(" ")).not.toMatch(/March 4/);
    const badCur = await csv("Date,Description,Amount,Currency\n2026-10-01,x,-1.00,DOLLARS\n");
    expect(badCur.diagnostics.errors[0]).toMatchObject({ code: "invalid_currency" });
  });

  it("zero-amount lines move no cash and are reported, not imported", async () => {
    const r = await csv("Date,Description,Amount\n2026-10-01,Fee waiver,0.00\n2026-10-02,Rent,-10.00\n");
    expect(r.events).toHaveLength(1);
    expect(r.diagnostics.warnings.join(" ")).toMatch(/1 zero-amount line skipped/);
  });

  it("reads an XLSX statement: real dates, numeric amounts, cached values", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Statement");
    ws.addRow(["Date", "Description", "Amount", "Balance"]);
    ws.addRow([new Date(Date.UTC(2026, 9, 1)), "RENT", -1000, 9000]);
    ws.addRow([new Date(Date.UTC(2026, 9, 2)), "CUSTOMER", 250.5, 9250.5]);
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
    const r = await importBankStatement({ fileName: "s.xlsx", bytes, receivedAt: AT }, opts);
    expect(r.evidence.format).toBe("xlsx");
    expect(r.events.map((e) => [e.date, e.direction, e.amount])).toEqual([["2026-10-01", "out", 100000], ["2026-10-02", "in", 25050]]);
    expect(r.balances[0]).toMatchObject({ amount: 925050, asOf: "2026-10-03" });
  });

  it("explains an unsupported or damaged file in plain words, without throwing", async () => {
    const pdf = await importBankStatement({ fileName: "s.pdf", bytes: new Uint8Array([1, 2]), receivedAt: AT }, opts);
    expect(pdf.readable).toBe(false);
    expect(pdf.evidence.extraction).toBe("unsupported");
    expect(pdf.diagnostics.errors[0]!.nextStep).toMatch(/CSV or Excel/);
    const broken = await importBankStatement({ fileName: "s.xlsx", bytes: new Uint8Array([1, 2, 3]), receivedAt: AT }, opts);
    expect(broken.readable).toBe(false);
    expect(broken.evidence.extraction).toBe("unreadable");
    expect(broken.diagnostics.errors[0]!.message).toMatch(/could not be opened/);
  });
});

describe("bank statement: balance safety", () => {
  const head = "Date,Description,Amount,Balance\n";

  it("takes no balance when an unreadable row has no date, or is as new as the balance, and says what to do", async () => {
    const noDate = await csv(head + "2026-10-20,SHOP,-10.00,990.00\n13/45/2026,CORRUPT,-5.00,985.00\n2026-10-22,SHOP,-10.00,980.00\n");
    expect(noDate.balances).toEqual([]);
    expect(noDate.diagnostics.warnings.join(" ")).toMatch(/did not set your current cash.*could not be read.*enter your current bank balance/);
    const newestBad = await csv(head + "2026-10-20,SHOP,-10.00,990.00\n2026-10-23,SHOP,abc,980.00\n");
    expect(newestBad.balances).toEqual([]);
  });

  it("an older unreadable row does not stop the balance: a running balance already includes it", async () => {
    const r = await csv(head + "2026-10-10,SHOP,abc,1000.00\n2026-10-20,SHOP,-10.00,990.00\n2026-10-22,SHOP,-10.00,980.00\n");
    expect(r.balances).toEqual([expect.objectContaining({ amount: 98000, asOf: "2026-10-23" })]);
    expect(r.diagnostics.errors.map((e) => e.code)).toEqual(["invalid_amount"]);
  });

  it("a balance written with DR or OD is negative, CR is positive", async () => {
    const dr = await csv(head + "2026-10-22,SHOP,-10.00,1200.00 DR\n");
    expect(dr.balances[0]!.amount).toBe(-120000);
    const od = await csv(head + "2026-10-22,SHOP,-10.00,50.00 OD\n");
    expect(od.balances[0]!.amount).toBe(-5000);
    const cr = await csv(head + "2026-10-22,SHOP,10.00,300.00 CR\n");
    expect(cr.balances[0]!.amount).toBe(30000);
  });

  it("says when amounts were read as the default currency, and warns that paid invoices must be marked paid", async () => {
    const r = await csv(head + "2026-10-22,SHOP,-10.00,980.00\n");
    const w = r.diagnostics.warnings.join(" ");
    expect(w).toMatch(/no currency column, so amounts were read as USD/);
    expect(w).toMatch(/mark it paid in your books or it is forecast again/);
  });

  it("tags every event with its file so a corrected re-import can replace that file's events", async () => {
    const r = await csv(head + "2026-10-22,SHOP,-10.00,980.00\n");
    expect(r.events[0]!.sourceRef.record).toMatch(/^[0-9a-f]{12}:[0-9a-f]{16}$/);
  });
});
