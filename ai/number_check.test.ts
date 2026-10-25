import { describe, expect, it } from "vitest";
import type { Answer } from "../schema/forecast";
import {
  allowedFromToolResults, checkAnswer, checkText, extractFigures, guardAnswer,
} from "./number_check";

const opts = { currency: "USD", asOf: "2026-10-25" };
const allowed = { amounts: [2_800_000, -600_000, 620_000], dates: ["2026-12-21", "2026-12-24"] };
const ans = (text: string, extra: Partial<Answer> = {}): Answer => ({ text, citations: ["inv-1"], ...extra });
const amounts = (t: string) => extractFigures(t, opts).amounts;
const dates = (t: string) => extractFigures(t, opts).dates.map((d) => d.date);

describe("extractFigures: amounts", () => {
  it("parses the supported formats to minor units", () => {
    const cases: [string, number, boolean][] = [
      ["$28,000", 2_800_000, false],
      ["$28K", 2_800_000, true],
      ["28k", 2_800_000, true],
      ["$1.2M", 120_000_000, true],
      ["USD 6,200.00", 620_000, false],
      ["-$5,000", -500_000, false],
      ["−$5,000", -500_000, false],
      ["($5,000)", -500_000, false],
      ["28,000 dollars", 2_800_000, false],
      ["about $28,000", 2_800_000, true],
      ["$0.10", 10, false],
      ["$1.005", 101, false],
    ];
    for (const [text, minor, approx] of cases) {
      const a = amounts(`Total ${text} due.`);
      expect(a, text).toHaveLength(1);
      expect(a[0]!.minor, text).toBe(minor);
      expect(a[0]!.approx, text).toBe(approx);
    }
  });

  it("reports spans that slice back to the raw text", () => {
    const text = "Owe ($5,000) and -$6K, plus 28,000 dollars.";
    const a = amounts(text);
    expect(a.map((x) => x.raw)).toEqual(["($5,000)", "-$6K", "28,000 dollars"]);
    for (const x of a) expect(text.slice(x.start, x.end)).toBe(x.raw);
  });

  it("uses integer math (no float drift) and the currency's minor digits", () => {
    expect(amounts("$0.07")[0]!.minor).toBe(7);
    expect(amounts("$19.99")[0]!.minor).toBe(1999);
    expect(amounts("$1,234,567.89")[0]!.minor).toBe(123_456_789);
    expect(extractFigures("¥5,000", { currency: "JPY", asOf: "2026-10-25" }).amounts[0]!.minor).toBe(5000);
  });

  it("ignores counts, days, weeks, and years", () => {
    expect(amounts("3 things to do. Customer A pays 22 days late in week 7 of 2026.")).toEqual([]);
    expect(amounts("Invoice 1187 for 5 kg, 12 km, 30 min, 5m away")).toEqual([]);
  });

  it("splits ranges and does not read the dash as a minus", () => {
    const a = amounts("$28K-$30K or $28,000-$30,000");
    expect(a.map((x) => x.minor)).toEqual([2_800_000, 3_000_000, 2_800_000, 3_000_000]);
  });
});

describe("extractFigures: dates", () => {
  it("parses ISO and month-name forms, inferring the year from asOf", () => {
    expect(dates("on 2026-12-24")).toEqual(["2026-12-24"]);
    expect(dates("December 24, 2026")).toEqual(["2026-12-24"]);
    expect(dates("Dec 24")).toEqual(["2026-12-24"]);
    expect(dates("24 December")).toEqual(["2026-12-24"]);
    expect(dates("the 24th of December")).toEqual(["2026-12-24"]);
    expect(dates("the week of Dec 21")).toEqual(["2026-12-21"]);
    expect(dates("12/24/2026")).toEqual(["2026-12-24"]);
  });

  it("picks the nearest occurrence within six months of asOf", () => {
    expect(dates("Jan 5")).toEqual(["2027-01-05"]);
    expect(dates("Aug 1")).toEqual(["2026-08-01"]);
    expect(extractFigures("Dec 28", { currency: "USD", asOf: "2027-01-02" }).dates[0]!.date).toBe("2026-12-28");
  });

  it("ignores impossible dates and the verb 'may'", () => {
    expect(dates("Feb 30 and 2026-13-45")).toEqual([]);
    expect(dates("you may 5 times")).toEqual([]);
    expect(dates("May 5")).toEqual(["2026-05-05"]);
  });

  it("does not read dates as amounts", () => {
    expect(amounts("Dec 24, 2026 and 24 December")).toEqual([]);
  });
});

