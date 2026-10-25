// Recurring-payment detection for a bank statement: plain code, no model, proposals only.
// Design defaults (docs/design/04-adapters.md, "Bank recurring detection"): group by normalized payee, regular
// intervals of 7, 14, 15, 30 or 91 days within +/-2, stable amounts within +/-10%. We add one safety rule of
// our own: at least three occurrences, so two coincidental payments are never called a schedule.
// A proposal is never a commitment: the owner confirms it first, and nothing here changes cash.

export const RECURRING_CADENCES = [
  { cadence: "weekly", days: 7 },
  { cadence: "biweekly", days: 14 },
  { cadence: "semimonthly", days: 15 },
  { cadence: "monthly", days: 30 },
  { cadence: "quarterly", days: 91 },
] as const;
export const INTERVAL_TOLERANCE_DAYS = 2;
export const AMOUNT_TOLERANCE = 0.1;      // fraction of the typical amount
export const MIN_OCCURRENCES = 3;

export type RecurringCadence = (typeof RECURRING_CADENCES)[number]["cadence"];   // same names as Profile.recurring[].cadence

export type BankLine = {
  eventId: string;
  row: number;            // 1-based spreadsheet row
  date: string;           // YYYY-MM-DD
  amount: number;         // minor units, positive
  direction: "in" | "out";
  currency: string;
  description: string;
};

export type RecurringProposal = {
  id: string;
  payee: string;          // what the statement calls it (most common wording)
  direction: "in" | "out";
  cadence: RecurringCadence;
  intervalDays: number;   // median gap actually seen
  typicalAmount: number;  // median, minor units
  currency: string;
  occurrences: number;
  firstDate: string;
  lastDate: string;
  nextExpected: string;   // last date + the cadence's nominal days: an estimate for the owner to confirm
  evidence: { eventId: string; row: number; date: string; amount: number }[];
  basis: string;          // why it was proposed, in plain words
};

// Bank wording that says how the money moved, not who it moved to.
const NOISE = new Set([
  "ach", "pos", "debit", "credit", "card", "purchase", "payment", "pmt", "pymt", "transfer", "xfer", "online", "withdrawal",
  "deposit", "check", "chk", "wire", "ref", "dda", "bill", "recurring", "autopay", "to", "from", "the", "and", "for",
]);

// "ACH DEBIT ACME PAYROLL #1043 10/16" -> "acme payroll". Letters only, so reference numbers and dates drop out.
export function payeeKey(description: string): string {
  const tokens = description.toLowerCase().replace(/[^\p{L}\s]/gu, " ").split(/\s+/)
    .filter((t) => t && !NOISE.has(t) && (t.length > 1 || /[^\x00-\x7f]/.test(t)));
  return tokens.slice(0, 3).join(" ");
}

const dayNumber = (d: string): number => {
  const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, dd) / 86_400_000;
};
export const addDaysUtc = (d: string, n: number): string => new Date((dayNumber(d) + n) * 86_400_000).toISOString().slice(0, 10);

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of s) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export function proposeRecurring(lines: BankLine[]): RecurringProposal[] {
  const groups = new Map<string, BankLine[]>();
  for (const l of lines) {
    const key = payeeKey(l.description);
    if (!key) continue;   // nothing to group on: never guess a payee
    const k = `${l.direction}|${l.currency}|${key}`;
    const list = groups.get(k);
    if (list) list.push(l); else groups.set(k, [l]);
  }
  const out: RecurringProposal[] = [];
  for (const [key, group] of groups) {
    if (group.length < MIN_OCCURRENCES) continue;
    const sorted = [...group].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.row - b.row));
    const gaps = sorted.slice(1).map((l, i) => dayNumber(l.date) - dayNumber(sorted[i]!.date));
    const med = median(gaps);
    const fit = RECURRING_CADENCES
      .filter((c) => Math.abs(c.days - med) <= INTERVAL_TOLERANCE_DAYS && gaps.every((g) => Math.abs(g - c.days) <= INTERVAL_TOLERANCE_DAYS))
      .sort((a, b) => Math.abs(a.days - med) - Math.abs(b.days - med))[0];
    if (!fit) continue;
    const typical = Math.round(median(sorted.map((l) => l.amount)));
    if (!sorted.every((l) => Math.abs(l.amount - typical) <= typical * AMOUNT_TOLERANCE)) continue;
    const wording = new Map<string, number>();
    for (const l of sorted) wording.set(l.description, (wording.get(l.description) ?? 0) + 1);
    const payee = [...wording].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    const last = sorted[sorted.length - 1]!;
    out.push({
      id: `rec-${shortHash(key)}`, payee, direction: last.direction, cadence: fit.cadence, intervalDays: med, typicalAmount: typical,
      currency: last.currency, occurrences: sorted.length, firstDate: sorted[0]!.date, lastDate: last.date,
      nextExpected: addDaysUtc(last.date, fit.days),
      evidence: sorted.map((l) => ({ eventId: l.eventId, row: l.row, date: l.date, amount: l.amount })),
      basis: `${sorted.length} payments about ${fit.days} days apart (${fit.cadence}) within 10% of the same amount.`,
    });
  }
  return out.sort((a, b) => (a.direction < b.direction ? -1 : a.direction > b.direction ? 1 : a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : a.id < b.id ? -1 : 1));
}
