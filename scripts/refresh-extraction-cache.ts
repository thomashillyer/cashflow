// Replaces cached extractions with real model output: one live call per intake fixture, written under the
// same cache key. Needs ANTHROPIC_API_KEY in the environment (never committed) and spends API credits.
// A failed call leaves the existing cache file for that fixture untouched.
//
//   ANTHROPIC_API_KEY=... npx tsx scripts/refresh-extraction-cache.ts [fixture-name ...]

import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_CACHE_DIR, writeCache } from "../ai/cache";
import { callModel, extractionCacheKey } from "../ai/extract/document";
import { EXTRACTION_MODEL, PROMPT_VERSION, anthropicOptions } from "../ai/config";
import { CASCADE_BUSINESS, FIXTURE_NAMES, loadFixtureSegments } from "./cache-fixtures";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : [...FIXTURE_NAMES];
const client = new Anthropic(anthropicOptions());
let failed = 0;

for (const name of names) {
  const segments = await loadFixtureSegments(name);
  const key = extractionCacheKey(segments, CASCADE_BUSINESS);
  const result = await callModel(client, segments, CASCADE_BUSINESS, EXTRACTION_MODEL);
  if ("problem" in result) {
    failed++;
    console.log(`FAILED ${name}: ${result.problem}`);
    continue;
  }
  writeCache(DEFAULT_CACHE_DIR, { key, promptVersion: PROMPT_VERSION, model: EXTRACTION_MODEL, source: "live", output: result.output });
  console.log(`ok     ${name}  ${key}  kind=${result.output.kind}`);
}
process.exit(failed ? 1 : 0);
