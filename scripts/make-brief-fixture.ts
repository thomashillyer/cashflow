// Builds fixtures/cascade_trade/brief/: a trimmed ForecastRun (from the engine's cascade_trade run), the
// records behind three work items, the work items, and hand-authored stand-in cache entries for the brief
// text and the three drafts. Every stand-in is checked here with the same number_check rules the runtime
// uses, so a stand-in can never state a figure that is not in its facts.
//
//   npx tsx scripts/make-brief-fixture.ts
//
// Replace the stand-ins with live output later: scripts/refresh-brief-cache.ts.
//
// Provenance of the work items: item 1 (chase INV-1187) takes its cashEffect from engine simulate() on
// fixtures/cascade_trade (+$19,500). Items 2 and 3 are illustrative until the ranker (engine/rank.ts)
// produces them: the engine has no ask_advance lever yet, and PO HH-PO-552 is added to the records here.
//
// The committed brief/ fixture is a snapshot of an earlier fixtures/cascade_trade/records.json (before #74 aligned it
// with the intake fixtures; its forecast_run.json carries that run's inputsHash). Its figures still hold, but the cache
// keys include the inputsHash, so re-running this script replaces the live entries with stand-ins under new keys.
// Refresh both together: this script, then scripts/refresh-brief-cache.ts (live, needs ANTHROPIC_API_KEY).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIEF_CACHE_DIR, writeCache } from "../ai/cache";
import {
  briefCacheKey, buildFacts, checkBriefText, checkDraftText, draftCacheKey,
} from "../ai/brief";
import { BRIEF_MODEL, BRIEF_PROMPT_VERSION, DRAFT_MODEL, DRAFT_PROMPT_VERSION } from "../ai/config";
import type { ForecastRun } from "../schema/forecast";
import type { Commitment, Party, Records, WorkItem } from "../schema/records";
import { BRIEF_BUSINESS, BRIEF_DIR, loadBriefFixture } from "./brief-fixture";

const root = join(import.meta.dirname, "..");
const read = <T>(p: string): T => JSON.parse(readFileSync(join(root, p), "utf8")) as T;
const write = (name: string, v: unknown) => writeFileSync(join(BRIEF_DIR, name), JSON.stringify(v, null, 2) + "\n");

// ---- records: the three parties and three commitments the items point at
const all = read<Records>("fixtures/cascade_trade/records.json");
const pick = (id: string) => all.commitments.find((c) => c.id === id)!;
const party = (id: string) => all.parties.find((p) => p.id === id) as Party;

const inv1187: Commitment = {
  ...pick("inv-INV-1187"),
  invoiceUrl: "https://books.zoho.example/portal/cascadetrade/invoice/2-INV-1187",
};
const po2302 = pick("po-PO-2302");
const poHH552: Commitment = {
  id: "po-HH-PO-552", type: "purchase_order", direction: "in", reference: "HH-PO-552", partyId: "party-harbor-hearth",
  amount: 1000000, currency: "USD", anchors: { order: "2026-11-02" }, status: "committed", settlement: "open",
  sourceRef: { system: "generic_file", record: "harbor-po-552.pdf" },
};
const records: Records & { _comment: string } = {
  _comment: "Synthetic. Subset of fixtures/cascade_trade/records.json for the brief/draft tests, plus PO HH-PO-552 (from the intake fixtures) and an invoice link on INV-1187. work_items.json is illustrative: only the INV-1187 cashEffect comes from the engine. Regenerate with scripts/make-brief-fixture.ts.",
  parties: [party("party-evergreen-home"), party("party-jaipur-textiles"), party("party-harbor-hearth")],
  commitments: [inv1187, po2302, poHH552],
  events: [], signals: [], rules: [], settlements: [], balances: [], evidence: [],
};

// ---- forecast run: the engine's cascade_trade run, with daily detail and unrelated events dropped
const full = read<ForecastRun>("fixtures/cascade_trade/forecast_run.json");
const ids = new Set(records.commitments.map((c) => c.id));
const run: ForecastRun = { ...full, days: [], events: full.events.filter((e) => e.commitmentId && ids.has(e.commitmentId)) };

// ---- work items. score = value / (1 + d/7) * confidence * relationship, d = days from asOf to neededBy.
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const score = (value: number, neededBy: string, confidence: number, relationship: number) =>
  Math.round((value / (1 + Math.max(0, days(run.asOf, neededBy)) / 7)) * confidence * relationship);
