// Ask Neri decision engine (P4.20). One pure function from a resolved AskIntent to a Decision: code runs the
// engine, picks ONE recommendation, computes conviction, and names what would change the call. Claude only
// voices the result. No LLM, no I/O, no clock (asOf is an input), no randomness.
//
// Design: docs/design/08-claude-layer.md ("Ask Neri: a CFO, not a menu"). Contract: schema/ask.ts.
//
// Every string in a Decision (action, assumptions, convictionReasons, whatWouldChange, question,
// missingData) is built here from data. It names parties and document references from the records and
// never quotes party notes, rule notes, or message text. Every figure in those strings goes through the
// `Figures` collector, so `Decision.allowed` is exactly the union of what the strings and fields state.

import { createHash } from "node:crypto";
import type { AskIntent, Conviction, Decision, NumberFact } from "../../schema/ask";
import type { ForecastRun } from "../../schema/forecast";
import type { Profile } from "../../schema/profile";
import type { CashEvent, Commitment, Lever, Override, Records, Scenario, WorkItem } from "../../schema/records";
import { runAtUpfrontShare, smallestUpfrontShare } from "../../engine/affordability";
import { addDays, diffDays } from "../../engine/dates";
import { toBase } from "../../engine/expand";
import { forecast, horizonEnd } from "../../engine/forecast";
import { buildBrief } from "../../engine/brief";
import { simulate } from "../../engine/simulate";
import { confirmedLagRule, lagSamples, partyLag } from "../../engine/lag";
import { mondayOf } from "../../engine/dates";
import { commitmentDirection, isOpen, pendingEventsByCommitment } from "../../engine/warnings";
import { extractFigures } from "../number_check";
import { fmtDate } from "../brief";
import { fmtMoney } from "../money";
import { askDraftId, draftCadence, intentAssumptions } from "./intent";

export type DecideContext = {
  records: Records;
  profile: Profile;
  asOf: string;
  fxRates: Record<string, number>;
  baseOverrides?: Override[];
  pendingReviewCount: number;   // unresolved Review items; the caller counts them
};

const DEFAULT_HIGH_SAMPLES = 6;
const DEFAULT_MEDIUM_SAMPLES = 3;
const DEFAULT_MAX_PENDING = 0;
const DEFAULT_DATE_OFFSET_DAYS = 30;
const SYNTHETIC_PREFIX = "ask-draft-";

// ---------------------------------------------------------------------------------------------------------
// Figures: the one place a number enters a code-built string, so `allowed` can never miss one.

class Figures {
  readonly amounts = new Set<number>();
  readonly dates = new Set<string>();
  readonly numbers: NumberFact[] = [];
  constructor(readonly currency: string, readonly asOf: string) {}

