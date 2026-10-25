// Writes the Ask Neri voice fixtures for cascade_trade (fixtures/cascade_trade/ask/):
//  - decisions.json: a handful of HAND-BUILT Decisions (what the engine-side Decision builder would produce
//    for five typical questions). Figures are consistent by construction, not engine output.
//  - cache/<key>.json: HAND-AUTHORED stand-ins for the model's CfoVoice, marked source "stand-in", under the
//    same cache keys ai/ask/voice.ts reads. Every stand-in must pass checkVoice, or this script throws.
// They exist so the demo and tests run with no API key. `npx tsx scripts/refresh-voice-cache.ts` replaces
// the stand-ins with real model output (same keys, so no code changes).
//
//   npx tsx scripts/make-voice-standins.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASK_CACHE_DIR, writeCache } from "../ai/cache";
import { CFO_VOICE_MODEL, CFO_VOICE_PROMPT_VERSION } from "../ai/config";
import { checkVoice, voiceCacheKey } from "../ai/ask/voice";
import type { Decision } from "../schema/ask";
import { ASK_DIR, ASK_BUSINESS, loadAskFixture } from "./ask-fixture";

type VoiceOut = { headline: string; why: string; nextStep: string | null; convictionNote: string; whatWouldChange: string | null };
type Draft = Omit<Decision, "allowed"> & { allowedExtra?: Partial<Decision["allowed"]> };

// The union of every figure in the Decision (what the real builder does), plus anything the stand-in text needs.
function withAllowed(d: Draft): Decision {
  const { allowedExtra, ...rest } = d;
  const amounts = new Set<number>(allowedExtra?.amounts ?? []);
  const dates = new Set<string>(allowedExtra?.dates ?? []);
  const add = (a?: number) => { if (a !== undefined) amounts.add(a); };
  for (const f of d.headlineFacts) { add(f.amount); if (f.date) dates.add(f.date); }
  const c = d.context;
  add(c.baseLowPoint?.amount); add(c.safetyLine); add(c.shortfall);
  if (c.baseLowPoint) dates.add(c.baseLowPoint.date);
  const r = d.recommendation;
  if (r) {
    add(r.cashEffect); add(r.resultingLowPoint?.amount);
    if (r.byDate) dates.add(r.byDate);
    if (r.resultingLowPoint) dates.add(r.resultingLowPoint.date);
  }
  add(d.fallback?.cashEffect);
  return {
    ...rest,
    allowed: {
      amounts: [...amounts].sort((a, b) => a - b),
      dates: [...dates].sort(),
      numbers: [...d.numbers, ...(allowedExtra?.numbers ?? [])],
    },
  };
}

const common = { asOf: "2026-11-16", currency: "USD" } as const;

