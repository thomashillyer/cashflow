// Zoho CRM connector: open deals -> `sales_deal` commitments (future inflows before an invoice exists).
// Read-only. A deal's certainty comes from the business's own mapping (profile.crm) or, without one, from
// the CRM's own per-stage probability: committed at 100%, likely above the profile's cut, possible (weighted)
// below it, lost at 0. Cash timing is not decided here: the engine turns a sales_deal into legs with the
// profile's payment pattern. A missing amount is a visible error, never zero.
//
// Double-count guard: a deal that already has an invoice in the books must map to "skip" (for example
// Delivered), or the same money is counted as a deal and as an invoice. That is a per-business stage rule.

import type { Commitment, Evidence, Party, Status } from "../../schema/records";
import type { CrmMapping } from "../../schema/profile";
import { ConnectorFailure, type Fetch, type PullResult, type TokenProvider } from "../connector";
import { isoDate, sortKeys, str, toMinor } from "../accounting/common";
import { summarize, type ImportDiagnostics, type RowError } from "../core/diagnostics";
import { sha256Hex } from "../core/hash";
import { recordEvidenceId, segment } from "../core/ids";
import type { ZohoRegion } from "../zoho_books/client";
import { ZohoCrmClient } from "./client";

export type ZohoCrmPullInput = {
  region: ZohoRegion;
  token: TokenProvider;
  now: string;
  mapping?: CrmMapping;
  fetch?: Fetch;
  existingEvidence?: Evidence[];
};

export type ZohoCrmPull = {
  parties: Party[];
  commitments: Commitment[];
  evidence: Evidence[];
  skipped: { dealId: string; stage: string; reason: string }[];
  diagnostics: ImportDiagnostics;
};

const FIELDS = { name: "Deal_Name", stage: "Stage", amount: "Amount", currency: "Currency", closeDate: "Closing_Date", account: "Account_Name", probability: "Probability" } as const;

// Zoho CRM sends a lookup as { name, id }.
const lookup = (v: unknown): { id?: string; name?: string } =>
  typeof v === "object" && v !== null ? { ...(str((v as { id?: unknown }).id) ? { id: str((v as { id?: unknown }).id)! } : {}), ...(str((v as { name?: unknown }).name) ? { name: str((v as { name?: unknown }).name)! } : {}) } : {};

export async function pullZohoCrm(input: ZohoCrmPullInput): Promise<PullResult<ZohoCrmPull>> {
  try {
    return { ok: true, data: await pull(input) };
  } catch (err) {
    if (err instanceof ConnectorFailure) return { ok: false, error: err.error };
    return { ok: false, error: { kind: "unsupported", message: "Something in the CRM data could not be read.", nextStep: "Upload a CRM export instead.", fallback: "file" } };
  }
}

