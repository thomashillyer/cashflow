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
        // A hypothetical item must land inside the forecast, or the answer can only say "no change".
        const horizonEnd = new Date(Date.parse(`${meta.asOf}T00:00:00Z`) + (profile.horizonWeeks * 7 - 1) * 86_400_000).toISOString().slice(0, 10);
        if (intent.date) expect(intent.date <= horizonEnd, `${intent.date} is past ${horizonEnd}`).toBe(true);
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

// The preview engine (app/mock/engine.js) answers the same chips when the app runs without an API.
type PreviewAnswer = { text: string; missingData?: string; proposal?: { date: string }; scenario?: { run: { days: { date: string }[] } } };
const previewDir = "../../app/mock/"; // a variable path: the preview engine is plain JS with no types
describe("Ask bar example questions in the preview engine", () => {
  for (const id of ["cascade_trade", "pike_noodle"]) {
    it(`${id}: every hint gets an answer, and any plan lands inside the forecast`, async () => {
      const { createEngine } = await import(/* @vite-ignore */ `${previewDir}engine.js`);
      const fx = await import(/* @vite-ignore */ `${previewDir}${id}.js`);
      const engine = createEngine(fx);
      for (const q of ASK_HINTS) {
        const a: PreviewAnswer = await engine.ask(q);
        expect(a.missingData, q).toBeUndefined();
        expect(a.text, q).not.toMatch(/can't|don't see/i);
        if (a.proposal) expect(a.scenario?.run.days.some((d) => d.date === a.proposal!.date), q).toBe(true);
      }
    });
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