describe("checkAnswer", () => {
  it("fails an invented figure", () => {
    const r = checkAnswer(ans("You will have $31,500 left."), allowed, opts);
    expect(r.ok).toBe(false);
    expect(r.unmatched).toEqual([{ kind: "amount", raw: "$31,500" }]);
  });

  it("matches rounded $28K against 2,800,000 and within-rounding values, not 2,950,000", () => {
    expect(checkAnswer(ans("About $28K is due."), allowed, opts).ok).toBe(true);
    expect(checkAnswer(ans("$28K"), { amounts: [2_849_900], dates: [] }, opts).ok).toBe(true);
    expect(checkAnswer(ans("$28K"), { amounts: [2_950_000], dates: [] }, opts).ok).toBe(false);
  });

  it("applies 5% only to approximate figures", () => {
    expect(checkAnswer(ans("about $29,000"), allowed, opts).ok).toBe(true);
    expect(checkAnswer(ans("$29,000"), allowed, opts).ok).toBe(false);
  });

  it("passes a negative low point stated with a minus sign and a week-of date", () => {
    const r = checkAnswer(ans("−$6K low point in the week of Dec 21"), allowed, opts);
    expect(r).toEqual({ ok: true, unmatched: [], problems: [] });
  });

  it("matches deltas stated positive", () => {
    expect(checkAnswer(ans("You are $6,000 short."), allowed, opts).ok).toBe(true);
  });

  it("fails a wrong date", () => {
    const r = checkAnswer(ans("Cash dips the week of Dec 28", { citations: ["x"] }), allowed, opts);
    expect(r.ok).toBe(false);
    expect(r.unmatched).toEqual([{ kind: "date", raw: "Dec 28" }]);
  });

  it("fails amounts without citations", () => {
    const r = checkAnswer(ans("$28K is due.", { citations: [] }), allowed, opts);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain("amounts without citations");
  });

  it("allows dates without citations and the run date", () => {
    expect(checkAnswer(ans("As of Oct 25 nothing is due Dec 24.", { citations: [] }), allowed, opts).ok).toBe(true);
  });

  it("does not treat counts, days, or years as amounts", () => {
    const r = checkAnswer(ans("3 things: Customer A is 22 days late; see week 7 of 2026.", { citations: [] }), allowed, opts);
    expect(r.ok).toBe(true);
  });

  it("passes a missingData answer with no figures", () => {
    const r = checkAnswer(
      { text: "I don't have that data.", citations: [], missingData: "No tax bill in the books yet." },
      allowed, opts,
    );
    expect(r.ok).toBe(true);
  });

  it("checks figures inside missingData too", () => {
    const r = checkAnswer({ text: "I don't know.", citations: [], missingData: "Expected $99,000" }, allowed, opts);
    expect(r.ok).toBe(false);
  });
});

describe("guardAnswer", () => {
  const fallback = (): Answer => ({ text: "Fallback: $28,000 due.", citations: ["fb"] });

  it("returns the first answer when it passes", async () => {
    const r = await guardAnswer(async () => ans("$28,000 due"), allowed, fallback, opts);
    expect(r.attempts).toBe(1);
    expect(r.usedFallback).toBe(false);
  });

  it("retries once with feedback listing the unmatched figures, then accepts", async () => {
    const calls: [number, string | undefined][] = [];
    const r = await guardAnswer(async (n, fb) => {
      calls.push([n, fb]);
      return n === 1 ? ans("You have $77,777") : ans("$28,000 due");
    }, allowed, fallback, opts);
    expect(r).toMatchObject({ attempts: 2, usedFallback: false });
    expect(r.answer.text).toBe("$28,000 due");
    expect(calls[0]).toEqual([1, undefined]);
    expect(calls[1]![1]).toContain("$77,777");
  });

  it("uses the fallback when both attempts fail, and never returns the failed answers", async () => {
    let n = 0;
    const r = await guardAnswer(async () => ans(`Invented $${++n}00,000`), allowed, fallback, opts);
    expect(n).toBe(2);
    expect(r).toMatchObject({ attempts: 2, usedFallback: true });
    expect(r.answer).toEqual(fallback());
  });

  it("treats a throwing generator as a failed attempt", async () => {
    const r = await guardAnswer(async () => { throw new Error("timeout"); }, allowed, fallback, opts);
    expect(r.usedFallback).toBe(true);
  });

  it("accepts a missingData answer", async () => {
    const r = await guardAnswer(
      async () => ({ text: "I don't have that data.", citations: [], missingData: "tax schedule" }),
      allowed, fallback, opts,
    );
    expect(r.usedFallback).toBe(false);
  });
});

