// Number check (P4.14): deterministic guard for every user-facing Claude answer.
// Pure: no network, no LLM, no clock (pass `asOf`). Design: docs/design/08-claude-layer.md
// (Guardrails) and docs/TECHNICAL_PLAN.md section 7.
//
// Every amount and date in an answer must match a value present in that turn's tool results.
// An answer with amounts must carry citations. On failure: one regeneration with feedback,
// then a deterministic code-built fallback.
//
// Money is integer minor units throughout; amount text is parsed with BigInt digit math, never
// through float arithmetic.

import type { NumberFact } from "../schema/ask";
import type { Answer } from "../schema/forecast";
import { minorUnitDigits } from "./normalize";

export type CheckOpts = { currency: string; asOf: string };

export type ExtractedAmount = {
  raw: string;
  minor: number;      // signed, integer minor units of the stated currency
  start: number;
  end: number;
  approx: boolean;    // K/M suffix or "about/around/roughly/..."
  hedged: boolean;    // preceded by "about/around/roughly/..." (the only case that gets the 5% band)
  precision: number;  // size of the last stated digit in minor units (>= 1); the rounding rule
};
// `alts`: when the year was inferred, every candidate year's date (asOf year +-1), including `date`.
export type ExtractedDate = { raw: string; date: string; start: number; end: number; alts?: string[] };
export type Figures = { amounts: ExtractedAmount[]; dates: ExtractedDate[] };

// `numbers` (Ask Neri, Decision.allowed.numbers): when present, "N%", "N days" / "N more days", and
// "N payments|samples|invoices" are checked against it. When absent, those stay unchecked.
export type Allowed = { amounts: number[]; dates: string[]; numbers?: NumberFact[] };
export type Unmatched = { kind: "amount" | "date" | "number"; raw: string };
export type CheckResult = { ok: boolean; unmatched: Unmatched[]; problems: string[] };
export type GuardResult = { answer: Answer; attempts: number; usedFallback: boolean };

// ---------------------------------------------------------------- minor units

// minorUnitDigits comes from ai/normalize.ts. parseAmount is not reused: it has no K/M scaling and
// does not report the stated precision the rounding rule needs.

// Decimal string ("6,200.50", "1.2") times 10^exp, in minor units, by integer math. Rounds half up.
// `precision` is the size of the last stated digit in minor units.
const toMinor = (numText: string, exp: number, digits: number): { minor: number; precision: number } => {
  const [intPart = "0", frac = ""] = numText.replace(/,/g, "").split(".");
  const n = BigInt(intPart + frac);
  const k = digits + exp - frac.length; // minor = n * 10^k
  let minor: bigint;
  if (k >= 0) minor = n * 10n ** BigInt(k);
  else {
    const d = 10n ** BigInt(-k);
    minor = n / d + ((n % d) * 2n >= d ? 1n : 0n);
  }
  return { minor: Number(minor), precision: k > 0 ? Number(10n ** BigInt(k)) : 1 };
};

// ---------------------------------------------------------------- amounts

const SYMBOL = "[A-Z]{1,2}\\$|\\$|€|£|¥|₹";
const ISO_CODE = "USD|EUR|GBP|CAD|AUD|NZD|JPY|CHF|CNY|INR|MXN|BRL|SEK|NOK|DKK|SGD|HKD|AED|ZAR|KRW|PLN|THB|IDR|VND|TRY";
const SYMBOL_CODE: Record<string, string> = { "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR" };

// Maximal numeric token; its format (US, European, Indian grouping) is decided in parseNumber.
const numRe = /(?<![\d.,])\d(?:[\d.,]*\d)?/g;
// Codes are case-sensitive (a lowercase "try" is a verb); usd/eur/gbp are also accepted lowercase.
const curRe = new RegExp(
  `(${SYMBOL}|(?<![A-Za-z])(?:${ISO_CODE}|usd|eur|gbp)(?![a-z]))\\s?$`);
