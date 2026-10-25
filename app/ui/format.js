// Formatting and date helpers. Money is integer minor units (cents); dates are ISO YYYY-MM-DD in UTC.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function parseDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toIso(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  const d = parseDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}

export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

export function mondayOf(iso) {
  const d = parseDate(iso);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return toIso(d);
}

/** "Dec 22" */
export function shortDate(iso) {
  if (!iso) return "";
  const d = parseDate(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "Tue, Dec 22" */
export function dayDate(iso) {
  const d = parseDate(iso);
  return `${DAYS[d.getUTCDay()]}, ${shortDate(iso)}`;
}

/** "Dec 21–27" for a Monday-start week */
export function weekLabel(monday) {
  const end = addDays(monday, 6);
  const a = parseDate(monday);
  const b = parseDate(end);
  if (a.getUTCMonth() === b.getUTCMonth()) return `${MONTHS[a.getUTCMonth()]} ${a.getUTCDate()}–${b.getUTCDate()}`;
  return `${shortDate(monday)} – ${shortDate(end)}`;
}

/** $41,800 (no cents for owner-facing amounts) */
export function money(cents, { signed = false, currency = "USD" } = {}) {
  const v = Math.round(cents / 100);
  const abs = Math.abs(v).toLocaleString(currency === "INR" ? "en-IN" : "en-US");
  const sym = currency === "USD" ? "$" : currency === "INR" ? "₹" : currency + " ";
  if (v < 0) return `−${sym}${abs}`;
  return `${signed && v > 0 ? "+" : ""}${sym}${abs}`;
}

/** $41.8K / $1.2M, for tight spaces */
export function moneyShort(cents, { signed = false } = {}) {
  const v = cents / 100;
  const abs = Math.abs(v);
  let s;
  if (abs >= 1e6) s = `$${(abs / 1e6).toFixed(1)}M`;
  else if (abs >= 1e3) s = `$${(abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`;
  else s = `$${Math.round(abs)}`;
  if (v < 0) return `−${s}`;
  return `${signed && v > 0 ? "+" : ""}${s}`;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function greeting(hour) {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

// Plain words for an internal id ("rec-payroll" -> "payroll", "revenueModel.dailySales" -> "daily sales").
// Same rule as ai/labels.ts humanizeId; the browser can't import the TypeScript.
export function humanizeId(id) {
  const words = String(id)
    .replace(/^(?:rec|inv|bill|po|cmt|plan|evt)-/i, "")
    .replace(/^revenueModel\./, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_.]+/g, " ")
    .trim()
    .toLowerCase();
  return words || String(id);
}