  m(minor: number): string {
    this.amounts.add(minor);
    return fmtMoney(minor, this.currency);
  }
  d(date: string): string {
    this.dates.add(date);
    return date;
  }
  // A date written for the owner ("Dec 10"); registered as allowed like d().
  h(date: string): string {
    this.dates.add(date);
    return fmtDate(date, this.asOf);
  }
  private fact(label: string, value: number, unit: NumberFact["unit"]): void {
    if (!this.numbers.some((n) => n.value === value && n.unit === unit && n.label === label)) this.numbers.push({ label, value, unit });
  }
  pct(label: string, whole: number): string {
    this.fact(label, whole, "pct");
    return `${whole}%`;
  }
  days(label: string, value: number, more = false): string {
    this.fact(label, value, "days");
    return `${value}${more ? " more" : ""} day${value === 1 ? "" : "s"}`;
  }
  count(label: string, value: number, noun: string, plural = `${noun}s`): string {
    this.fact(label, value, "count");
    return `${value} ${value === 1 ? noun : plural}`;
  }
  stat(label: string, value: number, unit: NumberFact["unit"]): void {
    this.fact(label, value, unit);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Small helpers

type Day = { date: string; amount: number };
type Window = { from: string; to: string };

const hash10 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const isSynthetic = (id: string | undefined) => !!id && id.startsWith(SYNTHETIC_PREFIX);

function dirOf(c: Commitment): "in" | "out" {
  return c.direction ?? commitmentDirection(c) ?? (c.type === "sales_deal" ? "in" : "out");
}

function partyName(records: Records, id: string | undefined): string | undefined {
  return id ? records.parties.find((p) => p.id === id)?.name : undefined;
}

const commitmentLabel = (c: Commitment): string => c.reference ?? c.id;

function minDay(run: ForecastRun, w: Window): Day | undefined {
  let low: Day | undefined;
  for (const d of run.days) {
    if (d.date < w.from || d.date > w.to) continue;
    if (!low || d.closing < low.amount) low = { date: d.date, amount: d.closing };
  }
  return low;
}

function eventsOn(run: ForecastRun, date: string): string[] {
  return run.days.find((d) => d.date === date)?.eventIds ?? [];
}

function pendingEvents(run: ForecastRun, ids: string[]): CashEvent[] {
  return run.events.filter(
    (e) => e.status !== "actual" && !!e.commitmentId && ids.some((id) => e.commitmentId === id || e.commitmentId!.startsWith(`${id}~`)),
  );
}

// ---------------------------------------------------------------------------------------------------------
// Draft Decision assembly: `allowed` and `numbers` are computed once, here.

type DecisionDraft = Omit<Decision, "allowed" | "numbers">;

function assemble(f: Figures, d: DecisionDraft): Decision {
  const amounts = new Set(f.amounts);
  const dates = new Set(f.dates);
  const addA = (n: number | undefined) => { if (n !== undefined) amounts.add(n); };
  const addD = (x: string | undefined) => { if (x) dates.add(x); };
  for (const h of d.headlineFacts) { addA(h.amount); addD(h.date); }
  addA(d.context.baseLowPoint?.amount); addD(d.context.baseLowPoint?.date);
  addA(d.context.safetyLine); addA(d.context.shortfall);
  const r = d.recommendation;
  if (r) {
    addA(r.cashEffect); addA(r.resultingLowPoint?.amount); addD(r.resultingLowPoint?.date); addD(r.byDate);
    if (r.lever?.kind === "chase") addD(r.lever.assumeDate);
    if (r.lever?.kind === "defer") f.stat("days asked", r.lever.days, "days");
    if (r.upfrontShare !== undefined) f.stat("upfront share", Math.round(r.upfrontShare * 100), "pct");
  }
  addA(d.fallback?.cashEffect);
  if (d.fallback?.lever?.kind === "chase") addD(d.fallback.lever.assumeDate);
  if (d.fallback?.lever?.kind === "defer") f.stat("days asked", d.fallback.lever.days, "days");
  if (d.proposal?.kind === "commitment") {
    addA(d.proposal.draft.amount);
    for (const a of Object.values(d.proposal.draft.anchors)) addD(a);
  }
  for (const c of d.scenarioInputs?.commitments ?? []) {
    addA(c.amount);
    for (const a of Object.values(c.anchors)) addD(a);
  }
  for (const x of d.scenarioInputs?.recurring ?? []) { addA(x.amount); addD(x.anchor); addD(x.startDate); }
  for (const o of d.scenario?.overrides ?? []) { addD(o.change.date); addA(o.change.amount); }
  addD(d.asOf);
  const numbers: NumberFact[] = [...f.numbers];
  return {
    ...d,
    // Synthetic drafts and virtual linked costs are not records the UI can open.
    citations: d.citations.filter((id) => !id.includes(SYNTHETIC_PREFIX) && !id.includes("~")),
    numbers,
    allowed: {
      amounts: [...amounts].sort((a, b) => a - b),
      dates: [...dates].sort(),
      numbers,
    },
  };
}

function skeleton(intent: AskIntent, ctx: DecideContext): Pick<DecisionDraft, "intent" | "asOf" | "currency"> {
  return { intent: intent.kind, asOf: ctx.asOf, currency: ctx.profile.baseCurrency };
}

// ---------------------------------------------------------------------------------------------------------
// need_info and decline

function needInfo(intent: AskIntent, ctx: DecideContext, question: string, why: string): Decision {
  const f = new Figures(ctx.profile.baseCurrency, ctx.asOf);
  // The question may come from the resolver; any figure it states is its own, so it is allowed.
  const figs = extractFigures(question, { currency: ctx.profile.baseCurrency, asOf: ctx.asOf });
  for (const a of figs.amounts) if (Number.isFinite(a.minor)) f.amounts.add(a.minor);
  for (const dt of figs.dates) f.dates.add(dt.date);
  const q = question.trim();
  const text = /[?]$/.test(q) ? q : `${q}?`;
  return assemble(f, {
    ...skeleton(intent, ctx),
    verdict: "need_info",
    headlineFacts: [],
    context: {},
    assumptions: [],
    question: text.charAt(0).toUpperCase() + text.slice(1),
    conviction: "low",
    convictionReasons: [why],
    citations: [],
    missingData: why,
  });
}

function neededSlots(intent: AskIntent): { question: string; why: string } | undefined {
  switch (intent.kind) {
    case "afford":
      if (!intent.draft && !intent.commitmentId) return { question: "How much is it, or which order or bill do you mean?", why: "No amount or existing order or bill was identified." };
      return undefined;
    case "what_if":
      if (!intent.draft && !((intent.commitmentId || intent.partyId) && intent.date)) return { question: "Which customer or supplier, and on what date?", why: "A what-if needs a party or item and a date." };
      return undefined;
    case "tell":
      if (!intent.draft && !intent.rule) {
        return intent.raw.ruleKind
          ? { question: "Which customer or supplier, and what should I remember about them?", why: "A rule needs a party and a parameter." }
          : { question: "How much is the plan, and when is it?", why: "A plan needs an amount and a date." };
      }
      return undefined;
    case "lookup":
      if (!intent.partyId && !intent.commitmentId) return { question: "Which customer or supplier do you mean?", why: "No party was identified." };
      return undefined;
    default:
      return undefined;
  }
}

function baseWorld(ctx: DecideContext): World {
  return { records: ctx.records, profile: ctx.profile, overrides: ctx.baseOverrides ?? [] };
}

function decline(intent: AskIntent, ctx: DecideContext): Decision {
  const f = new Figures(ctx.profile.baseCurrency, ctx.asOf);
  const w = baseWorld(ctx);
  const run = forecast(w.records, w.profile, { id: "base", kind: "base", overrides: w.overrides }, ctx.asOf, ctx.fxRates);
  const low: Day = { date: run.lowPoint.date, amount: run.lowPoint.amount };
  return assemble(f, {
    ...skeleton(intent, ctx),
    verdict: "decline",
    headlineFacts: [{ label: "Lowest cash point", amount: low.amount, date: low.date }, { label: "Safety line", amount: run.safetyLine }],
    context: { baseLowPoint: low, safetyLine: run.safetyLine, ...(low.amount < run.safetyLine ? { shortfall: run.safetyLine - low.amount } : {}) },
    assumptions: [],
    conviction: "high",
    convictionReasons: ["The cash figures come straight from the current forecast."],
    citations: uniq(eventsOn(run, low.date)),
    missingData: "I can't advise on investment or loan products, or on topics outside this business's cash. Here is where your cash stands.",
  });
}

// ---------------------------------------------------------------------------------------------------------
// Worlds: the records, profile, and overrides a question is evaluated in.

type World = { records: Records; profile: Profile; overrides: Override[] };

// ---------------------------------------------------------------------------------------------------------
// Conviction

type Path = {
  events: CashEvent[];                       // pending events the call rests on
  timingPartyIds: (string | undefined)[];    // parties whose payment timing is an estimate on this path
};

const LEVEL_ORDER: Conviction[] = ["low", "medium", "high"];
const lower = (a: Conviction, b: Conviction): Conviction => (LEVEL_ORDER.indexOf(a) <= LEVEL_ORDER.indexOf(b) ? a : b);

function timingParties(records: Records, commitmentIds: string[]): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  for (const id of commitmentIds) {
    const c = records.commitments.find((x) => x.id === id);
    if (c && dirOf(c) === "in") out.push(c.partyId);
  }
  return uniq(out);
}

function eventNoun(records: Records, profile: Profile, e: CashEvent, parentOnly = false): string {
  if (isSynthetic(e.commitmentId)) return e.direction === "in" ? "the order you are asking about" : "your planned payment";
  const parentId = e.commitmentId?.includes("~") ? e.commitmentId.split("~")[0] : e.commitmentId;
  const c = records.commitments.find((x) => x.id === parentId);
  const rec = profile.recurring.find((r) => r.id === parentId);
  if (!parentOnly && e.commitmentId?.includes("~") && c) return `the linked costs of ${commitmentLabel(c)}`;
  if (c) return commitmentLabel(c);
  if (rec) return rec.name;
  return "an unmatched item";
}

function convict(
  ctx: DecideContext,
  f: Figures,
  world: World,
  path: Path,
  assumedDate: string | undefined,
): { conviction: Conviction; convictionReasons: string[]; whatWouldChange?: string } {
  const { records, profile } = world;
  const t = profile.thresholds;
  const highMin = t.conviction?.highMinLagSamples ?? DEFAULT_HIGH_SAMPLES;
  const midMin = t.conviction?.mediumMinLagSamples ?? DEFAULT_MEDIUM_SAMPLES;
  const maxPending = t.conviction?.maxPendingReviewsForHigh ?? DEFAULT_MAX_PENDING;
  const reasons: string[] = [];

  // 1. The weakest timing input on the path.
  let level: Conviction = "high";
  if (path.timingPartyIds.length === 0) {
    reasons.push("The call does not rest on when a customer pays.");
  } else {
    const per = path.timingPartyIds.map((pid) => {
      const lag = partyLag(records, profile, pid);
      const rule = confirmedLagRule(records.rules, pid);
      const n = lagSamples(records, pid ?? "").length;
      const name = partyName(records, pid) ?? "this customer";
      const strong = !!rule || n >= highMin;
      const mid = !!rule || n >= midMin;
      const reviewsBlock = ctx.pendingReviewCount > maxPending;
      const lv: Conviction = strong && !reviewsBlock ? "high" : mid ? "medium" : "low";
      let why: string;
      if (rule && !reviewsBlock) why = `${name} has a payment rule you confirmed.`;
      else if (rule) why = `${name} has a payment rule you confirmed, but ${f.count("items waiting in Review", ctx.pendingReviewCount, "item")} are waiting in Review.`;
      else if (n === 0) why = `There is no payment history for ${name}; the forecast uses the profile default of ${f.days("default lag", lag.days)}.`;
      else if (strong && reviewsBlock) why = `${name} has ${f.count("payments on record", n, "payment")}, but ${f.count("items waiting in Review", ctx.pendingReviewCount, "item")} are waiting in Review.`;
      else if (strong) why = `Based on ${f.count("payments on record", n, "payment")} from ${name}.`;
      else why = `Only ${f.count("payments on record", n, "payment")} from ${name} on record.`;
      return { lv, why };
    });
    level = per.map((p) => p.lv).reduce(lower);
    for (const p of per) if (p.lv === level) reasons.push(p.why);
  }

  // 2. Caps: a stale balance, a tentative or possible event on the path, a vague date.
  let caps = 0;
  const snap = records.balances.reduce<string | undefined>((m, b) => (m === undefined || b.asOf > m ? b.asOf : m), undefined);
  if (t.staleAfterHours !== undefined && snap !== undefined && diffDays(ctx.asOf, snap) * 24 > t.staleAfterHours) {
    caps++;
    reasons.push(`The bank balance was last updated on ${f.h(snap)}, ${f.days("balance age", diffDays(ctx.asOf, snap))} old.`);
  }
  const tentative = uniq(
    path.events
      .filter((e) => (e.status === "likely" || e.status === "possible") && !isSynthetic(e.commitmentId))
      .map((e) => eventNoun(records, profile, e, true)),
  );
  if (tentative.length > 0) {
    caps++;
    reasons.push(`${tentative.slice(0, 2).join(" and ")} ${tentative.length > 1 ? "are" : "is"} not yet confirmed.`);
  }
  if (assumedDate !== undefined) {
    caps++;
    reasons.push(assumedDate ? `The date is an assumption: ${f.h(assumedDate)}.` : "The date is an assumption.");
  }
  if (caps >= 2) level = "low";
  else if (caps === 1) level = lower(level, "medium");

  // 3. The lowest-confidence event on the path (earliest first on ties).
  const least = [...path.events].sort((a, b) => a.confidence - b.confidence || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || (a.id < b.id ? -1 : 1))[0];
  let whatWouldChange: string | undefined;
  if (least) {
    const c = records.commitments.find((x) => x.id === least.commitmentId);
    const who = partyName(records, c?.partyId);
    const what = eventNoun(records, profile, least);
    const money = f.m(least.amountBase);
    const when = f.h(least.date);
    if (isSynthetic(least.commitmentId)) whatWouldChange = `Least certain: ${what} of ${money}, expected ${when}.`;
    else if (least.direction === "in") whatWouldChange = `Least certain: the ${money} receipt${who ? ` from ${who}` : ""} (${what}), expected ${when}.`;
    else whatWouldChange = `Least certain: the ${money} payment${who ? ` to ${who}` : ""} (${what}), expected ${when}.`;
  }
  return { conviction: level, convictionReasons: reasons, ...(whatWouldChange ? { whatWouldChange } : {}) };
}

// ---------------------------------------------------------------------------------------------------------
// Levers as actions, and the fix_gap pick

// withDate: a chase names the date it assumes payment; the recommendation leaves it to byDate (one by-date in the answer).
function leverAction(f: Figures, records: Records, lever: Lever, withDate = true): string {
  const c = records.commitments.find((x) => x.id === lever.commitmentId);
  const ref = c ? commitmentLabel(c) : lever.commitmentId;
  const who = partyName(records, c?.partyId);
  switch (lever.kind) {
    case "chase":
      if (!withDate) return who ? `Chase ${who} to pay ${ref}` : `Chase payment of ${ref}`;
      return who ? `Chase ${who} to pay ${ref} by ${f.h(lever.assumeDate)}` : `Chase payment of ${ref} by ${f.h(lever.assumeDate)}`;
    case "defer":
      return who ? `Ask ${who} for ${f.days("days asked", lever.days, true)} on ${ref}` : `Move ${ref} out by ${f.days("days asked", lever.days)}`;
    case "pay_early":
      return `Pay ${ref} early to keep the discount`;
    case "split":
      return `Ask ${who ?? "them"} to split ${ref} into ${f.count("split payments", lever.shares.length, "payment")}`;
    case "ask_advance":
      return `Ask ${who ?? "them"} for ${f.pct("advance share", Math.round(lever.share * 100))} up front on ${ref}`;
  }
}

const EXCLUDED_WARNINGS = new Set(["idle_balance_over", "early_pay_discount", "payment_slip"]);

type Move = { item: WorkItem; lever: Lever; cashEffect: number; resulting: Day };
type Gap = { run: ForecastRun; low: Day; below: boolean; pick?: Move; fallback?: Move };

function fixGap(ctx: DecideContext, world: World, window: Window | undefined, mustClear: boolean): Gap {
  const { run, brief } = buildBrief({
    records: world.records, profile: world.profile, asOf: ctx.asOf, fxRates: ctx.fxRates, baseOverrides: world.overrides,
  });
  const w = window ?? { from: ctx.asOf, to: horizonEnd(world.profile, ctx.asOf) };
  const low = minDay(run, w) ?? { date: run.lowPoint.date, amount: run.lowPoint.amount };
  const below = low.amount < run.safetyLine;
  if (!below) return { run, low, below };

  const seen = new Set<string>();
  const items = [...brief.today, ...brief.all].filter((i) => {
    if (seen.has(i.id)) return false;
    seen.add(i.id);
    return i.state === "open" && !!i.lever && i.cashEffect > 0 && i.lever.kind !== "pay_early" && !EXCLUDED_WARNINGS.has(i.warning);
  });
  const evalItem = (item: WorkItem): Move | undefined => {
    const lever = item.lever!;
    const sim = simulate(world.records, world.profile, world.overrides, [lever], ctx.asOf, ctx.fxRates);
    const before = minDay(sim.base, w);
    const after = minDay(sim.run, w);
    if (!before || !after) return undefined;
    const cashEffect = after.amount - before.amount;
    if (cashEffect <= 0) return undefined;
    if (mustClear && after.amount < run.safetyLine) return undefined;
    return { item, lever, cashEffect, resulting: after };
  };
  const partyOfLever = (l: Lever) => world.records.commitments.find((c) => c.id === l.commitmentId)?.partyId;
  let pick: Move | undefined;
  let fallback: Move | undefined;
  for (const item of items) {
    const mv = evalItem(item);
    if (!mv) continue;
    if (!pick) { pick = mv; continue; }
    const pa = partyOfLever(pick.lever);
    const pb = partyOfLever(mv.lever);
    if (mv.lever.commitmentId === pick.lever.commitmentId) continue;
    if (pa && pb && pa === pb) continue;
    fallback = mv;
    break;
  }
  return { run, low, below, ...(pick ? { pick } : {}), ...(fallback ? { fallback } : {}) };
}

// Recommendation, fallback, and conviction path for a Gap's pick.
function moveParts(f: Figures, world: World, gap: Gap) {
  const rec: NonNullable<Decision["recommendation"]> | undefined = gap.pick && {
    action: leverAction(f, world.records, gap.pick.lever, false),
    lever: gap.pick.lever,
    byDate: f.d(gap.pick.item.neededBy),
    cashEffect: gap.pick.cashEffect,
    resultingLowPoint: { date: gap.pick.resulting.date, amount: gap.pick.resulting.amount },
  };
  if (rec?.resultingLowPoint) f.d(rec.resultingLowPoint.date);
  const fb: Decision["fallback"] | undefined = gap.fallback && {
    action: leverAction(f, world.records, gap.fallback.lever),
    lever: gap.fallback.lever,
    cashEffect: gap.fallback.cashEffect,
  };
  return { rec, fb };
}


function pathForMove(world: World, gap: Gap): Path {
  if (!gap.pick) return { events: [], timingPartyIds: [] };
  const id = gap.pick.lever.commitmentId;
  return { events: pendingEvents(gap.run, [id]), timingPartyIds: timingParties(world.records, [id]) };
}

// The call on a clean run rests on the receipts that must land before the tightest day.
function pathForOnTrack(world: World, run: ForecastRun, low: Day): Path {
  const events = run.events.filter(
    (e) => e.direction === "in" && e.status !== "actual" && e.status !== "possible" && e.commitmentId && e.date >= run.asOf && e.date <= low.date,
  );
  const ids = uniq(events.map((e) => e.commitmentId!.split("~")[0]!));
  return { events, timingPartyIds: timingParties(world.records, ids) };
}

function lowFacts(label: string, d: Day) {
  return { label, amount: d.amount, date: d.date };
}

// ---------------------------------------------------------------------------------------------------------
// fix_gap and status

function runFixGap(intent: AskIntent, ctx: DecideContext, window: Window | undefined, tightestLabel: string, extraAssumptions: string[] = []): Decision {
  const f = new Figures(ctx.profile.baseCurrency, ctx.asOf);
  const world = baseWorld(ctx);
  const win = window ?? { from: ctx.asOf, to: horizonEnd(ctx.profile, ctx.asOf) };
  const gap = fixGap(ctx, world, win, false);
  if (!minDay(gap.run, win)) {
    return needInfo(intent, ctx, `Which dates should I look at? I can only see through ${horizonEnd(ctx.profile, ctx.asOf)}`, "The dates asked about are outside the forecast.");
  }
  const assumptions = [...baseAssumptions(intent, ctx, f), ...extraAssumptions];
  const verdict: Decision["verdict"] = gap.below ? "act_now" : "on_track";
  const { rec, fb } = moveParts(f, world, gap);
  const path = gap.below ? pathForMove(world, gap) : pathForOnTrack(world, gap.run, gap.low);
  const conv = convict(ctx, f, world, path, assumedOf(intent, undefined));
  const reasons = [...conv.convictionReasons];
  let missing: string | undefined;
  if (gap.below && !gap.pick) {
    missing = "No single move in your books raises the low point enough to count.";
    reasons.push("No lever in the books raises the low point.");
  }
  const headline: Decision["headlineFacts"] = [lowFacts(tightestLabel, gap.low), { label: "Safety line", amount: gap.run.safetyLine }];
  if (rec?.resultingLowPoint) headline.push(lowFacts("Lowest cash point after the move", rec.resultingLowPoint));
  const tightest = intent.kind === "status" && diffDays(win.to, win.from) >= 28;
  return assemble(f, {
    ...skeleton(intent, ctx),
    verdict,
    ...(tightest ? { lead: { kind: "tightest" as const, weekStart: f.d(mondayOf(gap.low.date)) } } : {}),
    headlineFacts: headline.slice(0, 3),
    context: {
      baseLowPoint: gap.low,
      safetyLine: gap.run.safetyLine,
      ...(gap.below ? { shortfall: gap.run.safetyLine - gap.low.amount } : {}),
    },
    ...(rec ? { recommendation: rec } : {}),
    ...(fb ? { fallback: fb } : {}),
    assumptions,
    conviction: conv.conviction,
    convictionReasons: reasons,
    ...(conv.whatWouldChange ? { whatWouldChange: conv.whatWouldChange } : {}),
    citations: uniq([...(gap.pick ? [gap.pick.lever.commitmentId, ...gap.pick.item.evidenceRefs] : []), ...eventsOn(gap.run, gap.low.date)]),
    ...(missing ? { missingData: missing } : {}),
  });
}

// What the intent step assumed on the owner's behalf (currency, vague or default date, linked costs, cadence),
// reused as written. Those strings carry the owner's own figures, so what they state is registered as allowed.
function baseAssumptions(intent: AskIntent, ctx: DecideContext, f: Figures): string[] {
  const out = intentAssumptions(intent, { profile: ctx.profile, asOf: ctx.asOf }).map((s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`);
  const figs = extractFigures(out.join(" "), { currency: ctx.profile.baseCurrency, asOf: ctx.asOf });
  for (const a of figs.amounts) if (Number.isFinite(a.minor)) f.amounts.add(a.minor);
  for (const d of figs.dates) f.dates.add(d.date);
  if (intent.date) f.dates.add(intent.date);
  const text = out.join(" ");
  for (const m of text.matchAll(/(?<![\d,.$])(\d+)%/g)) f.pct("stated percent", Number(m[1]));
  for (const m of text.matchAll(/(?<![\d,.$])(\d+) (?:more |extra )?days?\b/g)) f.days("stated days", Number(m[1]));
  if (intent.raw.containsInstructions) out.push("The question contained an instruction; it was ignored and only the question was answered.");
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// afford and what_if: synthetic inputs

function resolveDate(intent: AskIntent, ctx: DecideContext, f: Figures, assumptions: string[]): string {
  const a = intent.draft?.anchors;
  const given = intent.date ?? a?.due ?? a?.order ?? a?.delivery ?? a?.invoice;
  if (given) return given;
  const date = addDays(ctx.asOf, DEFAULT_DATE_OFFSET_DAYS);
  assumptions.push(`No date was given; assumed ${f.h(date)}, ${f.days("default date offset", DEFAULT_DATE_OFFSET_DAYS)} out.`);
  return date;
}

function draftBase(ctx: DecideContext, intent: AskIntent): number | undefined {
  const d = intent.draft!;
  return toBase(d.amount, d.currency, ctx.profile, ctx.fxRates);
}

function syntheticCommitment(ctx: DecideContext, intent: AskIntent, kind: "deal" | "plan", date: string, amountBase: number): Commitment {
  const draft = intent.draft!;
  const id = askDraftId(intent.question);
  const partyId = draft.partyId ?? intent.partyId;
  const common = {
    id,
    currency: ctx.profile.baseCurrency,
    amount: amountBase,
    status: "likely" as const,
    sourceRef: { system: "owner", record: id },
    ...(partyId ? { partyId } : {}),
    ...(draft.category ? { category: draft.category } : {}),
  };
  return kind === "deal"
    ? { ...common, type: "sales_deal", direction: "in", anchors: { order: date } }
    : { ...common, type: "plan", direction: "out", anchors: { due: date } };
}

function withCommitment(records: Records, c: Commitment): Records {
  return { ...records, commitments: [...records.commitments, c] };
}

// An assumed date caps conviction: given by the resolver as vague, or defaulted here. "" = vague with no date.
// The intent step also defaults a draft's missing date (no date phrase), which is an assumption too.
function assumedOf(intent: AskIntent, dateAssumed: string | undefined): string | undefined {
  const defaulted = !!intent.draft && !!intent.date && !intent.raw.datePhrase;
  return dateAssumed ?? (intent.dateVague !== undefined || defaulted ? intent.date ?? "" : undefined);
}

// "Can I afford a hire / new fixed cost?" is a recurring item, not a one-time payment: evaluate it as the what_if
// does (profile recurring item), then phrase the verdict as an afford answer.
function affordRecurring(intent: AskIntent, ctx: DecideContext): Decision {
  const d = runWhatIf(intent, ctx);
  if (d.verdict !== "on_track" && d.verdict !== "act_now") return d;
  const safety = d.context.safetyLine ?? 0;
  if (d.verdict === "on_track") return { ...d, verdict: "yes" };
  const baseOk = (d.context.baseLowPoint?.amount ?? 0) >= safety;
  if (!baseOk) return d; // short of the line without the new cost: the gap is the story (act_now)
  if (d.recommendation?.resultingLowPoint && d.recommendation.resultingLowPoint.amount >= safety) return { ...d, verdict: "yes_if" };
  const { recommendation: _drop, fallback: _fb, ...rest } = d;
  return { ...rest, verdict: "no", recommendation: { action: "Hold off on the new recurring cost until cash improves" } };
}

// The shortfall exists without the thing asked about: answer as fix_gap on the world without it (act_now).
function actNowWithout(
  intent: AskIntent, ctx: DecideContext, f: Figures, w2: World, assumptions: string[], assumed: string | undefined,
  scenarioInputs: Decision["scenarioInputs"], subjectId: string, note: string, label: string,
): Decision {
  const gap = fixGap(ctx, w2, undefined, false);
  const { rec, fb } = moveParts(f, w2, gap);
  const conv = convict(ctx, f, w2, pathForMove(w2, gap), assumed);
  assumptions.push(note);
  const headline: Decision["headlineFacts"] = [lowFacts(label, gap.low), { label: "Safety line", amount: gap.run.safetyLine }];
  if (rec?.resultingLowPoint) headline.push(lowFacts("Lowest cash point after the move", rec.resultingLowPoint));
  return assemble(f, {
    ...skeleton(intent, ctx),
    verdict: "act_now",
    lead: { kind: "short_before" },
    headlineFacts: headline.slice(0, 3),
    context: { baseLowPoint: gap.low, safetyLine: gap.run.safetyLine, shortfall: Math.max(0, gap.run.safetyLine - gap.low.amount) },
    ...(rec ? { recommendation: rec } : {}),
    ...(fb ? { fallback: fb } : {}),
    assumptions,
    conviction: conv.conviction,
    convictionReasons: conv.convictionReasons,
    ...(conv.whatWouldChange ? { whatWouldChange: conv.whatWouldChange } : {}),
    ...(scenarioInputs ? { scenarioInputs } : {}),
    citations: uniq([subjectId, ...(gap.pick ? [gap.pick.lever.commitmentId, ...gap.pick.item.evidenceRefs] : []), ...eventsOn(gap.run, gap.low.date)]),
  });
}

function runAfford(intent: AskIntent, ctx: DecideContext): Decision {
  const f = new Figures(ctx.profile.baseCurrency, ctx.asOf);
  const assumptions = baseAssumptions(intent, ctx, f);
  const records = ctx.records;
  if (intent.draft?.type === "recurring" && !intent.commitmentId) return affordRecurring(intent, ctx);
  const existing = intent.commitmentId ? records.commitments.find((c) => c.id === intent.commitmentId) : undefined;
  if (intent.commitmentId && !existing && !intent.draft) {
    return needInfo(intent, ctx, "Which order or bill do you mean?", "The item named was not found in the books.");
  }

  // What is being asked about: an existing commitment, or a draft turned into a synthetic one.
  let target: Commitment;
  let synthetic = false;
  let dateAssumed: string | undefined;
  let date: string | undefined;
  if (existing) {
    target = existing;
  } else {
    const base = draftBase(ctx, intent);
    if (base === undefined) return needInfo(intent, ctx, `What is ${intent.draft!.currency} worth in ${ctx.profile.baseCurrency}?`, `There is no exchange rate for ${intent.draft!.currency}.`);
    const before = assumptions.length;
    date = resolveDate(intent, ctx, f, assumptions);
    if (assumptions.length > before) dateAssumed = date;
    const dir = intent.draft!.direction ?? (intent.draft!.type === "sales_deal" ? "in" : "out");
    target = syntheticCommitment(ctx, intent, dir === "in" ? "deal" : "plan", date, base);
    synthetic = true;
  }

  const dir = dirOf(target);
  const world: World = { records: synthetic ? withCommitment(records, target) : records, profile: ctx.profile, overrides: ctx.baseOverrides ?? [] };
  const scenarioInputs = synthetic ? { commitments: [target] } : undefined;
  const label = synthetic ? (dir === "in" ? "the order" : "the payment") : commitmentLabel(target);
  const dateOf = date ?? target.anchors.due ?? target.anchors.order ?? target.anchors.invoice ?? ctx.asOf;

  if (dir === "in" && target.type === "sales_deal") {
    return affordDeal(intent, ctx, f, world, target, label, assumptions, scenarioInputs, assumedOf(intent, dateAssumed));
  }
  if (dir === "in") {
    // Already-expected receivable: nothing to afford; show the cash picture and the move that helps most.
    return runFixGap(intent, ctx, undefined, "Lowest cash point", ["This is money you are owed rather than a spend, so the answer is the current cash picture."]);
  }

  // Outbound plan (or existing outbound commitment).
  const without: ForecastRun = synthetic
    ? forecast(records, ctx.profile, { id: "base", kind: "base", overrides: world.overrides }, ctx.asOf, ctx.fxRates)
    : forecast(records, ctx.profile, { id: "base-without", kind: "what_if", overrides: [...world.overrides, { id: `ask-without-${target.id}`, target: { commitmentId: target.id }, change: { exclude: true }, origin: "owner" }] }, ctx.asOf, ctx.fxRates);
  const baseLow: Day = { date: without.lowPoint.date, amount: without.lowPoint.amount };
  if (baseLow.amount < without.safetyLine) {
    // Short of the line without this payment: the payment is not the cause.
    const w2: World = synthetic
      ? { records, profile: ctx.profile, overrides: world.overrides }
      : { records, profile: ctx.profile, overrides: [...world.overrides, { id: `ask-without-${target.id}`, target: { commitmentId: target.id }, change: { exclude: true }, origin: "owner" }] };
    return actNowWithout(intent, ctx, f, w2, assumptions, assumedOf(intent, dateAssumed), scenarioInputs, target.id,
      `Cash is below the safety line even without ${synthetic ? "this payment" : label}, so the payment is not the cause.`, "Lowest cash point without the payment");
  }
  const gap = fixGap(ctx, world, undefined, true);
  // The money asked about, in the base currency from the run's own legs (an existing item may be partly paid or foreign).
  const legs = pendingEvents(gap.run, [target.id]).filter((e) => e.direction === "out");
  const spendAmount = legs.length > 0 ? legs.reduce((a, e) => a + e.amountBase, 0) : target.amount;
  const spendDate = legs.length > 0 ? legs.map((e) => e.date).sort()[0]! : dateOf;
  const amountText = f.m(spendAmount);
  const planDate = f.h(spendDate);
  const spend: Decision["headlineFacts"][number] = { label: synthetic ? "Planned payment" : "Payment", amount: spendAmount, date: spendDate };
  // baseLowPoint is the run without the payment (design table), so the shortfall is measured on it too; the low
  // point with the payment is headlineFacts[0].
  const ctxFacts = {
    baseLowPoint: baseLow,
    safetyLine: gap.run.safetyLine,
    ...(baseLow.amount < gap.run.safetyLine ? { shortfall: gap.run.safetyLine - baseLow.amount } : {}),
  };
  const targetPath: Path = { events: pendingEvents(gap.run, [target.id]), timingPartyIds: [] };
  const citeBase = [target.id, ...eventsOn(gap.run, gap.low.date)];

  if (!gap.below) {
    const conv = convict(ctx, f, world, targetPath, assumedOf(intent, dateAssumed));
    return assemble(f, {
      ...skeleton(intent, ctx),
      verdict: "yes",
      headlineFacts: [lowFacts("Lowest cash point with this payment", gap.low), { label: "Safety line", amount: gap.run.safetyLine }, spend],
      context: ctxFacts,
      assumptions,
      conviction: conv.conviction,
      convictionReasons: conv.convictionReasons,
      ...(conv.whatWouldChange ? { whatWouldChange: conv.whatWouldChange } : {}),
      ...(scenarioInputs ? { scenarioInputs } : {}),
      citations: uniq(citeBase),
    });
  }

  if (gap.pick) {
    const { rec, fb } = moveParts(f, world, gap);
    const path: Path = {
      events: [...targetPath.events, ...pendingEvents(gap.run, [gap.pick.lever.commitmentId])],
      timingPartyIds: timingParties(world.records, [gap.pick.lever.commitmentId]),
    };
    const conv = convict(ctx, f, world, path, assumedOf(intent, dateAssumed));
    const scenario: Scenario = { id: `whatif-${hash10(JSON.stringify([gap.pick.lever, target.id]))}`, kind: "what_if", overrides: [], levers: [gap.pick.lever] };
    return assemble(f, {
      ...skeleton(intent, ctx),
      verdict: "yes_if",
      headlineFacts: [lowFacts("Lowest cash point without the move", gap.low), lowFacts("Lowest cash point with the move", gap.pick.resulting), spend],
      context: ctxFacts,
      recommendation: rec!,
      ...(fb ? { fallback: fb } : {}),
      assumptions,
      conviction: conv.conviction,
      convictionReasons: conv.convictionReasons,
      ...(conv.whatWouldChange ? { whatWouldChange: conv.whatWouldChange } : {}),
      scenario,
      scenarioId: scenario.id,
      ...(scenarioInputs ? { scenarioInputs } : {}),
      citations: uniq([...citeBase, gap.pick.lever.commitmentId, ...gap.pick.item.evidenceRefs]),
    });
  }

  const conv = convict(ctx, f, world, targetPath, assumedOf(intent, dateAssumed));
  return assemble(f, {
    ...skeleton(intent, ctx),
    verdict: "no",
    headlineFacts: [lowFacts("Lowest cash point with this payment", gap.low), { label: "Safety line", amount: gap.run.safetyLine }, spend],
    context: ctxFacts,
    recommendation: { action: `Hold off on ${label === "the payment" ? `the ${amountText} payment` : label} due ${planDate} until cash improves` },
    assumptions,
    conviction: conv.conviction,
    convictionReasons: [...conv.convictionReasons, "No single move in the books keeps cash above the safety line."],
    ...(conv.whatWouldChange ? { whatWouldChange: conv.whatWouldChange } : {}),
    ...(scenarioInputs ? { scenarioInputs } : {}),
    citations: uniq(citeBase),
  });
}

function affordDeal(
  intent: AskIntent,
  ctx: DecideContext,
  f: Figures,
  world: World,
  deal: Commitment,
  label: string,
  assumptions: string[],
  scenarioInputs: Decision["scenarioInputs"],
  assumed: string | undefined,
): Decision {
  const out = smallestUpfrontShare(world.records, world.profile, world.overrides, deal.id, ctx.asOf, ctx.fxRates);
  const who = partyName(world.records, deal.partyId);
  // The base run: the deal on its current terms (not_deal_driven has no share to rerun; it never reads this).
  const base: ForecastRun =
    out.kind === "already_ok" ? out.run
    : out.kind === "not_deal_driven" ? out.run
    : runAtUpfrontShare(world.records, world.profile, world.overrides, deal.id, ctx.asOf, ctx.fxRates, out.currentShare);
  const safety = base.safetyLine;
  const baseLow: Day = { date: base.lowPoint.date, amount: base.lowPoint.amount };
  const ctxFacts = (low: Day = baseLow) => ({
    baseLowPoint: low,
    safetyLine: safety,
    ...(low.amount < safety ? { shortfall: safety - low.amount } : {}),
  });
  const dealPath = (run: ForecastRun): Path => ({ events: pendingEvents(run, [deal.id]), timingPartyIds: timingParties(world.records, [deal.id]) });
  const si = (share?: number): Decision["scenarioInputs"] =>
    ({ ...(scenarioInputs ?? {}), ...(share !== undefined ? { upfrontShare: { commitmentId: deal.id, share } } : {}) });
  const cite = (run: ForecastRun, low: Day) => uniq([deal.id, ...(deal.partyId ? [deal.partyId] : []), ...eventsOn(run, low.date)]);

  switch (out.kind) {
    case "already_ok": {
      const conv = convict(ctx, f, world, dealPath(out.run), assumed);
      return assemble(f, {
        ...skeleton(intent, ctx),
        verdict: "yes",
        headlineFacts: [lowFacts("Lowest cash point with the order", baseLow), { label: "Safety line", amount: safety }],
        context: ctxFacts(),
        assumptions,
        conviction: conv.conviction,
        convictionReasons: conv.convictionReasons,
        ...(conv.whatWouldChange ? { whatWouldChange: conv.whatWouldChange } : {}),
        ...(Object.keys(si()!).length ? { scenarioInputs: si() } : {}),
        citations: cite(out.run, baseLow),
      });
    }
    case "ok": {
      const resulting: Day = { date: out.run.lowPoint.date, amount: out.run.lowPoint.amount };
      const pctNow = Math.round(out.currentShare * 100);
      const pctAsk = Math.round(out.share * 100);
      const upfrontDate = out.run.events
        .filter((e) => e.commitmentId === deal.id && e.direction === "in" && e.status !== "actual" && out.upfrontLegs.includes(e.legIndex))
        .map((e) => e.date)
        .sort()[0];
      const action = `Ask ${who ?? "the customer"} for ${f.pct("upfront share asked", pctAsk)} up front on ${label}`;
      assumptions.push(`Terms today put ${f.pct("upfront share today", pctNow)} of the order up front.`);
      f.m(resulting.amount); f.d(resulting.date);
      const conv = convict(ctx, f, world, dealPath(out.run), assumed);
      const cashEffect = resulting.amount - baseLow.amount;
      return assemble(f, {
        ...skeleton(intent, ctx),
        verdict: "yes_if",
        headlineFacts: [lowFacts("Lowest cash point on current terms", baseLow), lowFacts("Lowest cash point with the deposit", resulting), { label: "Safety line", amount: safety }],
        context: ctxFacts(),
        recommendation: {
          action,
          upfrontShare: out.share,
          ...(upfrontDate ? { byDate: f.d(upfrontDate) } : {}),
          cashEffect,
          resultingLowPoint: resulting,
        },
        assumptions,
        conviction: conv.conviction,
        convictionReasons: conv.convictionReasons,
        ...(conv.whatWouldChange ? { whatWouldChange: conv.whatWouldChange } : {}),
        scenarioInputs: si(out.share),
        citations: cite(out.run, resulting),
      });
    }
    case "not_achievable": {
      const best: Day = { date: out.run.lowPoint.date, amount: out.run.lowPoint.amount };
      const conv = convict(ctx, f, world, dealPath(out.run), assumed);
      return assemble(f, {
        ...skeleton(intent, ctx),
        verdict: "no",
        headlineFacts: [lowFacts("Lowest cash point even with everything up front", best), { label: "Safety line", amount: safety }],
        context: ctxFacts(),
        recommendation: {
          action: `Hold off on ${label}: even ${f.pct("upfront share", 100)} up front leaves cash below your safety line`,
          upfrontShare: 1,
          cashEffect: best.amount - baseLow.amount,
          resultingLowPoint: best,
        },
        assumptions,
        conviction: conv.conviction,
        convictionReasons: conv.convictionReasons,
        ...(conv.whatWouldChange ? { whatWouldChange: conv.whatWouldChange } : {}),
        scenarioInputs: si(1),
        citations: cite(out.run, best),
      });
    }
    case "not_deal_driven": {
      // The shortfall exists without this order: answer as fix_gap on the world without it.
      const without: Override = { id: `ask-without-${deal.id}`, target: { commitmentId: deal.id }, change: { exclude: true }, origin: "owner" };
      const w2: World = { records: world.records, profile: world.profile, overrides: [...world.overrides, without] };
      return actNowWithout(intent, ctx, f, w2, assumptions, assumed, scenarioInputs, deal.id,
        `Cash is below the safety line even without ${label}, so the order is not the cause.`, "Lowest cash point without the order");
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// what_if

function runWhatIf(intent: AskIntent, ctx: DecideContext): Decision {
  const f = new Figures(ctx.profile.baseCurrency, ctx.asOf);
  const assumptions = baseAssumptions(intent, ctx, f);
  const baseOverrides = ctx.baseOverrides ?? [];
  const baseWorldV = baseWorld(ctx);
  const baseRun = forecast(ctx.records, ctx.profile, { id: "base", kind: "base", overrides: baseOverrides }, ctx.asOf, ctx.fxRates);
  const baseLow: Day = { date: baseRun.lowPoint.date, amount: baseRun.lowPoint.amount };
  const tag = hash10(intent.question);
  let world: World = baseWorldV;
  let whatIfOverrides: Override[] = [];
  let scenarioInputs: Decision["scenarioInputs"];
  let changedIds: string[] = [];
  let extraFact: Decision["headlineFacts"][number] | undefined;
  let dateAssumed: string | undefined;
  const subjects: string[] = [];
  const draft = intent.draft;

  if (draft) {
    const base = draftBase(ctx, intent);
    if (base === undefined) return needInfo(intent, ctx, `What is ${draft.currency} worth in ${ctx.profile.baseCurrency}?`, `There is no exchange rate for ${draft.currency}.`);
    const before = assumptions.length;
    const date = resolveDate(intent, ctx, f, assumptions);
    if (assumptions.length > before) dateAssumed = date;
    if (draft.type === "recurring") {
      const item: Profile["recurring"][number] = {
        id: askDraftId(intent.question), name: "New fixed cost", amount: base, direction: draft.direction ?? "out",
        cadence: draftCadence(draft) ?? "monthly", anchor: date, startDate: date, category: "fixed cost",
      };
      world = { ...world, profile: { ...ctx.profile, recurring: [...ctx.profile.recurring, item] } };
      scenarioInputs = { recurring: [item] };
      extraFact = { label: `Recurring cost (${item.cadence})`, amount: base, date };
      subjects.push(`you add a ${f.m(base)} ${item.cadence} cost from ${f.h(date)}`);
    } else {
      const dir = draft.direction ?? (draft.type === "sales_deal" ? "in" : "out");
      const c = syntheticCommitment(ctx, intent, dir === "in" ? "deal" : "plan", date, base);
      world = { ...world, records: withCommitment(ctx.records, c) };
      scenarioInputs = { commitments: [c] };
      changedIds = [c.id];
      extraFact = { label: dir === "in" ? "Order amount" : "Planned payment", amount: base, date };
      subjects.push(dir === "in" ? `you win a ${f.m(base)} order paid on ${f.h(date)}` : `you pay ${f.m(base)} on ${f.h(date)}`);
    }
  } else {
    const date = intent.date!;
    const pending = pendingEventsByCommitment(baseRun);
    let targets: Commitment[];
    if (intent.commitmentId) {
      const c = ctx.records.commitments.find((x) => x.id === intent.commitmentId);
      targets = c ? [c] : [];
    } else {
      const mine = ctx.records.commitments.filter((c) => c.partyId === intent.partyId && isOpen(c) && (pending.get(c.id)?.length ?? 0) > 0);
      const dir = intent.raw.direction ?? (mine.some((c) => dirOf(c) === "in") ? "in" : "out");
      targets = mine.filter((c) => dirOf(c) === dir);
    }
    if (targets.length === 0) return needInfo(intent, ctx, "Which invoice, bill, or order do you mean?", "Nothing open was found for that party.");
    targets.forEach((c, i) => {
      const legs = (pending.get(c.id) ?? []).filter((e) => e.direction === dirOf(c));
      const first = legs[0];
      const id = `ask-whatif-${tag}-${i}`;
      if (first && legs.length > 1) {
        whatIfOverrides.push({ id, target: { commitmentId: c.id }, change: { shiftDays: diffDays(date, first.date) }, origin: "owner" });
      } else {
        whatIfOverrides.push({ id, target: { commitmentId: c.id }, change: { date }, origin: "owner" });
      }
      const who = partyName(ctx.records, c.partyId);
      subjects.push(`${dirOf(c) === "in" ? (who ?? "the customer") : "you"} ${dirOf(c) === "in" ? "pays" : "pay"} ${commitmentLabel(c)}${dirOf(c) === "out" && who ? ` to ${who}` : ""} on ${f.h(date)}`);
      assumptions.push(`Assumed ${who ? `${who} ` : ""}${dirOf(c) === "in" ? "pays" : "is paid"} ${commitmentLabel(c)} on ${f.h(date)}${first ? `, instead of ${f.h(first.date)}` : ""}.`);
    });
    world = { ...world, overrides: [...baseOverrides, ...whatIfOverrides] };
    changedIds = targets.map((c) => c.id);
  }

  const gap = fixGap(ctx, world, undefined, false);
  const verdict: Decision["verdict"] = gap.below ? "act_now" : "on_track";
  const { rec, fb } = moveParts(f, world, gap);
  const path: Path = gap.pick
    ? {
        events: [...pendingEvents(gap.run, [...changedIds, gap.pick.lever.commitmentId])],
        timingPartyIds: timingParties(world.records, [gap.pick.lever.commitmentId]),
      }
    : { events: pendingEvents(gap.run, changedIds), timingPartyIds: [] };
  const conv = convict(ctx, f, world, path, assumedOf(intent, dateAssumed));
  const scenario: Scenario = { id: `whatif-${tag}`, kind: "what_if", overrides: whatIfOverrides };
  const headline: Decision["headlineFacts"] = [lowFacts("Lowest cash point if this happens", gap.low), lowFacts("Lowest cash point today", baseLow)];
  if (rec?.resultingLowPoint) headline.push(lowFacts("Lowest cash point after the move", rec.resultingLowPoint));
  else if (extraFact) headline.push(extraFact);
  return assemble(f, {
    ...skeleton(intent, ctx),
    verdict,
    ...(subjects.length ? { lead: { kind: "effect" as const, subject: subjects.slice(0, 2).join(" and ") } } : {}),
    headlineFacts: headline.slice(0, 3),
    context: {
      baseLowPoint: baseLow,
      safetyLine: gap.run.safetyLine,
      ...(baseLow.amount < gap.run.safetyLine ? { shortfall: gap.run.safetyLine - baseLow.amount } : {}),
    },
    ...(rec ? { recommendation: rec } : {}),
    ...(fb ? { fallback: fb } : {}),
    assumptions,
    conviction: conv.conviction,
    convictionReasons: conv.convictionReasons,
    ...(conv.whatWouldChange ? { whatWouldChange: conv.whatWouldChange } : {}),
    scenario,
    scenarioId: scenario.id,
    ...(scenarioInputs ? { scenarioInputs } : {}),
    citations: uniq([...changedIds, ...(gap.pick ? [gap.pick.lever.commitmentId, ...gap.pick.item.evidenceRefs] : []), ...eventsOn(gap.run, gap.low.date)]),
  });
}

// ---------------------------------------------------------------------------------------------------------
// lookup

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// "When does Evergreen usually pay?", "how late is Harbor?": a timing question, not a balance question.
const TIMING_RE = /\bwhen\b|\bhow\s+(?:late|long|early|fast|quickly|soon)\b|\busually\b|\btypically\b|\bnormally\b|\bon\s+average\b|\bpay(?:s)?\s+(?:late|early|on\s+time)\b|\blag\b/i;

function runLookup(intent: AskIntent, ctx: DecideContext): Decision {
  const f = new Figures(ctx.profile.baseCurrency, ctx.asOf);
  const world = baseWorld(ctx);
  const { records, profile } = ctx;
  const commitment = intent.commitmentId ? records.commitments.find((c) => c.id === intent.commitmentId) : undefined;
  const partyId = intent.partyId ?? commitment?.partyId;
  const party = records.parties.find((p) => p.id === partyId);
  if (!party) return needInfo(intent, ctx, "Which customer or supplier do you mean?", "No party was identified.");
  const run = forecast(records, profile, { id: "base", kind: "base", overrides: world.overrides }, ctx.asOf, ctx.fxRates);
  const assumptions = baseAssumptions(intent, ctx, f);

  const samples = lagSamples(records, party.id);
  const lag = partyLag(records, profile, party.id);
  const rule = confirmedLagRule(records.rules, party.id);
  const dayWord = (n: number) => (n > 0 ? "days after the due date" : n < 0 ? "days before the due date" : "days (pays on the due date)");
  if (samples.length > 0) {
    const typical = Math.floor(median(samples) + 0.5);
    f.stat(`typical ${dayWord(typical)}`, Math.abs(typical), "days");
  }
  f.stat(`days the forecast assumes, ${dayWord(lag.days)}`, Math.abs(lag.days), "days");
  f.stat("payments on record", samples.length, "count");
  if (rule) assumptions.push(`The forecast uses a payment rule you confirmed for ${party.name}.`);
  else if (samples.length === 0) assumptions.push(`There is no payment history for ${party.name}; the forecast uses the profile default of ${f.days("default lag", profile.defaultLagDays)}.`);

  // Open items for the party, from the run's pending events.
  const pending = pendingEventsByCommitment(run);
  const open = records.commitments.filter((c) => c.partyId === party.id && isOpen(c) && (pending.get(c.id)?.length ?? 0) > 0);
  const sum = (dir: "in" | "out") => open.filter((c) => dirOf(c) === dir).reduce((a, c) => a + (pending.get(c.id) ?? []).reduce((s, e) => s + e.amountBase, 0), 0);
  const owed = sum("in");
  const owe = sum("out");
  const next = open.flatMap((c) => pending.get(c.id) ?? []).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))[0];
  const settle = records.settlements
    .filter((s) => s.partyId === party.id || records.commitments.some((c) => c.id === s.commitmentId && c.partyId === party.id))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
    .at(-1);
  const lastBase = settle ? toBase(settle.amount, settle.currency, profile, ctx.fxRates) : undefined;
  const headline: Decision["headlineFacts"] = [];
  if (owed > 0) headline.push({ label: `Open amount ${party.name} owes you`, amount: owed });
  if (owe > 0) headline.push({ label: `Open amount you owe ${party.name}`, amount: owe });
  if (next) headline.push({ label: "Next expected", amount: next.amountBase, date: next.date });
  if (settle && lastBase !== undefined) headline.push({ label: "Last payment", amount: lastBase, date: settle.date });

  // A question about when they pay is answered with the lag first (from the rule, else the payment history).
  const timing = TIMING_RE.test(intent.question)
    ? { days: rule ? lag.days : samples.length > 0 ? Math.floor(median(samples) + 0.5) : lag.days, samples: samples.length, rule: !!rule }
    : undefined;
  if (timing) { f.stat("days", Math.abs(timing.days), "days"); f.stat("payments on record", timing.samples, "count"); }
  const hasInbound = records.commitments.some((c) => c.partyId === party.id && dirOf(c) === "in");
  const conv = convict(ctx, f, world, { events: [], timingPartyIds: hasInbound ? [party.id] : [] }, undefined);
  return assemble(f, {
    ...skeleton(intent, ctx),
    verdict: "info",
    ...(timing ? { lead: { kind: "timing" as const, subject: party.name, timing } } : {}),
    headlineFacts: headline.slice(0, 3),
    context: { safetyLine: run.safetyLine },
    assumptions,
    conviction: conv.conviction,
    convictionReasons: conv.convictionReasons,
    citations: uniq([party.id, ...open.map((c) => c.id), ...(settle ? [settle.id] : [])]),
  });
}

// ---------------------------------------------------------------------------------------------------------
// tell

function runTell(intent: AskIntent, ctx: DecideContext): Decision {
  const f = new Figures(ctx.profile.baseCurrency, ctx.asOf);
  const { records } = ctx;
  const assumptions = baseAssumptions(intent, ctx, f);
  const world = baseWorld(ctx);
  const base = { ...skeleton(intent, ctx), verdict: "proposed" as const, context: {} as Decision["context"] };

  if (intent.rule) {
    const r = intent.rule;
    const who = "partyId" in r.scope ? partyName(records, r.scope.partyId) ?? "this party" : "every customer and supplier";
    const key = "partyId" in r.scope ? r.scope.partyId : undefined;
    let action: string;
    if (r.kind === "lag_offset" && typeof r.params.offsetDays === "number") {
      const n = Math.round(r.params.offsetDays);
      action = `Remember that ${who} pays ${f.days("days from due date", Math.abs(n))} ${n < 0 ? "early" : "late"}`;
    } else if (r.kind === "flexibility" && typeof r.params.extraDays === "number") {
      action = `Remember that ${who} allows ${f.days("extra days", Math.round(r.params.extraDays), true)} on what you owe`;
    } else if (r.kind === "preference") {
      action = `Remember a preference for ${who}`;
    } else {
      return needInfo(intent, ctx, "Which customer or supplier, and what should I remember about them?", "The rule did not carry a usable parameter.");
    }
    const conv = convict(ctx, f, world, { events: [], timingPartyIds: [] }, undefined);
    return assemble(f, {
      ...base,
      headlineFacts: [],
      recommendation: { action: `${action}; confirm to save it` },
      assumptions,
      conviction: conv.conviction,
      convictionReasons: ["You stated this directly; nothing changes until you confirm."],
      proposal: { kind: "rule", rule: r },
      citations: key ? [key] : [],
    });
  }

  const draft = intent.draft!;
  const amount = draftBase(ctx, intent);
  if (amount === undefined) return needInfo(intent, ctx, `What is ${draft.currency} worth in ${ctx.profile.baseCurrency}?`, `There is no exchange rate for ${draft.currency}.`);
  const before = assumptions.length;
  const date = resolveDate(intent, ctx, f, assumptions);
  const dateAssumed = assumptions.length > before ? date : undefined;
  const dir = draft.direction ?? (draft.type === "sales_deal" ? "in" : "out");
  const conv = convict(ctx, f, world, { events: [], timingPartyIds: [] }, assumedOf(intent, dateAssumed));
  const proposed = { ...draft, anchors: Object.keys(draft.anchors).length ? draft.anchors : { due: date } };
  return assemble(f, {
    ...base,
    headlineFacts: [{ label: dir === "in" ? "Planned receipt" : "Planned payment", amount, date }],
    recommendation: { action: `Confirm to add the ${f.m(amount)} ${dir === "in" ? "receipt" : "payment"} on ${f.h(date)} to your forecast` },
    assumptions,
    conviction: conv.conviction,
    convictionReasons: ["You stated this plan directly; nothing changes until you confirm.", ...conv.convictionReasons.filter((r) => !r.startsWith("The call does not rest"))],
    proposal: { kind: "commitment", draft: proposed },
    citations: draft.partyId ? [draft.partyId] : [],
  });
}

// ---------------------------------------------------------------------------------------------------------

export function decide(intent: AskIntent, ctx: DecideContext): Decision {
  if (intent.kind === "out_of_scope") return decline(intent, ctx);
  if (intent.unresolved.length > 0) {
    return needInfo(intent, ctx, intent.unresolved[0]!, `Needed before I can answer: ${intent.unresolved[0]!.replace(/\?+$/, "")}.`);
  }
  const missing = neededSlots(intent);
  if (missing) return needInfo(intent, ctx, missing.question, missing.why);
  switch (intent.kind) {
    case "afford": return runAfford(intent, ctx);
    case "fix_gap": return runFixGap(intent, ctx, intent.window, "Lowest cash point");
    case "status": return runFixGap(intent, ctx, intent.window, "Tightest day");
    case "what_if": return runWhatIf(intent, ctx);
    case "lookup": return runLookup(intent, ctx);
    case "tell": return runTell(intent, ctx);
  }
}
