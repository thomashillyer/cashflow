#!/usr/bin/env node
// Validate Supabase access in .env and run a read-only connectivity check.
//
// Default flow (no org access needed): put SUPABASE_URL, SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY (shared by the team lead) into .env, then run
//   npm run setup:supabase [-- --require-service-role]
//
// Optional --from-cli mode (for someone logged in to the Supabase org via
// `npx -y supabase@2 login`): fetch the keys with the CLI and merge them into .env.
//   npm run setup:supabase -- --from-cli [--with-service-role] [--force] [--project-ref <ref>]
//
// Key values are never printed; only variable names and lengths.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  DEFAULT_PROJECT_REF,
  buildEnvValues,
  mergeEnv,
  parseApiKeysOutput,
  parseArgs,
  parseEnv,
  pickKeys,
  validateEnv,
} from "./lib/supabase-setup.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");

function fail(message) {
  console.error(message);
  process.exit(1);
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2), process.env);
} catch (e) {
  fail(e.message);
}
const { fromCli, withServiceRole, requireServiceRole, force } = opts;

// .env must be gitignored before it holds (or receives) secrets.
try {
  execFileSync("git", ["check-ignore", "-q", ".env"], { cwd: root, stdio: "ignore" });
} catch {
  fail("Refusing to continue: .env is not gitignored (git check-ignore -q .env failed). Fix .gitignore first.");
}

if (fromCli) {
  const projectRef = opts.projectRef ?? DEFAULT_PROJECT_REF;
  let stdout;
  try {
    stdout = execFileSync("npx", ["-y", "supabase@2", "projects", "api-keys", "--project-ref", projectRef, "-o", "json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const detail = `${e.stderr ?? ""}${e.stdout ?? ""}${e.message ?? ""}`;
    if (/access token|not logged in|supabase login|SUPABASE_ACCESS_TOKEN/i.test(detail)) {
      fail(
        "Not logged in to Supabase. Run: npx -y supabase@2 login (you must be invited to the Supabase org first), then rerun this script.",
      );
    }
    if (/forbidden|not found|403|404|do not have permission|unauthorized/i.test(detail)) {
      fail(
        `Project ${projectRef} is not visible to your Supabase account. You need an invite to the Supabase org; otherwise use the default flow (paste the shared values into .env).`,
      );
    }
    fail(`Supabase CLI failed:\n${String(e.stderr ?? e.message).trim()}`);
  }

  let keys;
  try {
    keys = pickKeys(parseApiKeysOutput(stdout));
  } catch (e) {
    fail(e.message);
  }
  if (!keys.anon) fail("Could not find an anon/publishable key for this project.");
  if (withServiceRole && !keys.serviceRole) fail("Could not find a service_role/secret key for this project.");

  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const merged = mergeEnv(
    existing,
    buildEnvValues({ projectRef, anonKey: keys.anon, serviceRoleKey: keys.serviceRole, withServiceRole }),
    { force },
  );
  writeFileSync(envPath, merged.text, { mode: 0o600 });
  for (const { name, length } of merged.set) console.log(`set ${name} (${length} chars)`);
  for (const name of merged.kept) console.log(`kept existing ${name} (use --force to overwrite)`);
}

if (!existsSync(envPath)) {
  fail(".env not found. Copy .env.example to .env and paste the SUPABASE_* values the team lead shared, then rerun.");
}
chmodSync(envPath, 0o600);

const env = parseEnv(readFileSync(envPath, "utf8"));
const { errors, warnings, lengths } = validateEnv(env, { requireServiceRole, projectRef: opts.projectRef });
for (const [name, length] of Object.entries(lengths)) console.log(`${name}: present (${length} chars)`);
for (const w of warnings) console.log(`warning: ${w}`);
if (errors.length > 0) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}

// Read-only connectivity check with the anon key.
try {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.from("businesses").select("id").limit(1);
  if (error) {
    console.log(`connection check failed: ${error.message}`);
    console.log("(If the schema is not pushed yet, a missing businesses table is expected.)");
    process.exitCode = 1;
  } else {
    console.log(`connected (businesses: ${data.length === 0 ? "table is empty" : "1+ rows readable"})`);
  }
} catch (e) {
  console.log(`connection check failed: ${e.message}`);
  process.exitCode = 1;
}
