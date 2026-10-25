// Apply a confirmed ChangeProposal to Records (P4.10). Pure: returns new Records and never
// mutates its input. Persons 3/5 call this inside the store's atomic confirm transaction
// (docs/TECHNICAL_PLAN.md section 4); revision and idempotency-key checks live there.
//
// Commitment.settlement changes in exactly one place: createSettlement, because a confirmed settlement is identified
// payment evidence. Documents and links never change it. A confirmed link adds evidence only, never cash. A PO <->
// invoice link only records linkedCommitmentIds; linked coverage is computed once, by the engine (expand).

import type { ChangeProposal, CommitmentFieldChange, ProposalOp } from "../../schema/intake";
import type { Commitment, Party, Records, SourceRef } from "../../schema/records";
import { fmtDate, humanizeId } from "../labels";
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

export function applyProposal(records: Records, proposal: ChangeProposal, opts: { now: string }): ApplyResult {
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
          warnings.push(`Evidence already belongs to ${existing.reference ?? humanizeId(existing.id)}; no new commitment created.`);
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
          // Do not touch to.outstanding or to.amount: the engine's expand() subtracts linked invoices
          // (coveredByLinked), so lowering outstanding here would subtract them twice.
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
        const target = commitment(s.commitmentId);
        const dup = next.settlements.find((x) =>
          x.commitmentId === s.commitmentId && x.date === s.date && x.amount === s.amount && x.sourceRef.record === s.sourceRef.record);
        if (dup) return;
        const id = uniqueId(`stl-${s.commitmentId}-${s.date}`, new Set(next.settlements.map((x) => x.id)));
        next.settlements.push({ ...structuredClone(s), id });
        affected.add(id);
        if (target.outstanding === undefined) {
          // The engine derives the remainder from amount minus settlements; setting it here would count it twice.
          warnings.push(`Payment recorded for ${target.reference ?? humanizeId(target.id)}; the remaining amount is derived from settlements.`);
        } else if (s.currency !== target.currency) {
          warnings.push(`Payment in ${s.currency} recorded for ${target.reference ?? humanizeId(target.id)}, which is in ${target.currency}; outstanding left unchanged (needs review).`);
        } else if (
          // Same rule as the engine's unset path: a payment on/after the latest balance snapshot with no bank line yet
          // is not in opening cash, so it stays expected until the bank shows it.
          s.date >= latestSnapshot(next, opts.now) && !next.events.some((e) => e.commitmentId === target.id)
        ) {
          warnings.push(`Payment recorded for ${target.reference ?? humanizeId(target.id)} dated ${fmtDate(s.date, "")}, after the latest balance and not yet in the bank; outstanding left unchanged until it appears (needs reconciliation).`);
        } else if (
          // An importer may already have lowered outstanding for this payment; decrementing again would hide a
          // double count (the engine's own warning would go quiet) or wrongly mark the invoice paid.
          target.outstanding + priorSettled(next, target, id) < target.amount
        ) {
          warnings.push(`Payment recorded for ${target.reference ?? humanizeId(target.id)}, but its outstanding amount is already below the invoice total; left unchanged. Check whether this payment is already in the books (needs review).`);
        } else {
          // Outstanding is authoritative in the engine, so keep it consistent with the payment. Idempotent: a repeat
          // of the same settlement returned above. A confirmed settlement is identified payment evidence, so this is
          // the one place settlement state moves.
          if (s.amount > target.outstanding) {
            warnings.push(`Payment of ${s.amount} exceeds the ${target.outstanding} outstanding on ${target.reference ?? humanizeId(target.id)}; outstanding set to 0 (needs review).`);
          }
          target.outstanding = Math.max(0, target.outstanding - s.amount);
          if (target.settlement !== "cancelled" && target.settlement !== "credited") {
            target.settlement = target.outstanding === 0 ? "paid" : "partial";
          }
          affected.add(target.id);
          warnings.push(`Payment recorded for ${target.reference ?? humanizeId(target.id)}; outstanding is now ${target.outstanding}.`);
        }
        return;
      }
    }
  }
}

// Latest balance snapshot on or before `now` (YYYY-MM-DD); "" when there is none (then nothing counts as after it).
function latestSnapshot(records: Records, now: string): string {
  const today = now.slice(0, 10);
  let snap = "";
  for (const b of records.balances) if (b.asOf <= today && b.asOf > snap) snap = b.asOf;
  return snap || "9999-99-99";
}

// Same-currency settlements already recorded for the commitment, not counting the one just added (`excludeId`).
function priorSettled(records: Records, c: Commitment, excludeId: string): number {
  return records.settlements
    .filter((x) => x.commitmentId === c.id && x.currency === c.currency && x.id !== excludeId)
    .reduce((a, x) => a + x.amount, 0);
}

function firstCreatedTemp(p: ChangeProposal): string {
  const op = p.ops.find((o) => o.op === "createCommitment");
  return op && op.op === "createCommitment" ? op.tempId : "";
}
