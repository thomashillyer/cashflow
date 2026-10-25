// Stand-ins for the Ask Neri eval questions (fixtures/cascade_trade/ask/eval.json) whose voice cache entry is
// missing or no longer passes checkVoice (a prompt or fact change alters the cache key). The stand-in is the
// code-built voice for the real engine Decision, marked source "stand-in". It exists so the demo shows the
// same words with or without a key; `npx tsx scripts/refresh-ask-cache.ts` replaces it with live model output.
//
//   npx tsx scripts/eval-voice-standins.ts           # list the eval questions that miss
//   npx tsx scripts/eval-voice-standins.ts --write   # write stand-ins for the misses

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASK_CACHE_DIR, INTENT_CACHE_DIR, readCache, writeCache } from "../ai/cache";
import { CFO_VOICE_MODEL, CFO_VOICE_PROMPT_VERSION } from "../ai/config";
import { decide } from "../ai/ask/decide";
import { readIntent } from "../ai/ask/intent";
import { checkVoice, fallbackVoice, voiceCacheKey } from "../ai/ask/voice";
import type { Profile } from "../schema/profile";
import type { Records } from "../schema/records";
import { ASK_BUSINESS } from "./ask-fixture";

const dir = join(import.meta.dirname, "../fixtures/cascade_trade");
const records: Records = JSON.parse(readFileSync(join(dir, "records.json"), "utf8"));
const meta = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8")) as { asOf: string; fxRates: Record<string, number> };
const profile: Profile = JSON.parse(readFileSync(join(import.meta.dirname, "../profiles/trading.json"), "utf8"));
const evalSet = JSON.parse(readFileSync(join(dir, "ask/eval.json"), "utf8")) as { id: string; question: string }[];
const write = process.argv.includes("--write");

const CODE_BUILT = new Set(["need_info", "decline", "proposed"]);
let missing = 0;
for (const e of evalSet) {
  const intent = await readIntent(e.question, { records, profile, asOf: meta.asOf, mode: "cache_only", cacheDir: INTENT_CACHE_DIR });
  const d = decide(intent, { records, profile, asOf: meta.asOf, fxRates: meta.fxRates, pendingReviewCount: 0 });
  if (CODE_BUILT.has(d.verdict)) continue;
  const key = voiceCacheKey(d, { profile, business: ASK_BUSINESS });
  const hit = readCache(ASK_CACHE_DIR, key);
  const v = fallbackVoice(d);
  if (hit && typeof hit.output === "object" && hit.output !== null && !checkVoice(hit.output as never, d).length) continue;
  missing++;
  const problems = checkVoice(v, d);
  console.log(`${write ? "write" : "miss "}  ${e.id}  ${key}${problems.length ? `  CODE-BUILT VOICE FAILS: ${problems.join("; ")}` : ""}`);
  if (problems.length) { process.exitCode = 1; continue; }
  if (write) {
    writeCache(ASK_CACHE_DIR, {
      key, promptVersion: CFO_VOICE_PROMPT_VERSION, model: CFO_VOICE_MODEL, source: "stand-in",
      output: { headline: v.headline, why: v.why, nextStep: v.nextStep ?? null, convictionNote: v.convictionNote, whatWouldChange: v.whatWouldChange ?? null },
    });
  }
}
console.log(`${missing} eval question(s) without a passing voice cache entry`);
