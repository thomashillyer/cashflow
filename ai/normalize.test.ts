import { describe, expect, it } from "vitest";
import type { IntakeCandidate } from "../schema/intake";
import { fieldFrom, locateQuote, parseAmount, parseDate, validateCandidate, type SourceSegment } from "./normalize";

describe("parseAmount", () => {
  it("reads common formats into minor units", () => {
    expect(parseAmount("28,000.00", "USD")).toBe(2800000);
    expect(parseAmount("USD 6,200.00", "USD")).toBe(620000);
    expect(parseAmount("$4,000", "USD")).toBe(400000);
    expect(parseAmount("1.234,56", "EUR")).toBe(123456);
    expect(parseAmount("¥5,000", "JPY")).toBe(5000);
    expect(parseAmount("TOTAL 12.5", "USD")).toBeUndefined(); // stray words are not a number
    expect(parseAmount("12.5", "USD")).toBe(1250);
    expect(parseAmount("12,5", "EUR")).toBe(1250);
    expect(parseAmount("4000", "USD")).toBe(400000);
  });

  it("tells thousands from decimals", () => {
    expect(parseAmount("1,234", "USD")).toBe(123400);
    expect(parseAmount("1,234.56", "USD")).toBe(123456);
    expect(parseAmount("1,234,567", "USD")).toBe(123456700);
    expect(parseAmount("1.234.567,89", "EUR")).toBe(123456789);
    expect(parseAmount("1.234", "EUR")).toBe(123400);
    expect(parseAmount("28 000,00", "EUR")).toBe(2800000);
    expect(parseAmount("0.50", "USD")).toBe(50);
    expect(parseAmount("0,5", "EUR")).toBe(50);
    expect(parseAmount("28,000.00.", "USD")).toBe(2800000); // sentence punctuation
  });

  it("honours the currency's minor unit", () => {
    expect(parseAmount("5,000", "JPY")).toBe(5000);
    expect(parseAmount("5.5", "JPY")).toBeUndefined(); // yen has no decimals
    expect(parseAmount("1.234", "KWD")).toBe(1234); // 3 decimals: "." is the decimal mark
    expect(parseAmount("10.0051", "USD")).toBeUndefined(); // sub-cent precision is not silently rounded
    expect(parseAmount("10.5000", "USD")).toBe(1050); // extra zeros are harmless
  });

  it("handles negatives", () => {
    expect(parseAmount("-1,200.00", "USD")).toBe(-120000);
    expect(parseAmount("(1,200.00)", "USD")).toBe(-120000);
  });

  it("returns undefined for garbage and never 0 for empty input", () => {
    for (const bad of ["", "   ", "abc", "USD", "$", "N/A", "1,2345,6", "12,34,567", "1,234.56,7", "28,000.00 (net 30)", "1.2.3"]) {
      expect(parseAmount(bad, "USD"), JSON.stringify(bad)).toBeUndefined();
    }
    expect(parseAmount("0.00", "USD")).toBe(0); // an explicit zero is still zero
  });

  it("rejects amounts beyond the safe integer range", () => {
    expect(parseAmount("999,999,999,999,999,999", "USD")).toBeUndefined();
  });
});

