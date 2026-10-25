// Supabase client. Reads SUPABASE_URL plus SUPABASE_ANON_KEY (browser-safe) or,
// for server-only code, SUPABASE_SERVICE_ROLE_KEY (bypasses RLS; never ship it to the app).
// Load .env with `node --env-file=.env` or your framework's loader.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type ClientOptions = { serviceRole?: boolean };

export function getSupabase({ serviceRole = false }: ClientOptions = {}): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const keyName = serviceRole ? "SUPABASE_SERVICE_ROLE_KEY" : "SUPABASE_ANON_KEY";
  const key = process.env[keyName];
  if (!url || !key) {
    throw new Error(`Missing SUPABASE_URL or ${keyName}. Copy .env.example to .env and fill it in.`);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
