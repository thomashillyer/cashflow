// Smoke test for the work-item store helpers against the hosted Supabase project (they are
// otherwise only unit-tested against a mock). Needs the migrations through
// 20261025150000_work_items_atomic.sql applied and SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY in the
// repo-root .env (SUPABASE_ANON_KEY is optional and adds an access check). Keys are never printed.
//
//   npx tsx scripts/smoke-work-items.ts
//
// It writes only to synthetic businesses named smoke-test-<timestamp>[-empty], deletes them (the
// foreign keys cascade to work_items) when it finishes, and first sweeps any smoke-test-* business a
// crashed earlier run left behind, so it is safe to rerun. Exit code 0 means every step passed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import type { WorkItem } from "../schema/records";
import { getSupabase } from "../db/client";
import { StoreError, loadWorkItems, saveWorkItems, setWorkItemState, upsertBusiness } from "../db/records";
import { parseEnv } from "./lib/supabase-setup.mjs";

// Load the repo-root .env without overriding variables already set in the environment.
try {
  const env = parseEnv(readFileSync(fileURLToPath(new URL("../.env", import.meta.url)), "utf8"));
  for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
} catch {
  // No .env file: fall back to whatever is already in the environment.
}

const PREFIX = "smoke-test-";
const stamp = Date.now();
const businessId = `${PREFIX}${stamp}`;
const emptyBusinessId = `${PREFIX}${stamp}-empty`;

let failures = 0;
function check(step: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) failures++;
}
async function step(name: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    check(name, false, e instanceof Error ? e.message : String(e));
    return false;
  }
}

const item = (id: string, score: number, extra: Partial<WorkItem> = {}): WorkItem => ({
  id, warning: "projected_cash_gap", title: `Title ${id}`, why: `Why ${id}`, cashEffect: 12_345, neededBy: "2026-12-12",
  confidence: 0.8, score, evidenceRefs: ["inv-1", "inv-2"], actions: [{ kind: "draft_email", draftId: "d1" }, { kind: "mark_done" }],
  state: "open", ...extra,
});
const lever = { kind: "defer", commitmentId: "c1", days: 10 } as const;

const db = getSupabase({ serviceRole: true });

async function deleteSmokeBusinesses(ids: string[]): Promise<void> {
  const safe = ids.filter((id) => id.startsWith(PREFIX));  // never touch anything else
  if (safe.length === 0) return;
  const { error } = await db.from("businesses").delete().in("id", safe).eq("is_synthetic", true);
  if (error) throw new Error(`delete businesses: ${error.message}`);
}

