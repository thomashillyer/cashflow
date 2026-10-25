// Entry point: `npm run dev` (tsx, port 8787) or `npm start`. Serves the API and, when app/ exists,
// the app on the same origin. With DEMO_MODE=1 or the Supabase values set, /config.js is served live
// (same-origin API, plus sign-in when both public Supabase values are set); otherwise the committed preview config.
// Env: see api/README.md. Secrets come from .env only.

import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { getSupabase } from "../db/client";
import { buildApp, type Verifier } from "./app";
import { loadSamples } from "./demo";
import { MemoryStore, type Store } from "./store";
import { SupabaseStore } from "./supabase-store";
import { isBehind, supabaseSchemaStatus } from "./schema-status";

const env = process.env;
const demoMode = env.DEMO_MODE === "1";
const port = Number(env.PORT ?? 8787);

async function memoryStore(): Promise<Store> {
  const store = new MemoryStore();
  for (const s of loadSamples()) await store.resetBusiness(s, s.records);
  return store;
}

const useMemory = env.NERI_STORE === "memory";
const sb = useMemory ? null : getSupabase({ serviceRole: true });
const store: Store = sb ? new SupabaseStore(sb) : await memoryStore();
// The Dockerfile copies the whole repo, so supabase/migrations is in the image.
const schemaStatus = sb ? supabaseSchemaStatus(sb, join(import.meta.dirname, "../supabase/migrations")) : undefined;

// Supabase verifies the session token (anon-key client; getUser checks it with the auth server).
const verify: Verifier = env.SUPABASE_URL && env.SUPABASE_ANON_KEY
  ? async (token) => {
      const sb = createClient(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await sb.auth.getUser(token);
      if (error || !data.user) return null;
      return { id: data.user.id, ...(data.user.email ? { email: data.user.email } : {}) };
    }
  : async () => null;

const app = await buildApp({
  store,
  verify,
  demoMode,
  defaultBusiness: env.NERI_DEFAULT_BUSINESS ?? "cascade_trade",
  // Live Claude only with a key, and never by default on the public demo (anonymous callers could spend it).
  aiMode: env.ANTHROPIC_API_KEY && (env.NERI_AI_MODE === "live" || (!demoMode && env.NERI_AI_MODE !== "cache_only")) ? "live" : "cache_only",
  staticDir: env.NERI_STATIC_DIR ?? join(import.meta.dirname, "../app"),
  ...(demoMode || (env.SUPABASE_URL && env.SUPABASE_ANON_KEY)
    ? { appConfig: { supabaseUrl: env.SUPABASE_URL, supabaseAnonKey: env.SUPABASE_ANON_KEY } }
    : {}),
  allowReset: demoMode || env.NERI_ALLOW_RESET === "1",
  logger: true,
  ...(schemaStatus ? { schemaStatus } : {}),
});

// Startup check: warn loudly, never crash (the demo must keep serving).
if (schemaStatus) {
  const s = await schemaStatus().catch(() => null);
  if (s && isBehind(s)) {
    app.log.warn({ repo: s.repo, db: s.db }, `DATABASE IS BEHIND THE CODE: repo migration ${s.repo}, database ${s.db ?? "unknown (schema_version() missing, so its migration isn't applied)"}. Run npx supabase db push.`);
  }
}

await app.listen({ port, host: env.HOST ?? "127.0.0.1" });
app.log.info(`Neri API on http://localhost:${port} (store: ${useMemory ? "memory" : "supabase"}, demo mode: ${demoMode ? "on" : "off"})`);