describe("parseDate", () => {
  it("reads unambiguous absolute dates", () => {
    expect(parseDate("December 10, 2026")).toEqual({ date: "2026-12-10", ambiguous: false });
    expect(parseDate("Dec. 10th, 2026")).toEqual({ date: "2026-12-10", ambiguous: false });
    expect(parseDate("10 December 2026")).toEqual({ date: "2026-12-10", ambiguous: false });
    expect(parseDate("10 Sept 2026")).toEqual({ date: "2026-09-10", ambiguous: false });
    expect(parseDate("2026-12-10")).toEqual({ date: "2026-12-10", ambiguous: false });
    expect(parseDate("2026-12-10T09:30:00Z")).toEqual({ date: "2026-12-10", ambiguous: false });
  });

  it("resolves numeric dates and flags the ambiguous ones", () => {
    expect(parseDate("11/28/26")).toEqual({ date: "2026-11-28", ambiguous: false }); // 28 can't be a month
    expect(parseDate("28/11/2026")).toEqual({ date: "2026-11-28", ambiguous: false });
    expect(parseDate("03/04/2026")).toEqual({ date: "2026-03-04", ambiguous: true });
    expect(parseDate("03/04/2026", { dayFirst: true })).toEqual({ date: "2026-04-03", ambiguous: true });
    expect(parseDate("05/05/2026")).toEqual({ date: "2026-05-05", ambiguous: false });
  });

  it("returns undefined for relative, impossible, or malformed dates", () => {
    for (const bad of ["next Friday", "early January", "", "tomorrow", "2026-02-30", "February 30, 2026", "13/13/2026", "Mayday 10, 2026", "10 Foo 2026"]) {
      expect(parseDate(bad), bad).toBeUndefined();
    }
  });
});

describe("locateQuote", () => {
  const segments: SourceSegment[] = [
    { evidenceId: "ev-a", page: 1, text: "CASCADE TRADE CO.\nINVOICE INV-1187\nDue date: December 10, 2026" },
    { evidenceId: "ev-b", page: 2, text: "Terms:   Net\n 30 days" },
  ];

  it("finds an exact quote with offsets that slice back to the source", () => {
    const e = locateQuote(segments, "Due date: December 10, 2026")!;
    expect(e).toMatchObject({ evidenceId: "ev-a", page: 1, text: "Due date: December 10, 2026" });
    expect(segments[0]!.text.slice(e.excerpt!.start, e.excerpt!.end)).toBe(e.text);
  });

  it("matches ignoring case and whitespace, reporting the original span", () => {
    const e = locateQuote(segments, "invoice  inv-1187")!;
    expect(e.text).toBe("INVOICE INV-1187");
    expect(segments[0]!.text.slice(e.excerpt!.start, e.excerpt!.end)).toBe("INVOICE INV-1187");

    const e2 = locateQuote(segments, "terms: net 30")!;
    expect(e2.evidenceId).toBe("ev-b");
    expect(e2.page).toBe(2);
    expect(e2.text).toBe("Terms:   Net\n 30");
    expect(segments[1]!.text.slice(e2.excerpt!.start, e2.excerpt!.end)).toBe(e2.text);
  });

  it("keeps offsets aligned past characters whose lowercase is longer", () => {
    const seg: SourceSegment[] = [{ evidenceId: "ev", text: "İstanbul Ltd owes INV-7" }];
    const e = locateQuote(seg, "inv-7")!;
    expect(e.text).toBe("INV-7");
    expect(seg[0]!.text.slice(e.excerpt!.start, e.excerpt!.end)).toBe("INV-7");
  });

  it("returns undefined for absent or empty quotes", () => {
    expect(locateQuote(segments, "INV-9999")).toBeUndefined();
    expect(locateQuote(segments, "")).toBeUndefined();
    expect(locateQuote(segments, "   ")).toBeUndefined();
    expect(locateQuote(segments, null)).toBeUndefined();
  });
});

