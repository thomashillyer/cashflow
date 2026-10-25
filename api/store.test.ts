// MemoryStore: saved overrides round-trip, validation on write, and re-imports keep them.

import { describe, expect, it } from "vitest";
import type { Override } from "../schema/records";
import { loadSample } from "./demo";
import { MemoryStore, type DecisionWrite } from "./store";
import type { ChangeProposal } from "../schema/intake";
import type { Signal } from "../schema/records";

const ov = (id: string, change: Override["change"], extra: Partial<Override> = {}): Override =>
  ({ id, target: { commitmentId: "inv-INV-1187" }, change, origin: "owner", ...extra });

describe("MemoryStore overrides", () => {
  it("round-trips, is isolated per business and survives upsertRecords", async () => {
    const store = new MemoryStore();
    const s = loadSample("cascade_trade")!;
    const a = await store.createBusiness({ name: "A", profile: s.profile, isSynthetic: false });
    const b = await store.createBusiness({ name: "B", profile: s.profile, isSynthetic: false });
    expect(await store.loadOverrides(a)).toEqual([]);
    const list = [ov("o1", { date: "2026-12-01" }), ov("o2", { amount: 150000 }, { target: { commitmentId: "inv-INV-1187", legIndex: 0 }, originId: "th-1" })];
    await store.saveOverrides(a, list);
    expect(await store.loadOverrides(a)).toEqual(list);
    expect(await store.loadOverrides(b)).toEqual([]);

    // The returned list is a copy.
    (await store.loadOverrides(a))[0]!.change.date = "2027-01-01";
    expect((await store.loadOverrides(a))[0]!.change.date).toBe("2026-12-01");

    await store.upsertRecords(a, s.records);
    await store.upsertRecords(a, s.records);
    expect(await store.loadOverrides(a)).toEqual(list);

    await store.saveOverrides(a, []);
    expect(await store.loadOverrides(a)).toEqual([]);
  });

  it("rejects bad shapes and duplicate ids, keeping the old list", async () => {
    const store = new MemoryStore();
    const id = await store.createBusiness({ name: "A", profile: loadSample("cascade_trade")!.profile, isSynthetic: false });
    await store.saveOverrides(id, [ov("o1", { exclude: true })]);
    const bad: unknown[] = [
      [ov("o1", { exclude: true }), ov("o1", { shiftDays: 3 })],
      [ov("o2", { amount: 1.5 })],
      [ov("o2", { date: "2026-13-01" })],
      [{ ...ov("o2", { exclude: true }), extra: 1 }],
      [ov("o2", { exclude: true }, { origin: "bank" as Override["origin"] })],
      "not a list",
    ];
    for (const list of bad) {
      await expect(store.saveOverrides(id, list as Override[])).rejects.toMatchObject({ status: 400, code: "INVALID_ARGUMENT" });
    }
    expect(await store.loadOverrides(id)).toEqual([ov("o1", { exclude: true })]);
  });
});

describe("MemoryStore bumpRevisionIf", () => {
  it("bumps only from the expected revision", async () => {
    const store = new MemoryStore();
    const id = await store.createBusiness({ name: "A", profile: loadSample("cascade_trade")!.profile, isSynthetic: false });
    const r = (await store.load(id)).storeRevision;
    expect(await store.bumpRevisionIf(id, r)).toBe(r + 1);
    expect(await store.bumpRevisionIf(id, r)).toBeNull();
    expect((await store.load(id)).storeRevision).toBe(r + 1);
  });
});

describe("MemoryStore commitDecision", () => {
  const setupBiz = async () => {
    const store = new MemoryStore();
    const s = loadSample("cascade_trade")!;
    const id = await store.createBusiness({ name: "A", profile: s.profile, isSynthetic: false });
    await store.upsertRecords(id, s.records);
    const signal = s.records.signals[0]!;
    const proposal = { id: "cp-1", state: "proposed" } as unknown as ChangeProposal;
    await store.saveProposals(id, [proposal]);
    return { store, id, signal, proposal };
  };
  const decision = (over: Partial<DecisionWrite>, signal: Signal, proposal: ChangeProposal): DecisionWrite => ({
    expectedRevision: 0, idempotencyKey: "k", requestHash: "h", records: { signals: [{ ...signal, state: "applied" }] },
    proposals: [{ ...proposal, state: "confirmed" }], response: { ok: true }, ...over,
  });

  it("a stale commit changes neither the records nor the proposal", async () => {
    const { store, id, signal, proposal } = await setupBiz();
    const { storeRevision } = await store.load(id);
    const before = JSON.stringify(await store.load(id));
    const r = await store.commitDecision(id, decision({ expectedRevision: storeRevision - 1 }, signal, proposal));
    expect(r).toEqual({ kind: "stale", storeRevision });
    expect(JSON.stringify(await store.load(id))).toBe(before);
    expect((await store.listProposals(id))[0]!.state).toBe("proposed");
    // A rejected commit does not burn the key.
    expect((await store.commitDecision(id, decision({ expectedRevision: storeRevision }, signal, proposal))).kind).toBe("ok");
  });

  it("ok bumps once, then replays after the revision moved, and flags a different hash", async () => {
    const { store, id, signal, proposal } = await setupBiz();
    const { storeRevision } = await store.load(id);
    const ok = await store.commitDecision(id, decision({ expectedRevision: storeRevision }, signal, proposal));
    expect(ok).toEqual({ kind: "ok", storeRevision: storeRevision + 1, response: { ok: true, storeRevision: storeRevision + 1 } });
    await store.bumpRevision(id);
    const replay = await store.commitDecision(id, decision({ expectedRevision: storeRevision }, signal, proposal));
    expect(replay).toEqual({ kind: "replay", response: { ok: true, storeRevision: storeRevision + 1 } });
    expect((await store.commitDecision(id, decision({ expectedRevision: storeRevision, requestHash: "other" }, signal, proposal))).kind).toBe("conflict");
    expect((await store.load(id)).storeRevision).toBe(storeRevision + 2);
  });
});
