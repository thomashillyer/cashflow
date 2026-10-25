import { describe, expect, it } from "vitest";
import { payeeKey, proposeRecurring, type BankLine } from "./recurring";

let n = 0;
const lines = (description: string, dates: string[], amounts: number | number[], over: Partial<BankLine> = {}): BankLine[] =>
  dates.map((date, i) => ({
    eventId: `e${++n}`, row: i + 2, date, direction: "out", currency: "USD", description,
    amount: Array.isArray(amounts) ? amounts[i]! : amounts, ...over,
  }));

describe("payeeKey", () => {
  it("drops bank wording, reference numbers and dates, keeping who was paid", () => {
    expect(payeeKey("ACH DEBIT NORTHWIND PAYROLL #1043 10/16")).toBe("northwind payroll");
    expect(payeeKey("POS PURCHASE 4411 Corner Cafe")).toBe("corner cafe");
    expect(payeeKey("12345 / 2026-10-01")).toBe("");
  });
});

describe("proposeRecurring", () => {
  it("proposes each design cadence with its nominal next date", () => {
    const cases: [string, string[], string, number, string][] = [
      ["WEEKLY CO", ["2026-09-01", "2026-09-08", "2026-09-16", "2026-09-22"], "weekly", 7, "2026-09-29"],
      ["TWICE MONTHLY LLC", ["2026-08-14", "2026-08-28", "2026-09-11"], "biweekly", 14, "2026-09-25"],
      ["MIDMONTH INC", ["2026-08-01", "2026-08-16", "2026-08-31", "2026-09-15"], "semimonthly", 15, "2026-09-30"],
      ["LANDLORD", ["2026-07-31", "2026-08-31", "2026-09-30"], "monthly", 30, "2026-10-30"],
      ["TAX AUTHORITY", ["2026-01-15", "2026-04-16", "2026-07-16"], "quarterly", 91, "2026-10-15"],
    ];
    for (const [payee, dates, cadence, days, next] of cases) {
      const [p] = proposeRecurring(lines(payee, dates, 50000));
      expect(p, payee).toMatchObject({ cadence, nextExpected: next, occurrences: dates.length, typicalAmount: 50000, direction: "out" });
      expect(p!.basis).toContain(`${days} days apart`);
      expect(p!.evidence).toHaveLength(dates.length);
    }
  });

  it("never proposes near-misses", () => {
    const none: BankLine[][] = [
      lines("TWO ONLY", ["2026-08-01", "2026-09-01"], 1000),                                              // fewer than 3
      lines("DRIFTING", ["2026-08-01", "2026-08-21", "2026-09-10"], 1000),                                // 20 days is no cadence
      lines("ONE LATE", ["2026-08-01", "2026-09-01", "2026-10-15"], 1000),                                // a gap far outside +/-2
      lines("AMOUNT SWINGS", ["2026-08-01", "2026-09-01", "2026-10-01"], [1000, 1000, 1112]),            // more than 10% off the typical
      lines("SAME DAY", ["2026-08-01", "2026-08-01", "2026-08-01"], 1000),                                // gap 0
      lines("12345", ["2026-08-01", "2026-09-01", "2026-10-01"], 1000),                                   // no payee to group on
    ];
    for (const set of none) expect(proposeRecurring(set), set[0]!.description).toEqual([]);
  });

  it("accepts amounts exactly 10% off the typical amount, and no more", () => {
    expect(proposeRecurring(lines("EDGE", ["2026-08-01", "2026-09-01", "2026-10-01"], [900, 1000, 1100]))).toHaveLength(1);
    expect(proposeRecurring(lines("OVER", ["2026-08-01", "2026-09-01", "2026-10-01"], [900, 1000, 1101]))).toHaveLength(0);
  });

  it("keeps inflows and outflows, and currencies, in separate groups", () => {
    const dates = ["2026-08-01", "2026-09-01", "2026-10-01"];
    const mixed = [
      ...lines("ACME", dates, 1000), ...lines("ACME", dates, 1000, { direction: "in" }), ...lines("ACME", dates, 1000, { currency: "EUR" }),
    ];
    expect(proposeRecurring(mixed).map((p) => [p.direction, p.currency])).toEqual([["in", "USD"], ["out", "EUR"], ["out", "USD"]].sort());
    expect(proposeRecurring([...lines("ACME", dates.slice(0, 2), 1000), ...lines("ACME", dates.slice(2), 1000, { direction: "in" })])).toEqual([]);
  });

  it("is deterministic: the same lines in any order give the same proposals", () => {
    const set = [...lines("A CO", ["2026-08-01", "2026-09-01", "2026-10-01"], 100), ...lines("B CO", ["2026-08-14", "2026-08-28", "2026-09-11"], 200)];
    expect(proposeRecurring([...set].reverse())).toEqual(proposeRecurring(set));
  });
});
