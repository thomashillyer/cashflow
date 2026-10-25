import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Profile } from "../schema/profile";
import type { Records } from "../schema/records";
import type { AskIntentRaw } from "../schema/ask";
import { forecast } from "../engine/forecast";
import { resolveIntent } from "../ai/ask/intent";
import { ownerSignal, readThought } from "./thoughts";
import { buildApp } from "./app";
import { MemoryStore } from "./store";

const profile = JSON.parse(readFileSync(new URL("../profiles/trading.json", import.meta.url), "utf8")) as Profile;
const asOf = "2026-10-25";
const empty: Records = { parties: [], commitments: [], events: [], signals: [], rules: [], settlements: [], balances: [], evidence: [] };
const incoming = [
  ["im expecting a 50k loan next week", 5_000_000],
  ["add a 100k inbound loan received next week", 10_000_000],
  ["i am getting 50k next week", 5_000_000],
  ["i have a loan next week in for 100 k", 10_000_000],
  ["I expect a 50k loan to buy equipment next week", 5_000_000],
] as const;

describe("owner cash direction", () => {
  it.each(incoming)("reads the screenshot's incoming cash: %s", (text, amount) => {
    const reading = readThought(text, empty, asOf);
    expect(reading).toMatchObject({ direction: "in", amount, date: "2026-11-01", missing: [] });
    expect(reading.kind).not.toBe("note");
    const signal = ownerSignal("receipt", { text, createdAt: asOf }, reading, profile, "applied")!;
    expect(signal.claim).toMatchObject({ kind: "plan", draft: { type: "plan", direction: "in", amount } });
    const run = forecast({ ...empty, signals: [signal] }, { ...profile, recurring: [] }, { id: "base", kind: "base", overrides: [] }, asOf, {});
    expect(run.events.filter(e => e.direction === "in")).toHaveLength(1);
    expect(run.events.filter(e => e.direction === "out")).toHaveLength(0);
    expect(run.days.at(-1)!.closing).toBe(amount);
  });

  it.each([
    "I will repay a 50k loan next week", "Loan repayment of 50k next week",
    "I am lending 50k next week", "I am getting a 50k forklift next week",
    "I expect to pay a 50k deposit next week",
    "I expect a 50k expense next week",
    "I expect a 50k tax payment next week",
    "Acme is borrowing 50k from us next week",
  ])("keeps payments outgoing: %s", text => {
    expect(readThought(text, empty, asOf)).toMatchObject({ direction: "out", amount: 5_000_000 });
  });

  it.each(["A 50k loan next week", "I am not receiving a 50k loan next week", "I will not be receiving a 50k loan next week", "Acme is not borrowing 50k from us next week"])("asks for direction instead of guessing: %s", text => {
    const reading = readThought(text, empty, asOf);
    expect(reading.direction).toBeNull();
    expect(reading.missing).toContain("direction");
    expect(ownerSignal("unknown", { text, createdAt: asOf }, reading, profile, "applied")).toBeNull();
  });

  it("keeps expected orders possible, and receiving a document is not receiving cash", () => {
    expect(readThought("We are expecting a 50k order from Acme next week", empty, asOf)).toMatchObject({ kind: "new_business", direction: "in", status: "possible" });
    expect(readThought("I am receiving a 50k invoice from Acme next week", empty, asOf).direction).not.toBe("in");
    expect(readThought("They are sending a 50k invoice to us next week", empty, asOf).direction).not.toBe("in");
  });

  it.each(["I expect a 50k loan repayment from Acme next week", "I am receiving a 50k loan repayment next week"])("receives repayments without labeling them new financing: %s", text => {
    const reading = readThought(text, empty, asOf);
    expect(reading.direction).toBe("in");
    const signal = ownerSignal("repaid", { text, createdAt: asOf }, reading, profile, "applied")!;
    expect(signal.claim).toMatchObject({ kind: "plan", draft: { direction: "in" } });
    if (signal.claim.kind === "plan") expect(signal.claim.draft.funding).toBeUndefined();
  });

  it("does not match incoming financing to a customer's open invoice", () => {
    const records: Records = { ...empty, parties: [{ id: "customer", name: "Acme", kind: "customer", tags: [], notes: [] }], commitments: [{ id: "invoice", type: "invoice", partyId: "customer", reference: "INV-42", amount: 100_000, currency: "USD", status: "committed", anchors: { due: asOf }, sourceRef: { system: "books", record: "INV-42" } }] };
    const reading = readThought("I am receiving a 50k loan from Acme next week", records, asOf);
    expect(reading.direction).toBe("in");
    expect(reading.invoiceId).toBeUndefined();
    const signal = ownerSignal("loan", { text: "I am receiving a 50k loan from Acme next week", createdAt: asOf }, reading, profile, "applied")!;
    expect(signal.claim).toMatchObject({ kind: "plan", draft: { direction: "in", funding: true } });
    const receipt = readThought("I am getting 50k from Acme next week", records, asOf);
    expect(receipt.invoiceId).toBeUndefined();
    expect(ownerSignal("cash", { text: "I am getting 50k from Acme next week", createdAt: asOf }, receipt, profile, "applied")!.claim)
      .toMatchObject({ kind: "plan", draft: { amount: 5_000_000, direction: "in" } });
    const ambiguous = { ...records, commitments: [0, 1].map(i => ({ ...records.commitments[0]!, id: `invoice-${i}`, reference: `INV-${i}`, amount: 5_000_000 })) };
    expect(readThought("I am getting 50k from Acme next week", ambiguous, asOf).missing).toContain("invoice reference");
  });

  it("preserves incoming plans through Ask Neri even when the model labels a plan outgoing", () => {
    const question = "What if I receive a 50k loan next week?";
    const raw: AskIntentRaw = { kind: "what_if", partyPhrase: null, referencePhrase: null, amountPhrase: "50k", datePhrase: "next week", windowPhrase: null, commitmentType: "plan", direction: "out", ruleKind: null, ruleParamPhrase: null, containsInstructions: false };
    const intent = resolveIntent(question, raw, { records: empty, profile, asOf });
    expect(intent.draft).toMatchObject({ type: "plan", direction: "in", funding: true, amount: 5_000_000 });
    const mislabeledDeal = resolveIntent(question, { ...raw, commitmentType: "sales_deal", direction: "in" }, { records: empty, profile, asOf });
    expect(mislabeledDeal.draft).toMatchObject({ type: "plan", direction: "in", funding: true });
    const ambiguous = resolveIntent("What if a 50k loan next week?", raw, { records: empty, profile, asOf });
    expect(ambiguous.draft).toBeUndefined();
    expect(ambiguous.unresolved).toContain("Is this money coming in or going out?");
  });

  it("parks a receipt without changing cash, then adds only the confirmed inflow", async () => {
    const store = new MemoryStore();
    const id = await store.createBusiness({ name: "Receipt test", profile: { ...profile, recurring: [] }, isSynthetic: false, ownerUserId: "owner" });
    const app = await buildApp({ store, verify: async () => ({ id: "owner", email: "owner@example.test" }), demoMode: false, now: () => new Date(`${asOf}T12:00:00Z`) });
    const headers = { authorization: "Bearer test", "x-neri-business": id };
    try {
      const parked = await app.inject({ method: "POST", url: "/notes", headers, payload: { text: incoming[0][0] } });
      expect(parked.statusCode).toBe(200);
      expect(parked.json().reading.direction).toBe("in");
      expect((await store.load(id)).records.signals).toEqual([]);
      const added = await app.inject({ method: "POST", url: `/notes/${parked.json().id}/add`, headers });
      expect(added.statusCode).toBe(200);
      const records = (await store.load(id)).records;
      expect(records.signals).toHaveLength(1);
      expect(records.signals[0]!.claim).toMatchObject({ kind: "plan", draft: { direction: "in", funding: true, amount: 5_000_000 } });
      const uncertain = (await app.inject({ method: "POST", url: "/notes", headers, payload: { text: "A 50k loan next week" } })).json();
      expect((await app.inject({ method: "POST", url: `/notes/${uncertain.id}/add`, headers })).statusCode).toBe(422);
      const clarified = (await app.inject({ method: "PATCH", url: `/notes/${uncertain.id}`, headers, payload: { direction: "in" } })).json();
      expect(clarified.reading.missing).toEqual([]);
      expect((await app.inject({ method: "POST", url: `/notes/${uncertain.id}/add`, headers })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});
