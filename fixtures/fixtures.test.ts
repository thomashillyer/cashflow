import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Commitment, Evidence, Party } from "../schema/records";

const root = join(import.meta.dirname, "..");
const cases = JSON.parse(readFileSync(join(root, "fixtures/expected/intake/cases.json"), "utf8"));
const base = JSON.parse(readFileSync(join(root, cases.baseRecords), "utf8")) as {
  parties: Party[]; commitments: Commitment[]; evidence: Evidence[];
};

describe("intake fixtures", () => {
  it("every case input exists", () => {
    for (const c of cases.cases) {
      for (const input of c.inputs) {
        expect(existsSync(join(root, "fixtures/cascade_trade/intake", input)), `${c.id}: ${input}`).toBe(true);
      }
    }
  });

  it("every expected target exists in the base records", () => {
    const ids = new Set(base.commitments.map((c) => c.id));
    for (const c of cases.cases) if (c.expect.target) expect(ids.has(c.expect.target), c.id).toBe(true);
  });

  it("base records reference known parties and use minor units", () => {
    const parties = new Set(base.parties.map((p) => p.id));
    for (const c of base.commitments) {
      expect(parties.has(c.partyId!)).toBe(true);
      expect(Number.isInteger(c.amount)).toBe(true);
    }
  });
});
