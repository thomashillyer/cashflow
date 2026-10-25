// Schema readiness: the newest migration in the repo versus what the database has applied
// (public.schema_version(), migration 20261025210000). Used by GET /ready and the startup warning.

import { readdirSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

export type SchemaStatus = { repo: string; db: string | null };
export type SchemaStatusFn = () => Promise<SchemaStatus>;

// Latest version prefix among `<version>_name.sql` filenames; "" when there are none.
export function latestMigrationVersion(files: string[]): string {
  const versions = files.map((f) => /^(\d+)_.*\.sql$/.exec(f)?.[1]).filter((v): v is string => !!v);
  return versions.sort().at(-1) ?? "";
}

export const repoSchemaVersion = (dir: string): string => latestMigrationVersion(readdirSync(dir));

// db is null when the RPC is missing or fails (the migration isn't applied yet). Never throws.
export function supabaseSchemaStatus(sb: SupabaseClient, migrationsDir: string): SchemaStatusFn {
  return async () => {
    let repo = "";
    try {
      repo = repoSchemaVersion(migrationsDir);
      const { data, error } = await sb.rpc("schema_version");
      return { repo, db: error || typeof data !== "string" ? null : data };
    } catch {
      return { repo, db: null };
    }
  };
}

export const isBehind = (s: SchemaStatus): boolean => s.db === null || s.db < s.repo;
