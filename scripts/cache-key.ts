// Prints the response-cache key of each intake fixture, and with --write stores the hand-authored
// stand-ins (scripts/cache-standins.ts) under those keys.
//
//   npx tsx scripts/cache-key.ts            # print keys
//   npx tsx scripts/cache-key.ts --write    # also write fixtures/cascade_trade/intake/cache/<key>.json

import { DEFAULT_CACHE_DIR, writeCache } from "../ai/cache";
import { extractionCacheKey } from "../ai/extract/document";
import { EXTRACTION_MODEL, PROMPT_VERSION } from "../ai/config";
import { CASCADE_BUSINESS, FIXTURE_NAMES, loadFixtureSegments } from "./cache-fixtures";
import { STANDINS } from "./cache-standins";

const write = process.argv.includes("--write");

for (const name of FIXTURE_NAMES) {
  const key = extractionCacheKey(await loadFixtureSegments(name), CASCADE_BUSINESS);
  const standin = STANDINS[name];
  console.log(`${key}  ${name}${standin ? "" : "  (no stand-in)"}`);
  if (write && standin) {
    writeCache(DEFAULT_CACHE_DIR, {
      key, promptVersion: PROMPT_VERSION, model: EXTRACTION_MODEL,
      source: `hand-authored stand-in for ${name}; replace with a live run (scripts/refresh-extraction-cache.ts)`,
      output: standin,
    });
  }
}
