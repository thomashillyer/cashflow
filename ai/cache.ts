// File-based response cache for model calls (docs/design/08-claude-layer.md: "Demo safety and cost").
// The key is a hash of everything that determines the answer, so a changed prompt version, model,
// business identity, or source text is a miss. Entries are plain JSON files so they can be committed
// as demo fixtures and read without a network or an API key.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Committed demo entries for the synthetic fixtures. Read as a fallback; nothing at runtime writes here.
export const DEFAULT_CACHE_DIR = join(import.meta.dirname, "../fixtures/cascade_trade/intake/cache");

// Committed demo entries for brief text and drafts (ai/brief.ts), hand-authored stand-ins until refreshed live.
export const BRIEF_CACHE_DIR = join(import.meta.dirname, "../fixtures/cascade_trade/brief/cache");

// Where live extractions of real documents are stored. Gitignored (data/private/): the entries contain
// names, amounts, and quotes from the owner's documents.
export const LIVE_CACHE_DIR = join(import.meta.dirname, "../data/private/ai-cache");

// JSON with object keys sorted at every level and undefined dropped, so equal inputs hash equally.
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

export function cacheKey(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export type CacheEntry = {
  key: string;
  promptVersion: string;
  model: string;
  // How the entry was produced: "live" for an API response, or a note for hand-authored stand-ins.
  source: string;
  output: unknown;
};

const KEY_RE = /^[0-9a-f]{64}$/;

const pathFor = (dir: string, key: string): string => {
  if (!KEY_RE.test(key)) throw new Error(`invalid cache key: ${key}`);
  return join(dir, `${key}.json`);
};

// The entry for `key`, or undefined when absent or unreadable. A corrupt file is a miss, not an error.
export function readCache(dir: string, key: string): CacheEntry | undefined {
  const file = pathFor(dir, key);
  if (!existsSync(file)) return undefined;
  try {
    const entry = JSON.parse(readFileSync(file, "utf8")) as Partial<CacheEntry> | null;
    if (!entry || entry.key !== key || !("output" in entry)) return undefined;
    return entry as CacheEntry;
  } catch {
    return undefined;
  }
}

export function writeCache(dir: string, entry: CacheEntry): void {
  const file = pathFor(dir, entry.key);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2) + "\n");
  renameSync(tmp, file); // atomic: a reader never sees a half-written entry
}

// Committed demo entries for Ask Neri's CFO voice (ai/ask/voice.ts), hand-authored stand-ins until refreshed live.
export const ASK_CACHE_DIR = join(import.meta.dirname, "../fixtures/cascade_trade/ask/cache");
