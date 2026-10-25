import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Commitment, Evidence, Party, Records } from "../schema/records";

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

// One Cascade Trade Co. across lanes (#74): the intake slice and the engine fixture are written by the same generator
// (scripts/make-engine-fixtures.ts), so ingesting the intake files onto records.json links instead of duplicating.
describe("intake base records agree with the engine fixture", () => {
  const records = JSON.parse(readFileSync(join(root, "fixtures/cascade_trade/records.json"), "utf8")) as Records;
  const intakeDir = join(root, "fixtures/cascade_trade/intake");

  it("every base party is the same party in records.json", () => {
    for (const p of base.parties) expect(records.parties.find((x) => x.id === p.id), p.id).toEqual(p);
  });

  it("every base commitment is in records.json with the same identity, amount, and dates", () => {
    const keep = (c: Commitment) => ({ type: c.type, direction: c.direction, reference: c.reference, partyId: c.partyId, amount: c.amount, currency: c.currency, anchors: c.anchors, sourceRef: c.sourceRef });
    for (const c of base.commitments) {
      const r = records.commitments.find((x) => x.id === c.id);
      expect(r, c.id).toBeDefined();
      expect(keep(r!), c.id).toEqual(keep(c));
    }
  });

  it("each signal's excerpt slices the intake file it cites", () => {
    const files = readdirSync(intakeDir);
    expect(records.signals.length).toBeGreaterThan(0);
    for (const s of records.signals) {
      const file = files.find((f) => `ev-${f.replace(/\.[^.]+$/, "")}` === s.sourceRef.record);
      expect(file, s.id).toBeDefined();
      const x = s.sourceRef.excerpt!;
      expect(readFileSync(join(intakeDir, file!), "utf8").slice(x.start, x.end), s.id).toBe(x.text);
    }
  });
});
