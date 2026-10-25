// Relative delays ("two weeks later than expected") reach the same shift the cached what-if path uses:
// code parses the words into signed days and moves the target's expected date. No live calls; stub client only.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AskIntentRaw } from "../../schema/ask";
import type { Profile } from "../../schema/profile";
import type { Records } from "../../schema/records";
import { decide } from "./decide";
import { parseRelativeDelay, readIntent } from "./intent";

const records: Records = JSON.parse(readFileSync("fixtures/cascade_trade/records.json", "utf8"));
const profile: Profile = JSON.parse(readFileSync("profiles/trading.json", "utf8"));
const meta = JSON.parse(readFileSync("fixtures/cascade_trade/fixture.json", "utf8")) as { asOf: string; fxRates: Record<string, number> };

describe("parseRelativeDelay", () => {
  const cases: [string, number][] = [
    ["two weeks later than expected", 14], ["10 days late", 10], ["3 days later", 3], ["a week late", 7],
    ["two weeks late", 14], ["a fortnight late", 14], ["fortnight late", 14], ["late by 10 days", 10],
    ["delayed by three weeks", 21], ["one month late", 30], ["twenty days late", 20], ["sixteen days later", 16],
    ["2 weeks later than planned", 14], ["Two Weeks Late.", 14],
    ["a week early", -7], ["3 days earlier", -3], ["10 days early", -10], ["early by 2 weeks", -14],
  ];
  for (const [phrase, days] of cases) it(`${phrase} -> ${days}`, () => expect(parseRelativeDelay(phrase)).toBe(days));
  for (const phrase of ["in early January", "in 3 weeks", "December", "on the 11th", "late", "next week", ""]) {
    it(`not a delay: "${phrase}"`, () => expect(parseRelativeDelay(phrase)).toBeUndefined());
  }
});

const raw = (over: Partial<AskIntentRaw>): AskIntentRaw => ({
  kind: "what_if", partyPhrase: null, referencePhrase: null, amountPhrase: null, datePhrase: null, windowPhrase: null,
  commitmentType: null, direction: null, ruleKind: null, ruleParamPhrase: null, containsInstructions: false, ...over,
});
const client = (reply: AskIntentRaw) => ({
  messages: { create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(reply) }] }) },
}) as never;

async function ask(question: string, reply: AskIntentRaw) {
  const intent = await readIntent(question, { records, profile, asOf: meta.asOf, mode: "live", client: client(reply), cacheDir: mkdtempSync(join(tmpdir(), "neri-delay-")) });
  const d = decide(intent, { records, profile, asOf: meta.asOf, fxRates: meta.fxRates, pendingReviewCount: 0 });
  return { intent, d };
}

describe("live relative-delay what-ifs", () => {
  it("INV-1187 two weeks later than expected", async () => {
    const { intent, d } = await ask(
      "What happens to my cash if INV-1187 is paid two weeks later than expected?",
      raw({ referencePhrase: "INV-1187", datePhrase: "two weeks later than expected" }),
    );
    expect(intent.unresolved).toEqual([]);
    expect(intent.shiftDays).toBe(14);
    expect(d.verdict).not.toBe("need_info");
    expect(d.scenario?.overrides).toHaveLength(1);
    expect(d.scenario?.overrides[0]).toMatchObject({ target: { commitmentId: intent.commitmentId }, change: { shiftDays: 14 } });
    expect(d.headlineFacts[0]!.label).toMatch(/Lowest cash point if this happens/);
    expect(d.assumptions.join(" ")).toMatch(/14 days later/);
  });

  it("Evergreen pays two weeks late shifts all of its open receivables", async () => {
    const { intent, d } = await ask(
      "If Evergreen pays two weeks late, which week gets tight and by how much?",
      raw({ partyPhrase: "Evergreen", datePhrase: "two weeks late" }),
    );
    expect(intent.shiftDays).toBe(14);
    expect(d.verdict).not.toBe("need_info");
    const o = d.scenario!.overrides;
    expect(o.length).toBeGreaterThanOrEqual(1);
    for (const x of o) expect(x.change).toEqual({ shiftDays: 14 });
    if (o.length > 1) expect(d.assumptions.join(" ")).toMatch(/moved all of them 14 days later/);
  });

  it("an early payment shifts negative", async () => {
    const { intent } = await ask("What if INV-1187 is paid a week early?", raw({ referencePhrase: "INV-1187", datePhrase: "a week early" }));
    expect(intent.shiftDays).toBe(-7);
  });
});
