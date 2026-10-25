// Entry point: `npm run dev` (tsx, port 8787) or `npm start`. Serves the API and, when app/ exists,
// the app on the same origin (set window.NERI_API_BASE = "same-origin" in app/config.js).
// Env: see api/README.md. Secrets come from .env only.

import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { getSupabase } from "../db/client";
import { buildApp, type Verifier } from "./app";
import { loadSamples } from "./demo";
import { MemoryStore, type Store } from "./store";
import { SupabaseStore } from "./supabase-store";

const env = process.env;
const demoMode = env.DEMO_MODE === "1";
const port = Number(env.PORT ?? 8787);

async function memoryStore(): Promise<Store> {
  const store = new MemoryStore();
  for (const s of loadSamples()) await store.resetBusiness(s, s.records);
  return store;
}

const useMemory = env.NERI_STORE === "memory";
const store: Store = useMemory ? await memoryStore() : new SupabaseStore(getSupabase({ serviceRole: true }));

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
  allowReset: demoMode || env.NERI_ALLOW_RESET === "1",
  logger: true,
});

await app.listen({ port, host: env.HOST ?? "127.0.0.1" });
app.log.info(`Neri API on http://localhost:${port} (store: ${useMemory ? "memory" : "supabase"}, demo mode: ${demoMode ? "on" : "off"})`);
