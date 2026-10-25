// Seed the synthetic sample businesses (cascade_trade, pike_noodle) and their fixture records into
// Supabase with the service role. Idempotent: upserts on (business_id, id), is_synthetic = true.
// Usage: npx tsx --env-file=.env scripts/seed-demo.ts [--reset]
//   --reset  delete each sample's records first (same as POST /demo/reset), so applied signals and
//            confirmed proposals from earlier demos are gone. Never touches a non-synthetic business.

import { getSupabase } from "../db/client";
import { upsertBusiness, upsertRecords } from "../db/records";
import { loadSamples } from "../api/demo";
import { SupabaseStore } from "../api/supabase-store";

const reset = process.argv.includes("--reset");
const db = getSupabase({ serviceRole: true });
const store = new SupabaseStore(db);

for (const s of loadSamples()) {
  const existing = await store.getBusiness(s.id);
  if (existing && !existing.isSynthetic) {
    console.error(`${s.id}: a non-synthetic business already uses this id; skipped.`);
    process.exitCode = 1;
    continue;
  }
  if (reset) {
    await store.resetBusiness(s, s.records);
  } else {
    // Keep owner notes and import notes from earlier sessions; refresh everything else.
    const account = { ...s.profile.account, ...(existing?.profile.account?.thoughts ? { thoughts: existing.profile.account.thoughts } : {}),
      ...(existing?.profile.account?.intakeNotes ? { intakeNotes: existing.profile.account.intakeNotes } : {}) };
    await upsertBusiness(db, { id: s.id, name: s.name, profile: { ...s.profile, account }, isSynthetic: true });
    await upsertRecords(db, s.id, s.records);
  }
  const counts = Object.entries(s.records).map(([k, v]) => `${k} ${(v as unknown[]).length}`).join(", ");
  console.log(`${s.id}: ${reset ? "reset" : "seeded"} (${counts})`);
}
