// Layer 2 reconciliation (P4.9, P4.11): turn one IntakeCandidate into one ChangeProposal.
// Pure and deterministic. Rules: docs/design/03-data-model.md "Reconciliation rules" and
// docs/TECHNICAL_PLAN.md section 6A.
//
// - Match on party + direction + normalized reference + currency. Amount and dates are
//   consistency checks only; never match on amount or display name alone.
// - New commitments and cross-source links are proposals; nothing here writes.
// - Documents never change settlement. A payment link or a "PAID" stamp is not payment.

import type {
  ChangeProposal, Field, FieldEvidence, IntakeCandidate, ProposalAction, ProposalOp,
} from "../../schema/intake";
import type { Commitment, CommitmentDraft, CommitmentType, Direction, Records } from "../../schema/records";

export type ProposeContext = { storeRevision: number; now: string };

export const TEMP_COMMITMENT = "tmp-commitment";
export const TEMP_PARTY = "tmp-party";

export const normalizeRef = (ref: string): string => ref.toUpperCase().replace(/[^A-Z0-9]/g, "");

const found = <T>(f: Field<T> | undefined): T | undefined => (f && f.state === "found" ? f.value : undefined);
const evidenceOf = <T>(f: Field<T> | undefined): FieldEvidence[] => (f && f.state === "found" ? f.evidence : []);

// Direction implied by the document kind, relative to this business.
function directionOf(c: IntakeCandidate): Direction | undefined {
  if (c.kind === "invoice") return "in";
  if (c.kind === "bill") return "out";
  return c.direction;
}

function typeOf(c: IntakeCandidate): CommitmentType | undefined {
  if (c.kind === "invoice" || c.kind === "bill" || c.kind === "purchase_order") return c.kind;
  return undefined;
}

const commitmentDirection = (c: Commitment): Direction | undefined =>
  c.direction ?? (c.type === "invoice" ? "in" : c.type === "bill" ? "out" : undefined);

// Evidence describing a stored commitment, for showing "ours vs theirs" in a conflict.
function storedEvidence(t: Commitment, value: unknown): FieldEvidence[] {
  return [{ evidenceId: t.evidenceIds?.[0] ?? t.sourceRef.record, text: `${t.sourceRef.system} ${t.sourceRef.record}: ${String(value)}` }];
}

// Sum of linked invoice/bill amounts against a PO. The store-side home for explicit
// allocations is po_invoice_allocations (TECHNICAL_PLAN section 4); until then the
// linked document's amount is the allocation.
export function poAllocated(records: Records, po: Commitment): number {
  const byId = new Map(records.commitments.map((c) => [c.id, c]));
  return (po.linkedCommitmentIds ?? [])
    .map((id) => byId.get(id))
    // Same rule as the engine's coveredByLinked: same-direction invoices/bills that are not cancelled or credited.
    .filter((c): c is Commitment => !!c && (c.type === "invoice" || c.type === "bill") &&
      c.settlement !== "cancelled" && c.settlement !== "credited" &&
      (commitmentDirection(c) ?? "out") === (po.direction ?? "out"))
    .reduce((sum, c) => sum + c.amount, 0);
}

export function poRemaining(records: Records, poId: string): number | undefined {
  const po = records.commitments.find((c) => c.id === poId && c.type === "purchase_order");
  return po ? po.amount - poAllocated(records, po) : undefined;
}

