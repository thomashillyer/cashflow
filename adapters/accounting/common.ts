// Provider-neutral accounting import: invoices, bills, and payments from any books system become
// parties, commitments, settlements, evidence, and diagnostics. Providers (Zoho, QuickBooks, Xero)
// only fetch and map their fields into AccountingDoc / AccountingPayment; every rule that matters
// lives here once: a missing total is never zero, drafts and voids add no cash, an edited record
// supersedes by payload hash, and a repeat pull changes nothing.

import type { Commitment, Evidence, Party, Settlement } from "../../schema/records";
import { minorUnitDigits } from "../../ai/normalize";
import { summarize, type ImportDiagnostics, type RowError } from "../core/diagnostics";
import { sha256Hex } from "../core/hash";
import { recordEvidenceId, segment } from "../core/ids";

export type DocKind = "invoice" | "bill";
export type DocStatus = "draft" | "open" | "partial" | "paid" | "void";

export type AccountingDoc = {
  kind: DocKind;
  providerId?: string;
  number?: string;
  partyId?: string;
  partyName?: string;
  currency?: string;
  total?: unknown;                 // decimal in document currency; validated here
  balance?: unknown;
  issued?: string;                 // YYYY-MM-DD
  due?: string;
  status: DocStatus;
  url?: string;
  raw: unknown;                    // the provider payload; hashed for change detection
  sheet: string;                   // label for diagnostics ("invoices")
  row: number;                     // 1-based position in the provider's list
};

export type AccountingPayment = {
  providerId: string;
  date: string;                    // YYYY-MM-DD, actual paid date
  kind?: DocKind;                  // which side, when the payment applied to nothing
  amount?: unknown;                // the payment's full amount, when the provider states it
  unapplied?: unknown;             // the provider's own "unapplied/unused amount": preferred over subtracting
  appliedKnown?: boolean;          // true only when `applied` is the complete list (the detail was read)
  currency?: string;
  partyId?: string;
  partyName?: string;
  applied: { kind: DocKind; docProviderId?: string; docNumber?: string; amount: unknown }[];
};

export type AccountingBuildInput = {
  system: "zoho_books" | "quickbooks" | "xero";   // SourceRef.system and Evidence.channel
  docs: AccountingDoc[];
  payments: AccountingPayment[];
  now: string;
  warnings?: string[];
  existingEvidence?: Evidence[];
};

// Money that left or arrived but is not applied to any document yet (a vendor advance, an unapplied
// customer payment). It is proof of a payment, never a guess at which invoice it settles: matching
// it to a PO or invoice is a proposal for the owner.
export type UnallocatedPayment = {
  id: string;
  system: AccountingBuildInput["system"];
  providerId: string;
  direction: "in" | "out";
  date: string;
  amount: number;                  // minor units, the part not applied to any document
  currency: string;
  partyId?: string;
  partyName?: string;
};

export type AccountingImport = {
  parties: Party[];
  commitments: Commitment[];
  settlements: Settlement[];
  evidence: Evidence[];
  paymentHistory: { partyId: string; invoiceId: string; due: string; paid: string }[];
  unallocatedPayments: UnallocatedPayment[];
  diagnostics: ImportDiagnostics;
};

export const isoDate = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/);
  return m?.[1];
};
export const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

// Decimals in the document currency. Missing or non-numeric is undefined, never 0.
export function toMinor(v: unknown, currency: string): number | undefined {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) n = Number(v.trim());
  else return undefined;   // blank, array, boolean, hex, exponent: missing, never 0
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 10 ** minorUnitDigits(currency));
}

const LABEL = { invoice: "invoice", bill: "bill" } as const;
const PREFIX = { invoice: "inv", bill: "bill" } as const;

function settlementState(status: DocStatus, outstanding: number, amount: number): Commitment["settlement"] {
  if (status === "paid") return "paid";
  if (status === "void") return "cancelled";
  if (status === "partial") return "partial";
  return outstanding <= 0 ? "paid" : outstanding < amount ? "partial" : "open";
}

