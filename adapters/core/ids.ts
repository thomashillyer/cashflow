import type { Evidence } from "../../schema/records";

// Evidence ids are derived from the source so a re-import upserts the same row.
// Business scope comes from business_id in the store, not from the id.
const slug = (s: string): string =>
  s.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

// A provider record (Zoho invoice, CSV row, message id): ev-<channel>-<record>.
export function recordEvidenceId(channel: Evidence["channel"], record: string): string {
  const id = slug(record);
  if (!id) throw new Error("evidence record id is empty");
  return `ev-${channel}-${id}`;
}

// A whole file: ev-<channel>-<first 8 hex of its hash>.
export function fileEvidenceId(channel: Evidence["channel"], fileHash: string): string {
  return `ev-${channel}-${fileHash.slice(0, 8)}`;
}

// One sheet of a workbook, or one row of a table file. Opaque to other lanes.
export function childEvidenceId(parentId: string, part: string | number): string {
  return `${parentId}-${slug(String(part))}`;
}
