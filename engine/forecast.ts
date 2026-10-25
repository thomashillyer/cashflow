// forecast(): one pure function from records + profile + scenario to a ForecastRun.
// Docs: docs/design/05-forecast-engine.md. No I/O, no clock (asOf is an input), no randomness.

import { createHash } from "node:crypto";
import type { CashEvent, Commitment, Records, Scenario } from "../schema/records";
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

// How opening cash treats each stored actual. Pure; shared by forecast() and countedActualIds().
export type OpeningCash = {
  opening: number;
  counted: Set<string>;   // actual ids whose cash is in the run: inside a snapshot, rolled into opening, or in the main line on/after asOf
  excluded: Set<string>;  // actual ids kept out of the run entirely (tagged to an account with no snapshot)
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// Opening cash, per account: latest start-of-day snapshot on/before asOf, plus that account's actuals dated
// on/after the snapshot and before asOf. Actuals without `account` go to the only account when there is one.
// With several accounts they roll forward from the latest snapshot date; those in the window between the oldest
// and latest snapshot may or may not be in a snapshot already, so outflows are counted (conservative) and inflows
// left out, with a needs-review warning.
// Actuals tagged to an account with no snapshot on/before asOf are left out of opening cash AND of the main line
// (the account's starting balance is unknown, so its movements alone would mislead), with one warning per account
// covering actuals on/after the oldest snapshot date (asOf - 90 days when there is no snapshot at all).
export function openingCash(records: Records, profile: Profile, asOf: string, fx: Record<string, number>, warnings: string[]): OpeningCash {
  const latest = new Map<string, Records["balances"][number]>();
  for (const b of records.balances) {
    if (b.asOf > asOf) continue;
    const cur = latest.get(b.account);
    if (!cur || b.asOf > cur.asOf) latest.set(b.account, b);
  }
  const counted = new Set<string>();
  const excluded = new Set<string>();
  let total = 0;
  let newest = "";
  let oldest = "";
  if (latest.size === 0) warnings.push("No opening balance on or before the as-of date; the forecast starts from $0.00 and cannot be trusted.");
  const staleHours = profile.thresholds.staleAfterHours;
  for (const b of [...latest.values()].sort((x, y) => (x.account < y.account ? -1 : 1))) {
    const base = toBase(b.amount, b.currency, profile, fx);
    if (base === undefined) warnings.push(`Balance for ${b.account} is in ${b.currency} with no FX rate; left out of opening cash.`);
    else total += base;
    if (b.asOf > newest) newest = b.asOf;
    if (oldest === "" || b.asOf < oldest) oldest = b.asOf;
    if (staleHours !== undefined && diffDays(asOf, b.asOf) * 24 > staleHours) warnings.push(`Bank balance for ${b.account} is from ${b.asOf}, older than ${staleHours} hours; refresh before relying on this.`);
  }
  const windowStart = latest.size > 0 ? oldest : addDays(asOf, -90);
  const only = latest.size === 1 ? [...latest.keys()][0] : undefined;
  const signed = (e: CashEvent, base: number) => (e.direction === "in" ? base : -base);
  const orphans = new Map<string, { n: number; net: number; noFx: number }>();
  const amb = { n: 0, out: 0, inn: 0 };
  for (const e of records.events) {
    const account = e.account ?? only;
    const base = toBase(e.amount, e.currency, profile, fx);
    if (account !== undefined && !latest.has(account)) {
      excluded.add(e.id);
      if (e.date < windowStart) continue;
      const o = orphans.get(account) ?? { n: 0, net: 0, noFx: 0 };
      o.n++;
      if (base === undefined) o.noFx++;
      else o.net += signed(e, base);
      orphans.set(account, o);
      continue;
    }
    if (e.date >= asOf) {
      if (base !== undefined) counted.add(e.id); // actualEvents() puts it in the main line (and warns when FX is missing)
      continue;
    }
    if (latest.size === 0) continue; // no snapshot to roll onto
    const from = account === undefined ? newest : latest.get(account)!.asOf;
    if (e.date < (account === undefined ? oldest : from)) {
      counted.add(e.id); // already inside its snapshot
      continue;
    }
    if (base === undefined) {
      warnings.push(`Actual ${e.id} is in ${e.currency} with no FX rate; left out of opening cash, which is understated or overstated by that amount (needs review).`);
      continue;
    }
    if (e.date < from) {
      // untagged, several accounts, between the oldest and latest snapshot
      amb.n++;
      if (e.direction === "in") {
        amb.inn += base;
        continue;
      }
      amb.out += base;
    }
    total += signed(e, base);
    counted.add(e.id);
  }
  const cur = profile.baseCurrency;
  const netText = (net: number) => `net ${money(Math.abs(net), cur)} ${net >= 0 ? "in" : "out"}`;
  if (amb.n > 0) {
    warnings.push(
      `${amb.n} ${plural(amb.n, "actual", "actuals")} with no account dated ${oldest} to before ${newest}, between the account balance dates, could not be matched to an account (${netText(amb.inn - amb.out)}); ` +
        `to be safe, outflows (${money(amb.out, cur)}) are counted in opening cash and inflows (${money(amb.inn, cur)}) left out; tag ${plural(amb.n, "it", "them")} with an account (needs review).`,
    );
  }
  for (const [account, o] of [...orphans].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const fxNote = o.noFx > 0 ? `, ${o.noFx} with no FX rate not in that total` : "";
    warnings.push(
      `${o.n} ${plural(o.n, "actual", "actuals")} tagged to account ${account}, which has no balance on or before ${asOf} (${netText(o.net)}${fxNote}), ` +
        `${plural(o.n, "is", "are")} left out of opening cash and the forecast; add a balance for ${account} (needs review).`,
    );
  }
  return { opening: total, counted, excluded };
}

// Ids of stored actuals whose cash the run actually counts (inside a snapshot, rolled into opening cash, or in the
// main line on/after asOf). Actuals left out (ambiguous inflows, no-snapshot account, no FX rate) are not in it,
// so they must not be treated as payment of an expected item.
export function countedActualIds(records: Records, profile: Profile, asOf: string, fxRates: Record<string, number>): Set<string> {
  return openingCash(records, profile, asOf, { [profile.baseCurrency]: 1, ...fxRates }, []).counted;
}

function actualEvents(records: Records, profile: Profile, asOf: string, fx: Record<string, number>, warnings: string[], excluded: Set<string>): CashEvent[] {
  const out: CashEvent[] = [];
  for (const e of records.events) {
    if (e.date < asOf || excluded.has(e.id)) continue;
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

// Order-sensitive inputs (signals, rules, settlements) are sorted so the same set of inputs always gives the same run,
// matching the sort used for inputsHash.
function normalize(r: Records): Records {
  return {
    ...r,
    parties: sortedById(r.parties),
    commitments: sortedById(r.commitments),
    events: sortedById(r.events),
    rules: sortedById(r.rules),
    settlements: sortedById(r.settlements),
    balances: sortedById(r.balances),
    signals: [...r.signals].sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : a.id < b.id ? -1 : 1)),
  };
}

// Overdue unpaid payments are still owed, so they count on asOf instead of falling out of the balance.
// Overdue receipts keep their date and stay out of the balance (TECHNICAL_PLAN section 6), warned in forecast().
// Not rolled, kept past-dated with a warning:
//   - virtual linked costs (`deal~pattern`) and legs dated from an estimated anchor: no source document says they are due;
//   - legs already covered by bank actuals tagged to the commitment that the books do not reflect yet (possibly paid).
function rollOverdueOutflows(
  events: CashEvent[],
  records: Records,
  commitments: Commitment[],
  profile: Profile,
  asOf: string,
  fx: Record<string, number>,
  warnings: string[],
): CashEvent[] {
  const label = (e: CashEvent) => `${e.basis.split(";")[0]} -> ${money(e.amountBase, profile.baseCurrency)} payment dated ${e.date}`;
  // Bank-side cover per commitment: tagged outflow actuals on/before asOf beyond what the books already count as paid.
  const cover = new Map<string, { left: number; ids: string[] }>();
  for (const c of commitments) {
    const actuals = records.events.filter((x) => x.commitmentId === c.id && x.direction === "out" && x.date <= asOf);
    if (actuals.length === 0) continue;
    const bank = actuals.reduce((a, x) => a + (toBase(x.amount, x.currency, profile, fx) ?? 0), 0);
    const booksPaid = toBase(c.amount - (c.outstanding ?? c.amount), c.currency, profile, fx) ?? 0;
    const left = bank - booksPaid;
    if (left > 0) cover.set(c.id, { left, ids: actuals.map((x) => x.id) });
  }
  const overdue = (e: CashEvent) => e.date < asOf && e.direction === "out" && e.status !== "actual" && e.status !== "possible";
  const order = [...events].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.legIndex - b.legIndex));
  const out = new Map<CashEvent, CashEvent | undefined>();
  for (const e of order) {
    if (!overdue(e)) continue;
    if (e.commitmentId?.includes("~") || /estimated/.test(e.basis.split(";")[0]!)) {
      warnings.push(`Overdue: ${label(e)} is before ${asOf}; past-dated linked/estimated cost, not counted (needs review).`);
      continue;
    }
    const cv = e.commitmentId ? cover.get(e.commitmentId) : undefined;
    let rest = e;
    if (cv && cv.left > 0) {
      const take = Math.min(cv.left, e.amountBase);
      cv.left -= take;
      warnings.push(`Overdue: ${label(e)} is possibly paid already (bank line ${cv.ids.join(", ")}), needs reconciliation.`);
      if (take >= e.amountBase) {
        out.set(e, undefined); // keep it out: stays past-dated
        continue;
      }
      const restBase = e.amountBase - take;
      rest = { ...e, amountBase: restBase, amount: Math.round((e.amount * restBase) / e.amountBase), basis: `${e.basis}; ${money(take, profile.baseCurrency)} possibly paid already per bank` };
    }
    warnings.push(`Overdue: ${label(e)} is before ${asOf}; assumed payable now and counted on ${asOf} (needs review).`);
    out.set(e, { ...rest, date: asOf, basis: `${rest.basis}; overdue since ${e.date}, assumed payable now` });
  }
  return events.map((e) => (out.has(e) ? (out.get(e) ?? e) : e));
}