const item = (o: Pick<WorkItem, "id" | "lever" | "cashEffect" | "neededBy" | "confidence" | "evidenceRefs"> & { relationship: number }): WorkItem => ({
  id: o.id, warning: "projected_cash_gap", title: "", why: "", lever: o.lever, cashEffect: o.cashEffect, neededBy: o.neededBy,
  confidence: o.confidence, score: score(o.cashEffect, o.neededBy, o.confidence, o.relationship), evidenceRefs: o.evidenceRefs,
  actions: [{ kind: "draft_email" }, { kind: "mark_done" }], state: "open",
});
const items: WorkItem[] = [
  item({ id: "wi-chase-INV-1187", lever: { kind: "chase", commitmentId: "inv-INV-1187", assumeDate: "2026-12-18" },
    cashEffect: 1950000, neededBy: "2026-12-18", confidence: 0.85, relationship: 1, evidenceRefs: ["inv-INV-1187"] }),
  item({ id: "wi-defer-PO-2302", lever: { kind: "defer", commitmentId: "po-PO-2302", days: 10 },
    cashEffect: 1200000, neededBy: "2026-12-12", confidence: 0.9, relationship: 0.5, evidenceRefs: ["po-PO-2302"] }),
  item({ id: "wi-advance-HH-PO-552", lever: { kind: "ask_advance", commitmentId: "po-HH-PO-552", share: 0.4 },
    cashEffect: 400000, neededBy: "2026-11-23", confidence: 0.8, relationship: 1, evidenceRefs: ["po-HH-PO-552"] }),
];

mkdirSync(BRIEF_DIR, { recursive: true });
write("forecast_run.json", run);
write("records.json", records);
write("work_items.json", items);

// ---- stand-ins, checked against the facts they were written from
const fx = loadBriefFixture();
const ctx = { ...fx };
// Marks an entry as hand-authored. scripts/refresh-brief-cache.ts replaces it with a live one under the same key.
const SOURCE = "stand-in";

const brief = {
  items: [
    { id: "wi-chase-INV-1187", title: "Chase Evergreen Home on INV-1187",
      why: "Evergreen Home's $28,000 is due Dec 10 but is expected Dec 26, after your lowest point. Getting it by Dec 18 lifts your lowest point from −$5,500 to $14,000." },
    { id: "wi-defer-PO-2302", title: "Ask Jaipur Textiles for 10 more days",
      why: "Jaipur Textiles' ₹1,000,000 (about $12,000 at today's rate) balance falls due Dec 15. Moving it back 10 days lifts your lowest point from −$5,500 to $6,500. Ask by Dec 12." },
    { id: "wi-advance-HH-PO-552", title: "Ask Harbor and Hearth for a 40% advance",
      why: "Harbor and Hearth's PO HH-PO-552 is for $10,000. Asking for 40% up front lifts your lowest point from −$5,500 to −$1,500, which is still below your $35,000 safety line. Ask by Nov 23." },
  ],
};
for (const [i, it] of fx.items.entries()) {
  const b = brief.items[i]!;
  const problem = checkBriefText(b.title, b.why, it, buildFacts(it, ctx));
  if (problem) throw new Error(`brief stand-in ${it.id}: ${problem}`);
}
for (const [i, it] of fx.items.entries()) {
  const { title, why } = brief.items[i]!;
  writeCache(BRIEF_CACHE_DIR, {
    key: briefCacheKey(it, ctx), promptVersion: BRIEF_PROMPT_VERSION, model: BRIEF_MODEL, source: SOURCE, output: { title, why },
  });
}

const drafts: Record<string, { subject: string; body: string }> = {
  "wi-chase-INV-1187": {
    subject: "Invoice INV-1187: $28,000",
    body: "Hello Evergreen Home team,\n\nOur records show invoice INV-1187 for $28,000 is due Dec 10. Could you let me know when we can expect payment? If you can pay it by the due date, Dec 10, it would help us a great deal with our year-end commitments.\n\nIf anything is holding it up, please tell me and I will help sort it out.\n\nThank you,\nCascade Trade Co.",
  },
  "wi-defer-PO-2302": {
    subject: "Payment timing for PO-2302",
    body: "Hello Jaipur Textiles team,\n\nThank you for your continued partnership. We would like to ask whether you could allow 10 more days on PO-2302 (₹2,000,000 in total) for the balance that falls due Dec 15. It would help us manage our cash through the year-end period, and we would be grateful for any flexibility you can offer.\n\nPlease let me know what is possible.\n\nThank you,\nCascade Trade Co.",
  },
  "wi-advance-HH-PO-552": {
    subject: "Advance on PO HH-PO-552",
    body: "Hello Harbor and Hearth team,\n\nThank you for PO HH-PO-552 for $10,000. To help us fund the order, we would like to ask whether you could pay 40% in advance. Please let me know whether that works for you, or what you would suggest instead.\n\nThank you,\nCascade Trade Co.",
  },
};
for (const it of fx.items) {
  const d = drafts[it.id]!;
  const problem = checkDraftText(d.subject, d.body, it, buildFacts(it, ctx));
  if (problem) throw new Error(`draft stand-in ${it.id}: ${problem}`);
  writeCache(BRIEF_CACHE_DIR, {
    key: draftCacheKey(it, { ...ctx, business: BRIEF_BUSINESS }), promptVersion: DRAFT_PROMPT_VERSION, model: DRAFT_MODEL,
    source: SOURCE, output: d,
  });
}
console.log("wrote fixtures/cascade_trade/brief/ and its cache");
