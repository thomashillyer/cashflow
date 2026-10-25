// Replaces the hand-authored brief and draft stand-ins with real model output: one live brief call and one
// live draft call per work item of the cascade_trade brief fixture, written under the same cache keys.
// Needs ANTHROPIC_API_KEY in the environment (never committed) and spends API credits. A call whose output
// fails number_check or the text rules leaves the existing cache file untouched.
//
//   ANTHROPIC_API_KEY=... npx tsx scripts/refresh-brief-cache.ts

import Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIEF_CACHE_DIR, readCache, writeCache } from "../ai/cache";
import { briefCacheKey, draftCacheKey, draftMessage, writeBrief } from "../ai/brief";
import { BRIEF_MODEL, BRIEF_PROMPT_VERSION, DRAFT_MODEL, DRAFT_PROMPT_VERSION } from "../ai/config";
import { loadBriefFixture } from "./brief-fixture";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}

const fx = loadBriefFixture();
const client = new Anthropic();
// Live calls write into a scratch directory first; only validated entries are copied over the demo cache.
const scratch = mkdtempSync(join(tmpdir(), "neri-brief-"));
const ctx = { ...fx, mode: "live" as const, client, cacheDir: scratch };
let failed = 0;

// One cache entry per item. An item whose text fell back (failed validation twice) keeps its current entry.
const brief = await writeBrief(fx.items, ctx);
for (const item of fx.items.slice(0, 3)) {
  const key = briefCacheKey(item, ctx);
  const entry = readCache(scratch, key);
  if (brief.usedFallback.includes(item.id) || !entry) {
    failed++;
    console.log(`FAILED brief ${item.id}: fallback used`);
    continue;
  }
  writeCache(BRIEF_CACHE_DIR, { ...entry, promptVersion: BRIEF_PROMPT_VERSION, model: BRIEF_MODEL });
  console.log(`ok     brief  ${item.id}  ${key}`);
}

for (const item of fx.items.slice(0, 3)) {
  const draft = await draftMessage(item, ctx);
  const key = draftCacheKey(item, ctx);
  const entry = readCache(scratch, key);
  if (draft.usedFallback || !entry) {
    failed++;
    console.log(`FAILED draft ${item.id}: fallback used`);
    continue;
  }
  writeCache(BRIEF_CACHE_DIR, { ...entry, promptVersion: DRAFT_PROMPT_VERSION, model: DRAFT_MODEL });
  console.log(`ok     draft  ${item.id}  ${key}`);
}
rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
