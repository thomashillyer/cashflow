// Replaces the hand-authored voice stand-ins (scripts/make-voice-standins.ts) with real model output: one live
// call per model-voiced Decision of the cascade_trade ask fixture, written under the same cache keys.
// Needs ANTHROPIC_API_KEY in the environment (never committed) and spends API credits. A Decision whose output
// fails the checks (voice() fell back to code-built text) leaves the existing cache file untouched.
//
//   ANTHROPIC_API_KEY=... npx tsx scripts/refresh-voice-cache.ts

import Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_CACHE_DIR, readCache, writeCache } from "../ai/cache";
import { CFO_VOICE_MODEL, CFO_VOICE_PROMPT_VERSION, anthropicOptions } from "../ai/config";
import { voice, voiceCacheKey } from "../ai/ask/voice";
import { loadAskFixture } from "./ask-fixture";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}

const fx = loadAskFixture();
const client = new Anthropic(anthropicOptions());
// Live calls write into a scratch directory first; only validated entries are copied over the demo cache.
const scratch = mkdtempSync(join(tmpdir(), "neri-voice-"));
const ctx = { profile: fx.profile, business: fx.business, mode: "live" as const, client, cacheDir: scratch };
let failed = 0;

for (const { id, decision } of fx.entries) {
  if (["need_info", "decline", "proposed"].includes(decision.verdict)) continue; // code-built, never cached
  const answer = await voice(decision, ctx);
  const key = voiceCacheKey(decision, ctx);
  const entry = readCache(scratch, key);
  if (answer.usedFallback || !entry) {
    failed++;
    console.log(`FAILED ${id}: fallback used`);
    continue;
  }
  writeCache(ASK_CACHE_DIR, { ...entry, promptVersion: CFO_VOICE_PROMPT_VERSION, model: CFO_VOICE_MODEL });
  console.log(`ok     ${id}  ${key}`);
}
rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
