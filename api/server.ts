// Entry point: `npm run dev` (tsx, port 8787) or `npm start`. Serves the API and, when app/ exists,
// the app on the same origin. /config.js is always served live, including the explicit demo capability.
// Missing production configuration fails startup; it never falls back to fixture data.
// Env: see api/README.md. Secrets come from .env only.

import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { getSupabase } from "../db/client";
import { buildApp, type Verifier } from "./app";
import { loadSamples } from "./demo";
import { MemoryStore, type Store } from "./store";
import { SupabaseStore } from "./supabase-store";
import { isBehind, supabaseSchemaStatus } from "./schema-status";
import { buildConnectionService } from "./connections";

const env = process.env;
const demoMode = env.DEMO_MODE === "1";
const port = Number(env.PORT ?? 8787);
const useMemory = env.NERI_STORE === "memory";
const production = env.NODE_ENV === "production";
if (env.NERI_STORE && !["memory", "supabase"].includes(env.NERI_STORE)) throw new Error("NERI_STORE must be supabase or memory.");
if (production && (demoMode || useMemory)) throw new Error("Production requires private Supabase storage with DEMO_MODE off; memory and fixture demos are local only.");
if (!useMemory) {
  const missing = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"].filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing server configuration: ${missing.join(", ")}. Configure Supabase, or explicitly use NERI_STORE=memory DEMO_MODE=1 for a local fixture demo.`);
}

async function memoryStore(): Promise<Store> {
  const store = new MemoryStore();
  if (demoMode) for (const s of loadSamples()) await store.resetBusiness(s, s.records);
  return store;
}

const sb = useMemory ? null : getSupabase({ serviceRole: true });
const store: Store = useMemory ? await memoryStore() : new SupabaseStore(sb!);
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

const aiMode = env.ANTHROPIC_API_KEY && (env.NERI_AI_MODE === "live" || (!demoMode && env.NERI_AI_MODE !== "cache_only")) ? "live" : "cache_only";
const app = await buildApp({
  store,
  verify,
  demoMode,
  defaultBusiness: env.NERI_DEFAULT_BUSINESS ?? "cascade_trade",
  // Live Claude only with a key, and never by default on the public demo (anonymous callers could spend it).
  aiMode,
  connections: buildConnectionService(env, { aiMode }),
  staticDir: env.NERI_STATIC_DIR ?? join(import.meta.dirname, "../app"),
  appConfig: { supabaseUrl: env.SUPABASE_URL, supabaseAnonKey: env.SUPABASE_ANON_KEY },
  allowReset: demoMode && !production && env.NERI_ALLOW_RESET === "1",
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
