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

import type { Answer } from "../schema/forecast";

export type CheckOpts = { currency: string; asOf: string };

export type ExtractedAmount = {
  raw: string;
  minor: number;      // signed, integer minor units of the stated currency
  start: number;
  end: number;
  approx: boolean;    // K/M suffix or "about/around/roughly/..."
  precision: number;  // size of the last stated digit in minor units (>= 1); the rounding rule
};
export type ExtractedDate = { raw: string; date: string; start: number; end: number };
export type Figures = { amounts: ExtractedAmount[]; dates: ExtractedDate[] };

export type Allowed = { amounts: number[]; dates: string[] };
export type Unmatched = { kind: "amount" | "date"; raw: string };
export type CheckResult = { ok: boolean; unmatched: Unmatched[]; problems: string[] };
export type GuardResult = { answer: Answer; attempts: number; usedFallback: boolean };

// ---------------------------------------------------------------- minor units

export const minorUnitDigits = (currency: string): number => {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
};

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
const NUM = "(?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)";

const numRe = new RegExp(`(?<![\\w.,])${NUM}(?!\\d|,\\d)`, "g");
const curRe = new RegExp(`(${SYMBOL}|(?<![A-Za-z])(?:${ISO_CODE})(?![A-Za-z]))\\s?$`, "i");
const suffixRe = /^(?:([kK])(?![A-Za-z])|(M)(?![A-Za-z])|(m)(?![A-Za-z])|\s?([Tt]housand)\b|\s?([Mm]illion)\b)/;
const tailRe = /^\s?(?:dollars?|bucks|usd|euros?|eur|pounds?|gbp)\b/i;
const approxRe = /(?:\babout|\baround|\broughly|\bapproximately|\bapprox\.?|\bnearly|\balmost|\bcirca|~)\s*$/i;

const isSign = (c: string | undefined): boolean => c === "-" || c === "−" || c === "–";
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);

