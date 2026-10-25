// Zoho Books connector: invoices, bills, contacts-as-parties, and payments -> shared records.
// Read-only. Output is an import preview (see docs/design/04-adapters.md): the coordinator decides
// what is stored, and the engine, not this module, creates future cash events. Owner overrides are
// separate records this module never emits, so a refresh cannot erase them.

import type { Commitment, Evidence, Party, Settlement } from "../../schema/records";
import { minorUnitDigits } from "../../ai/normalize";
import { ConnectorFailure, type Fetch, type PullResult, type TokenProvider } from "../connector";
import { summarize, type ImportDiagnostics, type RowError } from "../core/diagnostics";
import { sha256Hex } from "../core/hash";
import { recordEvidenceId, segment } from "../core/ids";
import { ZohoClient, type ZohoRecord, type ZohoRegion } from "./client";

export type ZohoPullInput = {
  region: ZohoRegion;
  token: TokenProvider;
  now: string;                       // ISO instant; the clock is passed in
  organizationId?: string;
  fetch?: Fetch;
  existingEvidence?: Evidence[];     // to report repeats; the store still upserts by sourceRef
};

export type ZohoPull = {
  parties: Party[];
  commitments: Commitment[];
  settlements: Settlement[];
  evidence: Evidence[];
  paymentHistory: { partyId: string; invoiceId: string; due: string; paid: string }[];
  diagnostics: ImportDiagnostics;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const isoDate = (v: unknown): string | undefined => { const s = str(v); return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined; };

// Zoho sends decimals in the document currency. Missing or non-numeric is undefined, never 0.
export function toMinor(v: unknown, currency: string): number | undefined {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 10 ** minorUnitDigits(currency));
}

const SPEC = {
  invoice: { path: "invoices", key: "invoices", idKey: "invoice_id", numKey: "invoice_number", partyIdKey: "customer_id", partyNameKey: "customer_name", direction: "in" as const, prefix: "inv", partyKind: "customer" as const, label: "invoice" },
  bill: { path: "bills", key: "bills", idKey: "bill_id", numKey: "bill_number", partyIdKey: "vendor_id", partyNameKey: "vendor_name", direction: "out" as const, prefix: "bill", partyKind: "supplier" as const, label: "bill" },
};

function settlementState(status: string | undefined, outstanding: number, amount: number): Commitment["settlement"] {
  switch (status) {
    case "paid": return "paid";
    case "void": case "write_off": return "cancelled";
    case "partially_paid": return "partial";
    default: return outstanding <= 0 ? "paid" : outstanding < amount ? "partial" : "open";
  }
}

export async function pullZoho(input: ZohoPullInput): Promise<PullResult<ZohoPull>> {
  try {
    return { ok: true, data: await pull(input) };
  } catch (err) {
    if (err instanceof ConnectorFailure) return { ok: false, error: err.error };
    return { ok: false, error: { kind: "unsupported", message: "Something in the Zoho Books data could not be read.", nextStep: "Upload an export from Zoho Books instead.", fallback: "file" } };
  }
}

