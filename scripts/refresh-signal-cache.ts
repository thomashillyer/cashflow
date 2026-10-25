// Replaces the hand-authored signal stand-ins (scripts/signal-standins.ts) with real model output: one live
// call per message that passes triage, written under the same cache key as the stand-in it replaces.
// Needs ANTHROPIC_API_KEY in the environment (never committed) and spends API credits. A failed call leaves
// the existing cache file for that message untouched. Mirrors scripts/refresh-extraction-cache.ts.
//
//   ANTHROPIC_API_KEY=... npx tsx scripts/refresh-signal-cache.ts [fixture-name ...]
//
// Fixture names: whatsapp-evergreen.txt, owner-message-inv104.txt, email-injection.eml

import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_CACHE_DIR, writeCache } from "../ai/cache";
import { EXTRACTION_MODEL, SIGNAL_PROMPT_VERSION, anthropicOptions } from "../ai/config";
import { callSignalModel, messageUnits, signalCacheKey } from "../ai/extract/signals";
import { loadSignalBundle, SIGNAL_STANDINS, type SignalFixture } from "./signal-standins";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}

const known = Object.keys(SIGNAL_STANDINS) as SignalFixture[];
const wanted = process.argv.slice(2);
const unknown = wanted.filter((n) => !known.includes(n as SignalFixture));
if (unknown.length) {
  console.error(`Unknown fixture(s): ${unknown.join(", ")}. Known: ${known.join(", ")}`);
  process.exit(1);
}
const names = wanted.length ? (wanted as SignalFixture[]) : known;
const client = new Anthropic(anthropicOptions());
let failed = 0;

for (const name of names) {
  for (const unit of messageUnits(loadSignalBundle(name), SIGNAL_STANDINS[name].channel)) {
    const key = signalCacheKey(unit.content);
    const result = await callSignalModel(client, unit.content, EXTRACTION_MODEL);
    if ("problem" in result) {
      failed++;
      console.log(`FAILED ${name} ${unit.label}: ${result.problem}`);
      continue;
    }
    writeCache(DEFAULT_CACHE_DIR, { key, promptVersion: SIGNAL_PROMPT_VERSION, model: EXTRACTION_MODEL, source: "live", output: result.output });
    console.log(`ok     ${name} ${unit.label}  ${key}  claim=${result.output.claim}`);
  }
}
process.exit(failed ? 1 : 0);
