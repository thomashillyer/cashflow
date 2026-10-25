// Ask Neri decision engine over the cascade_trade fixture (the books and trading profile the engine's own
// tests use). One test per intent and verdict path, conviction levels and caps, fallback, number-check
// coverage of every code-built string, and determinism.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AskIntent, AskIntentRaw, Decision } from "../../schema/ask";
import type { Profile } from "../../schema/profile";
import type { CommitmentDraft, Records } from "../../schema/records";
import { forecast } from "../../engine/forecast";
import { checkText } from "../number_check";
import { decide, type DecideContext } from "./decide";

const records: Records = JSON.parse(readFileSync("fixtures/cascade_trade/records.json", "utf8"));
const profile: Profile = JSON.parse(readFileSync("profiles/trading.json", "utf8"));
const meta = JSON.parse(readFileSync("fixtures/cascade_trade/fixture.json", "utf8")) as { asOf: string; fxRates: Record<string, number> };
const asOf = meta.asOf;
const fxRates = meta.fxRates;

const $ = (n: number) => n * 100;
const baseCtx: DecideContext = { records, profile, asOf, fxRates, pendingReviewCount: 0 };

const rawOf = (kind: AskIntent["kind"], o: Partial<AskIntentRaw> = {}): AskIntentRaw => ({
  kind, partyPhrase: null, referencePhrase: null, amountPhrase: null, datePhrase: null, windowPhrase: null,
  commitmentType: null, direction: null, ruleKind: null, ruleParamPhrase: null, containsInstructions: false, ...o,
});
const intent = (kind: AskIntent["kind"], o: Partial<Omit<AskIntent, "raw">> & { raw?: Partial<AskIntentRaw> } = {}): AskIntent => {
  const { raw, ...rest } = o;
  return { kind, question: `question for ${kind} ${JSON.stringify(rest)}`, raw: rawOf(kind, raw), unresolved: [], ...rest };
};
const withBalance = (amount: number, asOfDate?: string): Records => ({
  ...records,
  balances: records.balances.map((b) => ({ ...b, amount, ...(asOfDate ? { asOf: asOfDate } : {}) })),
});
// The same books with the deal's supplier and freight costs scaled up, so a deal can fail every upfront share.
const heavyProfile: Profile = {
  ...profile,
  paymentPatterns: profile.paymentPatterns.map((p) =>
    p.id === "customer_advance_net60"
      ? { ...p, linkedCosts: [{ patternId: "supplier_30_70", share: 3 }, { patternId: "freight_and_duties", share: 1 }] }
      : p,
  ),
};
const outPlan = (amount: number, due: string): CommitmentDraft => ({
  type: "plan", direction: "out", amount, currency: "USD", anchors: { due }, status: "likely",
});

// Every Decision the suite builds, for the figure-coverage test at the end.
const seen: Decision[] = [];
const run = (i: AskIntent, ctx: Partial<DecideContext> = {}): Decision => {
  const d = decide(i, { ...baseCtx, ...ctx });
  seen.push(d);
  return d;
};

// Every code-built string in a Decision.
function strings(d: Decision): string[] {
  return [
    d.recommendation?.action, d.fallback?.action, ...d.assumptions, ...d.convictionReasons, d.whatWouldChange, d.question, d.missingData,
  ].filter((s): s is string => typeof s === "string");
}

