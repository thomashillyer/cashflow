// Code-side normalization of extracted values (P4.3). The model returns raw strings and
// quotes; code turns them into minor units, ISO dates, and located evidence. A value
// with no supporting quote in the source becomes "missing": we never trust an unquoted figure.

import type { Field, FieldEvidence, IntakeCandidate } from "../schema/intake";

// A piece of source text: one PDF page, one message, one sheet rendered as text.
export type SourceSegment = { evidenceId: string; text: string; page?: number };

// ---------- money ----------

export function minorUnitDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

// "28,000.00" | "USD 6,200.00" | "$4,000" | "1.234,56" -> integer minor units, without floats.
export function parseAmount(raw: string, currency: string): number | undefined {
  const negative = /^\s*-|\(\s*[\d.,]+\s*\)|-\s*$/.test(raw);
  const digits = raw.replace(/[^\d.,]/g, "");
  if (!/\d/.test(digits)) return undefined;
  // The decimal separator is the last "." or "," followed by 1-3 digits at the end,
  // unless that group is exactly 3 digits and another separator of the same kind appears earlier (thousands).
  const m = digits.match(/^(.*?)([.,])(\d{1,3})$/);
  let intPart = digits;
  let frac = "";
  if (m) {
    const [, head = "", sep, tail = ""] = m;
    const isThousands = tail.length === 3 && (head.includes(sep!) || !/[.,]/.test(head)) && sep === "," ;
    if (!isThousands) {
      intPart = head;
      frac = tail;
    }
  }
  intPart = intPart.replace(/[.,]/g, "");
  if (!/^\d+$/.test(intPart || "0")) return undefined;
  const exp = minorUnitDigits(currency);
  if (frac.length > exp) {
    // More decimals than the currency allows: only accept if the extra digits are zeros.
    if (!/^0*$/.test(frac.slice(exp))) return undefined;
    frac = frac.slice(0, exp);
  }
  const minor = BigInt(intPart || "0") * 10n ** BigInt(exp) + BigInt((frac + "0".repeat(exp)).slice(0, exp) || "0");
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const n = Number(minor);
  return negative ? -n : n;
}

// ---------- dates ----------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const iso = (y: number, m: number, d: number): string | undefined => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

export type ParsedDate = { date: string; ambiguous: boolean };

// Absolute dates only. Relative phrases ("next Friday", "early January") return undefined;
// the signals pipeline resolves those against receivedAt.
export function parseDate(raw: string, opts: { dayFirst?: boolean } = {}): ParsedDate | undefined {
  const s = raw.trim().replace(/(\d)(st|nd|rd|th)\b/gi, "$1").replace(/,/g, " ").replace(/\s+/g, " ");
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const date = iso(+m[1]!, +m[2]!, +m[3]!);
    return date ? { date, ambiguous: false } : undefined;
  }
  m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2}) (\d{4})$/);           // December 10 2026
  if (m) {
    const mon = MONTHS[m[1]!.toLowerCase().slice(0, m[1]!.toLowerCase().startsWith("sept") ? 4 : 3)];
    const date = mon ? iso(+m[3]!, mon, +m[2]!) : undefined;
    return date ? { date, ambiguous: false } : undefined;
  }
  m = s.match(/^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})$/);           // 10 December 2026
  if (m) {
    const mon = MONTHS[m[2]!.toLowerCase().slice(0, 3)];
    const date = mon ? iso(+m[3]!, mon, +m[1]!) : undefined;
    return date ? { date, ambiguous: false } : undefined;
  }
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/);       // 11/28/26, 28.11.2026
  if (m) {
    const a = +m[1]!, b = +m[2]!;
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    const [mon, day] = opts.dayFirst ? [b, a] : [a, b];
    const date = iso(y, mon, day);
    if (!date) {
      const swapped = iso(y, day, mon);
      return swapped ? { date: swapped, ambiguous: false } : undefined;
    }
    return { date, ambiguous: a <= 12 && b <= 12 && a !== b };
  }
  return undefined;
}

// ---------- quotes -> evidence ----------