// Only currency-marked ($, USD, "dollars") or K/M-suffixed numbers are money. Bare numbers are
// counts, days, weeks, or years.
export function extractAmounts(text: string, opts: { currency: string }): ExtractedAmount[] {
  const out: ExtractedAmount[] = [];
  const baseDigits = minorUnitDigits(opts.currency);
  for (const m of text.matchAll(numRe)) {
    const numStart = m.index!;
    const numEnd = numStart + m[0].length;

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
    let open = false;
    if (text[i - 1] === "(") { open = true; i -= 1; }
    let start = i;

    // Right: K / M / thousand / million suffix, then an optional currency word.
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
    if (!cur && exp === 0 && !t) continue;

    let end = numEnd + suffixLen + tailLen;
    if (open) {
      if (text[end] === ")") { end += 1; negative = true; } // accounting negative
      else start += 1;                                      // stray "(" is not part of the figure
    }

    const code = cur && /^[A-Za-z]{3}$/.test(cur) ? cur.toUpperCase() : opts.currency;
    const { minor, precision } = toMinor(m[0], exp, code === opts.currency ? baseDigits : minorUnitDigits(code));
    out.push({
      raw: text.slice(start, end),
      minor: negative ? -minor : minor,
      start,
      end,
      approx: exp > 0 || approxRe.test(text.slice(Math.max(0, start - 20), start)),
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
const monthDayRe = new RegExp(
  `(?<!\\w)(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(${YEAR})(?!\\d))?`, "gi");
const dayMonthRe = new RegExp(
  `(?<![\\w.,$€£-])(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS})(?![A-Za-z])\\.?(?:,?\\s+(${YEAR})(?!\\d))?`, "gi");

const pad = (n: number): string => String(n).padStart(2, "0");
const validYmd = (y: number, m: number, d: number): string | undefined => {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return undefined;
  return `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
};

// No year stated: the occurrence of month/day nearest asOf (so within +-6 months); ties go later.
const inferYear = (month: number, day: number, asOf: string): string | undefined => {
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
  return best?.iso;
};

const monthOf = (name: string): number => MONTH_INDEX[name.slice(0, 3).toLowerCase()]!;
// "may" is also a verb: accept it as a month only when capitalized.
const isMonthWord = (name: string): boolean => name.toLowerCase() !== "may" || name[0] === "M";

// Date spans cover the date itself; "the week of" is context ("the week of Dec 21" yields Dec 21).
export function extractDates(text: string, opts: { asOf: string }): ExtractedDate[] {
  const found: ExtractedDate[] = [];
  const push = (m: RegExpMatchArray, date: string | undefined) => {
    if (date) found.push({ raw: m[0], date, start: m.index!, end: m.index! + m[0].length });
  };
  for (const m of text.matchAll(isoRe)) push(m, validYmd(+m[1]!, +m[2]!, +m[3]!));
  for (const m of text.matchAll(usRe)) {
    let a = +m[1]!, b = +m[2]!; // US month/day unless the first part cannot be a month
    if (a > 12) [a, b] = [b, a];
    push(m, validYmd(+m[3]!, a, b));
  }
  for (const m of text.matchAll(monthDayRe)) {
    if (!isMonthWord(m[1]!)) continue;
    const mo = monthOf(m[1]!), d = +m[2]!;
    push(m, m[3] ? validYmd(+m[3], mo, d) : inferYear(mo, d, opts.asOf));
  }
  for (const m of text.matchAll(dayMonthRe)) {
    if (!isMonthWord(m[2]!)) continue;
    const mo = monthOf(m[2]!), d = +m[1]!;
    push(m, m[3] ? validYmd(+m[3], mo, d) : inferYear(mo, d, opts.asOf));
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: ExtractedDate[] = [];
  for (const d of found) if (!out.length || d.start >= out[out.length - 1]!.end) out.push(d);
  return out;
}

export function extractFigures(text: string, opts: CheckOpts): Figures {
  return { amounts: extractAmounts(text, opts), dates: extractDates(text, opts) };
}

// ---------------------------------------------------------------- check

// Rounding rule. A stated amount matches an allowed amount (compared by absolute value, since
// deltas and shortfalls are often stated positive) when:
//  - they differ by no more than half the last stated digit: "$6,200" matches 620,050; "$28K"
//    matches 2,849,900 but not 2,950,000; or
//  - the figure is approximate (K/M, "about ...") and within 5% of the allowed value.
export const amountMatches = (a: ExtractedAmount, allowed: number[]): boolean => {
  const x = Math.abs(a.minor);
  return allowed.some((v) => {
    const y = Math.abs(v);
    const diff = Math.abs(x - y);
    return diff * 2 <= a.precision || (a.approx && diff * 20 <= y);
  });
};

// Checks `text` and `missingData` (both are user-facing). Dates must match exactly; the run date
// (`asOf`) is always allowed. Any amount with no citations is a problem.
export function checkAnswer(answer: Answer, allowed: Allowed, opts: CheckOpts): CheckResult {
  const unmatched: Unmatched[] = [];
  const problems: string[] = [];
  const allowedDates = new Set([...allowed.dates, opts.asOf]);
  let amountCount = 0;
  for (const part of [answer.text, answer.missingData]) {
    if (typeof part !== "string") continue;
    const figs = extractFigures(part, opts);
    amountCount += figs.amounts.length;
    for (const a of figs.amounts) if (!amountMatches(a, allowed.amounts)) unmatched.push({ kind: "amount", raw: a.raw });
    for (const d of figs.dates) if (!allowedDates.has(d.date)) unmatched.push({ kind: "date", raw: d.raw });
  }
  if (amountCount > 0 && !(answer.citations?.length > 0)) problems.push("amounts without citations");
  return { ok: unmatched.length === 0 && problems.length === 0, unmatched, problems };
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

const MONEY_KEY = /amount|closing|opening|inflow|outflow|cash|delta|outstanding|balance|total|net|shortfall|payable|receivable|revenue|expense|price|cost|fee|tax|safety|floor|buffer|threshold|minimum|weighted|pipeline|low/i;
const COUNT_KEY = /count|days|weeks|probability|score|rank|rate|revision|version|index/i;
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
      else for (const [k, x] of Object.entries(v)) walk(x, MONEY_KEY.test(k) && !COUNT_KEY.test(k));
    }
  };
  for (const r of results) walk(r, false);
  return { amounts: [...amounts].sort((a, b) => a - b), dates: [...dates].sort() };
}