describe("afford, inbound deal (smallestUpfrontShare)", () => {
  const ask = intent("afford", { commitmentId: "rfq-harbor-spring", partyId: "party-harbor-hearth" });

  it("already_ok -> yes, no recommendation", () => {
    const d = run(ask, { records: withBalance($(200000)) });
    expect(d.verdict).toBe("yes");
    expect(d.recommendation).toBeUndefined();
    expect(d.context.baseLowPoint!.amount).toBeGreaterThanOrEqual(d.context.safetyLine!);
    expect(d.citations).toContain("rfq-harbor-spring");
  });

  it("ok -> yes_if with the smallest upfront share, its date, and the resulting low point", () => {
    const d = run(ask, { profile: heavyProfile, records: withBalance($(300000)) });
    expect(d.verdict).toBe("yes_if");
    const r = d.recommendation!;
    expect(r.upfrontShare).toBe(0.8);
    expect(r.action).toBe("Ask Harbor and Hearth for 80% up front on RFQ-77");
    expect(r.byDate).toBe("2026-12-05"); // the order date: when the deposit leg lands
    expect(r.resultingLowPoint!.amount).toBeGreaterThanOrEqual(d.context.safetyLine!);
    expect(r.cashEffect).toBe(r.resultingLowPoint!.amount - d.context.baseLowPoint!.amount);
    expect(r.cashEffect).toBeGreaterThan(0);
    expect(d.scenarioInputs!.upfrontShare).toEqual({ commitmentId: "rfq-harbor-spring", share: 0.8 });
    expect(d.numbers).toContainEqual({ label: "upfront share asked", value: 80, unit: "pct" });
    expect(d.numbers).toContainEqual({ label: "upfront share today", value: 30, unit: "pct" });
    expect(d.assumptions.join(" ")).toContain("30%");
  });

  it("not_achievable -> no, with the best case (everything up front)", () => {
    const d = run(ask, { profile: heavyProfile, records: withBalance($(250000)) });
    expect(d.verdict).toBe("no");
    expect(d.recommendation!.upfrontShare).toBe(1);
    expect(d.recommendation!.resultingLowPoint!.amount).toBeLessThan(d.context.safetyLine!);
    expect(d.recommendation!.lever).toBeUndefined();
  });

  it("not_deal_driven -> act_now through the fix_gap path, measured without the deal", () => {
    const d = run(ask);
    expect(d.verdict).toBe("act_now");
    expect(d.recommendation!.lever).toMatchObject({ kind: "chase", commitmentId: "inv-INV-1187" });
    expect(d.assumptions.join(" ")).toContain("even without RFQ-77");
    expect(d.context.baseLowPoint).toEqual({ date: "2026-12-25", amount: -550_000 });
  });

  it("a hypothetical inbound deal is a synthetic ask-draft sales_deal and says linked costs are unknown", () => {
    const draft: CommitmentDraft = { type: "sales_deal", direction: "in", amount: $(60000), currency: "USD", anchors: { order: "2026-12-05" }, status: "likely" };
    const d = run(intent("afford", { draft, date: "2026-12-05" }), { profile: heavyProfile, records: withBalance($(300000)) });
    const c = d.scenarioInputs!.commitments![0]!;
    expect(c).toMatchObject({ type: "sales_deal", direction: "in", status: "likely", anchors: { order: "2026-12-05" }, currency: "USD" });
    expect(c.id).toMatch(/^ask-draft-[0-9a-f]{10}$/);
    expect(c.patternId).toBeUndefined();
    expect(d.assumptions).toContain("Linked costs are unknown; only the profile's default terms for an order are assumed.");
    expect(d.verdict).toBe("yes_if");
    // No customer is named, so there is no payment history behind the timing: low conviction.
    expect(d.conviction).toBe("low");
  });
});

