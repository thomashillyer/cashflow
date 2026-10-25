// Persist an accounting adapter's output (Zoho Books, QuickBooks, Xero: adapters/accounting/common.ts)
// idempotently, keyed on sourceRef. A repeat pull writes nothing and leaves the store revision alone;
// an edited invoice updates its one row. The owner's own data survives a refresh: party tags and notes,
// evidence linked to a commitment by reconciliation, and saved overrides (a separate store, never touched).

import type { Commitment, Party, Records, Settlement, SourceRef } from "../schema/records";
import { dedupeEvidence } from "../adapters/core/dedupe";
import { sortKeys } from "../adapters/accounting/common";
import { sha256Hex } from "../adapters/core/hash";
import type { Store } from "./store";

export type AdapterOutput = Pick<Records, "parties" | "commitments" | "settlements" | "evidence">;

type Counts = { added: number; updated: number; unchanged: number };
export type PersistSummary = {
  evidence: Counts; parties: Counts; commitments: Counts; settlements: Counts;
  storeRevision: number;   // unchanged when nothing was written
  written: boolean;
};

export type ImportPlan = { write: AdapterOutput; summary: Omit<PersistSummary, "storeRevision" | "written"> };

const srcKey = (r: SourceRef) => `${r.system}\u0000${r.record}`;
const refKey = (r: { sourceRef: SourceRef }) => srcKey(r.sourceRef);
const same = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const union = (a: string[] = [], b: string[] = []) => [...new Set([...a, ...b])];
const counts = (): Counts => ({ added: 0, updated: 0, unchanged: 0 });

// Set by the owner or the profile, never by the books: a refresh keeps them when the books are silent.
const OWNER_FIELDS = ["category", "patternId", "discount", "probability", "funding", "paymentUrl"] as const;

// Keep `next` unless it equals `prev`; tally which it was.
function keep<T>(prev: T | undefined, next: T, tally: Counts, out: T[]): void {
  if (!prev) { tally.added++; out.push(next); return; }
  if (same(prev, next)) { tally.unchanged++; return; }
  tally.updated++;
  out.push(next);
}

