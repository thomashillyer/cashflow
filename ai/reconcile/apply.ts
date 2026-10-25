// Apply a confirmed ChangeProposal to Records (P4.10). Pure: returns new Records and never
// mutates its input. Persons 3/5 call this inside the store's atomic confirm transaction
// (docs/TECHNICAL_PLAN.md section 4); revision and idempotency-key checks live there.
//
// Never touches Commitment.settlement. A confirmed link adds evidence only, never cash.

import type { ChangeProposal, CommitmentFieldChange, ProposalOp } from "../../schema/intake";
import type { Commitment, Party, Records, SourceRef } from "../../schema/records";
import { normalizeRef, poAllocated } from "./match";

export type ApplyErrorCode = "NOT_PROPOSED" | "NOTHING_TO_APPLY" | "STALE_REVIEW" | "UNKNOWN_TARGET" | "OVER_ALLOCATED";

export class ApplyError extends Error {
  constructor(readonly code: ApplyErrorCode, message: string) {
    super(message);
    this.name = "ApplyError";
  }
}

export type ApplyResult = { records: Records; affectedRecordIds: string[]; warnings: string[] };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function getField(c: Commitment, field: CommitmentFieldChange["field"]): unknown {
  if (field.startsWith("anchors.")) return c.anchors[field.slice(8) as keyof Commitment["anchors"]];
  return c[field as keyof Commitment];
}

function setField(c: Commitment, change: CommitmentFieldChange): void {
  if (change.field.startsWith("anchors.")) {
    c.anchors = { ...c.anchors, [change.field.slice(8)]: change.to };
  } else {
    (c as Record<string, unknown>)[change.field] = change.to;
  }
}