async function pull(input: ZohoCrmPullInput): Promise<ZohoCrmPull> {
  const m = input.mapping ?? {};
  const f = { ...FIELDS, ...(m.fields ?? {}) };
  const module = m.module ?? "Deals";
  const committedAt = m.probabilityStatus?.committedAt ?? 1;
  const likelyAt = m.probabilityStatus?.likelyAt ?? 0.6;
  const RULES = ["skip", "committed", "likely", "possible"];
  for (const [stage, rule] of Object.entries(m.stageStatus ?? {})) {
    if (!RULES.includes(rule as string)) {
      throw new ConnectorFailure({ kind: "config", message: `The CRM mapping for stage "${stage}" is not valid.`, nextStep: "Use skip, committed, likely or possible for each stage in the profile's CRM mapping, or upload a CRM export instead.", fallback: "file" });
    }
  }
  const client = new ZohoCrmClient({ region: input.region, token: input.token, ...(input.fetch ? { fetch: input.fetch } : {}) });
  const { records, truncated } = await client.records(module, [f.name, f.stage, f.amount, f.currency, f.closeDate, f.account, f.probability, "Modified_Time"]);

  const parties = new Map<string, Party>();
  const commitments: Commitment[] = [];
  const evidence: Evidence[] = [];
  const skipped: ZohoCrmPull["skipped"] = [];
  const rawStageOf = new Map<string, string>();   // deal id -> stage, to tell a stage rule from the probability path
  const errors: RowError[] = [];
  const warnings: string[] = [];
  if (truncated) warnings.push(`Only the newest ${records.length} deals were read; older ones were left out.`);

  records.forEach((rec, i) => {
    const row = i + 1;
    const fail = (code: RowError["code"], message: string, nextStep: string) => { errors.push({ row, sheet: module, code, message, nextStep }); };
    const id = str(rec.id);
    const name = str(rec[f.name]);
    const stage = str(rec[f.stage]) ?? "";
    if (!id) return fail("missing_reference", "A deal has no id in the CRM, so it was skipped.", "Open the deal in the CRM and save it again, or add it by hand.");

    // Certainty: the business's stage rule first, then the CRM's own probability. Never invented.
    const raw = rec[f.probability];
    const p = typeof raw === "number" ? raw / 100 : typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) / 100 : undefined;
    const rule = m.stageStatus && Object.hasOwn(m.stageStatus, stage) ? m.stageStatus[stage] : undefined;   // own keys only: a stage named "constructor" is not a rule
    let status: Status | undefined;
    let probability: number | undefined;
    if (rule === "skip") { skipped.push({ dealId: id, stage, reason: "stage is mapped to skip (already in the books, or lost)" }); return; }
    if (rule) { status = rule; probability = p; }
    else if (p === undefined) { return fail("unsupported", `Deal "${name ?? id}" has no probability and its stage "${stage}" is not mapped, so it was skipped.`, "Map this stage in the CRM settings of your Neri profile, or set a probability on the deal."); }
    else if (p <= 0) { skipped.push({ dealId: id, stage, reason: "probability 0 (lost)" }); return; }
    else { status = p >= committedAt ? "committed" : p >= likelyAt ? "likely" : "possible"; probability = p; }
    if (status === "possible" && probability === undefined) { return fail("unsupported", `Deal "${name ?? id}" is a possible deal but has no probability, so it was skipped.`, "Set a probability on the deal in the CRM."); }

    const currency = str(rec[f.currency]) ?? m.defaultCurrency;
    if (!currency) return fail("invalid_currency", `Deal "${name ?? id}" has no currency, so it was skipped.`, "Set the currency on the deal in the CRM.");
    const amount = toMinor(rec[f.amount], currency);
    if (amount === undefined) return fail("missing_amount", `Deal "${name ?? id}" has no amount, so it was skipped and adds no cash.`, "Enter the deal amount in the CRM and import again.");
    const close = isoDate(rec[f.closeDate]);
    if (!close) fail("missing_date", `Deal "${name ?? id}" has no closing date; it was imported but cannot be placed on the forecast yet.`, "Enter the closing date on the Review screen.");

    rawStageOf.set(id, stage);
    const acct = lookup(rec[f.account]);
    let partyId: string | undefined;
    if (acct.id && acct.name) {
      partyId = `party-crm-${segment(acct.id)}`;
      if (!parties.has(partyId)) parties.set(partyId, { id: partyId, name: acct.name, kind: "customer", tags: [], notes: [], sourceRefs: [{ system: "crm", record: acct.id }] });
    }
    const ev: Evidence = {
      id: recordEvidenceId("crm", `deal-${id}`), channel: "crm", format: "api", receivedAt: input.now, extraction: "ok",
      // Fingerprint of what matters to cash: a changed stage, amount or date supersedes; an untouched deal is a repeat.
      fileHash: sha256Hex(JSON.stringify(sortKeys({ name, stage, amount, currency, close, p, account: acct.id }))),
      sourceRef: { system: "crm", record: `deal:${id}` },
    };
    commitments.push({
      id: `deal-${segment(id)}`, type: "sales_deal", direction: "in", ...(name ? { reference: name } : {}),
      ...(partyId ? { partyId } : {}), amount, currency, anchors: close ? { order: close } : {},
      status, ...(probability !== undefined && status !== "committed" ? { probability } : {}),
      settlement: "open", evidenceIds: [ev.id], sourceRef: { system: "crm", record: id },
    });
    evidence.push(ev);
  });

  // A deal committed only because the CRM says 100% may already be invoiced in the books.
  const byProbability = commitments.filter((c) => c.status === "committed" && !(m.stageStatus && Object.hasOwn(m.stageStatus, rawStageOf.get(c.sourceRef.record) ?? ""))).length;
  if (byProbability) warnings.push(`${byProbability} deal${byProbability === 1 ? " is" : "s are"} committed because the CRM says 100%. If ${byProbability === 1 ? "it is" : "they are"} already invoiced in your books, map that stage to "skip" in the profile's CRM mapping or the money is counted twice.`);
  // An open deal whose closing date is already past is probably stale (or already invoiced): the engine would
  // place its cash in the past. Say so; do not change the date.
  const today = input.now.slice(0, 10);
  const stale = commitments.filter((c) => c.anchors.order !== undefined && c.anchors.order < today).length;
  if (stale) warnings.push(`${stale} open deal${stale === 1 ? " has" : "s have"} a closing date in the past. Check ${stale === 1 ? "it is" : "they are"} still open, or already invoiced (map that stage to "skip" in the profile).`);
  if (skipped.length) {
    const byStage: Record<string, number> = {};
    for (const s of skipped) byStage[s.stage || "(no stage)"] = (byStage[s.stage || "(no stage)"] ?? 0) + 1;
    warnings.push(`${skipped.length} deal${skipped.length === 1 ? "" : "s"} left out (${Object.entries(byStage).map(([k, v]) => `${k}: ${v}`).join(", ")}): already in the books, or lost.`);
  }
  const key = (e: Evidence) => `${e.sourceRef.system}|${e.sourceRef.record}|${e.fileHash ?? ""}`;
  const existing = new Set((input.existingEvidence ?? []).map(key));
  const rowsDuplicate = evidence.filter((e) => existing.has(key(e))).length;
  return {
    parties: [...parties.values()], commitments, evidence, skipped,
    diagnostics: summarize({
      evidenceId: "zoho_crm", source: "crm", startedAt: input.now, rowsRead: records.length - skipped.length,   // a deal left out on purpose is not an import problem
      rowsImported: commitments.length - rowsDuplicate, rowsDuplicate, errors, warnings, syncedAt: input.now,
    }),
  };
}
