// The Ask bar's example questions (app/catalog/ask-hints.js) must get a real answer in demo mode (no API
// key, cache_only) for every sample business: each has a committed intent entry, and none comes back as a
// decline or a follow-up question. Issue #164.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASK_HINTS } from "../../app/catalog/ask-hints.js";
import { INTENT_STANDINS } from "../../scripts/intent-standins";
import type { Profile } from "../../schema/profile";
import type { Records } from "../../schema/records";
import { ASK_CACHE_DIR, INTENT_CACHE_DIR, readCache } from "../cache";
import { askNeri } from "./index";
import { intentCacheKey, readIntent } from "./intent";

const fixtures = readdirSync("fixtures").filter((d) => existsSync(`fixtures/${d}/fixture.json`) && existsSync(`fixtures/${d}/records.json`));

describe("Ask bar example questions", () => {
  it("are three, each with an intent stand-in and a committed cache entry", () => {
    expect(ASK_HINTS).toHaveLength(3);
    for (const q of ASK_HINTS) {
      expect(INTENT_STANDINS.map((s) => s.question)).toContain(q);
      expect(readCache(INTENT_CACHE_DIR, intentCacheKey(q)), q).toBeDefined();
    }
  });

  for (const name of fixtures) {
    const meta = JSON.parse(readFileSync(`fixtures/${name}/fixture.json`, "utf8")) as { profile: string; asOf: string; fxRates: Record<string, number> };
    const records: Records = JSON.parse(readFileSync(`fixtures/${name}/records.json`, "utf8"));
    const profile: Profile = JSON.parse(readFileSync(meta.profile, "utf8"));
    for (const q of ASK_HINTS) {
      it(`${name}: ${q}`, async () => {
        const intent = await readIntent(q, { records, profile, asOf: meta.asOf, mode: "cache_only", cacheDir: INTENT_CACHE_DIR });
        expect(intent.unresolved).toEqual([]);
        const a = await askNeri(q, {
          records, profile, asOf: meta.asOf, fxRates: meta.fxRates, pendingReviewCount: 0, business: { name },
          mode: "cache_only", cacheDirs: { intent: INTENT_CACHE_DIR, voice: ASK_CACHE_DIR },
          persistProposal: async () => "sig-test",
        });
        expect(["decline", "need_info"]).not.toContain(a.verdict);
        expect(a.headline).not.toMatch(/can't answer/i);
        expect(a.citations.length).toBeGreaterThan(0);
      });
    }
  }
});

describe("a question demo mode has no saved answer for", () => {
  const meta = JSON.parse(readFileSync("fixtures/cascade_trade/fixture.json", "utf8")) as { profile: string; asOf: string; fxRates: Record<string, number> };
  const records: Records = JSON.parse(readFileSync("fixtures/cascade_trade/records.json", "utf8"));
  const profile: Profile = JSON.parse(readFileSync(meta.profile, "utf8"));

  it("says so, not that it is investment or loan advice", async () => {
    const a = await askNeri("Is there a question nobody has cached yet?", {
      records, profile, asOf: meta.asOf, fxRates: meta.fxRates, pendingReviewCount: 0, business: { name: "Cascade Trade Co." },
      mode: "cache_only", cacheDirs: { intent: INTENT_CACHE_DIR, voice: ASK_CACHE_DIR },
      persistProposal: async () => "sig-test",
    });
    expect(a.verdict).toBe("decline");
    expect(a.why).toContain("demo mode has no saved answer");
    expect(a.text).not.toMatch(/investment|loan|won't advise/i);
  });
});
