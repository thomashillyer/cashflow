// Replaces the hand-authored intent stand-ins (scripts/intent-standins.ts) with real model output: one live
// call per question, written under the same cache key as the stand-in it replaces.
// Needs ANTHROPIC_API_KEY in the environment (never committed) and spends API credits. A failed call leaves
// the existing cache file for that question untouched. Mirrors scripts/refresh-signal-cache.ts.
//
//   ANTHROPIC_API_KEY=... npx tsx scripts/refresh-intent-cache.ts ["question" ...]
//
// With no arguments, every question in INTENT_STANDINS is refreshed; with arguments, those questions
// (any text; a question not in INTENT_STANDINS gets a new entry).

import Anthropic from "@anthropic-ai/sdk";
import { callIntentModel, intentCacheKey, intentContent } from "../ai/ask/intent";
import { INTENT_CACHE_DIR, writeCache } from "../ai/cache";
import { INTENT_MODEL, INTENT_PROMPT_VERSION } from "../ai/config";
import { INTENT_STANDINS } from "./intent-standins";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}

const wanted = process.argv.slice(2);
const questions = wanted.length ? wanted : INTENT_STANDINS.map((s) => s.question);
const client = new Anthropic();
let failed = 0;

for (const question of questions) {
  const content = intentContent(question);
  const key = intentCacheKey(question);
  const result = await callIntentModel(client, content, INTENT_MODEL);
  if ("problem" in result) {
    failed++;
    console.log(`FAILED ${question}: ${result.problem}`);
    continue;
  }
  writeCache(INTENT_CACHE_DIR, { key, promptVersion: INTENT_PROMPT_VERSION, model: INTENT_MODEL, source: "live", output: result.output });
  console.log(`ok     ${key}  kind=${result.output.kind}  ${question}`);
}
process.exit(failed ? 1 : 0);