export function forecast(input: Records, profile: Profile, scenario: Scenario, asOf: string, fxRates: Record<string, number>): ForecastRun {
  const records = normalize(input);
  const end = horizonEnd(profile, asOf);
  const horizonDays = diffDays(end, asOf);
  const warnings: string[] = [];
  const fx = { [profile.baseCurrency]: 1, ...fxRates };

  const cash = openingCash(records, profile, asOf, fx, warnings);
  const opening = cash.opening;
  const expanded = expand(records, profile, asOf, end, fx);
  warnings.push(...expanded.warnings);

  // Fixed costs behind a "weeks of fixed costs" safety line: recurring outflows inside the horizon.
  const recurringIds = new Set([...profile.recurring.map((r) => r.id), ...records.commitments.filter((c) => c.type === "recurring").map((c) => c.id)]);
  const fixedOutflow = expanded.events
    .filter((e) => e.direction === "out" && e.commitmentId && recurringIds.has(e.commitmentId) && e.date >= asOf && e.date < end)
    .reduce((a, e) => a + e.amountBase, 0);

  const all = adjust([...expanded.events, ...actualEvents(records, profile, asOf, fx, warnings, cash.excluded)], scenario, {
    records,
    profile,
    asOf,
    fx,
    commitments: expanded.commitments,
    warnings,
  });
  const rolled = rollOverdueOutflows(all, records, expanded.commitments, profile, asOf, fx, warnings);
  const events = [...rolled].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));

  for (const e of events) {
    if (e.date < asOf && e.direction === "in" && e.status !== "actual" && e.status !== "possible") {
      warnings.push(`Overdue: ${e.basis.split(";")[0]} -> ${money(e.amountBase, profile.baseCurrency)} receipt dated ${e.date} is before ${asOf}; kept at its date, not moved to today (needs review).`);
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
