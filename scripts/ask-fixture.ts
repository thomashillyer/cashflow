// The Ask Neri voice fixture for cascade_trade (fixtures/cascade_trade/ask/): hand-built Decisions plus the
// profile. Shared by the cache scripts and ai/ask/voice.test.ts so the cache keys line up exactly.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Decision } from "../schema/ask";
import type { Profile } from "../schema/profile";

export const ASK_DIR = join(import.meta.dirname, "../fixtures/cascade_trade/ask");
export const ASK_BUSINESS = { name: "Cascade Trade Co." };

export type AskFixtureEntry = { id: string; question: string; decision: Decision };

export function loadAskFixture() {
  return {
    entries: JSON.parse(readFileSync(join(ASK_DIR, "decisions.json"), "utf8")) as AskFixtureEntry[],
    profile: JSON.parse(readFileSync(join(import.meta.dirname, "../profiles/trading.json"), "utf8")) as Profile,
    business: ASK_BUSINESS,
  };
}