describe("afford, outbound plan", () => {
  const draft = outPlan($(40000), "2026-12-15");
  const ask = intent("afford", { draft, date: "2026-12-15" });

  it("yes when the low point with the plan stays above the safety line", () => {
    const d = run(ask, { records: withBalance($(300000)) });
    expect(d.verdict).toBe("yes");
    expect(d.recommendation).toBeUndefined();
    const c = d.scenarioInputs!.commitments![0]!;
    expect(c).toMatchObject({ type: "plan", direction: "out", status: "likely", anchors: { due: "2026-12-15" }, amount: $(40000) });
    expect(c.patternId).toBeUndefined();
    // base = the forecast without the draft; the plan lowers the low point by its amount
    const without = forecast(withBalance($(300000)), profile, { id: "base", kind: "base", overrides: [] }, asOf, fxRates);
    expect(d.context.baseLowPoint!.amount).toBe(without.lowPoint.amount);
    expect(d.headlineFacts[0]!.amount).toBe(without.lowPoint.amount - $(40000));
  });

  it("yes_if when one lever, re-simulated with the plan, clears the line", () => {
    const d = run(ask, { records: withBalance($(210000)) });
    expect(d.verdict).toBe("yes_if");
    expect(d.recommendation!.lever).toMatchObject({ kind: "chase", commitmentId: "inv-INV-1187" });
    expect(d.recommendation!.resultingLowPoint!.amount).toBeGreaterThanOrEqual(d.context.safetyLine!);
    expect(d.recommendation!.cashEffect).toBe(1_950_000);
    expect(d.recommendation!.byDate).toBe("2026-12-15");
    expect(d.scenarioId).toBe(d.scenario!.id);
    expect(d.scenario!.levers).toEqual([d.recommendation!.lever]);
    expect(d.scenarioInputs!.commitments).toHaveLength(1);
  });

  it("no when no single move keeps cash above the line", () => {
    const d = run(ask, { records: withBalance($(200000)) });
    expect(d.verdict).toBe("no");
    expect(d.recommendation!.action).toBe("Hold off on the $40,000 payment due 2026-12-15 until cash improves");
    expect(d.recommendation!.lever).toBeUndefined();
    expect(d.headlineFacts[0]!.amount!).toBeLessThan(d.context.safetyLine!);
  });

  it("converts a foreign-currency draft to the base currency and says so", () => {
    const inr: CommitmentDraft = { ...draft, amount: 3_333_333_33, currency: "INR" };
    const d = run(intent("afford", { draft: inr, date: "2026-12-15" }), { records: withBalance($(300000)) });
    expect(d.scenarioInputs!.commitments![0]!.amount).toBe(Math.round(3_333_333_33 * 0.012));
    expect(d.assumptions).toContain("Converted INR to USD at the current rate.");
    const unknown = run(intent("afford", { draft: { ...draft, currency: "CHF" } }));
    expect(unknown.verdict).toBe("need_info");
  });

  it("with no date, assumes 30 days out and caps conviction at medium", () => {
    const noDate: CommitmentDraft = { ...draft, anchors: {} };
    const d = run(intent("afford", { draft: noDate }), { records: withBalance($(300000)) });
    expect(d.assumptions.join(" ")).toContain("assumed 2026-12-16, 30 days out");
    expect(d.scenarioInputs!.commitments![0]!.anchors).toEqual({ due: "2026-12-16" });
    expect(d.conviction).toBe("medium");
  });

  it("an existing outbound commitment is measured with and without it", () => {
    const d = run(intent("afford", { commitmentId: "po-PO-2291" }), { records: withBalance($(300000)) });
    expect(d.verdict).toBe("yes");
    expect(d.scenarioInputs).toBeUndefined(); // nothing synthesized
    expect(d.context.baseLowPoint!.amount).toBeGreaterThan(d.headlineFacts[0]!.amount!);
  });
});

describe("fix_gap", () => {
  it("act_now with a lever candidate, its act-by date, and the low point from simulate", () => {
    const d = run(intent("fix_gap"));
    expect(d.verdict).toBe("act_now");
    expect(d.context).toEqual({ baseLowPoint: { date: "2026-12-25", amount: -550_000 }, safetyLine: $(35000), shortfall: $(35000) + 550_000 });
    expect(d.recommendation).toMatchObject({
      action: "Chase Evergreen Home to pay INV-1187 by 2026-12-10",
      lever: { kind: "chase", commitmentId: "inv-INV-1187", assumeDate: "2026-12-10" },
      byDate: "2026-12-12",
      cashEffect: 1_950_000,
      resultingLowPoint: { date: "2027-01-08", amount: 1_400_000 },
    });
    expect(d.citations).toEqual(expect.arrayContaining(["inv-INV-1187", "evt-inv-INV-1187-0"]));
    expect(d.headlineFacts.length).toBeLessThanOrEqual(3);
  });

  it("fallback is a different commitment and party, with its standalone effect", () => {
    const d = run(intent("fix_gap"));
    expect(d.fallback).toMatchObject({
      action: "If that does not work: ask Cascade Customs Brokerage for 10 more days on DUTIES-2291",
      lever: { kind: "defer", commitmentId: "bill-duties-2291", days: 10 },
      cashEffect: 900_000,
    });
    expect(d.fallback!.lever!.commitmentId).not.toBe(d.recommendation!.lever!.commitmentId);
    const party = (id: string) => records.commitments.find((c) => c.id === id)!.partyId;
    expect(party(d.fallback!.lever!.commitmentId)).not.toBe(party(d.recommendation!.lever!.commitmentId));
  });

  it("never recommends deferring payroll or taxes, or a non-cash item", () => {
    const d = run(intent("fix_gap"));
    for (const l of [d.recommendation?.lever, d.fallback?.lever]) {
      expect(l?.kind).not.toBe("pay_early");
      expect(l?.commitmentId).not.toMatch(/^rec-/);
    }
  });

  it("on_track when the low point stays above the line: no recommendation", () => {
    const d = run(intent("fix_gap"), { records: withBalance($(300000)) });
    expect(d.verdict).toBe("on_track");
    expect(d.recommendation).toBeUndefined();
    expect(d.context.shortfall).toBeUndefined();
    expect(d.context.baseLowPoint!.amount).toBeGreaterThanOrEqual(d.context.safetyLine!);
  });
});