const drafts: { id: string; question: string; decision: Draft; voice: VoiceOut }[] = [
  {
    id: "afford-harbor-order",
    question: "Can I take the Harbor order?",
    decision: {
      ...common,
      intent: "afford",
      verdict: "yes_if",
      headlineFacts: [
        { label: "Lowest cash point without a deposit", amount: 2_150_000, date: "2026-12-25" },
        { label: "Safety line", amount: 3_500_000 },
      ],
      numbers: [
        { label: "Up-front share", value: 40, unit: "pct" },
        { label: "Harbor and Hearth payments on record", value: 4, unit: "count" },
        { label: "Extra days from Jaipur Textiles", value: 10, unit: "days" },
      ],
      context: { baseLowPoint: { date: "2026-12-25", amount: 2_150_000 }, safetyLine: 3_500_000, shortfall: 1_350_000 },
      recommendation: {
        action: "Ask Harbor and Hearth for 40% up front",
        lever: { kind: "ask_advance", commitmentId: "po-HH-PO-552", share: 0.4 },
        upfrontShare: 0.4,
        byDate: "2026-12-01",
        cashEffect: 1_600_000,
        resultingLowPoint: { date: "2026-12-25", amount: 3_750_000 },
      },
      fallback: {
        action: "Ask Jaipur Textiles for 10 more days",
        lever: { kind: "defer", commitmentId: "po-PO-2302", days: 10 },
        cashEffect: 1_200_000,
      },
      assumptions: ["linked costs unknown"],
      conviction: "medium",
      convictionReasons: ["Harbor and Hearth has only 4 payments on record"],
      whatWouldChange: "The deposit arriving later than Dec 1",
      citations: ["po-HH-PO-552", "po-PO-2302"],
      allowedExtra: { dates: ["2026-12-01"] },
    },
    voice: {
      headline: "Yes, if Harbor and Hearth pays 40% up front by Dec 1.",
      why: "Without a deposit, your cash drops to $21,500 on Dec 25, $13,500 under your $35,000 safety line. A 40% deposit lifts your lowest point by $16,000, to $37,500. If they refuse, ask Jaipur Textiles for 10 more days, which lifts it by $12,000 on its own.",
      nextStep: "Ask Harbor and Hearth for the 40% deposit by Dec 1.",
      convictionNote: "Medium confidence: Harbor and Hearth has only 4 payments on record.",
      whatWouldChange: "If the deposit arrives later than Dec 1, the low point moves.",
    },
  },
  {
    id: "fix-gap-december",
    question: "What should I do about December?",
    decision: {
      ...common,
      intent: "fix_gap",
      verdict: "act_now",
      headlineFacts: [
        { label: "Lowest cash point", amount: -550_000, date: "2026-12-25" },
        { label: "INV-1187 (Evergreen Home)", amount: 2_800_000, date: "2026-12-10" },
      ],
      numbers: [
        { label: "Evergreen Home payments on record", value: 8, unit: "count" },
        { label: "Extra days from Jaipur Textiles", value: 10, unit: "days" },
      ],
      context: { baseLowPoint: { date: "2026-12-25", amount: -550_000 }, safetyLine: 3_500_000, shortfall: 4_050_000 },
      recommendation: {
        action: "Chase Evergreen Home on INV-1187 for payment by Dec 18",
        lever: { kind: "chase", commitmentId: "inv-INV-1187", assumeDate: "2026-12-18" },
        byDate: "2026-12-18",
        cashEffect: 1_950_000,
        resultingLowPoint: { date: "2026-12-25", amount: 1_400_000 },
      },
      fallback: {
        action: "Ask Jaipur Textiles for 10 more days",
        lever: { kind: "defer", commitmentId: "po-PO-2302", days: 10 },
        cashEffect: 1_200_000,
      },
      assumptions: [],
      conviction: "high",
      convictionReasons: ["Evergreen Home has 8 payments on record", "no tentative money sits on the path"],
      whatWouldChange: "Evergreen Home paying later than Dec 26",
      citations: ["inv-INV-1187", "po-PO-2302"],
      allowedExtra: { dates: ["2026-12-26"] },
    },
    voice: {
      headline: "Act now: chase Evergreen Home on INV-1187 so their $28,000 lands by Dec 18.",
      why: "Your cash dips to -$5,500 on Dec 25, $40,500 under your $35,000 safety line. Evergreen Home's $28,000 is due Dec 10 but is expected Dec 26, after your lowest point, so getting it by Dec 18 lifts your lowest point by $19,500, to $14,000. If they refuse, ask Jaipur Textiles for 10 more days, which lifts it by $12,000 on its own.",
      nextStep: "Ask Evergreen Home to pay INV-1187 by Dec 18.",
      convictionNote: "High confidence: Evergreen Home has 8 payments on record and no tentative money sits on the path.",
      whatWouldChange: "If Evergreen Home pays later than Dec 26, the low point drops again.",
    },
  },
  {
    id: "what-if-evergreen-january",
    question: "What if Evergreen pays in January?",
    decision: {
      ...common,
      intent: "what_if",
      verdict: "act_now",
      headlineFacts: [
        { label: "New lowest cash point", amount: -3_350_000, date: "2027-01-14" },
        { label: "Lowest cash point today", amount: -550_000, date: "2026-12-25" },
      ],
      numbers: [
        { label: "Extra days from Jaipur Textiles", value: 10, unit: "days" },
        { label: "Up-front share", value: 40, unit: "pct" },
      ],
      context: { baseLowPoint: { date: "2027-01-14", amount: -3_350_000 }, safetyLine: 3_500_000, shortfall: 6_850_000 },
      recommendation: {
        action: "Ask Jaipur Textiles for 10 more days on PO-2302",
        lever: { kind: "defer", commitmentId: "po-PO-2302", days: 10 },
        byDate: "2026-12-12",
        cashEffect: 1_200_000,
        resultingLowPoint: { date: "2027-01-14", amount: -2_150_000 },
      },
      fallback: {
        action: "Ask Harbor and Hearth for 40% up front on HH-PO-552",
        lever: { kind: "ask_advance", commitmentId: "po-HH-PO-552", share: 0.4 },
        cashEffect: 400_000,
      },
      assumptions: ["assumed Jan 15 for 'in January'"],
      conviction: "medium",
      convictionReasons: ["'in January' is a vague date"],
      whatWouldChange: "The exact date Evergreen Home pays",
      scenario: {
        id: "whatif-evergreen-2027-01-15",
        kind: "what_if",
        overrides: [{ id: "ov-ask-evergreen-jan", target: { commitmentId: "inv-INV-1187" }, change: { date: "2027-01-15" }, origin: "owner" }],
      },
      scenarioId: "whatif-evergreen-2027-01-15",
      citations: ["inv-INV-1187", "po-PO-2302", "po-HH-PO-552"],
      allowedExtra: { dates: ["2027-01-15"] },
    },
    voice: {
      headline: "Act now: if Evergreen Home pays Jan 15, ask Jaipur Textiles for 10 more days by Dec 12.",
      why: "A Jan 15 payment pushes your lowest point to -$33,500 on Jan 14, down from -$5,500 on Dec 25. Ten more days on PO-2302 lifts it by $12,000, to -$21,500. If they refuse, ask Harbor and Hearth for 40% up front on HH-PO-552, which lifts it by $4,000 on its own.",
      nextStep: "Ask Jaipur Textiles for 10 more days on PO-2302 by Dec 12.",
      convictionNote: "Medium confidence: I assumed Jan 15 for \"in January\".",
      whatWouldChange: "The exact date Evergreen Home pays.",
    },
  },
  {
    id: "status-this-month",
    question: "Am I OK this month?",
    decision: {
      ...common,
      intent: "status",
      verdict: "on_track",
      headlineFacts: [
        { label: "Tightest day this month", amount: 4_800_000, date: "2026-11-27" },
        { label: "Safety line", amount: 3_500_000 },
      ],
      numbers: [{ label: "Payments behind the largest open invoice", value: 8, unit: "count" }],
      context: { baseLowPoint: { date: "2026-11-27", amount: 4_800_000 }, safetyLine: 3_500_000 },
      assumptions: [],
      conviction: "high",
      convictionReasons: ["based on 8 payments and current books"],
      whatWouldChange: "A bank balance that is out of date",
      citations: ["inv-INV-1187"],
      allowedExtra: { amounts: [1_300_000] },
    },
    voice: {
      headline: "You're on track this month.",
      why: "Your tightest day is Nov 27, when cash is $48,000, which is $13,000 above your $35,000 safety line.",
      nextStep: null,
      convictionNote: "High confidence: based on 8 payments and current books.",
      whatWouldChange: "If your bank balance is out of date, this changes.",
    },
  },
  {
    id: "lookup-evergreen-lag",
    question: "When does Evergreen usually pay?",
    decision: {
      ...common,
      intent: "lookup",
      verdict: "info",
      headlineFacts: [
        { label: "INV-1187 due", amount: 2_800_000, date: "2026-12-10" },
        { label: "INV-1187 expected", date: "2026-12-24" },
      ],
      numbers: [
        { label: "Evergreen Home typically pays late by", value: 14, unit: "days" },
        { label: "Evergreen Home payments on record", value: 8, unit: "count" },
      ],
      context: {},
      assumptions: [],
      conviction: "high",
      convictionReasons: ["based on 8 payments and no pending reviews"],
      citations: ["inv-INV-1187"],
    },
    voice: {
      headline: "Evergreen Home usually pays about 14 days late.",
      why: "Across 8 payments on record, that is the typical lag after the due date. INV-1187 ($28,000) is due Dec 10, so expect it around Dec 24.",
      nextStep: null,
      convictionNote: "High confidence: based on 8 payments and no pending reviews.",
      whatWouldChange: null,
    },
  },
];


