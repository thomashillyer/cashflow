// commit_review_decision against a LOCAL Supabase (never the hosted project). Skipped unless
//   npx supabase start && npx supabase db reset
//   NERI_LOCAL_DB=1 LOCAL_SUPABASE_URL=http://127.0.0.1:54321 LOCAL_SUPABASE_SERVICE_KEY=<from `npx supabase status`> npx vitest run db/review_decisions.local.test.ts

import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { SupabaseStore } from "../api/supabase-store";
import type { ChangeProposal } from "../schema/intake";
import type { Party } from "../schema/records";

const url = process.env.LOCAL_SUPABASE_URL;
const key = process.env.LOCAL_SUPABASE_SERVICE_KEY;

describe.skipIf(!process.env.NERI_LOCAL_DB || !url || !key)("SupabaseStore.commitDecision (local database)", () => {
  it("applies once, replays, conflicts and goes stale", async () => {
    const db = createClient(url!, key!, { auth: { persistSession: false } });
    const store = new SupabaseStore(db);
    const id = await store.createBusiness({ name: "Local test", profile: {} as never, isSynthetic: true, id: `biz-local-${Date.now()}` });
    try {
      const { storeRevision } = await store.load(id);
      const party: Party = { id: "p-1", name: "Acme", kind: "customer", tags: [], notes: [], sourceRef: { system: "test", record: "p-1" } } as unknown as Party;
      const proposal = { id: "cp-1", state: "confirmed", action: "link", ops: [], evidenceIds: [], expectedStoreRevision: storeRevision, createdAt: "2026-11-16T00:00:00.000Z" } as unknown as ChangeProposal;
      const d = { expectedRevision: storeRevision, idempotencyKey: "k1", requestHash: "h1", records: { parties: [party] }, proposals: [proposal], response: { done: true } };

      const stale = await store.commitDecision(id, { ...d, idempotencyKey: "k0", expectedRevision: storeRevision + 5 });
      expect(stale).toEqual({ kind: "stale", storeRevision });
      expect((await store.load(id)).records.parties).toHaveLength(0);

      const ok = await store.commitDecision(id, d);
      expect(ok).toEqual({ kind: "ok", storeRevision: storeRevision + 1, response: { done: true, storeRevision: storeRevision + 1 } });
      expect((await store.load(id)).records.parties).toHaveLength(1);
      expect((await store.listProposals(id))[0]!.state).toBe("confirmed");

      expect(await store.commitDecision(id, d)).toEqual({ kind: "replay", response: { done: true, storeRevision: storeRevision + 1 } });
      expect(await store.commitDecision(id, { ...d, requestHash: "h2" })).toEqual({ kind: "conflict" });
      expect((await store.load(id)).storeRevision).toBe(storeRevision + 1);
    } finally {
      await db.from("businesses").delete().eq("id", id);
    }
  });
});