describe("what_if", () => {
  it("a date move is an owner override on the existing commitment, with the new low point vs base", () => {
    const d = run(intent("what_if", { commitmentId: "inv-INV-1187", partyId: "party-evergreen-home", date: "2027-01-15" }));
    expect(d.scenario!.overrides).toEqual([
      { id: expect.stringMatching(/^ask-whatif-[0-9a-f]{10}-0$/), target: { commitmentId: "inv-INV-1187" }, change: { date: "2027-01-15" }, origin: "owner" },
    ]);
    expect(d.scenarioId).toBe(d.scenario!.id);
    expect(d.scenarioInputs).toBeUndefined();
    const [newLow, baseLow] = d.headlineFacts;
    expect(baseLow!.amount).toBe(-550_000);
    expect(newLow!.amount!).toBeLessThan(baseLow!.amount!);
    expect(d.context.baseLowPoint).toEqual({ date: "2026-12-25", amount: -550_000 });
    expect(d.assumptions.join(" ")).toContain("Evergreen Home pays INV-1187 on 2027-01-15, instead of 2026-12-26");
    expect(d.verdict).toBe("act_now");
    expect(d.recommendation).toBeDefined();
  });

  it("a party with no commitment id moves that party's open receivables", () => {
    const d = run(intent("what_if", { partyId: "party-evergreen-home", date: "2027-01-15" }));
    expect(d.scenario!.overrides.map((o) => o.target.commitmentId)).toEqual(["inv-INV-1187"]);
  });

  it("a hire is a synthetic monthly recurring item in scenarioInputs.recurring", () => {
    const draft: CommitmentDraft = { type: "recurring", direction: "out", amount: $(12000), currency: "USD", anchors: { due: "2026-12-01" }, status: "committed" };
    const d = run(intent("what_if", { draft, date: "2026-12-01" }), { records: withBalance($(300000)) });
    const item = d.scenarioInputs!.recurring![0]!;
    expect(item).toMatchObject({ amount: $(12000), direction: "out", cadence: "monthly", anchor: "2026-12-01" });
    expect(item.id).toMatch(/^ask-draft-[0-9a-f]{10}$/);
    expect(d.scenarioInputs!.commitments).toBeUndefined();
    expect(d.scenario!.overrides).toEqual([]); // a hypothetical never goes into overrides
    const base = forecast(withBalance($(300000)), profile, { id: "base", kind: "base", overrides: [] }, asOf, fxRates);
    expect(d.context.baseLowPoint!.amount).toBe(base.lowPoint.amount);
    expect(d.headlineFacts[0]!.amount!).toBeLessThan(base.lowPoint.amount);
    expect(d.verdict).toBe("on_track");
  });

  it("need_info when neither a party nor an item and a date are given", () => {
    const d = run(intent("what_if", { partyId: "party-evergreen-home" }));
    expect(d.verdict).toBe("need_info");
  });
});