// Pure: what to write for `incoming` given the stored `existing` records.
export function planImport(existing: Records, incoming: AdapterOutput): ImportPlan {
  const write: AdapterOutput = { parties: [], commitments: [], settlements: [], evidence: [] };
  const summary = { evidence: counts(), parties: counts(), commitments: counts(), settlements: counts() };

  // Evidence: new sources are added, a newer read of a known source keeps the stored id, repeats and
  // failed re-reads of a good source are left alone (adapters/core/dedupe.ts).
  const evidenceId = new Map<string, string>();   // incoming id -> stored id
  const stored = new Map(existing.evidence.map((e) => [refKey(e), e]));
  // A provider record seen for the first time is new even when its payload hashes like a stored one (an
  // invoice deleted and re-created in the books); only uploaded files dedupe on the hash alone.
  const newRecords = incoming.evidence.filter((e) => e.format === "api" && !stored.has(refKey(e)));
  const { fresh: freshKnown, superseded } = dedupeEvidence(existing.evidence, incoming.evidence.filter((e) => !newRecords.includes(e)));
  const fresh = [...newRecords, ...freshKnown];
  const supersededIds = new Map(superseded.map(({ old, next }) => [next, old.id]));
  const byHash = new Map(existing.evidence.filter((e) => e.fileHash).map((e) => [e.fileHash!, e]));
  for (const e of incoming.evidence) {
    const same = stored.get(refKey(e)) ?? (fresh.includes(e) || !e.fileHash ? undefined : byHash.get(e.fileHash));
    evidenceId.set(e.id, same?.id ?? e.id);
  }
  for (const e of fresh) {
    const id = supersededIds.get(e) ?? e.id;
    write.evidence.push(id === e.id ? e : { ...e, id });
    if (supersededIds.has(e)) summary.evidence.updated++; else summary.evidence.added++;
  }
  summary.evidence.unchanged = incoming.evidence.length - fresh.length;
  // Incoming evidence that was a failed re-read of a readable source: its documents keep their stored values.
  const failedReread = new Set(incoming.evidence.filter((e) => {
    const old = stored.get(refKey(e));
    return old?.extraction === "ok" && (e.extraction === "unreadable" || e.extraction === "unsupported");
  }).map((e) => evidenceId.get(e.id)!));   // stored ids

  // Parties: matched by id or by a shared provider ref, and only within the same kind (some books number
  // customers and vendors separately, so one provider id can name both). The provider's name and refs
  // refresh; the owner's tags, notes, aliases, contacts and learned lag stay.
  const partyId = new Map<string, string>();
  const partyIds = new Set(existing.parties.map((x) => x.id));
  for (const p of incoming.parties) {
    const refs = new Set((p.sourceRefs ?? []).map(srcKey));
    const prev = existing.parties.find((x) => x.id === p.id && x.kind === p.kind)
      ?? existing.parties.find((x) => x.kind === p.kind && (x.sourceRefs ?? []).some((r) => refs.has(srcKey(r))));
    const id = prev?.id ?? (partyIds.has(p.id) ? `${p.id}~${p.kind}` : p.id);
    partyIds.add(id);
    partyId.set(p.id, id);
    const next: Party = !prev ? { ...p, id } : {
      ...prev, ...p, id: prev.id,
      tags: union(prev.tags, p.tags), notes: union(prev.notes, p.notes),
      ...(prev.aliases || p.aliases || prev.name !== p.name
        ? { aliases: union(prev.aliases, [...(p.aliases ?? []), ...(prev.name !== p.name ? [prev.name] : [])]) } : {}),
      ...(prev.contacts || p.contacts ? { contacts: {
        emailDomains: union(prev.contacts?.emailDomains, p.contacts?.emailDomains),
        phones: union(prev.contacts?.phones, p.contacts?.phones) } } : {}),
      ...(prev.lagStats ? { lagStats: prev.lagStats } : {}),
      sourceRefs: [...new Map([...(prev.sourceRefs ?? []), ...(p.sourceRefs ?? [])].map((r) => [srcKey(r), r])).values()],
    };
    keep(prev, next, summary.parties, write.parties);
  }

  // Commitments: matched by type and provider ref, never by id alone (the id follows the document number,
  // which the owner can edit in the books, and an invoice and a bill can share a provider id). The stored
  // id is kept; a newcomer whose id is already taken gets a suffixed one. The books own the figures,
  // dates and links, so a field they stop sending clears; the owner's fields stay, and evidence linked by
  // reconciliation (a PDF, an email) stays linked.
  const commitmentId = new Map<string, string>();
  const typedKey = (c: Commitment) => `${c.type}\u0000${refKey(c)}`;
  const bySource = new Map(existing.commitments.map((c) => [typedKey(c), c]));
  const claimed = new Set(existing.commitments.map((c) => c.id));
  for (const c of incoming.commitments) {
    const prev = bySource.get(typedKey(c));
    let id = prev?.id ?? c.id;
    if (!prev && claimed.has(id)) id = `${c.id}~${sha256Hex(typedKey(c)).slice(0, 12)}`;
    claimed.add(id);
    commitmentId.set(c.id, id);
    const evidenceIds = (c.evidenceIds ?? []).map((e) => evidenceId.get(e) ?? e);
    if (prev && evidenceIds.length && evidenceIds.every((e) => failedReread.has(e))) {
      summary.commitments.unchanged++;
      continue;
    }
    const owner = Object.fromEntries(OWNER_FIELDS.flatMap((k) => (c[k] === undefined && prev?.[k] !== undefined ? [[k, prev[k]]] : [])));
    const next: Commitment = {
      ...c, ...owner, id,
      ...(c.partyId ? { partyId: partyId.get(c.partyId) ?? c.partyId } : {}),
      evidenceIds: union(prev?.evidenceIds, evidenceIds),
      ...(prev?.linkedCommitmentIds || c.linkedCommitmentIds ? { linkedCommitmentIds: union(prev?.linkedCommitmentIds, c.linkedCommitmentIds) } : {}),
    };
    keep(prev, next, summary.commitments, write.commitments);
  }

  // Settlements: one per provider payment and document, so matched on both after remapping the document.
  const settlementKey = (s: Settlement) => `${refKey(s)}\u0000${s.commitmentId}`;
  const storedSettlements = new Map(existing.settlements.map((s) => [settlementKey(s), s]));
  for (const s of incoming.settlements) {
    const mapped: Settlement = {
      ...s,
      commitmentId: commitmentId.get(s.commitmentId) ?? s.commitmentId,
      ...(s.partyId ? { partyId: partyId.get(s.partyId) ?? s.partyId } : {}),
    };
    const prev = storedSettlements.get(settlementKey(mapped)) ?? existing.settlements.find((x) => x.id === s.id);
    keep(prev, prev ? { ...mapped, id: prev.id } : mapped, summary.settlements, write.settlements);
  }

  return { write, summary };
}

// Load, plan, and write only what changed. Nothing to write means no write and no revision bump.
export async function persistImport(
  store: Pick<Store, "load" | "upsertRecords">, businessId: string, incoming: AdapterOutput,
): Promise<PersistSummary> {
  const { records, storeRevision } = await store.load(businessId);
  const { write, summary } = planImport(records, incoming);
  const any = write.evidence.length + write.parties.length + write.commitments.length + write.settlements.length > 0;
  if (!any) return { ...summary, storeRevision, written: false };
  return { ...summary, storeRevision: await store.upsertRecords(businessId, write), written: true };
}
