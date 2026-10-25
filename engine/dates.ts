// UTC calendar-date helpers. Dates are YYYY-MM-DD strings; never use local-time getters.

const DAY_MS = 86_400_000;

export function toMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

export function fromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromMs(toMs(date) + days * DAY_MS);
}

export function diffDays(a: string, b: string): number {
  return Math.round((toMs(a) - toMs(b)) / DAY_MS);
}

// Monday of the week containing `date` (weeks run Monday to Sunday).
export function mondayOf(date: string): string {
  const dow = (new Date(toMs(date)).getUTCDay() + 6) % 7; // 0 = Monday
  return addDays(date, -dow);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function endOfMonth(date: string): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
}

// Add whole months, clamping the day to the target month's length (Jan 31 + 1 month = Feb 28/29).
export function addMonthsClamped(date: string, months: number, dayOfMonth?: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const day = Math.min(dayOfMonth ?? d, daysInMonth(ny, nm));
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function dateRange(startInclusive: string, endExclusive: string): string[] {
  const out: string[] = [];
  for (let d = startInclusive; d < endExclusive; d = addDays(d, 1)) out.push(d);
  return out;
}

// Day of week with Monday = 0 ... Sunday = 6, matching profile weekday indexes.
export function dowOf(date: string): number {
  return (new Date(toMs(date)).getUTCDay() + 6) % 7;
}