const suffixRe = /^(?:([kK])(?![A-Za-z])|(M)(?![A-Za-z])|(m)(?![A-Za-z])|\s?([Tt]housand)\b|\s?([Mm]illion)\b)/;
const tailRe = new RegExp(
  `^\\s?(?:(?:[Uu]\\.?[Ss]\\.? )?[Dd]ollars?|bucks|[Ee]uros?|yen|[Pp]esos?|[Rr]upees?|francs?|${ISO_CODE}|usd|eur|gbp)(?![A-Za-z])`);
const approxRe = /(?:\babout|\baround|\broughly|\bapproximately|\bapprox\.?|\bnearly|\balmost|\bcirca|~)\s*$/i;

const isSign = (c: string | undefined): boolean => c === "-" || c === "−" || c === "–";
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);

// Normalizes a numeric token to "digits[.digits]". `grouped` is true for thousands-grouped numbers
// ("28,000", "1.234,56", "12,34,567"). Returns undefined for anything else ("1.5.3", "$1,23").
const parseNumber = (tok: string): { norm: string; grouped: boolean } | undefined => {
  if (/^\d+(?:\.\d+)?$/.test(tok)) return { norm: tok, grouped: false };
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(tok)) return { norm: tok.replace(/,/g, ""), grouped: true };
  if (/^\d{1,2}(?:,\d{2})+,\d{3}(?:\.\d+)?$/.test(tok)) return { norm: tok.replace(/,/g, ""), grouped: true };
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(tok)) return { norm: tok.replace(/\./g, "").replace(",", "."), grouped: true };
  if (/^\d+,\d{1,2}$/.test(tok)) return { norm: tok.replace(",", "."), grouped: false };
  return undefined;
};

// Money is: currency-marked ($, USD, "dollars", "5,000 CAD"), K/M-suffixed, or a thousands-grouped
// number ("48,000"). Other bare numbers are counts, days, weeks, or years. A marked figure that
// cannot be parsed is returned with minor NaN so it never matches (fails closed).
export function extractAmounts(text: string, opts: { currency: string }): ExtractedAmount[] {
  const out: ExtractedAmount[] = [];
  const digitsFor = (code: string) => minorUnitDigits(code);
  for (const m of text.matchAll(numRe)) {
    const numStart = m.index!;
    const numEnd = numStart + m[0].length;
    const parsed = parseNumber(m[0]);

    // Left: optional "(", sign, currency marker, sign. Parsed right to left.
    let i = numStart;
    let negative = false;
    if (isSign(text[i - 1])) { negative = true; i -= 1; }
    const cm = curRe.exec(text.slice(Math.max(0, i - 8), i));
    let cur: string | undefined;
    if (cm) { cur = cm[1]; i -= cm[0].length; }
    if (cm && !negative && isSign(text[i - 1])) { negative = true; i -= 1; }
    // A sign glued to a preceding word or number is a range dash ("$28K-$30K"), not a minus.
    if (negative && isWordChar(text[i - 1])) {
      negative = false;
      i = cm ? i + 1 : numStart;
      if (!cm) cur = undefined;
    }
    // Letters or digits glued to the number ("INV28K", "A1187") make it an identifier, not money.
    if (!cur && isWordChar(text[numStart - 1])) continue;
    let open = false;
    if (text[i - 1] === "(") { open = true; i -= 1; }
    let start = i;

    // Right: K / M / thousand / million suffix, then an optional currency word or code.
    const rest = text.slice(numEnd, numEnd + 24);
    const s = suffixRe.exec(rest);
    let exp = 0;
    let suffixLen = 0;
    if (s) {
      const e = s[1] ? 3 : s[2] ? 6 : s[3] ? (cur ? 6 : 0) : s[4] ? 3 : 6; // bare lowercase "m" is not money
      if (e > 0) { exp = e; suffixLen = s[0].length; }
    }
    const t = tailRe.exec(rest.slice(suffixLen));
    const tailLen = t ? t[0].length : 0;
    if (!cur && exp === 0 && !t && !parsed?.grouped) continue;

    let end = numEnd + suffixLen + tailLen;
    if (open) {
      if (text[end] === ")") { end += 1; negative = true; } // accounting negative
      else start += 1;                                      // stray "(" is not part of the figure
    }

    // Currency of the figure decides the minor-unit digits (JPY has none).
    const marker = t?.[0].trim() ?? cur ?? "";
    const code = /yen/i.test(marker) ? "JPY"
      : SYMBOL_CODE[marker] ?? (/^[A-Za-z]{3}$/.test(marker) && marker.toLowerCase() !== "bucks" ? marker.toUpperCase() : opts.currency);
    const hedged = approxRe.test(text.slice(Math.max(0, start - 20), start));
    if (!parsed) {
      out.push({ raw: text.slice(start, end), minor: NaN, start, end, approx: false, hedged: false, precision: 1 });
      continue;
    }
    const { minor, precision } = toMinor(parsed.norm, exp, digitsFor(code));
    out.push({
      raw: text.slice(start, end),
      minor: negative ? -minor : minor,
      start,
      end,
      approx: exp > 0 || hedged,
      hedged,
      precision,
    });
  }
  return out;
}

