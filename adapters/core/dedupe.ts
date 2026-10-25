import type { Evidence } from "../../schema/records";

// Evidence identity is separate from obligation identity (docs/design/03-data-model.md):
// two Evidence rows may describe one invoice, but the same source must never be stored twice.
const refKey = (e: Evidence): string => `${e.sourceRef.system}\u0000${e.sourceRef.record}`;

export type DedupeResult = {
  fresh: Evidence[];                         // new evidence, or a newer version of a known source
  unchanged: Evidence[];                     // exact repeats; leave the store alone
  superseded: { old: Evidence; next: Evidence }[];  // same provider record, newer receivedAt
};

// Match order: provider id (sourceRef), then file hash. Newest receivedAt wins; ties keep the stored one.
export function dedupeEvidence(existing: Evidence[], incoming: Evidence[]): DedupeResult {
  const byRef = new Map(existing.map((e) => [refKey(e), e]));
  const byHash = new Map(existing.filter((e) => e.fileHash).map((e) => [e.fileHash!, e]));
  const result: DedupeResult = { fresh: [], unchanged: [], superseded: [] };

  for (const e of incoming) {
    const sameRef = byRef.get(refKey(e));
    if (sameRef) {
      if (Date.parse(e.receivedAt) > Date.parse(sameRef.receivedAt) && e.fileHash !== sameRef.fileHash) {
        result.superseded.push({ old: sameRef, next: e });
        result.fresh.push(e);
      } else {
        result.unchanged.push(sameRef);
      }
      continue;
    }
    const sameFile = e.fileHash ? byHash.get(e.fileHash) : undefined;
    if (sameFile) {
      result.unchanged.push(sameFile);
      continue;
    }
    result.fresh.push(e);
    byRef.set(refKey(e), e);
    if (e.fileHash) byHash.set(e.fileHash, e);
  }
  return result;
}