async function pull(input: ZohoPullInput): Promise<ZohoPull> {
  const client = new ZohoClient({ region: input.region, token: input.token, ...(input.fetch ? { fetch: input.fetch } : {}), ...(input.organizationId ? { organizationId: input.organizationId } : {}) });
  const parties = new Map<string, Party>();
  const commitments: Commitment[] = [];
  const evidence: Evidence[] = [];
  const errors: RowError[] = [];
  const warnings: string[] = [];
  const byZohoId = new Map<string, Commitment>();   // `${kind}:${zoho id}` and `${kind}:${number}`
  let rowsRead = 0;
  let skippedDrafts = 0;

  for (const kind of ["invoice", "bill"] as const) {
    const s = SPEC[kind];
    const { records, truncated } = await client.list(s.path, s.key);
    if (truncated) warnings.push(`Only the first ${records.length} ${s.label}s were read; import older ones from an export.`);
    records.forEach((rec, i) => {
      rowsRead++;
      const row = i + 1;
      const fail = (code: RowError["code"], message: string, nextStep: string) => { errors.push({ row, sheet: s.path, code, message, nextStep }); };
      const zid = str(rec[s.idKey]);
      const number = str(rec[s.numKey]);
      const status = str(rec.status);
      if (!zid || !number) return fail("missing_reference", `A ${s.label} has no ${s.label} number in Zoho Books, so it was skipped.`, "Give it a number in Zoho Books and import again, or add it by hand.");
      if (status === "draft") { skippedDrafts++; return; }
      const currency = str(rec.currency_code);
      if (!currency) return fail("invalid_currency", `${s.label} ${number} has no currency, so it was skipped.`, "Set its currency in Zoho Books and import again.");
      const amount = toMinor(rec.total, currency);
      if (amount === undefined) return fail("missing_amount", `${s.label} ${number} has no readable total, so it was skipped and adds no cash.`, "Check the total in Zoho Books and import again.");
      const balance = toMinor(rec.balance, currency);
      const outstanding = balance ?? (status === "paid" ? 0 : undefined);
      const due = isoDate(rec.due_date);
      const issued = isoDate(rec.date);
      if (!due) fail("missing_date", `${s.label} ${number} has no due date; it was imported but cannot be placed on the forecast yet.`, "Enter the due date on the Review screen.");

      const partyZid = str(rec[s.partyIdKey]);
      const partyName = str(rec[s.partyNameKey]);
      let partyId: string | undefined;
      if (partyZid && partyName) {
        partyId = `party-zoho-${segment(partyZid)}`;
        if (!parties.has(partyId)) parties.set(partyId, { id: partyId, name: partyName, kind: s.partyKind, tags: [], notes: [], sourceRefs: [{ system: "zoho_books", record: partyZid }] });
      }
      const url = str(rec.invoice_url);
      const commitment: Commitment = {
        id: `${s.prefix}-${segment(number)}`, type: kind, direction: s.direction, reference: number,
        ...(partyId ? { partyId } : {}),
        amount, currency,
        anchors: { ...(issued ? { invoice: issued } : {}), ...(due ? { due } : {}) },
        status: "committed",
        ...(outstanding !== undefined ? { outstanding } : {}),
        settlement: settlementState(status, outstanding ?? amount, amount),
        ...(url && kind === "invoice" ? { invoiceUrl: url } : {}),
        sourceRef: { system: "zoho_books", record: zid },
      };
      const ev: Evidence = {
        id: recordEvidenceId("zoho_books", `${kind}-${zid}`), channel: "zoho_books", format: "api", receivedAt: input.now,
        // Canonical payload hash: an unchanged record is a repeat, an edited one supersedes.
        fileHash: sha256Hex(JSON.stringify(sortKeys(rec))), extraction: "ok",
        sourceRef: { system: "zoho_books", record: zid, ...(url ? { url } : {}) },
      };
      commitment.evidenceIds = [ev.id];
      commitments.push(commitment);
      evidence.push(ev);
      byZohoId.set(`${kind}:${zid}`, commitment);
      byZohoId.set(`${kind}:${number}`, commitment);
    });
  }
  if (skippedDrafts) warnings.push(`${skippedDrafts} draft document${skippedDrafts === 1 ? "" : "s"} skipped; drafts are not owed yet.`);

  const settlements: Settlement[] = [];
  const paymentHistory: ZohoPull["paymentHistory"] = [];
  for (const kind of ["invoice", "bill"] as const) {
    const isIn = kind === "invoice";
    const path = isIn ? "customerpayments" : "vendorpayments";
    const appliedKey = isIn ? "invoices" : "bills";
    const { records } = await client.list(path, path);
    for (const pay of records) {
      const payId = str(pay.payment_id);
      const date = isoDate(pay.date);
      if (!payId || !date) continue;
      // The list names invoices; the detail says how much went to each.
      const detail = await client.detail(path, payId, "payment");
      const applied = Array.isArray(detail?.[appliedKey]) ? (detail![appliedKey] as ZohoRecord[]) : [];
      for (const a of applied) {
        const target = byZohoId.get(`${kind}:${str(a[isIn ? "invoice_id" : "bill_id"]) ?? ""}`) ?? byZohoId.get(`${kind}:${str(a[isIn ? "invoice_number" : "bill_number"]) ?? ""}`);
        if (!target) continue;
        const amt = toMinor(a.amount_applied, target.currency);
        if (amt === undefined || amt <= 0) continue;
        settlements.push({
          id: `set-zoho-${segment(payId)}-${target.id}`, commitmentId: target.id, ...(target.partyId ? { partyId: target.partyId } : {}),
          amount: amt, currency: target.currency, date, sourceRef: { system: "zoho_books", record: payId },
        });
        if (isIn && target.partyId && target.anchors.due && target.settlement === "paid") {
          paymentHistory.push({ partyId: target.partyId, invoiceId: target.id, due: target.anchors.due, paid: date });
        }
      }
    }
  }

  const key = (e: Evidence) => `${e.sourceRef.system}|${e.sourceRef.record}|${e.fileHash ?? ""}`;
  const existing = new Set((input.existingEvidence ?? []).map(key));
  const rowsDuplicate = evidence.filter((e) => existing.has(key(e))).length;
  const diagnostics = summarize({
    evidenceId: "zoho_books", source: "zoho_books", startedAt: input.now, rowsRead,
    rowsImported: commitments.length - rowsDuplicate, rowsDuplicate, errors, warnings, syncedAt: input.now,
  });
  return { parties: [...parties.values()], commitments, settlements, evidence, paymentHistory, diagnostics };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}