describe("status", () => {
  it("on_track over a window that stays above the line; the tightest day is inside the window", () => {
    const d = run(intent("status", { window: { from: "2026-11-16", to: "2026-12-06" } }));
    expect(d.verdict).toBe("on_track");
    expect(d.headlineFacts[0]!.label).toBe("Tightest day");
    expect(d.headlineFacts[0]!.date! >= "2026-11-16" && d.headlineFacts[0]!.date! <= "2026-12-06").toBe(true);
    expect(d.context.baseLowPoint).toEqual({ date: d.headlineFacts[0]!.date, amount: d.headlineFacts[0]!.amount });
  });

  it("act_now over the horizon, via the fix_gap path", () => {
    const d = run(intent("status"));
    expect(d.verdict).toBe("act_now");
    expect(d.headlineFacts[0]).toMatchObject({ label: "Tightest day", date: "2026-12-25", amount: -550_000 });
    expect(d.recommendation!.lever).toMatchObject({ kind: "chase", commitmentId: "inv-INV-1187" });
  });

  it("need_info when the window is outside the forecast", () => {
    const d = run(intent("status", { window: { from: "2030-01-01", to: "2030-01-31" } }));
    expect(d.verdict).toBe("need_info");
  });
});

describe("lookup", () => {
  it("states the party's payment lag and sample count from lag samples", () => {
    const d = run(intent("lookup", { partyId: "party-evergreen-home" }));
    expect(d.verdict).toBe("info");
    expect(d.numbers).toContainEqual({ label: "payments on record", value: 8, unit: "count" });
    expect(d.numbers.filter((n) => n.unit === "days").length).toBe(2); // typical, and what the forecast assumes
    expect(d.headlineFacts).toContainEqual({ label: "Open amount Evergreen Home owes you", amount: $(28000) });
    expect(d.headlineFacts.find((h) => h.label === "Next expected")).toMatchObject({ amount: $(28000), date: "2026-12-26" });
    expect(d.convictionReasons).toEqual(["Based on 8 payments from Evergreen Home."]);
    expect(d.conviction).toBe("high");
    expect(d.citations).toContain("party-evergreen-home");
    expect(d.recommendation).toBeUndefined();
  });

  it("with no history says the forecast uses the profile default", () => {
    const d = run(intent("lookup", { partyId: "party-jaipur-textiles" }));
    expect(d.assumptions.join(" ")).toContain("no payment history for Jaipur Textiles");
    expect(d.numbers).toContainEqual({ label: "payments on record", value: 0, unit: "count" });
    expect(d.headlineFacts.find((h) => h.label.startsWith("Open amount you owe"))).toBeDefined();
  });

  it("a confirmed rule is used and named without quoting its note", () => {
    const rule = { id: "rule-1", scope: { partyId: "party-harbor-hearth" }, kind: "lag_offset" as const, params: { offsetDays: 12 }, fromNote: "Harbor always runs twelve days late", state: "confirmed" as const };
    const d = run(intent("lookup", { partyId: "party-harbor-hearth" }), { records: { ...records, rules: [rule] } });
    expect(d.assumptions).toContain("The forecast uses a payment rule you confirmed for Harbor and Hearth.");
    expect(JSON.stringify(d)).not.toContain("twelve days");
    expect(d.conviction).toBe("high");
  });

  it("need_info without a party", () => {
    expect(run(intent("lookup")).verdict).toBe("need_info");
  });
});

