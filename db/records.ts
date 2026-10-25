// Typed repository over the shared records. Upserts are idempotent on (business_id, id).

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BalanceSnapshot, CashEvent, Commitment, Evidence, Party, Records, Rule, Settlement, Signal,
} from "../schema/records";
import type { ChangeProposal, ConfirmationResult, IntakeCandidate } from "../schema/intake";
import { TABLES, fromRow, toRow, type Row } from "./rows";

// Errors raised by the SQL functions: the message is the code name and the SQLSTATE is
// PT<http status>, which PostgREST turns into that HTTP status (see the migration).
export type StoreErrorCode =
  | "STALE_REVIEW" | "IDEMPOTENCY_CONFLICT" | "PROPOSAL_NOT_PENDING" | "PROPOSAL_UNRESOLVED"
  | "NOT_FOUND" | "NOT_IMPLEMENTED" | "INVALID_ARGUMENT" | "FORBIDDEN";

const STORE_ERROR_CODES: ReadonlySet<string> = new Set<StoreErrorCode>([
  "STALE_REVIEW", "IDEMPOTENCY_CONFLICT", "PROPOSAL_NOT_PENDING", "PROPOSAL_UNRESOLVED",
  "NOT_FOUND", "NOT_IMPLEMENTED", "INVALID_ARGUMENT", "FORBIDDEN",
]);

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode | "DB_ERROR",
    readonly status: number,  // HTTP status the API should return: 409, 404, 501, ...
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export function toStoreError(context: string, error: { message: string; code?: string }): StoreError {
  const sqlState = /^PT(\d{3})$/.exec(error.code ?? "");
  const known = STORE_ERROR_CODES.has(error.message);
  const status = sqlState ? Number(sqlState[1]) : 500;
  return new StoreError(known ? (error.message as StoreErrorCode) : "DB_ERROR", status, `${context}: ${error.message}`);
}

async function upsert<T extends { id: string }>(
  db: SupabaseClient, table: string, businessId: string, records: T[],
): Promise<void> {
  if (records.length === 0) return;
  // defaultToNull: false makes columns a row omits take their DEFAULT instead of null.
  const { error } = await db
    .from(table)
    .upsert(records.map((r) => toRow(r, businessId)), { onConflict: "business_id,id", defaultToNull: false });
  if (error) throw new Error(`upsert ${table}: ${error.message}`);
}

export type LoadedRecords = { records: Records; storeRevision: number };

// One consistent snapshot through the load_records RPC: every collection plus the business
// revision from the same transaction, with no PostgREST row limit. Pass storeRevision as the
// expected revision when confirming a proposal built from these records.
export async function loadRecords(db: SupabaseClient, businessId: string): Promise<LoadedRecords> {
  const { data, error } = await db.rpc("load_records", { p_business_id: businessId });
  if (error) throw toStoreError(`load records ${businessId}`, error);
  const snapshot = data as { storeRevision: number; records: Record<keyof Records, Row[]> };
  const read = <T>(key: keyof Records) =>
    (snapshot.records[key] ?? []).map((r) => fromRow<T>(r, TABLES[key]));
  return {
    storeRevision: Number(snapshot.storeRevision),
    records: {
      parties: read<Party>("parties"),
      commitments: read<Commitment>("commitments"),
      events: read<CashEvent>("events"),
      signals: read<Signal>("signals"),
      rules: read<Rule>("rules"),
      settlements: read<Settlement>("settlements"),
      balances: read<BalanceSnapshot>("balances"),
      evidence: read<Evidence>("evidence"),
    },
  };
}

// Service-role only: create (or update) a business. is_synthetic must be passed explicitly;
// only synthetic businesses are visible to the anon key.
export async function upsertBusiness(
  db: SupabaseClient, b: { id: string; name: string; profile?: object; isSynthetic: boolean },
): Promise<void> {
  const { error } = await db.from("businesses").upsert(
    { id: b.id, name: b.name, ...(b.profile ? { profile: b.profile } : {}), is_synthetic: b.isSynthetic },
    { onConflict: "id" },
  );
  if (error) throw new Error(`upsert business ${b.id}: ${error.message}`);
}

// The individual upsertX helpers below do NOT bump the business revision. For imports and
// fixtures use upsertRecords, so open proposals computed before the write go stale.
export const upsertParties =(db: SupabaseClient, b: string, r: Party[]) => upsert(db, TABLES.parties, b, r);
export const upsertCommitments = (db: SupabaseClient, b: string, r: Commitment[]) => upsert(db, TABLES.commitments, b, r);
export const upsertCashEvents = (db: SupabaseClient, b: string, r: CashEvent[]) => upsert(db, TABLES.events, b, r);
export const upsertSignals = (db: SupabaseClient, b: string, r: Signal[]) => upsert(db, TABLES.signals, b, r);
export const upsertRules = (db: SupabaseClient, b: string, r: Rule[]) => upsert(db, TABLES.rules, b, r);
export const upsertSettlements = (db: SupabaseClient, b: string, r: Settlement[]) => upsert(db, TABLES.settlements, b, r);
export const upsertBalances = (db: SupabaseClient, b: string, r: BalanceSnapshot[]) => upsert(db, TABLES.balances, b, r);
export const upsertEvidence = (db: SupabaseClient, b: string, r: Evidence[]) => upsert(db, TABLES.evidence, b, r);
export const upsertIntakeCandidates = (db: SupabaseClient, b: string, r: IntakeCandidate[]) =>
  upsert(db, "intake_candidates", b, r);
export const upsertChangeProposals = (db: SupabaseClient, b: string, r: ChangeProposal[]) =>
  upsert(db, "change_proposals", b, r);

// Atomic confirm through the confirm_change_proposal RPC (one transaction). Throws StoreError
// with code STALE_REVIEW / IDEMPOTENCY_CONFLICT / PROPOSAL_NOT_PENDING / PROPOSAL_UNRESOLVED (409),
// NOT_FOUND (404), or NOT_IMPLEMENTED (501: the RPC cannot apply proposal ops yet).
export async function confirmChangeProposal(
  db: SupabaseClient, businessId: string, proposalId: string, expectedRevision: number, idempotencyKey: string,
): Promise<ConfirmationResult> {
  const { data, error } = await db.rpc("confirm_change_proposal", {
    p_business_id: businessId,
    p_proposal_id: proposalId,
    p_expected_revision: expectedRevision,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw toStoreError(`confirm ${proposalId}`, error);
  return data as ConfirmationResult;
}

// Write a whole Records bundle (e.g. an adapter's Normalized output or a fixture), then bump
// the business revision (service role only) so open proposals computed before the write go
// stale. Returns the new revision. The business row must already exist (the service role
// creates it; set is_synthetic = true explicitly for fixture/demo businesses).
export async function upsertRecords(db: SupabaseClient, businessId: string, records: Partial<Records>): Promise<number> {
  await upsertParties(db, businessId, records.parties ?? []);
  await upsertCommitments(db, businessId, records.commitments ?? []);
  await upsertCashEvents(db, businessId, records.events ?? []);
  await upsertSignals(db, businessId, records.signals ?? []);
  await upsertRules(db, businessId, records.rules ?? []);
  await upsertSettlements(db, businessId, records.settlements ?? []);
  await upsertBalances(db, businessId, records.balances ?? []);
  await upsertEvidence(db, businessId, records.evidence ?? []);
  const { data, error } = await db.rpc("bump_store_revision", { p_business_id: businessId });
  if (error) throw toStoreError(`bump revision ${businessId}`, error);
  return Number(data);
}
