// The genericity loop for warnings and ranking: buildBrief runs on every fixture with zero code changes.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Profile } from "../schema/profile";
import type { Records } from "../schema/records";
import { buildBrief } from "./brief";

const root = join(import.meta.dirname, "..");
const read = <T>(path: string): T => JSON.parse(readFileSync(join(root, path), "utf8")) as T;
const names = readdirSync(join(root, "fixtures")).filter((n) => existsSync(join(root, "fixtures", n, "fixture.json")));

function load(name: string) {
  const meta = read<{ profile: string; asOf: string; fxRates: Record<string, number> }>(`fixtures/${name}/fixture.json`);
  return { records: read<Records>(`fixtures/${name}/records.json`), profile: read<Profile>(meta.profile),
    asOf: meta.asOf, fxRates: meta.fxRates };
}

describe.each(names)("brief for fixture %s", (name) => {
  const input = load(name);
  const { run, brief } = buildBrief(input);

  it("is deterministic and does not mutate its inputs", () => {
    const before = JSON.stringify(input.records);
    expect(buildBrief(input).brief).toEqual(brief);
    expect(JSON.stringify(input.records)).toBe(before);
  });

  it("leads with at most three open lever items that raise cash, best first", () => {
    expect(brief.today.length).toBeLessThanOrEqual(3);
    for (const w of brief.today) {
      expect(w.lever).toBeDefined();
      expect(w.cashEffect).toBeGreaterThan(0);
      expect(w.score).toBeGreaterThanOrEqual(input.profile.thresholds.rankFloor);
    }
    const scores = brief.all.map((w) => w.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("traces every item to records in the run", () => {
    const known = new Set([
      ...input.records.commitments.map((c) => c.id), ...input.records.parties.map((p) => p.id),
      ...input.records.signals.map((s) => s.id), ...run.events.map((e) => e.id),
    ]);
    for (const w of brief.all) for (const ref of w.evidenceRefs) expect(known).toContain(ref);
  });

  it("never offers to defer a non-deferrable payment", () => {
    const fixed = new Set(input.profile.recurring.filter((r) => r.nonDeferrable).map((r) => r.id));
    for (const w of brief.all) if (w.lever?.kind === "defer") expect(fixed).not.toContain(w.lever.commitmentId);
  });

  it("keeps a done item done on the next run", () => {
    const first = brief.today[0];
    if (!first) return;
    const again = buildBrief({ ...input, prior: [{ id: first.id, state: "done" }] }).brief;
    expect(again.today.map((w) => w.id)).not.toContain(first.id);
    expect(again.all.find((w) => w.id === first.id)?.state).toBe("done");
  });
});

it("tells the cascade_trade story: chase Evergreen's late INV-1187 first (design 10)", () => {
  const { brief } = buildBrief(load("cascade_trade"));
  expect(brief.today[0]).toMatchObject({
    id: "wi-projected_cash_gap-chase-inv-INV-1187",
    lever: { kind: "chase", commitmentId: "inv-INV-1187", assumeDate: "2026-12-10" },
    cashEffect: 1_950_000,
  });
});