// What a change means to cash. Derived display fields in the provider payload ("overdue by 3 days")
// are left out so an untouched record is not reported as edited on every pull.
const fingerprint = (d: AccountingDoc) => ({
  kind: d.kind, number: d.number, party: d.partyId, currency: d.currency, total: d.total, balance: d.balance,
  status: d.status, issued: d.issued, due: d.due,
});

export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

export function buildAccounting(input: AccountingBuildInput): AccountingImport {
  const { system } = input;
  const parties = new Map<string, Party>();
  const commitments: Commitment[] = [];
  const evidence: Evidence[] = [];
  const errors: RowError[] = [];
  const warnings = [...(input.warnings ?? [])];
  const byProviderId = new Map<string, Commitment>();
  let skippedDrafts = 0;
  // A document number is the issuer's own reference and can repeat (two suppliers both send "1001").
  // Every document sharing a number gets the provider id in its id, so none overwrites another.
  const numberUses = new Map<string, number>();
  for (const d of input.docs) if (d.number) numberUses.set(`${d.kind}:${d.number}`, (numberUses.get(`${d.kind}:${d.number}`) ?? 0) + 1);

  for (const d of input.docs) {
    const label = LABEL[d.kind];
    const fail = (code: RowError["code"], message: string, nextStep: string) => { errors.push({ row: d.row, sheet: d.sheet, code, message, nextStep }); };
    const { providerId: zid, number } = d;
    if (!zid || !number) { fail("missing_reference", `A ${label} has no ${label} number, so it was skipped.`, `Give it a number in the source system and import again, or add it by hand.`); continue; }
    if (d.status === "draft") { skippedDrafts++; continue; }
    if (!d.currency) { fail("invalid_currency", `${label} ${number} has no currency, so it was skipped.`, "Set its currency in the source system and import again."); continue; }
    const amount = toMinor(d.total, d.currency);
    if (amount === undefined) { fail("missing_amount", `${label} ${number} has no readable total, so it was skipped and adds no cash.`, "Check the total in the source system and import again."); continue; }
    const balance = toMinor(d.balance, d.currency);
    const outstanding = balance ?? (d.status === "paid" ? 0 : undefined);
    if (!d.due) fail("missing_date", `${label} ${number} has no due date; it was imported but cannot be placed on the forecast yet.`, "Enter the due date on the Review screen.");

    let partyId: string | undefined;
    if (d.partyId && d.partyName) {
      partyId = `party-${system}-${segment(d.partyId)}`;
      if (!parties.has(partyId)) parties.set(partyId, { id: partyId, name: d.partyName, kind: d.kind === "invoice" ? "customer" : "supplier", tags: [], notes: [], sourceRefs: [{ system, record: d.partyId }] });
    }
    const shared = (numberUses.get(`${d.kind}:${number}`) ?? 0) > 1;
    const commitment: Commitment = {
      id: `${PREFIX[d.kind]}-${segment(number)}${shared ? `~${sha256Hex(zid).slice(0, 12)}` : ""}`, type: d.kind, direction: d.kind === "invoice" ? "in" : "out", reference: number,
      ...(partyId ? { partyId } : {}),
      amount, currency: d.currency,
      anchors: { ...(d.issued ? { invoice: d.issued } : {}), ...(d.due ? { due: d.due } : {}) },
      status: "committed",
      ...(outstanding !== undefined ? { outstanding } : {}),
      settlement: settlementState(d.status, outstanding ?? amount, amount),
      ...(d.url && d.kind === "invoice" ? { invoiceUrl: d.url } : {}),
      sourceRef: { system, record: zid },
    };
    const ev: Evidence = {
      id: recordEvidenceId(system, `${d.kind}-${zid}`), channel: system, format: "api", receivedAt: input.now,
      // Canonical payload hash: an unchanged record is a repeat, an edited one supersedes.
      fileHash: sha256Hex(JSON.stringify(sortKeys(fingerprint(d)))), extraction: "ok",
      sourceRef: { system, record: `${d.kind}:${zid}`, ...(d.url ? { url: d.url } : {}) },
    };
    commitment.evidenceIds = [ev.id];
    commitments.push(commitment);
    evidence.push(ev);
    byProviderId.set(`${d.kind}:${zid}`, commitment);
    if (!shared) byProviderId.set(`${d.kind}:${number}`, commitment);
  }
  const dupes = [...numberUses.values()].filter((n) => n > 1).length;
  if (dupes) warnings.push(`${dupes} document number${dupes === 1 ? " is" : "s are"} used more than once; each was kept as its own record. Check them on the Review screen.`);
  if (skippedDrafts) warnings.push(`${skippedDrafts} draft document${skippedDrafts === 1 ? "" : "s"} skipped; drafts are not owed yet.`);

  const settlements: Settlement[] = [];
  const unallocatedPayments: UnallocatedPayment[] = [];
  const history = new Map<string, AccountingImport["paymentHistory"][number]>();   // one row per invoice: the date it was fully paid
  for (const p of input.payments) {
    // Whatever a payment did not apply to a document stays visible as an unallocated payment. Only from
    // the provider's own unapplied amount, or from a complete applied list in one currency: never
    // inferred from a failed read, an unparseable line, or a mix of currencies.
    if (p.currency) {
      const kind = p.applied[0]?.kind ?? p.kind;
      let left: number | undefined;
      if (p.unapplied !== undefined) {
        left = toMinor(p.unapplied, p.currency);
      } else if (p.amount !== undefined && p.appliedKnown) {
        const total = toMinor(p.amount, p.currency);
        const parts = p.applied.map((a) => toMinor(a.amount, p.currency!));
        const mixed = p.applied.some((a) => {
          const t = byProviderId.get(`${a.kind}:${a.docProviderId ?? ""}`) ?? byProviderId.get(`${a.kind}:${a.docNumber ?? ""}`);
          return t !== undefined && t.currency !== p.currency;
        });
        if (total !== undefined && !mixed && parts.every((x): x is number => x !== undefined)) left = total - parts.reduce((n, x) => n + x, 0);
      }
      if (left !== undefined && left > 0 && kind) {
        unallocatedPayments.push({
          id: `unalloc-${system}-${segment(p.providerId)}`, system, providerId: p.providerId, direction: kind === "invoice" ? "in" : "out",
          date: p.date, amount: left, currency: p.currency,
          ...(p.partyId ? { partyId: `party-${system}-${segment(p.partyId)}` } : {}), ...(p.partyName ? { partyName: p.partyName } : {}),
        });
      }
    }
    for (const a of p.applied) {
      const target = byProviderId.get(`${a.kind}:${a.docProviderId ?? ""}`) ?? byProviderId.get(`${a.kind}:${a.docNumber ?? ""}`);
      if (!target) continue;
      const amt = toMinor(a.amount, target.currency);
      if (amt === undefined || amt <= 0) continue;
      settlements.push({
        id: `set-${system}-${segment(p.providerId)}-${target.id}`, commitmentId: target.id, ...(target.partyId ? { partyId: target.partyId } : {}),
        amount: amt, currency: target.currency, date: p.date, sourceRef: { system, record: p.providerId },
      });
      if (a.kind === "invoice" && target.partyId && target.anchors.due && target.settlement === "paid") {
        const prev = history.get(target.id);
        if (!prev || p.date > prev.paid) history.set(target.id, { partyId: target.partyId, invoiceId: target.id, due: target.anchors.due, paid: p.date });
      }
    }
  }

  const paymentHistory = [...history.values()];
  const key = (e: Evidence) => `${e.sourceRef.system}|${e.sourceRef.record}|${e.fileHash ?? ""}`;
  const existing = new Set((input.existingEvidence ?? []).map(key));
  const rowsDuplicate = evidence.filter((e) => existing.has(key(e))).length;
  const diagnostics = summarize({
    evidenceId: system, source: system, startedAt: input.now, rowsRead: input.docs.length,
    rowsImported: commitments.length - rowsDuplicate, rowsDuplicate, errors, warnings, syncedAt: input.now,
  });
  return { parties: [...parties.values()], commitments, settlements, evidence, paymentHistory, unallocatedPayments, diagnostics };
}