describe("tell", () => {
  it("a plan is proposed, not applied or persisted here", () => {
    const draft = outPlan($(40000), "2026-12-15");
    const d = run(intent("tell", { draft, date: "2026-12-15" }));
    expect(d.verdict).toBe("proposed");
    expect(d.proposal).toEqual({ kind: "commitment", draft });
    expect(d.headlineFacts).toEqual([{ label: "Planned payment", amount: $(40000), date: "2026-12-15" }]);
    expect(d.recommendation!.action).toBe("Confirm to add the $40,000 payment on 2026-12-15 to your forecast");
    expect(d.scenarioInputs).toBeUndefined();
  });

  it("a rule is proposed with its parameter as a stated number", () => {
    const rule = { scope: { partyId: "party-evergreen-home" }, kind: "lag_offset" as const, params: { offsetDays: 20 }, fromNote: "Evergreen always pays 20 days late" };
    const d = run(intent("tell", { rule, raw: { ruleKind: "lag_offset" } }));
    expect(d.verdict).toBe("proposed");
    expect(d.proposal).toEqual({ kind: "rule", rule });
    expect(d.recommendation!.action).toBe("Remember that Evergreen Home pays 20 days late; confirm to save it");
    expect(d.numbers).toContainEqual({ label: "days from due date", value: 20, unit: "days" });
    // The owner's own words live in the proposal only, not in any code-built string.
    expect(strings(d).join(" ")).not.toContain("always");
  });

  it("flexibility and preference rules get their own wording", () => {
    const flex = run(intent("tell", { rule: { scope: { partyId: "party-jaipur-textiles" }, kind: "flexibility", params: { extraDays: 15 }, fromNote: "n" }, raw: { ruleKind: "flexibility" } }));
    expect(flex.recommendation!.action).toBe("Remember that Jaipur Textiles allows 15 more days on what you owe; confirm to save it");
    const pref = run(intent("tell", { rule: { scope: { partyId: "party-jaipur-textiles" }, kind: "preference", params: { tag: "preferred" }, fromNote: "n" }, raw: { ruleKind: "preference" } }));
    expect(pref.proposal!.kind).toBe("rule");
  });

  it("need_info when neither a plan nor a rule was resolved", () => {
    expect(run(intent("tell")).verdict).toBe("need_info");
  });
});

describe("need_info and decline", () => {
  it("need_info when the intent has unresolved slots: one question, no recommendation", () => {
    const d = run(intent("afford", { unresolved: ["which supplier?", "how much?"] }));
    expect(d.verdict).toBe("need_info");
    expect(d.question).toBe("Which supplier?");
    expect(d.recommendation).toBeUndefined();
    expect(d.headlineFacts).toEqual([]);
    expect(d.conviction).toBe("low");
  });

  it("afford with neither an amount nor an item asks one question", () => {
    expect(run(intent("afford")).question).toBe("How much is it, or which order or bill do you mean?");
  });

  it("decline for out_of_scope, with the cash facts only", () => {
    const d = run(intent("out_of_scope"));
    expect(d.verdict).toBe("decline");
    expect(d.recommendation).toBeUndefined();
    expect(d.missingData).toContain("investment or loan products");
    expect(d.headlineFacts.map((h) => h.label)).toEqual(["Lowest cash point", "Safety line"]);
    expect(d.context.baseLowPoint).toEqual({ date: "2026-12-25", amount: -550_000 });
  });

  it("decline wins over unresolved slots", () => {
    expect(run(intent("out_of_scope", { unresolved: ["which?"] })).verdict).toBe("decline");
  });

  it("an instruction in the question is ignored and noted", () => {
    const d = run(intent("fix_gap", { raw: { containsInstructions: true } }));
    expect(d.verdict).toBe("act_now");
    expect(d.assumptions).toContain("The question contained an instruction; it was ignored and only the question was answered.");
  });
});