const decisions = drafts.map((x) => ({ id: x.id, question: x.question, decision: withAllowed(x.decision) }));
mkdirSync(ASK_DIR, { recursive: true });
writeFileSync(join(ASK_DIR, "decisions.json"), JSON.stringify(decisions, null, 2) + "\n");

const { profile } = loadAskFixture();
let failed = 0;
for (const [i, x] of drafts.entries()) {
  const d = decisions[i]!.decision;
  const problems = checkVoice({ ...x.voice, nextStep: x.voice.nextStep ?? undefined, whatWouldChange: x.voice.whatWouldChange ?? undefined }, d);
  if (problems.length) { failed++; console.error(`${x.id}: ${problems.join("; ")}`); continue; }
  const key = voiceCacheKey(d, { profile, business: ASK_BUSINESS });
  writeCache(ASK_CACHE_DIR, {
    key, promptVersion: CFO_VOICE_PROMPT_VERSION, model: CFO_VOICE_MODEL, source: "stand-in",
    output: { headline: x.voice.headline, why: x.voice.why, nextStep: x.voice.nextStep ?? null, convictionNote: x.voice.convictionNote, whatWouldChange: x.voice.whatWouldChange ?? null },
  });
  console.log(`ok  ${x.id}  ${key}`);
}
process.exit(failed ? 1 : 0);
