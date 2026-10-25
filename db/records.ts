// Typed repository over the shared records. Upserts are idempotent on (business_id, id).

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BalanceSnapshot, CashEvent, Commitment, Evidence, Party, Records, Rule, Settlement, Signal,
} from "../schema/records";
import type { DocumentCandidate, ProposedUpdate } from "../schema/intake";
import { TABLES, fromRow, toRow, type Row } from "./rows";

async function selectAll<T>(db: SupabaseClient, table: string, businessId: string): Promise<T[]> {
  const { data, error } = await db.from(table).select("*").eq("business_id", businessId);
  if (error) throw new Error(`load ${table}: ${error.message}`);
  return (data as Row[]).map((r) => fromRow<T>(r));
}

async function upsert<T extends { id: string }>(
  db: SupabaseClient, table: string, businessId: string, records: T[],
): Promise<void> {
  if (records.length === 0) return;
  const { error } = await db
    .from(table)
    .upsert(records.map((r) => toRow(r, businessId)), { onConflict: "business_id,id" });
  if (error) throw new Error(`upsert ${table}: ${error.message}`);
}

export async function loadRecords(db: SupabaseClient, businessId: string): Promise<Records> {
  const [parties, commitments, events, signals, rules, settlements, balances, evidence] = await Promise.all([
    selectAll<Party>(db, TABLES.parties, businessId),
    selectAll<Commitment>(db, TABLES.commitments, businessId),
    selectAll<CashEvent>(db, TABLES.events, businessId),
    selectAll<Signal>(db, TABLES.signals, businessId),
    selectAll<Rule>(db, TABLES.rules, businessId),
    selectAll<Settlement>(db, TABLES.settlements, businessId),
    selectAll<BalanceSnapshot>(db, TABLES.balances, businessId),
    selectAll<Evidence>(db, TABLES.evidence, businessId),
  ]);
  return { parties, commitments, events, signals, rules, settlements, balances, evidence };
}

export const upsertParties = (db: SupabaseClient, b: string, r: Party[]) => upsert(db, TABLES.parties, b, r);
export const upsertCommitments = (db: SupabaseClient, b: string, r: Commitment[]) => upsert(db, TABLES.commitments, b, r);
export const upsertCashEvents = (db: SupabaseClient, b: string, r: CashEvent[]) => upsert(db, TABLES.events, b, r);
export const upsertSignals = (db: SupabaseClient, b: string, r: Signal[]) => upsert(db, TABLES.signals, b, r);
export const upsertRules = (db: SupabaseClient, b: string, r: Rule[]) => upsert(db, TABLES.rules, b, r);
export const upsertSettlements = (db: SupabaseClient, b: string, r: Settlement[]) => upsert(db, TABLES.settlements, b, r);
export const upsertBalances = (db: SupabaseClient, b: string, r: BalanceSnapshot[]) => upsert(db, TABLES.balances, b, r);
export const upsertEvidence = (db: SupabaseClient, b: string, r: Evidence[]) => upsert(db, TABLES.evidence, b, r);
export const upsertDocumentCandidates = (db: SupabaseClient, b: string, r: DocumentCandidate[]) =>
  upsert(db, "document_candidates", b, r);
export const upsertProposedUpdates = (db: SupabaseClient, b: string, r: ProposedUpdate[]) =>
  upsert(db, "proposed_updates", b, r);

// Write a whole Records bundle (e.g. an adapter's Normalized output or a fixture).
export async function upsertRecords(db: SupabaseClient, businessId: string, records: Partial<Records>): Promise<void> {
  await upsertParties(db, businessId, records.parties ?? []);
  await upsertCommitments(db, businessId, records.commitments ?? []);
  await upsertCashEvents(db, businessId, records.events ?? []);
  await upsertSignals(db, businessId, records.signals ?? []);
  await upsertRules(db, businessId, records.rules ?? []);
  await upsertSettlements(db, businessId, records.settlements ?? []);
  await upsertBalances(db, businessId, records.balances ?? []);
  await upsertEvidence(db, businessId, records.evidence ?? []);
}
