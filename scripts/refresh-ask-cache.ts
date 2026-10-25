// Refreshes the Ask Neri demo caches live for the eval questions (fixtures/cascade_trade/ask/eval.json): runs
// askNeri end to end in live mode (intent, decision, voice) with scratch cache directories, then copies the
// validated intent and voice entries into the committed caches (INTENT_CACHE_DIR, ASK_CACHE_DIR).
// Needs ANTHROPIC_API_KEY in the environment (never committed) and spends API credits. A question whose
// answer fell back to the code-built voice keeps its existing voice cache entry (none is written for it).
//
//   ANTHROPIC_API_KEY=... npx tsx scripts/refresh-ask-cache.ts ["question" ...]
//
// With no arguments, every eval question and every Ask bar example (app/catalog/ask-hints.js) is refreshed.

import Anthropic from "@anthropic-ai/sdk";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_HINTS } from "../app/catalog/ask-hints.js";
import { askNeri } from "../ai/ask/index";
import { intentCacheKey } from "../ai/ask/intent";
import { ASK_CACHE_DIR, INTENT_CACHE_DIR } from "../ai/cache";
import type { Profile } from "../schema/profile";
import type { Records } from "../schema/records";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}

const dir = join(import.meta.dirname, "../fixtures/cascade_trade");
const records: Records = JSON.parse(readFileSync(join(dir, "records.json"), "utf8"));
const meta = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8")) as { asOf: string; fxRates: Record<string, number> };
const profile: Profile = JSON.parse(readFileSync(join(import.meta.dirname, "../profiles/trading.json"), "utf8"));
const evalSet = JSON.parse(readFileSync(join(dir, "ask/eval.json"), "utf8")) as { id: string; question: string }[];

const wanted = process.argv.slice(2);
const questions = wanted.length ? wanted : [...new Set([...evalSet.map((e) => e.question), ...ASK_HINTS])];
const client = new Anthropic();
const scratch = mkdtempSync(join(tmpdir(), "neri-ask-"));
const intentDir = join(scratch, "intent");
const voiceDir = join(scratch, "voice");
let failed = 0;

for (const question of questions) {
  const a = await askNeri(question, {
    records, profile, asOf: meta.asOf, fxRates: meta.fxRates, pendingReviewCount: 0, business: { name: "Cascade Trade Co." },
    mode: "live", client, cacheDirs: { intent: intentDir, voice: voiceDir },
    persistProposal: async () => "refresh-script-not-persisted",
  });
  const key = intentCacheKey(question);
  try {
    copyFileSync(join(intentDir, `${key}.json`), join(INTENT_CACHE_DIR, `${key}.json`));
    console.log(`ok     ${key}  verdict=${a.verdict}  voice=${a.usedFallback ? "code-built" : "model"}  ${question}`);
  } catch {
    failed++;
    console.log(`FAILED ${question}: no intent entry written (the call failed)`);
  }
}
try {
  for (const f of readdirSync(voiceDir).filter((x) => x.endsWith(".json"))) copyFileSync(join(voiceDir, f), join(ASK_CACHE_DIR, f));
} catch {
  // No model-voiced answers were produced.
}
rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
