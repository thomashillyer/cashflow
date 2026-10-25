// Owner-facing text never shows a record id ("rec-payroll") or an ISO date ("2027-01-08") (issues #174, #169),
// and "Can I make payroll?" answers yes or no first.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildBrief } from "../engine/brief";
import type { Profile } from "../schema/profile";
import type { Records } from "../schema/records";
import { askNeri } from "./ask/index";
import { writeBrief } from "./brief";
import { ASK_CACHE_DIR, BRIEF_CACHE_DIR, INTENT_CACHE_DIR } from "./cache";

const ISO = /\b\d{4}-\d{2}-\d{2}\b/;
const INTERNAL = /\brec-[a-z]|\bdailySales\b|revenueModel/;

function load(name: string) {
  const meta = JSON.parse(readFileSync(`fixtures/${name}/fixture.json`, "utf8")) as { profile: string; asOf: string; fxRates: Record<string, number> };
  const records: Records = JSON.parse(readFileSync(`fixtures/${name}/records.json`, "utf8"));
  const profile: Profile = JSON.parse(readFileSync(meta.profile, "utf8"));
  return { meta, records, profile };
}

const ask = (name: string, q: string) => {
  const { meta, records, profile } = load(name);
  return askNeri(q, {
    records, profile, asOf: meta.asOf, fxRates: meta.fxRates, pendingReviewCount: 0, business: { name },
    mode: "cache_only", cacheDirs: { intent: INTENT_CACHE_DIR, voice: ASK_CACHE_DIR }, persistProposal: async () => "sig-test",
  });
};

for (const name of ["cascade_trade", "pike_noodle"]) {
  describe(`owner words: ${name}`, () => {
    it("brief titles, reasons, flags and review text have no internal ids or ISO dates", async () => {
      const { meta, records, profile } = load(name);
      const { run, brief } = buildBrief({ profile, asOf: meta.asOf, fxRates: meta.fxRates, records, baseOverrides: [] });
      const out = await writeBrief(brief.today, { run, records, profile, business: { name }, mode: "cache_only", cacheDir: BRIEF_CACHE_DIR });
      const texts = [
        ...out.items.flatMap((i) => [i.title, i.why]),
        ...brief.all.flatMap((i) => [i.title, i.why]),
        ...run.warnings,
        ...(run.review?.reasons.map((r) => r.message) ?? []),
      ];
      expect(texts.length).toBeGreaterThan(0);
      for (const t of texts) {
        expect(t, t).not.toMatch(ISO);
        expect(t, t).not.toMatch(INTERNAL);
      }
    });

    it('"Can I make payroll?" opens with a direct yes or no and states the figure', async () => {
      const a = await ask(name, "Can I make payroll?");
      expect(a.headline).toMatch(/^(Yes|No)\b/);
      expect(a.headline).toMatch(/payroll on [A-Z][a-z]{2} \d+/);
      expect(a.headline).toMatch(/\$[\d,.]+/);
      expect(a.text).not.toMatch(ISO);
    });
  });
}

describe("payroll answer values", () => {
  it("cascade_trade: No, with the Dec 25 balance and the gap to the safety line, then the action", async () => {
    const a = await ask("cascade_trade", "Can I make payroll?");
    expect(a.headline).toBe("No: payroll on Dec 25 takes you to −$5,500, $40,500 under your $35,000 line.");
    expect(a.nextStep).toMatch(/Evergreen/);
  });
});