export function applyProposal(records: Records, proposal: ChangeProposal, _opts: { now: string }): ApplyResult {
  if (proposal.state !== "proposed") {
    throw new ApplyError("NOT_PROPOSED", `Proposal ${proposal.id} is ${proposal.state}.`);
  }
  if ((proposal.action === "conflict" || proposal.action === "review") && proposal.ops.length === 0 && !proposal.ownerEdits?.length) {
    throw new ApplyError("NOTHING_TO_APPLY", `Proposal ${proposal.id} needs the owner to resolve it before it can be applied.`);
  }

  const next = structuredClone(records);
  const affected = new Set<string>();
  const warnings: string[] = [];
  const temp = new Map<string, string>();
  const resolve = (id: string) => temp.get(id) ?? id;
  const commitment = (id: string): Commitment => {
    const c = next.commitments.find((x) => x.id === resolve(id));
    if (!c) throw new ApplyError("UNKNOWN_TARGET", `Commitment ${id} not found.`);
    return c;
  };
  const defaultSource = (): SourceRef => {
    if (proposal.sourceRef) return proposal.sourceRef;
    const evId = proposal.evidenceIds[0];
    const ev = next.evidence.find((e) => e.id === evId);
    return ev ? { system: ev.channel, record: ev.id } : { system: "intake", record: evId ?? proposal.id };
  };

  for (const op of proposal.ops) applyOp(op);

  // Owner edits win over extracted values; applied last to the main commitment.
  if (proposal.ownerEdits?.length) {
    const targetId = proposal.targetCommitmentId ?? temp.get(firstCreatedTemp(proposal));
    if (!targetId) throw new ApplyError("UNKNOWN_TARGET", "Owner edits have no target commitment.");
    const c = commitment(targetId);
    for (const edit of proposal.ownerEdits) setField(c, edit);
    affected.add(c.id);
  }

  return { records: next, affectedRecordIds: [...affected], warnings };

  function applyOp(op: ProposalOp): void {
    switch (op.op) {
      case "createParty": {
        const id = uniqueId(`party-${slug(op.party.name)}`, new Set(next.parties.map((p) => p.id)));
        const party: Party = { ...structuredClone(op.party), id };
        next.parties.push(party);
        temp.set(op.tempId, id);
        affected.add(id);
        return;
      }
      case "createCommitment": {
        const draft = structuredClone(op.draft);
        // Idempotency: same evidence and same reference means this document was already created.
        // (One email can describe several invoices, so shared evidence alone is not enough.)
        const sameRef = (c: Commitment) =>
          c.type === draft.type && normalizeRef(c.reference ?? "") === normalizeRef(draft.reference ?? "");
        const existing = next.commitments.find((c) => sameRef(c) && c.evidenceIds?.some((e) => draft.evidenceIds?.includes(e)));
        if (existing) {
          temp.set(op.tempId, existing.id);
          warnings.push(`Evidence already belongs to ${existing.id}; no new commitment created.`);
          return;
        }
        const partyId = draft.partyId ? resolve(draft.partyId) : undefined;
        const ref = draft.reference ? slug(draft.reference).toUpperCase() : undefined;
        const base =
          draft.type === "invoice" ? `inv-${ref ?? proposal.id}` :
          draft.type === "bill" ? `bill-${partyId ?? "unknown"}-${ref ?? proposal.id}` :
          draft.type === "purchase_order" ? `po-${ref ?? proposal.id}` :
          `cmt-${proposal.id}`;
        const id = uniqueId(base, new Set(next.commitments.map((c) => c.id)));
        const { sourceRef, ...rest } = draft;
        const c: Commitment = { ...rest, id, sourceRef: sourceRef ?? defaultSource() };
        if (partyId) c.partyId = partyId;
        c.evidenceIds = [...new Set(draft.evidenceIds ?? proposal.evidenceIds)];
        next.commitments.push(c);
        temp.set(op.tempId, id);
        affected.add(id);
        return;
      }
      case "linkEvidence": {
        const c = commitment(op.commitmentId);
        const before = c.evidenceIds?.length ?? 0;
        c.evidenceIds = [...new Set([...(c.evidenceIds ?? []), ...op.evidenceIds])];
        if (c.evidenceIds.length !== before) affected.add(c.id);
        return;
      }
      case "linkCommitments": {
        const from = commitment(op.fromId);
        const to = commitment(op.toId);
        if (to.linkedCommitmentIds?.includes(from.id) && from.linkedCommitmentIds?.includes(to.id)) return;
        from.linkedCommitmentIds = [...new Set([...(from.linkedCommitmentIds ?? []), to.id])];
        to.linkedCommitmentIds = [...new Set([...(to.linkedCommitmentIds ?? []), from.id])];
        if (to.type === "purchase_order") {
          const remaining = to.amount - poAllocated(next, to);
          if (remaining < 0) throw new ApplyError("OVER_ALLOCATED", `Invoices linked to ${to.id} exceed its amount.`);
          to.outstanding = remaining; // only the uninvoiced part of the PO still contributes
        }
        affected.add(from.id);
        affected.add(to.id);
        return;
      }
      case "updateCommitment": {
        const c = commitment(op.commitmentId);
        const current = getField(c, op.change.field);
        if (current === op.change.to) return; // already applied
        if (current !== op.change.from) {
          throw new ApplyError("STALE_REVIEW", `${c.id}.${op.change.field} changed since review (now ${String(current)}).`);
        }
        setField(c, op.change);
        affected.add(c.id);
        return;
      }
      case "createSettlement": {
        const s = op.settlement;
        commitment(s.commitmentId);
        const dup = next.settlements.find((x) =>
          x.commitmentId === s.commitmentId && x.date === s.date && x.amount === s.amount && x.sourceRef.record === s.sourceRef.record);
        if (dup) return;
        const id = uniqueId(`stl-${s.commitmentId}-${s.date}`, new Set(next.settlements.map((x) => x.id)));
        next.settlements.push({ ...structuredClone(s), id });
        affected.add(id);
        warnings.push(`Payment recorded for ${s.commitmentId}; outstanding and settlement state are derived from settlements.`);
        return;
      }
    }
  }
}

function firstCreatedTemp(p: ChangeProposal): string {
  const op = p.ops.find((o) => o.op === "createCommitment");
  return op && op.op === "createCommitment" ? op.tempId : "";
}