export function propose(candidate: IntakeCandidate, records: Records, ctx: ProposeContext): ChangeProposal {
  const base: ChangeProposal = {
    id: `cp-${candidate.id}-r${candidate.revision}`,
    action: "review",
    ops: [],
    candidateId: candidate.id,
    candidateRevision: candidate.revision,
    expectedStoreRevision: ctx.storeRevision,
    evidenceIds: [...candidate.evidenceIds],
    reasons: [],
    conflicts: [],
    state: "proposed",
    createdAt: ctx.now,
  };
  const review = (reason: string, extra: Partial<ChangeProposal> = {}): ChangeProposal =>
    ({ ...base, action: "review", reasons: [reason], ...extra });
  const out = (action: ProposalAction, extra: Partial<ChangeProposal>): ChangeProposal => ({ ...base, action, ...extra });

  // 0. Nothing to reconcile.
  if (candidate.extraction === "unreadable" || candidate.extraction === "unsupported") {
    return review("The document couldn't be read; upload a text PDF or enter the fields manually.");
  }
  if (candidate.kind === "none") return review("No invoice, bill, PO, or payment found in this source.");
  if (candidate.kind === "conversational_update") {
    return review("Message updates (promises, delays) are handled as signals, not document changes.");
  }

  const f = candidate.fields;
  const reference = found(f.reference);
  const amount = found(f.amount);
  const currency = found(f.currency);
  const direction = directionOf(candidate);

  // 1. Evidence already linked to the same document: link only what's new in the bundle.
  //    One email can describe several invoices, so the reference must agree too.
  const owner = records.commitments.find((c) =>
    c.evidenceIds?.some((id) => candidate.evidenceIds.includes(id)) &&
    (!reference || !c.reference || normalizeRef(c.reference) === normalizeRef(reference)));
  if (owner) {
    const fresh = candidate.evidenceIds.filter((id) => !owner.evidenceIds?.includes(id));
    return out("link", {
      targetCommitmentId: owner.id,
      ops: fresh.length ? [{ op: "linkEvidence", commitmentId: owner.id, evidenceIds: fresh }] : [],
      reasons: ["evidence already linked to this commitment"],
    });
  }

  // 2. Payment evidence: propose a settlement only for one identified commitment.
  if (candidate.kind === "payment_evidence") return proposeSettlement(candidate, records, base);

  const type = typeOf(candidate);
  if (!type || !direction) return review("Document direction is unknown; confirm whether this is money in or out.");

  // 3. Party must be confirmed before matching; similar names are only candidates.
  if (!candidate.partyId) {
    const existing = (candidate.partyCandidates ?? []).filter((p) => p.partyId);
    if (existing.length) {
      return review("Counterparty not confirmed; pick the right party.", {
        reasons: ["Counterparty not confirmed; pick the right party.", ...existing.map((p) => `${p.partyId}: ${p.reason}`)],
      });
    }
    const name = direction === "in" ? found(f.buyerName) : found(f.sellerName);
    if (!name || amount === undefined || !currency) {
      return review("Unknown counterparty and incomplete document; complete the fields to create it.");
    }
    const draft = buildDraft(candidate, type, direction, TEMP_PARTY, amount, currency);
    const ops: ProposalOp[] = [
      { op: "createParty", tempId: TEMP_PARTY, party: { name, kind: direction === "in" ? "customer" : "supplier", tags: [], notes: [] } },
      { op: "createCommitment", tempId: TEMP_COMMITMENT, draft },
    ];
    return review(`New counterparty "${name}"; confirm to create the party and the ${type}.`, { ops });
  }

  const sameParty = records.commitments.filter((c) => c.partyId === candidate.partyId);

  // 4. Reference match within the same party and direction.
  if (reference) {
    const ref = normalizeRef(reference);
    const hits = sameParty.filter((c) =>
      c.type === type && commitmentDirection(c) === direction && c.reference && normalizeRef(c.reference) === ref);
    if (hits.length > 1) {
      return review("Several commitments share this reference; pick one.", {
        matchCandidates: hits.map((c) => ({ commitmentId: c.id, reasons: ["same party, direction, reference"] })),
      });
    }
    const target = hits[0];
    if (target) return reconcileWithTarget(candidate, records, target, base);
  }

  // 5. Same party and amount but no reference match: candidates only.
  if (amount !== undefined) {
    const lookalikes = sameParty.filter((c) =>
      commitmentDirection(c) === direction && c.settlement !== "paid" && c.settlement !== "cancelled" &&
      (c.outstanding ?? c.amount) === amount && (!currency || c.currency === currency));
    if (lookalikes.length) {
      return review("Possible match by amount only; confirm before linking.", {
        matchCandidates: lookalikes.map((c) => ({ commitmentId: c.id, reasons: ["same party and amount; no reference match"] })),
      });
    }
  }

  // 6. New commitment.
  if (amount === undefined || !currency) {
    return review("Amount or currency is missing; enter it before this can affect cash.");
  }
  const draft = buildDraft(candidate, type, direction, candidate.partyId, amount, currency);
  const ops: ProposalOp[] = [{ op: "createCommitment", tempId: TEMP_COMMITMENT, draft }];
  const po = poLink(candidate, records, TEMP_COMMITMENT, amount, currency);
  if (po.conflict) return out("conflict", { conflicts: [po.conflict], reasons: ["PO allocation problem"], targetCommitmentId: po.poId });
  if (po.op) ops.push(po.op);
  return out("create", {
    ops,
    reasons: [reference ? `no existing ${type} ${reference} for this party` : `no reference; new ${type}`, ...(po.op ? [`fulfills PO ${found(f.poReference)}`] : [])],
  });
}

