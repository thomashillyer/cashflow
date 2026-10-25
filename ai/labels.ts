// Owner-facing labels and dates. Owner text must never show an internal id ("rec-payroll", "dailySales") or an
// ISO date ("2027-01-08"). Everything that builds such text goes through these helpers (issues #174, #169).
// No imports from the rest of the repo, so engine/, ai/ and api/ can all use it.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-12-18" -> "Dec 18"; "Jan 8, 2027" when the year differs from asOf's.
export function fmtDate(iso: string, asOf: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const base = `${MONTHS[(m ?? 1) - 1]} ${d}`;
  return iso.slice(0, 4) === asOf.slice(0, 4) ? base : `${base}, ${y}`;
}

// "rec-payroll" -> "payroll"; "rec-est-tax" -> "est tax"; "revenueModel.dailySales" -> "daily sales".
// Strips the record prefix, splits camelCase, dots, dashes and underscores, lowercases.
export function humanizeId(id: string): string {
  const words = id
    .replace(/^(?:rec|inv|bill|po|cmt|plan|evt)-/i, "")
    .replace(/^revenueModel\./, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_.]+/g, " ")
    .trim()
    .toLowerCase();
  return words || id;
}

type Named = { id: string; name?: string; label?: string };

// A plain name for an event or commitment source: the profile's recurring item name when the id (or the part
// before "~" for a linked cost) is one, else the record's own label or name, else a humanized id.
export function ownerLabel(id: string | undefined, sources: { recurring?: Named[]; records?: Named[] } = {}): string {
  if (!id) return "an item";
  const base = id.split("~")[0]!;
  const rec = sources.recurring?.find((r) => r.id === base);
  if (rec) return (rec.label ?? rec.name ?? humanizeId(base)).trim().toLowerCase();
  const own = sources.records?.find((r) => r.id === base);
  return (own?.label ?? own?.name)?.trim() ?? humanizeId(base);
}

const ISO_RE = /(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?![\w-])/g;
// Rewrites any ISO date left in a sentence as the owner format.
export function humanizeDates(text: string, asOf: string): string {
  return text.replace(ISO_RE, (iso) => fmtDate(iso, asOf));
}