function normalizeWithMap(text: string): { norm: string; map: number[] } {
  const map: number[] = [];
  let norm = "";
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (!lastSpace) { norm += " "; map.push(i); lastSpace = true; }
    } else {
      norm += ch.toLowerCase(); map.push(i); lastSpace = false;
    }
  }
  return { norm, map };
}

// Find the model's quote in the source. Exact first, then whitespace/case-insensitive.
export function locateQuote(segments: SourceSegment[], quote: string | null | undefined): FieldEvidence | undefined {
  const q = quote?.trim();
  if (!q) return undefined;
  for (const seg of segments) {
    const start = seg.text.indexOf(q);
    if (start >= 0) return ev(seg, start, start + q.length);
  }
  const nq = normalizeWithMap(q).norm.trim();
  if (!nq) return undefined;
  for (const seg of segments) {
    const { norm, map } = normalizeWithMap(seg.text);
    const at = norm.indexOf(nq);
    if (at >= 0) return ev(seg, map[at]!, map[at + nq.length - 1]! + 1);
  }
  return undefined;
}

function ev(seg: SourceSegment, start: number, end: number): FieldEvidence {
  return {
    evidenceId: seg.evidenceId,
    text: seg.text.slice(start, end),
    ...(seg.page !== undefined ? { page: seg.page } : {}),
    excerpt: { start, end },
  };
}

// ---------- fields ----------

export const missing = <T>(reason?: string): Field<T> => (reason ? { state: "missing", reason } : { state: "missing" });

// Build a field from a raw value + quote. The value must be supported by a located quote,
// and the parser (if any) must accept it; otherwise the field is missing with a reason.
export function fieldFrom<T>(
  raw: { value: string | null; quote: string | null } | null | undefined,
  segments: SourceSegment[],
  parse: (v: string) => T | undefined,
  label: string,
): Field<T> {
  if (!raw || raw.value === null || raw.value.trim() === "") return missing(`${label} not stated`);
  const evidence = locateQuote(segments, raw.quote ?? raw.value);
  if (!evidence) return missing(`${label} "${raw.value}" not found in the source`);
  const value = parse(raw.value.trim());
  if (value === undefined) return missing(`${label} "${raw.value}" could not be read`);
  return { state: "found", value, evidence: [evidence] };
}

// ---------- validation ----------

export type CandidateIssue = { field: string; problem: string };

// Structural checks the type system can't express. An empty list means valid.
export function validateCandidate(c: IntakeCandidate): CandidateIssue[] {
  const issues: CandidateIssue[] = [];
  for (const [name, f] of Object.entries(c.fields) as [string, Field<unknown> | undefined][]) {
    if (!f) continue;
    if (f.state === "found" && f.evidence.length === 0) issues.push({ field: name, problem: "found without evidence" });
    if (f.state === "conflict" && f.values.length < 2) issues.push({ field: name, problem: "conflict needs at least two values" });
    if (f.state === "missing" && "value" in f) issues.push({ field: name, problem: "missing field carries a value" });
  }
  const amt = c.fields.amount;
  if (amt.state === "found" && (!Number.isSafeInteger(amt.value) || amt.value < 0)) {
    issues.push({ field: "amount", problem: "amount must be a non-negative integer in minor units" });
  }
  const cur = c.fields.currency;
  if (cur.state === "found" && !/^[A-Z]{3}$/.test(cur.value)) issues.push({ field: "currency", problem: "currency must be ISO 4217" });
  for (const d of ["issueDate", "dueDate"] as const) {
    const f = c.fields[d];
    if (f.state === "found" && !/^\d{4}-\d{2}-\d{2}$/.test(f.value)) issues.push({ field: d, problem: "date must be YYYY-MM-DD" });
  }
  if (c.extraction === "ok" && (c.kind === "invoice" || c.kind === "bill") && amt.state !== "found") {
    issues.push({ field: "amount", problem: "an invoice or bill without an amount can't be extraction ok" });
  }
  if (c.confidence < 0 || c.confidence > 1) issues.push({ field: "confidence", problem: "confidence must be 0..1" });
  return issues;
}