function buildDraft(
  c: IntakeCandidate, type: CommitmentType, direction: Direction, partyId: string, amount: number, currency: string,
): CommitmentDraft {
  const f = c.fields;
  const anchors: Commitment["anchors"] = {};
  const issue = found(f.issueDate);
  const due = found(f.dueDate);
  if (issue) anchors.invoice = issue;
  if (due) anchors.due = due;
  const draft: CommitmentDraft = {
    type, direction, partyId, amount, currency, anchors,
    status: type === "purchase_order" ? "likely" : "committed",
    settlement: "open",
    evidenceIds: [...c.evidenceIds],
  };
  // Only a balance due the document itself states is authoritative. Otherwise leave outstanding unset so the
  // engine derives the remainder from amount minus Settlements (a set value would be counted on top of them).
  const stated = found(f.outstanding);
  if (stated !== undefined) draft.outstanding = stated;
  const reference = found(f.reference);
  if (reference) draft.reference = reference;
  const invoiceUrl = found(f.invoiceUrl);
  const paymentUrl = found(f.paymentUrl);
  if (invoiceUrl) draft.invoiceUrl = invoiceUrl;
  if (paymentUrl) draft.paymentUrl = paymentUrl;
  return draft;
}

function reconcileWithTarget(
  c: IntakeCandidate, records: Records, target: Commitment, base: ChangeProposal,
): ChangeProposal {
  const f = c.fields;
  const amount = found(f.amount);
  const currency = found(f.currency);
  const reasons = ["same party, direction, reference"];
  const conflicts: ChangeProposal["conflicts"] = [];

  if (!currency) {
    return {
      ...base, action: "review", targetCommitmentId: target.id,
      matchCandidates: [{ commitmentId: target.id, reasons: [...reasons, "currency not stated"] }],
      reasons: ["Reference matches but the currency isn't stated; confirm before linking."],
    };
  }
  if (currency !== target.currency) {
    conflicts.push({ field: "currency", values: [
      { value: target.currency, evidence: storedEvidence(target, target.currency) },
      { value: currency, evidence: evidenceOf(f.currency) },
    ] });
  }
  if (amount !== undefined && amount !== target.amount && amount !== target.outstanding) {
    conflicts.push({ field: "amount", values: [
      { value: target.amount, evidence: storedEvidence(target, target.amount) },
      { value: amount, evidence: evidenceOf(f.amount) },
    ] });
  }
  if (conflicts.length) {
    return { ...base, action: "conflict", targetCommitmentId: target.id, conflicts, reasons: [...reasons, "sources disagree; no cash change until resolved"] };
  }

  const ops: ProposalOp[] = [];
  const fresh = c.evidenceIds.filter((id) => !target.evidenceIds?.includes(id));
  if (fresh.length) ops.push({ op: "linkEvidence", commitmentId: target.id, evidenceIds: fresh });
  reasons.push(amount === undefined ? "amount not stated" : "amount consistent", "currency consistent");

  let action: ProposalAction = "link";
  const due = found(f.dueDate);
  if (due && due !== target.anchors.due) {
    ops.push({ op: "updateCommitment", commitmentId: target.id, change: { field: "anchors.due", from: target.anchors.due, to: due }, evidence: evidenceOf(f.dueDate) });
    action = "update";
    reasons.push(`due date differs (${target.anchors.due ?? "none"} -> ${due})`);
  }
  for (const key of ["invoiceUrl", "paymentUrl"] as const) {
    const url = found(f[key]);
    if (url && !target[key]) {
      ops.push({ op: "updateCommitment", commitmentId: target.id, change: { field: key, to: url }, evidence: evidenceOf(f[key]) });
    }
  }

  const po = poLink(c, records, target.id, target.amount, target.currency);
  if (po.conflict) return { ...base, action: "conflict", targetCommitmentId: target.id, conflicts: [po.conflict], reasons: ["PO allocation problem"] };
  if (po.op) ops.push(po.op);

  return { ...base, action, targetCommitmentId: target.id, ops, reasons };
}

