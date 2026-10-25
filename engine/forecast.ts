// forecast(): one pure function from records + profile + scenario to a ForecastRun.
// Docs: docs/design/05-forecast-engine.md. No I/O, no clock (asOf is an input), no randomness.

import { createHash } from "node:crypto";
import type { CashEvent, Records, Scenario } from "../schema/records";
import type { Profile } from "../schema/profile";
import type { ForecastRun } from "../schema/forecast";
import { addDays, dateRange, diffDays, mondayOf } from "./dates";
import { expand, money, toBase } from "./expand";
import { adjust } from "./adjust";

export const ENGINE_VERSION = "engine-1";

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, canonical(x)]),
    );
  }
  return v;
}

function sortedById<T extends { id: string }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function inputsHash(records: Records, profile: Profile, scenario: Scenario, asOf: string, fx: Record<string, number>): string {
  const r = records;
  const body = canonical({
    v: ENGINE_VERSION,
    asOf,
    fx,
    profile,
    scenario,
    records: {
      parties: sortedById(r.parties),
      commitments: sortedById(r.commitments),
      events: sortedById(r.events),
      signals: sortedById(r.signals),
      rules: sortedById(r.rules),
      settlements: sortedById(r.settlements),
      balances: sortedById(r.balances),
    },
  });
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export function horizonEnd(profile: Profile, asOf: string): string {
  return addDays(mondayOf(asOf), profile.horizonWeeks * 7);
}

// Opening cash: latest start-of-day snapshot per account on/before asOf, plus identified actuals since then.
function openingBalance(records: Records, profile: Profile, asOf: string, fx: Record<string, number>, warnings: string[]): number {
  const latest = new Map<string, Records["balances"][number]>();
  for (const b of records.balances) {
    if (b.asOf > asOf) continue;
    const cur = latest.get(b.account);
    if (!cur || b.asOf > cur.asOf) latest.set(b.account, b);
  }
  if (latest.size === 0) {
    warnings.push("No opening balance on or before the as-of date; the forecast starts from $0.00 and cannot be trusted.");
    return 0;
  }
  let total = 0;
  let snapDate = "";
  for (const b of latest.values()) {
    const base = toBase(b.amount, b.currency, profile, fx);
    if (base === undefined) warnings.push(`Balance for ${b.account} is in ${b.currency} with no FX rate; left out of opening cash.`);
    else total += base;
    if (b.asOf > snapDate) snapDate = b.asOf;
  }
  if (new Set([...latest.values()].map((b) => b.asOf)).size > 1) warnings.push("Account balances have different as-of dates; actuals since the latest snapshot are rolled forward for all accounts.");
  const staleHours = profile.thresholds.staleAfterHours;
  if (staleHours !== undefined && diffDays(asOf, snapDate) * 24 > staleHours) warnings.push(`Bank balance is from ${snapDate}, older than ${staleHours} hours; refresh before relying on this.`);
  for (const e of records.events) {
    if (e.date >= snapDate && e.date < asOf) {
      const base = toBase(e.amount, e.currency, profile, fx);
      if (base !== undefined) total += e.direction === "in" ? base : -base;
    }
  }
  return total;
}

function actualEvents(records: Records, profile: Profile, asOf: string, fx: Record<string, number>, warnings: string[]): CashEvent[] {
  const out: CashEvent[] = [];
  for (const e of records.events) {
    if (e.date < asOf) continue;
    const base = toBase(e.amount, e.currency, profile, fx);
    if (base === undefined) {
      warnings.push(`Actual ${e.id} is in ${e.currency} with no FX rate; excluded.`);
      continue;
    }
    out.push({ ...e, status: "actual", amountBase: base, confidence: e.confidence ?? 1, basis: e.basis ?? `actual ${e.date}` });
  }
  return out;
}

function safetyLine(profile: Profile, fixedOutflow: number, horizonDays: number): number {
  const s = profile.safetyLine;
  if (s.kind === "fixed") return s.amount;
  return Math.round(((fixedOutflow * 7) / Math.max(1, horizonDays)) * s.weeks);
}

const sign = (e: CashEvent) => (e.direction === "in" ? e.amountBase : -e.amountBase);

export function forecast(records: Records, profile: Profile, scenario: Scenario, asOf: string, fxRates: Record<string, number>): ForecastRun {
  const end = horizonEnd(profile, asOf);
  const horizonDays = diffDays(end, asOf);
  const warnings: string[] = [];
  const fx = { [profile.baseCurrency]: 1, ...fxRates };

  const opening = openingBalance(records, profile, asOf, fx, warnings);
  const expanded = expand(records, profile, asOf, end, fx);
  warnings.push(...expanded.warnings);

  // Fixed costs behind a "weeks of fixed costs" safety line: recurring outflows inside the horizon.
  const recurringIds = new Set([...profile.recurring.map((r) => r.id), ...records.commitments.filter((c) => c.type === "recurring").map((c) => c.id)]);
  const fixedOutflow = expanded.events
    .filter((e) => e.direction === "out" && e.commitmentId && recurringIds.has(e.commitmentId) && e.date >= asOf && e.date < end)
    .reduce((a, e) => a + e.amountBase, 0);

  const all = adjust([...expanded.events, ...actualEvents(records, profile, asOf, fx, warnings)], scenario, {
    records,
    profile,
    asOf,
    fx,
    commitments: expanded.commitments,
    warnings,
  });
  const events = [...all].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));

  for (const e of events) {
    if (e.date < asOf && e.status !== "actual" && e.status !== "possible") {
      warnings.push(`Overdue: ${e.basis.split(";")[0]} -> ${money(e.amountBase)} ${e.direction === "in" ? "receipt" : "payment"} dated ${e.date} is before ${asOf}; kept at its date, not moved to today (needs review).`);
    }
  }

  const inHorizon = (e: CashEvent) => e.date >= asOf && e.date < end;
  const main = events.filter((e) => e.status !== "possible" && inHorizon(e));
  const possible = events.filter((e) => e.status === "possible" && inHorizon(e));

  const byDate = new Map<string, CashEvent[]>();
  for (const e of main) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  const possibleByDate = new Map<string, number>();
  // Pipeline weight is the deal's own probability, not event.confidence (which also reflects lag certainty).
  const probability = new Map(expanded.commitments.map((c) => [c.id, c.probability]));
  for (const e of possible) {
    const p = e.commitmentId ? probability.get(e.commitmentId) : undefined;
    if (p === undefined) warnings.push(`${e.commitmentId ?? e.id} is "possible" without a probability; left out of the pipeline band.`);
    possibleByDate.set(e.date, (possibleByDate.get(e.date) ?? 0) + Math.round(sign(e) * (p ?? 0)));
  }

  const dates = dateRange(asOf, end);
  const safety = safetyLine(profile, fixedOutflow, horizonDays);
  const days: ForecastRun["days"] = [];
  const pipelineCum: number[] = [];
  let bal = opening;
  let pipe = 0;
  for (const date of dates) {
    const evs = byDate.get(date) ?? [];
    const inflow = evs.filter((e) => e.direction === "in").reduce((a, e) => a + e.amountBase, 0);
    const outflow = evs.filter((e) => e.direction === "out").reduce((a, e) => a + e.amountBase, 0);
    if (inflow > 0 && outflow > 0 && bal - outflow < 0 && Math.min(bal, bal + inflow - outflow) >= 0) {
      warnings.push(`${date}: receipts and payments land on the same day and the order decides whether cash dips below zero; intraday ordering is unknown.`);
    }
    bal += inflow - outflow;
    pipe += possibleByDate.get(date) ?? 0;
    pipelineCum.push(pipe);
    days.push({ date, inflow, outflow, closing: bal, eventIds: evs.map((e) => e.id) });
  }

  const weekStarts = [...new Set(dates.map(mondayOf))];
  const weeks: ForecastRun["weeks"] = weekStarts.map((start) => {
    const idx = days.map((d, i) => (mondayOf(d.date) === start ? i : -1)).filter((i) => i >= 0);
    const ds = idx.map((i) => days[i]!);
    return {
      start,
      inflow: ds.reduce((a, d) => a + d.inflow, 0),
      outflow: ds.reduce((a, d) => a + d.outflow, 0),
      closing: ds.at(-1)!.closing,
      minClosing: Math.min(...ds.map((d) => d.closing)),
      pipelineClosing: ds.at(-1)!.closing + pipelineCum[idx.at(-1)!]!,
      eventIds: ds.flatMap((d) => d.eventIds),
    };
  });

  let low = days[0]!;
  for (const d of days) if (d.closing < low.closing) low = d;
  const firstBelowSafety = days.find((d) => d.closing < safety)?.date;
  const firstNegative = days.find((d) => d.closing < 0)?.date;

  const H = profile.freeCashLookaheadWeeks;
  const free = weeks.map((_, i) => Math.min(...weeks.slice(i, i + H + 1).map((w) => w.minClosing)) - safety);
  const freeCash = weeks.map((w, i) => {
    let n = 0;
    while (i + n < weeks.length && free[i + n]! > 0) n++;
    return { week: w.start, amount: free[i]!, weeksFree: n };
  });
  if (weeks.length <= H) warnings.push(`Free-cash lookahead (${H} weeks) is longer than the modeled horizon; free cash is only checked through ${end}.`);

  if (records.commitments.length === 0 && records.events.length === 0) warnings.push("No commitments or actuals loaded; the forecast reflects only recurring items and opening cash.");

  const hash = inputsHash(records, profile, scenario, asOf, fx);
  return {
    id: `run-${scenario.id}-${hash.slice(0, 12)}`,
    asOf,
    inputsHash: hash,
    scenarioId: scenario.id,
    fxRates: fx,
    openingBalance: opening,
    safetyLine: safety,
    days,
    weeks,
    lowPoint: { week: mondayOf(low.date), date: low.date, amount: low.closing },
    ...(firstBelowSafety ? { firstBelowSafety } : {}),
    ...(firstNegative ? { firstNegative } : {}),
    weeksBelowSafety: weeks.filter((w) => w.minClosing < safety).map((w) => w.start),
    freeCash,
    warnings: [...new Set(warnings)],
    events,
  };
}