// ---------------------------------------------------------------- dates

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const YEAR = "(?:19|20)\\d{2}";
const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const isoRe = /(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
const usRe = new RegExp(`(?<![\\d/])(\\d{1,2})/(\\d{1,2})/(${YEAR})(?!\\d)`, "g");
const ymdSlashRe = /(?<![\d/])(\d{4})\/(\d{1,2})\/(\d{1,2})(?!\d)/g;
const dmyDotRe = /(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?![\d.]*\d)/g;
// Group 3 is a range tail ("-5" in "Nov 3-5"), group 4 its end day, group 5 the year.
const monthDayRe = new RegExp(
  `(?<!\\w)(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(\\s?[-–]\\s?(\\d{1,2})(?!\\d))?(?:,?\\s+(${YEAR})(?!\\d))?`, "gi");
const dayMonthRe = new RegExp(
  `(?<![\\w.,$€£-])(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS})(?![A-Za-z])\\.?(?:,?\\s+(${YEAR})(?!\\d))?`, "gi");

const pad = (n: number): string => String(n).padStart(2, "0");
const validYmd = (y: number, m: number, d: number): string | undefined => {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return undefined;
  return `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
};

type Resolved = { date: string; alts?: string[] };

// No year stated: the occurrence of month/day nearest asOf (so within +-6 months); ties go later.
// `alts` lists the candidates for asOf year -1, 0, +1 so a past date ("Jan 15", overdue) can still
// match an allowed date.
const inferYear = (month: number, day: number, asOf: string): Resolved | undefined => {
  const base = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(base)) return undefined;
  const y0 = new Date(base).getUTCFullYear();
  let best: { iso: string; diff: number; ms: number } | undefined;
  for (const y of [y0 - 4, y0 - 1, y0, y0 + 1, y0 + 4]) { // +-4 covers Feb 29
    const iso = validYmd(y, month, day);
    if (!iso) continue;
    const ms = Date.parse(`${iso}T00:00:00Z`);
    const diff = Math.abs(ms - base);
    if (!best || diff < best.diff || (diff === best.diff && ms > best.ms)) best = { iso, diff, ms };
  }
  if (!best) return undefined;
  const alts = [y0 - 1, y0, y0 + 1].map((y) => validYmd(y, month, day)).filter((x): x is string => !!x);
  if (!alts.includes(best.iso)) alts.push(best.iso);
  return { date: best.iso, alts };
};

const monthOf = (name: string): number => MONTH_INDEX[name.slice(0, 3).toLowerCase()]!;
// "may" is also a verb: accept it as a month only when capitalized.
const isMonthWord = (name: string): boolean => name.toLowerCase() !== "may" || name[0] === "M";

// Date spans cover the date itself; "the week of" is context ("the week of Dec 21" yields Dec 21).
// "Nov 3-5" yields both Nov 3 and Nov 5.
export function extractDates(text: string, opts: { asOf: string }): ExtractedDate[] {
  const found: ExtractedDate[] = [];
  const push = (start: number, end: number, date: string | Resolved | undefined, raw?: string) => {
    if (!date) return;
    const r = typeof date === "string" ? { date } : date;
    found.push({ raw: raw ?? text.slice(start, end), start, end, ...r });
  };
  const pushM = (m: RegExpMatchArray, date: string | Resolved | undefined) =>
    push(m.index!, m.index! + m[0].length, date);
  for (const m of text.matchAll(isoRe)) pushM(m, validYmd(+m[1]!, +m[2]!, +m[3]!));
  for (const m of text.matchAll(ymdSlashRe)) pushM(m, validYmd(+m[1]!, +m[2]!, +m[3]!));
  for (const m of text.matchAll(dmyDotRe)) pushM(m, validYmd(+m[3]!, +m[2]!, +m[1]!));
  for (const m of text.matchAll(usRe)) {
    let a = +m[1]!, b = +m[2]!; // US month/day unless the first part cannot be a month
    if (a > 12) [a, b] = [b, a];
    pushM(m, validYmd(+m[3]!, a, b));
  }
  for (const m of text.matchAll(monthDayRe)) {
    if (!isMonthWord(m[1]!)) continue;
    const mo = monthOf(m[1]!);
    const resolve = (d: number) => (m[5] ? validYmd(+m[5], mo, d) : inferYear(mo, d, opts.asOf));
    if (!m[3]) { pushM(m, resolve(+m[2]!)); continue; }
    const tail = m.index! + m[0].indexOf(m[3], m[1]!.length);
    push(m.index!, tail, resolve(+m[2]!));
    push(tail, tail + m[3].length, resolve(+m[4]!), `${m[1]} ${m[4]}`);
  }
  for (const m of text.matchAll(dayMonthRe)) {
    if (!isMonthWord(m[2]!)) continue;
    const mo = monthOf(m[2]!), d = +m[1]!;
    pushM(m, m[3] ? validYmd(+m[3], mo, d) : inferYear(mo, d, opts.asOf));
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: ExtractedDate[] = [];
  for (const d of found) if (!out.length || d.start >= out[out.length - 1]!.end) out.push(d);
  return out;
}

// ---------------------------------------------------------------- percentages, day counts, sample counts

export type ExtractedNumber = { raw: string; value: number; unit: NumberFact["unit"]; start: number; end: number };

// Only these three shapes are checked; any other bare number ("Net 30", "week 3", "2 of 3") stays ignored.
//   pct:   "40%", "12.5 %"
//   days:  "10 days", "10 more days", "1 extra day"
//   count: "8 payments", "6 samples", "3 invoices" (singular too)
const pctRe = /(?<![\w.])(\d+(?:\.\d+)?)\s?%/g;
const daysRe = /(?<![\w.])(\d+(?:\.\d+)?)\s+(?:(?:more|extra)\s+)?days?(?![A-Za-z])/gi;
const countRe = /(?<![\w.])(\d+(?:\.\d+)?)\s+(?:payments?|samples?|invoices?)(?![A-Za-z])/gi;

const monthBeforeRe = new RegExp(`(?<!\\w)(${MONTHS})\\.?\\s+$`, "i");

export function extractNumbers(text: string): ExtractedNumber[] {
  const out: ExtractedNumber[] = [];
  const add = (re: RegExp, unit: NumberFact["unit"]) => {
    for (const m of text.matchAll(re)) {
      // "Jan 15 payment" is a date followed by a noun, not 15 payments.
      const month = monthBeforeRe.exec(text.slice(Math.max(0, m.index! - 12), m.index!));
      if (month && isMonthWord(month[1]!)) continue;
      out.push({ raw: m[0], value: Number(m[1]), unit, start: m.index!, end: m.index! + m[0].length });
    }
  };
  add(pctRe, "pct");
  add(daysRe, "days");
  add(countRe, "count");
  return out.sort((a, b) => a.start - b.start);
}

export function extractFigures(text: string, opts: CheckOpts): Figures {
  return { amounts: extractAmounts(text, opts), dates: extractDates(text, opts) };
}

// ---------------------------------------------------------------- check

// Rounding rule. A stated amount matches an allowed amount (compared by absolute value, since
// deltas and shortfalls are often stated positive) when they differ by no more than half the last
// stated digit: "$6,200" matches 620,050; "$28K" matches 2,849,900 but not 2,950,000; or, for a
// hedged figure ("about $29,000"), by no more than 5% of the allowed value.
//
// Sign: a stated negative ("-$6K", "($6K)") matches either sign. A stated positive that only
// matches a negative allowed value (a low point, a negative balance) must be framed as a shortfall
// in its sentence (short, below, deficit, overdrawn, ...); "you will have $12,345 left" against a
// closing balance of -12,345 is a wrong statement and fails.
const SHORTFALL_RE = /\b(short(?:fall|age)?|below|under|deficit|gap|dips?|drops?|down|overdrawn|overdraft|negative|minus|shy|lose|loss|burn|owe[sd]?|pay|paying|payments?|spend|spending|costs?|behind|need[s]?|decline[sd]?|decrease[sd]?|lower|less|reduce[sd]?|fall[s]?|exposure|risk|delta|swing|out of cash|run out|runs out)\b/i;

export const amountMatches = (a: ExtractedAmount, allowed: number[], sentence = ""): boolean => {
  const x = Math.abs(a.minor);
  return allowed.some((v) => {
    const y = Math.abs(v);
    const diff = Math.abs(x - y);
    if (!(diff * 2 <= a.precision || (a.hedged && diff * 20 <= y))) return false;
    return v >= 0 || a.minor < 0 || SHORTFALL_RE.test(sentence);
  });
};

const sentenceAround = (text: string, start: number, end: number): string => {
  const before = [...text.slice(0, start).matchAll(/[.!?;]\s|\n/g)].pop();
  const s = before ? before.index! + before[0].length : 0;
  const after = /[.!?;](?:\s|$)|\n/.exec(text.slice(end));
  return text.slice(s, after ? end + after.index : text.length);
};

const checkParts = (parts: (string | undefined)[], citations: string[] | undefined, allowed: Allowed, opts: CheckOpts): CheckResult => {
  const unmatched: Unmatched[] = [];
  const problems: string[] = [];
  const allowedDates = new Set([...allowed.dates, opts.asOf]);
  let amountCount = 0;
  for (const part of parts) {
    if (typeof part !== "string") continue;
    const figs = extractFigures(part, opts);
    amountCount += figs.amounts.length;
    for (const a of figs.amounts) {
      if (!amountMatches(a, allowed.amounts, sentenceAround(part, a.start, a.end))) {
        unmatched.push({ kind: "amount", raw: a.raw });
      }
    }
    if (allowed.numbers) {
      for (const n of extractNumbers(part)) {
        if (!allowed.numbers.some((f) => f.unit === n.unit && Math.abs(f.value - n.value) < 1e-9)) {
          unmatched.push({ kind: "number", raw: n.raw });
        }
      }
    }
    // A date with an inferred year matches if any candidate year (asOf year +-1) is allowed.
    for (const d of figs.dates) {
      if (!(d.alts ?? [d.date]).some((x) => allowedDates.has(x))) unmatched.push({ kind: "date", raw: d.raw });
    }
  }
  if (amountCount > 0 && !(citations && citations.length > 0)) problems.push("amounts without citations");
  return { ok: unmatched.length === 0 && problems.length === 0, unmatched, problems };
};

// Checks any user-facing text (brief lines, drafts): every amount and date must be in `allowed`,
// and amounts need at least one citation. Dates must match exactly; the run date (`asOf`) is always
// allowed.
export function checkText(text: string, citations: string[] | undefined, allowed: Allowed, opts: CheckOpts): CheckResult {
  return checkParts([text], citations, allowed, opts);
}

// Checks an Ask Neri answer: `text` and `missingData` (both are user-facing).
export function checkAnswer(answer: Answer, allowed: Allowed, opts: CheckOpts): CheckResult {
  return checkParts([answer.text, answer.missingData], answer.citations, allowed, opts);
}


// ---------------------------------------------------------------- guard

const feedbackFor = (r: CheckResult): string => {
  const lines = ["Your previous answer failed the number check. Use only figures that appear in the tool results."];
  if (r.unmatched.length) {
    lines.push(`Figures not found in the tool results: ${r.unmatched.map((u) => `${u.kind} "${u.raw}"`).join(", ")}.`);
  }
  for (const p of r.problems) lines.push(`Problem: ${p}. Cite record ids for every amount.`);
  lines.push("If the tools do not return a figure, do not state it; set missingData instead.");
  return lines.join("\n");
};

const isAnswer = (a: unknown): a is Answer =>
  typeof a === "object" && a !== null && typeof (a as Answer).text === "string" &&
  Array.isArray((a as Answer).citations);

// One generation, one regeneration with feedback listing the unmatched figures, then the fallback.
// A generation that throws or returns a malformed value counts as a failed attempt. Nothing
// produced by `generate` is returned unless it passed checkAnswer. The fallback is built by code
// from engine output (Claude writes no part of it), so it is returned as is.
export async function guardAnswer(
  generate: (attempt: number, feedback?: string) => Promise<Answer>,
  allowed: Allowed,
  fallback: () => Answer,
  opts: CheckOpts,
): Promise<GuardResult> {
  let feedback: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let result: CheckResult;
    try {
      const answer = await generate(attempt, feedback);
      if (!isAnswer(answer)) {
        result = { ok: false, unmatched: [], problems: ["malformed answer"] };
      } else {
        result = checkAnswer(answer, allowed, opts);
        if (result.ok) return { answer, attempts: attempt, usedFallback: false };
      }
    } catch {
      result = { ok: false, unmatched: [], problems: ["generation failed"] };
    }
    feedback = feedbackFor(result);
  }
  return { answer: fallback(), attempts: 2, usedFallback: true };
}

// ---------------------------------------------------------------- allowed values

// Keys are split into camelCase / snake_case words and matched as whole words, so "accountBalance"
// is money and "account" or "discount" are not mistaken for "count".
const MONEY_WORDS = new Set(["amount", "amounts", "closing", "opening", "inflow", "inflows", "outflow", "outflows", "cash", "delta", "outstanding", "balance", "balances", "total", "net", "shortfall", "payable", "receivable", "revenue", "expense", "price", "cost", "fee", "tax", "safety", "floor", "buffer", "threshold", "minimum", "weighted", "pipeline", "payment", "due"]);
const COUNT_WORDS = new Set(["count", "days", "weeks", "probability", "score", "rank", "rate", "revision", "version", "index"]);
// Text fields carry message excerpts (data, possibly hostile): never harvest allowed values from them.
const TEXT_WORDS = new Set(["excerpt", "text", "body", "message", "snippet", "subject", "raw"]);
const words = (key: string): string[] =>
  key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const isMoneyKey = (key: string): boolean => {
  const w = words(key);
  return w.some((x) => MONEY_WORDS.has(x)) && !w.some((x) => COUNT_WORDS.has(x));
};
const isTextKey = (key: string): boolean => words(key).some((x) => TEXT_WORDS.has(x));
const isoInText = /(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?!\d)/g;

// Collect integers under money-like keys (arrays inherit the key) and ISO dates from JSON tool
// results. Strings that hold JSON are parsed.
export function allowedFromToolResults(results: unknown[]): Allowed {
  const amounts = new Set<number>();
  const dates = new Set<string>();
  const seen = new WeakSet<object>();

  const walk = (v: unknown, money: boolean): void => {
    if (typeof v === "number") {
      if (money && Number.isInteger(v)) amounts.add(v);
    } else if (typeof v === "string") {
      const t = v.trim();
      if (t.startsWith("{") || t.startsWith("[")) {
        try { walk(JSON.parse(t), false); return; } catch { /* plain text */ }
      }
      for (const m of v.matchAll(isoInText)) {
        const iso = validYmd(+m[1]!, +m[2]!, +m[3]!);
        if (iso) dates.add(iso);
      }
    } else if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) for (const x of v) walk(x, money);
      else for (const [k, x] of Object.entries(v)) if (!isTextKey(k)) walk(x, isMoneyKey(k));
    }
  };
  for (const r of results) walk(r, false);
  return { amounts: [...amounts].sort((a, b) => a - b), dates: [...dates].sort() };
}