// P4.11: link an invoice to its PO when the PO is already a commitment for the same party.
function poLink(
  c: IntakeCandidate, records: Records, invoiceId: string, amount: number, currency: string,
): { op?: ProposalOp; conflict?: ChangeProposal["conflicts"][number]; poId?: string } {
  const poRef = found(c.fields.poReference);
  if (!poRef || !c.partyId) return {};
  const ref = normalizeRef(poRef);
  const direction = directionOf(c);
  const po = records.commitments.find((x) =>
    x.type === "purchase_order" && x.partyId === c.partyId && x.reference && normalizeRef(x.reference) === ref &&
    (!x.direction || x.direction === direction));
  if (!po) return {};
  if (po.linkedCommitmentIds?.includes(invoiceId)) return {};
  const evidence = evidenceOf(c.fields.poReference);
  if (po.currency !== currency) {
    return { poId: po.id, conflict: { field: "poCurrency", values: [
      { value: po.currency, evidence: storedEvidence(po, po.currency) }, { value: currency, evidence },
    ] } };
  }
  const allocated = poAllocated(records, po);
  if (allocated + amount > po.amount) {
    return { poId: po.id, conflict: { field: "poAllocation", values: [
      { value: po.amount - allocated, evidence: storedEvidence(po, `remaining ${po.amount - allocated}`) },
      { value: amount, evidence: evidenceOf(c.fields.amount) },
    ] } };
  }
  return { poId: po.id, op: { op: "linkCommitments", fromId: invoiceId, toId: po.id, allocated: amount } };
}

function proposeSettlement(c: IntakeCandidate, records: Records, base: ChangeProposal): ChangeProposal {
  const f = c.fields;
  const paid = found(f.paidAmount);
  const date = found(f.paidDate);
  const refs = found(f.coversReferences) ?? [];
  const currency = found(f.currency);
  if (paid === undefined || !date || !currency || refs.length !== 1 || !c.partyId) {
    return { ...base, action: "review", reasons: ["Payment evidence needs one invoice reference, amount, currency, date, and a confirmed party."] };
  }
  const ref = normalizeRef(refs[0]!);
  const hits = records.commitments.filter((x) => x.partyId === c.partyId && x.reference && normalizeRef(x.reference) === ref);
  const target = hits[0];
  if (hits.length !== 1 || !target || target.currency !== currency) {
    return { ...base, action: "review", reasons: [`No single ${currency} commitment ${refs[0]} for this party.`] };
  }
  const ops: ProposalOp[] = [{
    op: "createSettlement",
    settlement: { commitmentId: target.id, partyId: c.partyId, amount: paid, currency, date, sourceRef: { system: "intake", record: c.evidenceIds[0] ?? c.id } },
  }];
  const fresh = c.evidenceIds.filter((id) => !target.evidenceIds?.includes(id));
  if (fresh.length) ops.push({ op: "linkEvidence", commitmentId: target.id, evidenceIds: fresh });
  return { ...base, action: "update", targetCommitmentId: target.id, ops, reasons: ["payment evidence names this commitment; confirm to record the payment"] };
}