async function main(): Promise<void> {
  // Sweep leftovers from a crashed earlier run.
  const { data: old, error: oldError } = await db.from("businesses").select("id").like("id", `${PREFIX}%`).eq("is_synthetic", true);
  if (oldError) throw new Error(`sweep: ${oldError.message}`);
  // Only ids stamped more than an hour ago, so a concurrent run by someone else is left alone.
  const stale = (old ?? []).map((r) => r.id as string).filter((id) => {
    const ts = Number(/^smoke-test-(\d+)/.exec(id)?.[1]);
    return Number.isFinite(ts) && stamp - ts > 60 * 60 * 1000;
  });
  if (stale.length) {
    await deleteSmokeBusinesses(stale);
    console.log(`swept ${stale.length} leftover smoke-test business(es)`);
  }

  if (!(await step("create synthetic businesses", async () => {
    await upsertBusiness(db, { id: businessId, name: "Smoke test", isSynthetic: true });
    await upsertBusiness(db, { id: emptyBusinessId, name: "Smoke test (empty ranking)", isSynthetic: true });
    check("create synthetic businesses", true);
  }))) return;

  // 1. Before any save: nothing, no hash.
  await step("load before save", async () => {
    const r = await loadWorkItems(db, businessId);
    check("load before save: no items, no hash", r.items.length === 0 && r.inputsHash === undefined, JSON.stringify(r));
  });

  // 2. save -> load
  const saved = await step("saveWorkItems", async () => {
    await saveWorkItems(db, businessId, [item("wi-a", 3, { lever }), item("wi-b", 2), item("wi-c", 1)], "hash-1");
    check("saveWorkItems (3 items, hash-1)", true);
  });
  if (saved) await step("loadWorkItems", async () => {
    const r = await loadWorkItems(db, businessId);
    check("load: 3 items best first", JSON.stringify(r.items.map((i) => i.id)) === '["wi-a","wi-b","wi-c"]', JSON.stringify(r.items.map((i) => i.id)));
    check("load: all open", r.items.every((i) => i.state === "open"));
    check("load: business hash is hash-1", r.inputsHash === "hash-1", String(r.inputsHash));
    const a = r.items[0]!;
    check("load: fields round-trip (lever, cashEffect, neededBy, evidenceRefs, actions)",
      // jsonb reorders object keys, so compare fields, not the serialized object.
      a.lever?.kind === "defer" && a.lever.commitmentId === "c1" && a.lever.days === 10 && a.cashEffect === 12_345 && a.neededBy === "2026-12-12"
      && JSON.stringify(a.evidenceRefs) === '["inv-1","inv-2"]' && a.actions.length === 2 && a.score === 3 && a.confidence === 0.8,
      JSON.stringify(a));
    check("load: no stamp column leaks into items", r.items.every((i) => !("inputsHash" in i) && !("businessId" in i)));
  });

  // 3. setWorkItemState -> load
  await step("setWorkItemState", async () => {
    await setWorkItemState(db, businessId, "wi-a", "done");
    check("setWorkItemState wi-a -> done", true);
    try {
      await setWorkItemState(db, businessId, "wi-missing", "done");
      check("setWorkItemState unknown id throws NOT_FOUND", false, "did not throw");
    } catch (e) {
      check("setWorkItemState unknown id throws NOT_FOUND", e instanceof StoreError && e.code === "NOT_FOUND" && e.status === 404, String(e));
    }
  });
  await step("loadWorkItems after state change", async () => {
    const r = await loadWorkItems(db, businessId);
    const states = Object.fromEntries(r.items.map((i) => [i.id, i.state]));
    check("load: wi-a done, others open", states["wi-a"] === "done" && states["wi-b"] === "open" && states["wi-c"] === "open", JSON.stringify(states));
    check("load: hash unchanged by a state change", r.inputsHash === "hash-1", String(r.inputsHash));
  });

  // 4. re-rank: done survives, open items not produced are pruned, hash moves.
  await step("re-save a new ranking", async () => {
    await saveWorkItems(db, businessId, [item("wi-a", 5, { title: "Retitled" }), item("wi-d", 4)], "hash-2");
    const r = await loadWorkItems(db, businessId);
    const states = Object.fromEntries(r.items.map((i) => [i.id, i.state]));
    check("re-save: wi-a keeps done, wi-b/wi-c pruned, wi-d open",
      JSON.stringify(states) === '{"wi-a":"done","wi-d":"open"}', JSON.stringify(states));
    check("re-save: wi-a updated and lever cleared", r.items[0]?.title === "Retitled" && r.items[0]?.lever === undefined, JSON.stringify(r.items[0]));
    check("re-save: business hash is hash-2", r.inputsHash === "hash-2", String(r.inputsHash));
  });

  // 5. Empty ranking on a business with no rows: current, not stale.
  await step("empty ranking", async () => {
    await saveWorkItems(db, emptyBusinessId, [], "hash-empty");
    const r = await loadWorkItems(db, emptyBusinessId);
    check("empty ranking: zero items but hash is recorded (not stale)", r.items.length === 0 && r.inputsHash === "hash-empty", JSON.stringify(r));
  });

  // 6. Errors
  await step("errors", async () => {
    const expectError = async (label: string, run: () => Promise<unknown>, code: string, status: number) => {
      try {
        await run();
        check(label, false, "did not throw");
      } catch (e) {
        check(label, e instanceof StoreError && e.code === code && e.status === status, String(e));
      }
    };
    await expectError("save for unknown business throws NOT_FOUND", () => saveWorkItems(db, `${PREFIX}${stamp}-nope`, [], "h"), "NOT_FOUND", 404);
    await expectError("save with duplicate ids throws INVALID_ARGUMENT", () => saveWorkItems(db, businessId, [item("x", 1), item("x", 2)], "h"), "INVALID_ARGUMENT", 400);
    const r = await loadWorkItems(db, businessId);
    check("rejected saves changed nothing", r.inputsHash === "hash-2" && r.items.length === 2, JSON.stringify(r));
  });

  // 7. Access: the anon key can read a synthetic business's items but cannot save.
  const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anonKey } = process.env;
  if (url && anonKey) {
    await step("anon access", async () => {
      const anon = createClient(url, anonKey, { auth: { persistSession: false } });
      const r = await loadWorkItems(anon, businessId);
      check("anon can read the synthetic business's items and hash", r.items.length === 2 && r.inputsHash === "hash-2", JSON.stringify(r));
      const { error } = await anon.rpc("save_work_items", { p_business_id: businessId, p_items: [], p_inputs_hash: "evil" });
      check("anon cannot call save_work_items", error !== null, "the call succeeded");
      const after = await loadWorkItems(db, businessId);
      check("anon attempt changed nothing", after.inputsHash === "hash-2" && after.items.length === 2);
    });
  } else {
    console.log("SKIP  anon access (SUPABASE_ANON_KEY not set)");
  }
}

try {
  await main();
} catch (e) {
  check("run", false, e instanceof Error ? e.message : String(e));
} finally {
  try {
    await deleteSmokeBusinesses([businessId, emptyBusinessId]);
    const { data, error } = await db.from("businesses").select("id").in("id", [businessId, emptyBusinessId]);
    check("cleanup: synthetic businesses deleted", !error && data?.length === 0, error?.message ?? "rows remain");
    const { data: left } = await db.from("work_items").select("id").in("business_id", [businessId, emptyBusinessId]);
    check("cleanup: no work items left behind", (left?.length ?? 0) === 0);
  } catch (e) {
    check("cleanup", false, e instanceof Error ? e.message : String(e));
  }
}
console.log(failures === 0 ? "\nALL STEPS PASSED" : `\n${failures} STEP(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