describe("allowedFromToolResults", () => {
  it("collects money integers under money-like keys and ISO dates", () => {
    const a = allowedFromToolResults([
      {
        lowPoint: { week: "2026-12-21", date: "2026-12-21", amount: -600_000 },
        weeks: [{ closing: 1_000_000, inflow: 50_000, outflow: 70_000, eventIds: ["evt-inv-2026-12-24-0"] }],
        freeCash: [{ amount: 300_000, weeksFree: 3 }],
        warnings: ["Bank feed stale since 2026-10-20T08:00:00Z"],
        probability: 70,
      },
      JSON.stringify({ outstanding: 123_456, count: 4, balance: 0.5 }),
    ]);
    expect(a.amounts).toEqual([-600_000, 50_000, 70_000, 123_456, 300_000, 1_000_000]);
    expect(a.dates).toEqual(["2026-10-20", "2026-12-21"]);
  });

  it("handles cycles and primitives", () => {
    const o: Record<string, unknown> = { amount: 5 };
    o.self = o;
    expect(allowedFromToolResults([o, null, 3, "x"]).amounts).toEqual([5]);
  });
});

describe("review hardening", () => {
  it("extracts codes, glued codes, grouped bare numbers, and European formats", () => {
    const m = (t: string) => amounts(t).map((a) => a.minor);
    expect(m("owes 48,000 CAD")).toEqual([4_800_000]);
    expect(m("USD5,000 and CHF500 and usd500")).toEqual([500_000, 50_000, 50_000]);
    expect(m("balance of 5,000")).toEqual([500_000]);
    expect(m("500 US dollars")).toEqual([50_000]);
    expect(m("1.234,56 EUR")).toEqual([123_456]);
    expect(m("12,34,567 INR")).toEqual([123_456_700]);
    expect(extractFigures("5,000 yen", opts).amounts[0]!.minor).toBe(5000);
  });

  it("never lets an unparseable marked figure pass", () => {
    const a = amounts("it cost $1.5.3");
    expect(a).toHaveLength(1);
    expect(Number.isNaN(a[0]!.minor)).toBe(true);
    expect(checkAnswer(ans("it cost $1.5.3"), { amounts: [123, 12_300], dates: [] }, opts).ok).toBe(false);
  });

  it("does not read identifiers or the word 'try' as money", () => {
    expect(amounts("INV28K and A1187 and try 5 times")).toEqual([]);
  });

  it("K/M figures use rounding only; the 5% band is for hedged figures", () => {
    expect(checkAnswer(ans("$28K"), { amounts: [2_900_000], dates: [] }, opts).ok).toBe(false);
    expect(checkAnswer(ans("about $28K"), { amounts: [2_900_000], dates: [] }, opts).ok).toBe(true);
  });

  it("rejects a positive statement of a negative balance but allows shortfall framing", () => {
    const neg = { amounts: [-1_234_500], dates: [] };
    expect(checkAnswer(ans("You will have $12,345 left."), neg, opts).ok).toBe(false);
    expect(checkAnswer(ans("You will be $12,345 short."), neg, opts).ok).toBe(true);
    expect(checkAnswer(ans("Closing balance is -$12,345."), neg, opts).ok).toBe(true);
  });

  it("matches a past date without a year against any nearby year", () => {
    const r = checkAnswer(ans("Invoice was due Jan 15", { citations: [] }), { amounts: [], dates: ["2026-01-15"] }, opts);
    expect(r.ok).toBe(true);
  });

  it("extracts both ends of a date range and more numeric formats", () => {
    expect(dates("Nov 3-5")).toEqual(["2026-11-03", "2026-11-05"]);
    expect(dates("2026/11/03 and 03.11.2026")).toEqual(["2026-11-03", "2026-11-03"]);
    expect(dates("Nov 3-5, 2026")).toEqual(["2026-11-03", "2026-11-05"]);
    const r = checkAnswer(ans("due Nov 5-6", { citations: [] }), { amounts: [], dates: ["2026-11-09"] }, opts);
    expect(r.unmatched).toHaveLength(2);
  });

  it("checkText applies the same rules to non-Answer text", () => {
    expect(checkText("Collect $28,000 by Dec 24", ["inv-1"], allowed, opts).ok).toBe(true);
    expect(checkText("Collect $28,000", [], allowed, opts).problems).toContain("amounts without citations");
  });

  it("matches whole key words and ignores message text fields", () => {
    const a = allowedFromToolResults([{
      accountBalance: 700_000, discountAmount: 5_000, weeksFree: 3,
      signal: { excerpt: "pay on 2026-11-30, $9,999", amount: 12_000 },
    }]);
    expect(a.amounts).toEqual([5_000, 12_000, 700_000]);
    expect(a.dates).toEqual([]);
  });
});