describe("fieldFrom", () => {
  const segments: SourceSegment[] = [{ evidenceId: "ev", page: 1, text: "TOTAL DUE (USD) 28,000.00\nDue date: December 10, 2026" }];
  const amount = (v: string) => parseAmount(v, "USD");

  it("found, with evidence, when the value is quoted and parses", () => {
    const f = fieldFrom({ value: "28,000.00", quote: "TOTAL DUE (USD) 28,000.00" }, segments, amount, "amount");
    expect(f).toMatchObject({ state: "found", value: 2800000 });
    expect(f.state === "found" && f.evidence[0]).toMatchObject({ evidenceId: "ev", page: 1 });
  });

  it("falls back to the value as the quote when no quote is given", () => {
    expect(fieldFrom({ value: "December 10, 2026", quote: null }, segments, (v) => parseDate(v)?.date, "due date"))
      .toMatchObject({ state: "found", value: "2026-12-10" });
  });

  it("is missing, with a reason, when the value is null or blank", () => {
    expect(fieldFrom({ value: null, quote: null }, segments, amount, "amount")).toEqual({ state: "missing", reason: "amount not stated" });
    expect(fieldFrom({ value: "  ", quote: null }, segments, amount, "amount")).toMatchObject({ state: "missing" });
    expect(fieldFrom(undefined, segments, amount, "amount")).toMatchObject({ state: "missing" });
  });

  it("is missing when the quote is not in the source", () => {
    const f = fieldFrom({ value: "99,000.00", quote: "TOTAL DUE 99,000.00" }, segments, amount, "amount");
    expect(f).toMatchObject({ state: "missing" });
    expect(f.state === "missing" && f.reason).toMatch(/not found in the source/);
  });

  it("is missing when a real quote does not contain the claimed value", () => {
    const f = fieldFrom({ value: "99,000.00", quote: "TOTAL DUE (USD) 28,000.00" }, segments, amount, "amount");
    expect(f).toMatchObject({ state: "missing" });
    expect(f.state === "missing" && f.reason).toMatch(/not in its quote/);
  });

  it("is missing when the parser rejects the value", () => {
    const f = fieldFrom({ value: "Due date", quote: "Due date" }, segments, amount, "amount");
    expect(f).toMatchObject({ state: "missing" });
    expect(f.state === "missing" && f.reason).toMatch(/could not be read/);
  });
});

describe("validateCandidate", () => {
  const miss = { state: "missing" as const };
  const base = (): IntakeCandidate => ({
    id: "c1", revision: 1, extractionVersion: "t", evidenceIds: ["ev"], kind: "invoice", direction: "in",
    fields: { sellerName: miss, buyerName: miss, reference: miss, amount: miss, currency: miss, issueDate: miss, dueDate: miss },
    confidence: 0.8, extraction: "partial", notes: [],
  });
  const ev = { evidenceId: "ev", text: "x" };

  it("accepts a coherent candidate", () => {
    const c = base();
    c.fields.amount = { state: "found", value: 100, evidence: [ev] };
    c.fields.currency = { state: "found", value: "USD", evidence: [ev] };
    c.extraction = "ok";
    expect(validateCandidate(c)).toEqual([]);
  });

  it("flags found without evidence", () => {
    const c = base();
    c.fields.reference = { state: "found", value: "INV-1", evidence: [] };
    expect(validateCandidate(c)).toContainEqual({ field: "reference", problem: "found without evidence" });
  });

  it("flags a conflict with fewer than two values", () => {
    const c = base();
    c.fields.currency = { state: "conflict", values: [{ value: "USD", evidence: [ev] }] };
    expect(validateCandidate(c).map((i) => i.field)).toContain("currency");
  });

  it("flags an ok invoice or bill without an amount", () => {
    for (const kind of ["invoice", "bill"] as const) {
      const c = base();
      c.kind = kind;
      c.extraction = "ok";
      expect(validateCandidate(c)).toContainEqual({ field: "amount", problem: "an invoice or bill without an amount can't be extraction ok" });
    }
    const c = base();
    c.extraction = "partial";
    expect(validateCandidate(c)).toEqual([]);
  });

  it("flags bad amounts, currencies, dates, and confidence", () => {
    const c = base();
    c.fields.amount = { state: "found", value: -5, evidence: [ev] };
    c.fields.currency = { state: "found", value: "usd", evidence: [ev] };
    c.fields.dueDate = { state: "found", value: "12/10/2026", evidence: [ev] };
    c.confidence = 1.5;
    expect(validateCandidate(c).map((i) => i.field).sort()).toEqual(["amount", "confidence", "currency", "dueDate"]);
    const frac = base();
    frac.fields.amount = { state: "found", value: 10.5, evidence: [ev] };
    expect(validateCandidate(frac).map((i) => i.field)).toContain("amount");
  });
});