describe("conviction", () => {
  it("high: eight payments from the party the move rests on, books fresh, nothing tentative", () => {
    const d = run(intent("fix_gap"));
    expect(d.conviction).toBe("high");
    expect(d.convictionReasons).toEqual(["Based on 8 payments from Evergreen Home."]);
    expect(d.whatWouldChange).toBe("Least certain: the $28,000 receipt from Evergreen Home (INV-1187), expected 2026-12-26.");
  });

  it("medium: pending reviews block high even with a long history", () => {
    const d = run(intent("fix_gap"), { pendingReviewCount: 2 });
    expect(d.conviction).toBe("medium");
    expect(d.convictionReasons[0]).toBe("Evergreen Home has 8 payments, but 2 items are waiting in Review.");
  });

  it("medium: a thin history (4 payments) is between the profile cutoffs", () => {
    const d = run(intent("lookup", { partyId: "party-harbor-hearth" }));
    expect(d.conviction).toBe("medium");
    expect(d.convictionReasons).toEqual(["Only 4 payments from Harbor and Hearth on record."]);
  });

  it("cutoffs read from profile.thresholds.conviction", () => {
    const strict: Profile = { ...profile, thresholds: { ...profile.thresholds, conviction: { highMinLagSamples: 9 } } };
    expect(run(intent("fix_gap"), { profile: strict }).conviction).toBe("medium");
    const lax: Profile = { ...profile, thresholds: { ...profile.thresholds, conviction: { highMinLagSamples: 4, maxPendingReviewsForHigh: 5 } } };
    expect(run(intent("lookup", { partyId: "party-harbor-hearth" }), { profile: lax, pendingReviewCount: 3 }).conviction).toBe("high");
    const none: Profile = { ...profile, thresholds: { ...profile.thresholds, conviction: { mediumMinLagSamples: 5 } } };
    expect(run(intent("lookup", { partyId: "party-harbor-hearth" }), { profile: none }).conviction).toBe("low");
  });

  it("low: no payment history behind the timing of a customer", () => {
    const draft: CommitmentDraft = { type: "sales_deal", direction: "in", amount: $(60000), currency: "USD", anchors: { order: "2026-12-05" }, status: "likely" };
    const d = run(intent("afford", { draft, date: "2026-12-05" }), { records: withBalance($(300000)) });
    expect(d.conviction).toBe("low");
    expect(d.convictionReasons[0]).toBe(`There is no payment history for this customer; the forecast uses the profile default of 20 days.`);
  });

  it("caps: a tentative (possible) event caps at medium", () => {
    const d = run(intent("afford", { commitmentId: "rfq-harbor-spring" }), { records: withBalance($(200000)) });
    expect(d.conviction).toBe("medium");
    expect(d.convictionReasons.join(" ")).toContain("RFQ-77 is not yet confirmed.");
  });

  it("caps: a stale balance caps at medium, using profile.thresholds.staleAfterHours", () => {
    const d = run(intent("fix_gap"), { records: withBalance(records.balances[0]!.amount, "2026-11-10") });
    expect(d.conviction).toBe("medium");
    expect(d.convictionReasons).toContain("The bank balance was last updated on 2026-11-10, 6 days old.");
    const noStale: Profile = { ...profile, thresholds: { ...profile.thresholds, staleAfterHours: undefined } };
    expect(run(intent("fix_gap"), { profile: noStale, records: withBalance(records.balances[0]!.amount, "2026-11-10") }).conviction).toBe("high");
  });

  it("caps: a vague date caps at medium", () => {
    const d = run(intent("afford", { draft: outPlan($(40000), "2026-12-15"), date: "2026-12-15", dateVague: "mid December" }), { records: withBalance($(300000)) });
    expect(d.conviction).toBe("medium");
    expect(d.assumptions).toContain('Assumed 2026-12-15 for "mid December".');
  });

  it("caps: two caps (stale balance and a vague date) drop to low", () => {
    const d = run(intent("afford", { draft: outPlan($(40000), "2026-12-15"), date: "2026-12-15", dateVague: "mid December" }), {
      records: withBalance($(300000), "2026-11-10"),
    });
    expect(d.conviction).toBe("low");
    expect(d.convictionReasons.length).toBe(3); // no timing line + two caps
  });

  it("whatWouldChange never quotes party notes or rule notes", () => {
    const all = JSON.stringify(seen.map((x) => strings(x)));
    for (const p of records.parties) for (const n of p.notes) expect(all).not.toContain(n);
  });
});

describe("determinism and purity", () => {
  it("same input, same Decision; inputs are not mutated", () => {
    const before = JSON.stringify(baseCtx);
    const i = intent("afford", { commitmentId: "rfq-harbor-spring" });
    expect(decide(i, baseCtx)).toEqual(decide(i, baseCtx));
    const j = intent("what_if", { partyId: "party-evergreen-home", date: "2027-01-15" });
    expect(decide(j, baseCtx)).toEqual(decide(j, baseCtx));
    expect(JSON.stringify(baseCtx)).toBe(before);
  });

  it("synthetic ids depend only on the question", () => {
    const a = decide(intent("afford", { question: "same", draft: outPlan($(40000), "2026-12-15"), date: "2026-12-15" }), baseCtx);
    const b = decide(intent("afford", { question: "same", draft: outPlan($(40000), "2026-12-15"), date: "2026-12-15" }), baseCtx);
    const c = decide(intent("afford", { question: "other", draft: outPlan($(40000), "2026-12-15"), date: "2026-12-15" }), baseCtx);
    expect(a.scenarioInputs!.commitments![0]!.id).toBe(b.scenarioInputs!.commitments![0]!.id);
    expect(a.scenarioInputs!.commitments![0]!.id).not.toBe(c.scenarioInputs!.commitments![0]!.id);
  });
});

