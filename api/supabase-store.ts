// Store over Supabase with the service-role key. The service role bypasses row level security, so the
// routes call this only after api/auth.ts has verified the caller and checked membership.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChangeProposal, IntakeCandidate } from "../schema/intake";
import type { Records, WorkItem } from "../schema/records";
import {
  loadRecords, loadWorkItems, saveWorkItems, setWorkItemState, toStoreError, upsertBusiness,
  upsertChangeProposals, upsertEvidence, upsertIntakeCandidates, upsertRecords, upsertSignals,
} from "../db/records";
import { fromRow, type Row } from "../db/rows";
import type { Business, IntakeWrite, Store, StoredProfile } from "./store";

// PostgREST / Postgres codes for "this table or function does not exist" (migration not applied yet).
const MISSING = new Set(["42P01", "PGRST205", "PGRST202", "42883"]);

export class SupabaseStore implements Store {
  constructor(private readonly db: SupabaseClient) {}

  async getBusiness(id: string): Promise<Business | null> {
    const { data, error } = await this.db.from("businesses").select("id,name,is_synthetic,profile").eq("id", id).maybeSingle();
    if (error) throw toStoreError(`load business ${id}`, error);
    if (!data) return null;
    const row = data as { id: string; name: string; is_synthetic: boolean; profile: StoredProfile };
    return { id: row.id, name: row.name, isSynthetic: row.is_synthetic, profile: row.profile };
  }

  async isMember(businessId: string, userId: string): Promise<boolean> {
    const { data, error } = await this.db.from("memberships").select("user_id")
      .eq("business_id", businessId).eq("user_id", userId).maybeSingle();
    if (!error && data) return true;
    if (error && !MISSING.has(error.code ?? "")) throw toStoreError(`membership ${businessId}`, error);
    // No memberships table yet (tenant-access migration not applied), or not listed there:
    // fall back to the owner recorded at setup.
    const b = await this.getBusiness(businessId);
    return !!b && !b.isSynthetic && b.profile.account?.ownerUserId === userId;
  }

  async findUserBusiness(userId: string): Promise<string | null> {
    const { data, error } = await this.db.from("memberships").select("business_id,created_at")
      .eq("user_id", userId).order("created_at").limit(1);
    if (!error && data?.length) return (data[0] as { business_id: string }).business_id;
    if (error && !MISSING.has(error.code ?? "")) throw toStoreError("find business", error);
    const owned = await this.db.from("businesses").select("id").eq("profile->account->>ownerUserId", userId)
      .eq("is_synthetic", false).order("created_at").limit(1);
    if (owned.error) throw toStoreError("find business", owned.error);
    return (owned.data?.[0] as { id: string } | undefined)?.id ?? null;
  }

  async createBusiness(b: { name: string; profile: StoredProfile; isSynthetic: boolean; ownerUserId?: string; id?: string }): Promise<string> {
    const id = b.id ?? `biz-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await upsertBusiness(this.db, { id, name: b.name, profile: b.profile, isSynthetic: b.isSynthetic });
    if (b.ownerUserId) {
      const { error } = await this.db.from("memberships").insert({ business_id: id, user_id: b.ownerUserId, role: "owner" });
      // Without the memberships table, profile.account.ownerUserId is the membership record.
      if (error && !MISSING.has(error.code ?? "")) throw toStoreError(`membership ${id}`, error);
    }
    return id;
  }

  async saveProfile(id: string, profile: StoredProfile): Promise<void> {
    const { error } = await this.db.from("businesses").update({ profile }).eq("id", id);
    if (error) throw toStoreError(`save profile ${id}`, error);
  }

  load(id: string) {
    return loadRecords(this.db, id);
  }

  upsertRecords(id: string, records: Partial<Records>): Promise<number> {
    return upsertRecords(this.db, id, records);
  }

  async bumpRevision(id: string): Promise<number> {
    const { data, error } = await this.db.rpc("bump_store_revision", { p_business_id: id });
    if (error) throw toStoreError(`bump revision ${id}`, error);
    return Number(data);
  }

  async saveIntake(id: string, w: IntakeWrite): Promise<void> {
    await upsertEvidence(this.db, id, w.evidence);
    await upsertIntakeCandidates(this.db, id, w.candidates);
    await upsertChangeProposals(this.db, id, w.proposals);
    await upsertSignals(this.db, id, w.signals);
  }

  async listProposals(id: string): Promise<ChangeProposal[]> {
    const { data, error } = await this.db.from("change_proposals").select("*").eq("business_id", id).order("created_at");
    if (error) throw toStoreError(`load proposals ${id}`, error);
    return (data as Row[]).map((r) => fromRow<ChangeProposal>(r, "change_proposals"));
  }

  saveProposals(id: string, proposals: ChangeProposal[]): Promise<void> {
    return upsertChangeProposals(this.db, id, proposals);
  }

  async listCandidates(id: string): Promise<IntakeCandidate[]> {
    const { data, error } = await this.db.from("intake_candidates").select("*").eq("business_id", id);
    if (error) throw toStoreError(`load candidates ${id}`, error);
    return (data as Row[]).map((r) => fromRow<IntakeCandidate>(r, "intake_candidates"));
  }

  loadWorkItems(id: string) {
    return loadWorkItems(this.db, id);
  }

  saveWorkItems(id: string, items: WorkItem[], inputsHash: string) {
    return saveWorkItems(this.db, id, items, inputsHash);
  }

  setWorkItemState(id: string, itemId: string, state: WorkItem["state"]) {
    return setWorkItemState(this.db, id, itemId, state);
  }

  // Synthetic only (the caller checks). Deleting the business cascades to every record table.
  async resetBusiness(b: { id: string; name: string; profile: StoredProfile }, records: Records): Promise<void> {
    const { error } = await this.db.from("businesses").delete().eq("id", b.id).eq("is_synthetic", true);
    if (error) throw toStoreError(`reset ${b.id}`, error);
    await upsertBusiness(this.db, { id: b.id, name: b.name, profile: b.profile, isSynthetic: true });
    await upsertRecords(this.db, b.id, records);
  }
}
