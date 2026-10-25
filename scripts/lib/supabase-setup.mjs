// Pure helpers for scripts/setup-supabase.mjs (kept free of I/O so they can be unit tested).

export const DEFAULT_PROJECT_REF = "iiqzllefkoyjisqnwpyh";

const REF_RE = /^[a-z0-9]{20}$/;
const HOSTED_URL_RE = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/;
const LOCAL_URL_RE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/;

/** Parse the `supabase projects api-keys -o json` stdout. The CLI may print a non-JSON line first. */
export function parseApiKeysOutput(stdout) {
  const start = stdout.indexOf("[");
  if (start === -1) throw new Error("No JSON array found in Supabase CLI output.");
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    throw new Error("Could not parse Supabase CLI output as JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("Supabase CLI output was not a JSON array.");
  return parsed;
}

function keyValue(entry) {
  return typeof entry?.api_key === "string" && entry.api_key !== "" ? entry.api_key : undefined;
}

/** Pick anon and service_role keys by name, falling back to publishable/secret types. */
export function pickKeys(entries) {
  const find = (name, type) =>
    entries.find((e) => e?.name === name && keyValue(e)) ?? entries.find((e) => e?.type === type && keyValue(e));
  return {
    anon: keyValue(find("anon", "publishable") ?? {}),
    serviceRole: keyValue(find("service_role", "secret") ?? {}),
  };
}

function stripQuotes(v) {
  const t = v.trim();
  return t.length >= 2 && /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/** Minimal .env reader: returns a plain object of KEY -> value. */
export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m) out[m[1]] = stripQuotes(m[2]);
  }
  return out;
}

/**
 * Merge `values` into .env text. Other lines are preserved untouched. An existing non-empty
 * value is kept unless `force`. Entries with an undefined value are ignored.
 * Returns { text, set: [{name, length}], kept: [name] } (never includes values).
 */
export function mergeEnv(existingText, values, { force = false } = {}) {
  const lines = existingText === "" ? [] : existingText.replace(/\r?\n$/, "").split(/\r?\n/);
  const set = [];
  const kept = [];
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=(.*)$`);
    const idx = lines.findIndex((l) => re.test(l));
    if (idx === -1) {
      lines.push(`${name}=${value}`);
      set.push({ name, length: value.length });
      continue;
    }
    const current = stripQuotes(re.exec(lines[idx])[1]);
    if (current !== "" && !force) {
      kept.push(name);
      continue;
    }
    lines[idx] = `${name}=${value}`;
    set.push({ name, length: value.length });
  }
  return { text: lines.join("\n") + "\n", set, kept };
}

/** Env values the CLI mode manages. The service role key is included only when requested. */
export function buildEnvValues({ projectRef, anonKey, serviceRoleKey, withServiceRole }) {
  return {
    SUPABASE_URL: `https://${projectRef}.supabase.co`,
    SUPABASE_ANON_KEY: anonKey,
    SUPABASE_PROJECT_REF: projectRef,
    ...(withServiceRole ? { SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey } : {}),
  };
}

/** Decode a JWT payload without verifying it. Returns undefined if the token is not a JWT. */
export function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check a key looks like a Supabase key for the expected role and project, without ever
 * echoing it. Returns an error string or undefined. `role` is "anon" or "service_role".
 */
export function checkKey(name, key, role, urlRef) {
  const newStyle = role === "anon" ? "sb_publishable_" : "sb_secret_";
  const otherStyle = role === "anon" ? "sb_secret_" : "sb_publishable_";
  if (key.startsWith(newStyle)) return undefined;
  if (key.startsWith(otherStyle)) return `${name} looks like a ${role === "anon" ? "secret/service" : "publishable/anon"} key; the two values are swapped.`;
  const payload = decodeJwtPayload(key);
  if (!payload) return `${name} does not look like a Supabase key (expected a JWT or an ${newStyle}... key). Check for stray quotes or truncation.`;
  if (payload.role !== role) {
    return `${name} has role "${String(payload.role)}" but should be "${role}"; the keys may be swapped.`;
  }
  if (urlRef && typeof payload.ref === "string" && payload.ref !== urlRef) {
    return `${name} belongs to project ${payload.ref} but SUPABASE_URL points at ${urlRef}.`;
  }
  return undefined;
}

/**
 * Validate the Supabase variables of a parsed .env. Returns { errors, warnings, lengths }.
 * Only variable names and lengths are reported, never values. The service role key is a
 * warning when missing unless `requireServiceRole`.
 */
export function validateEnv(env, { requireServiceRole = false, projectRef } = {}) {
  const errors = [];
  const warnings = [];
  const lengths = {};
  for (const name of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (env[name]) lengths[name] = env[name].length;
  }

  let urlRef;
  const url = env.SUPABASE_URL;
  if (!url) errors.push("SUPABASE_URL is not set.");
  else {
    const hosted = HOSTED_URL_RE.exec(url);
    if (hosted) urlRef = hosted[1];
    else if (!LOCAL_URL_RE.test(url)) errors.push("SUPABASE_URL must look like https://<project-ref>.supabase.co (or a local http://127.0.0.1:<port> URL).");
    if (projectRef && urlRef && projectRef !== urlRef) {
      errors.push(`SUPABASE_URL points at project ${urlRef}, expected ${projectRef}.`);
    }
  }

  if (!env.SUPABASE_ANON_KEY) errors.push("SUPABASE_ANON_KEY is not set.");
  else {
    const e = checkKey("SUPABASE_ANON_KEY", env.SUPABASE_ANON_KEY, "anon", urlRef);
    if (e) errors.push(e);
  }

  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    const msg = "SUPABASE_SERVICE_ROLE_KEY is not set (only needed for server/importer work).";
    (requireServiceRole ? errors : warnings).push(msg);
  } else {
    const e = checkKey("SUPABASE_SERVICE_ROLE_KEY", env.SUPABASE_SERVICE_ROLE_KEY, "service_role", urlRef);
    if (e) errors.push(e);
  }
  return { errors, warnings, lengths };
}

/**
 * Parse CLI args: --from-cli, --project-ref <ref>|--project-ref=<ref>, --with-service-role,
 * --require-service-role, --force. `projectRef` is set only when given by flag or env.
 */
export function parseArgs(argv, env = {}) {
  const opts = {
    fromCli: false,
    projectRef: env.SUPABASE_PROJECT_REF || undefined,
    withServiceRole: false,
    requireServiceRole: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from-cli") opts.fromCli = true;
    else if (a === "--with-service-role") opts.withServiceRole = true;
    else if (a === "--require-service-role") opts.requireServiceRole = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--project-ref") {
      const v = argv[++i];
      if (!v) throw new Error("--project-ref needs a value.");
      opts.projectRef = v;
    } else if (a.startsWith("--project-ref=")) opts.projectRef = a.slice("--project-ref=".length);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (opts.projectRef !== undefined && !REF_RE.test(opts.projectRef)) {
    throw new Error(`Invalid project ref "${opts.projectRef}" (expected 20 lowercase letters/digits).`);
  }
  return opts;
}