// Runs last: every Decision above must pass number_check on its own code-built strings, and the percent,
// day, and count figures in them must be in allowed.numbers.
describe("allowed covers every figure in the code-built strings", () => {
  it("amounts and dates pass number_check against allowed; N%, N days, N payments are in allowed.numbers", () => {
    expect(seen.length).toBeGreaterThan(40);
    for (const d of seen) {
      const allowed = { amounts: d.allowed.amounts, dates: d.allowed.dates };
      for (const s of strings(d)) {
        const r = checkText(s, ["x"], allowed, { currency: d.currency, asOf: d.asOf });
        expect(r, s).toMatchObject({ ok: true });
        for (const m of s.matchAll(/(\d+)%/g)) expect(d.allowed.numbers, s).toContainEqual(expect.objectContaining({ value: Number(m[1]), unit: "pct" }));
        for (const m of s.matchAll(/(?<![\d,.$])(\d+) (?:more |extra )?days?\b/g)) expect(d.allowed.numbers, s).toContainEqual(expect.objectContaining({ value: Number(m[1]), unit: "days" }));
        for (const m of s.matchAll(/(?<![\d,.$])(\d+) (?:payments?|samples?|invoices?)\b/g)) expect(d.allowed.numbers, s).toContainEqual(expect.objectContaining({ value: Number(m[1]), unit: "count" }));
      }
      expect(d.allowed.numbers).toEqual(d.numbers);
    }
  });

  it("allowed also holds every money and date field of the Decision", () => {
    for (const d of seen) {
      const a = new Set(d.allowed.amounts);
      const dt = new Set(d.allowed.dates);
      for (const h of d.headlineFacts) {
        if (h.amount !== undefined) expect(a.has(h.amount)).toBe(true);
        if (h.date) expect(dt.has(h.date)).toBe(true);
      }
      for (const x of [d.context.safetyLine, d.context.shortfall, d.context.baseLowPoint?.amount, d.recommendation?.cashEffect, d.recommendation?.resultingLowPoint?.amount, d.fallback?.cashEffect]) {
        if (x !== undefined) expect(a.has(x)).toBe(true);
      }
      for (const x of [d.recommendation?.byDate, d.recommendation?.resultingLowPoint?.date, d.context.baseLowPoint?.date]) {
        if (x) expect(dt.has(x)).toBe(true);
      }
      expect(d.currency).toBe("USD");
      expect(d.asOf).toBe(asOf);
    }
  });
});

// Generic core: every fixture's profile answers fix_gap, status, and a plan question with zero code changes.
const fixtureNames = readdirSync("fixtures").filter((n) => existsSync(join("fixtures", n, "fixture.json")));
describe.each(fixtureNames)("fixture %s", (name) => {
  const m = JSON.parse(readFileSync(join("fixtures", name, "fixture.json"), "utf8")) as { profile: string; asOf: string; fxRates: Record<string, number> };
  const ctx: DecideContext = {
    records: JSON.parse(readFileSync(join("fixtures", name, "records.json"), "utf8")) as Records,
    profile: JSON.parse(readFileSync(m.profile, "utf8")) as Profile,
    asOf: m.asOf, fxRates: m.fxRates, pendingReviewCount: 0,
  };
  it("answers fix_gap, status, and a plan question deterministically, with every string checked", () => {
    const plan = intent("afford", { draft: outPlan($(5000), addDaysIso(m.asOf, 20)), date: addDaysIso(m.asOf, 20) });
    for (const i of [intent("fix_gap"), intent("status"), plan]) {
      const d = decide(i, ctx);
      expect(decide(i, ctx)).toEqual(d);
      expect(["yes", "no", "yes_if", "act_now", "on_track"]).toContain(d.verdict);
      for (const s of strings(d)) expect(checkText(s, ["x"], d.allowed, { currency: d.currency, asOf: d.asOf }), s).toMatchObject({ ok: true });
    }
  });
});

function addDaysIso(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
