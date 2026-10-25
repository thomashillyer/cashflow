// PREVIEW ENGINE — a stand-in so the app runs before engine/, ai/ and api/ exist.
// It follows docs/design/05-forecast-engine.md and 07-warnings-and-ranking.md closely enough to drive
// the UI with honest numbers, and it is generic: every threshold comes from the profile, nothing
// branches on a business. When the real API is wired (see app/api.js), none of this ships.

import { addDays, daysBetween, mondayOf, money, shortDate, weekLabel } from "../ui/format.js";

const STATUS_IN_MAIN = new Set(["actual", "committed", "likely"]);
const STATUTORY_KINDS = new Set(["employee", "other"]); // never suggest deferring payroll, rent, tax

export function createEngine(fixture) {
  const state = {
    signals: structuredClone(fixture.signals),
    plans: [], // owner plans confirmed in Ask Neri: Commitment[]
    done: new Set(), // work item ids the owner marked done
    safetyLine: fixture.profile.safetyLine.amount,
    thoughts: [],
  };

  const party = (id) => fixture.parties.find((p) => p.id === id);
  const commitmentById = (id) => allCommitments().find((c) => c.id === id);
  const allCommitments = () => [...fixture.commitments, ...state.plans];
  const asOf = fixture.business.asOf;
  const horizonEnd = addDays(mondayOf(addDays(asOf, 1)), fixture.profile.horizonWeeks * 7 - 1);
  const openingBalance = fixture.balances.reduce((s, b) => s + b.amount, 0);

  // ---- expand + overrides -------------------------------------------------
  function events({ levers = [], scenario = "base" } = {}) {
    const out = [];
    for (const c of allCommitments()) {
      if (c.settlement === "cancelled") continue;
      for (const l of c.legs) {
        const e = {
          id: `evt-${c.id}-${l.legIndex}`,
          commitmentId: c.id,
          legIndex: l.legIndex,
          date: l.date,
          amount: l.amount,
          currency: c.currency,
          amountBase: l.amount,
          direction: l.direction,
          status: l.status,
          confidence: l.confidence,
          basis: l.basis,
          sourceRef: c.sourceRef,
          overriddenBy: [],
        };
        // applied signals
        for (const s of state.signals) {
          if (s.state !== "applied" || s.commitmentRef !== c.id) continue;
          if (s.claim.kind === "date_change") {
            e.date = s.claim.newDate;
            e.basis = `${partyName(c.partyId)} wrote that they'll pay around ${shortDate(s.claim.newDate)} (email, ${shortDate(s.receivedAt.slice(0, 10))})`;
            e.confidence = Math.min(e.confidence, s.confidence);
          }
          if (s.claim.kind === "cancel") e.excluded = true;
          e.overriddenBy.push(s.id);
        }
        // scenario
        if (scenario === "stress" && e.direction === "in" && e.status !== "actual" && c.type !== "plan") {
          e.date = addDays(e.date, 7);
          e.basis += " · stress: 7 days later";
          e.overriddenBy.push("stress");
        }
        // levers (what-if)
        for (const lv of levers) {
          if (lv.commitmentId !== c.id) continue;
          if (lv.kind === "chase") e.date = lv.assumeDate;
          if (lv.kind === "defer") e.date = addDays(e.date, lv.days);
          if (lv.kind === "shift") e.date = addDays(e.date, lv.days);
          if (lv.kind === "pay_early" && c.discount) {
            e.date = c.discount.byDate;
            e.amount = Math.round(e.amount * (1 - c.discount.pct / 100));
            e.amountBase = e.amount;
          }
          e.overriddenBy.push(`lever:${lv.kind}`);
        }
        if (!e.excluded) out.push(e);
      }
    }
    for (const lv of levers) {
      if (lv.kind === "add") out.push(lv.event);
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  // ---- forecast -----------------------------------------------------------
  function forecast(opts = {}) {
    const evs = events(opts);
    const safetyLine = state.safetyLine;
    const firstMonday = mondayOf(addDays(asOf, 1));
    const days = [];
    let bal = openingBalance;
    let pipe = 0;
    const byDate = new Map();
    for (const e of evs) {
      if (!byDate.has(e.date)) byDate.set(e.date, []);
      byDate.get(e.date).push(e);
    }
    for (let d = asOf; d <= horizonEnd; d = addDays(d, 1)) {
      const todays = byDate.get(d) ?? [];
      for (const e of todays) {
        const signed = e.direction === "in" ? e.amountBase : -e.amountBase;
        if (STATUS_IN_MAIN.has(e.status)) bal += signed;
        else if (e.status === "possible") pipe += Math.round(signed * (commitmentById(e.commitmentId)?.probability ?? 0));
      }
      days.push({ date: d, closing: bal, pipeline: bal + pipe, eventIds: todays.map((e) => e.id) });
    }
    // events before the horizon start (none expected) are ignored; events after it are out of view.

    const weeks = [];
    for (let w = 0; w < fixture.profile.horizonWeeks; w++) {
      const start = addDays(firstMonday, w * 7);
      const wd = days.filter((d) => d.date >= start && d.date <= addDays(start, 6));
      const ids = wd.flatMap((d) => d.eventIds);
      const wev = evs.filter((e) => ids.includes(e.id) && STATUS_IN_MAIN.has(e.status));
      weeks.push({
        start,
        inflow: wev.filter((e) => e.direction === "in").reduce((s, e) => s + e.amountBase, 0),
        outflow: wev.filter((e) => e.direction === "out").reduce((s, e) => s + e.amountBase, 0),
        closing: wd[wd.length - 1].closing,
        minClosing: Math.min(...wd.map((d) => d.closing)),
        pipelineClosing: wd[wd.length - 1].pipeline,
        eventIds: ids,
      });
    }

    let low = days[0];
    for (const d of days) if (d.closing < low.closing) low = d;
    const firstBelowSafety = days.find((d) => d.closing < safetyLine)?.date;
    const firstNegative = days.find((d) => d.closing < 0)?.date;

    const H = fixture.profile.freeCashLookaheadWeeks;
    const freeCash = weeks.map((wk, i) => {
      const ahead = weeks.slice(i, i + H);
      const amount = Math.min(...ahead.map((x) => x.minClosing)) - safetyLine;
      return { week: wk.start, amount };
    });
    freeCash.forEach((f, i) => {
      let n = 0;
      for (let j = i; j < freeCash.length && freeCash[j].amount > 0; j++) n++;
      f.weeksFree = n;
    });

    return {
      id: `run-${opts.scenario ?? "base"}-${Math.abs(hashLevers(opts.levers))}`,
      asOf,
      inputsHash: "preview",
      fxRates: { USD: 1 },
      openingBalance,
      safetyLine,
      scenarioId: opts.scenario ?? "base",
      firstBelowSafety,
      firstNegative,
      warnings: [],
      days,
      weeks,
      lowPoint: { week: mondayOf(low.date), date: low.date, amount: low.closing },
      weeksBelowSafety: weeks.filter((w) => w.minClosing < safetyLine).map((w) => w.start),
      freeCash,
      events: evs,
    };
  }

  function simulate(levers, base = forecast()) {
    const run = forecast({ levers });
    return { run, lowPointDelta: run.lowPoint.amount - base.lowPoint.amount };
  }

  // ---- warnings → candidates → ranked work items ------------------------------
  function brief() {
    const base = forecast();
    const p = fixture.profile;
    const items = [];
    const gapDate = base.firstBelowSafety;

    if (gapDate) {
      // Chase: open receivables expected after their due date, that could land before the gap ends.
      for (const c of allCommitments()) {
        if (c.type !== "invoice" || c.settlement !== "open" || !c.anchors.due) continue;
        const ev = base.events.find((e) => e.commitmentId === c.id && e.direction === "in");
        if (!ev || ev.date <= c.anchors.due) continue;
        const assumeDate = c.anchors.due < asOf ? addDays(asOf, 3) : c.anchors.due;
        const lever = { kind: "chase", commitmentId: c.id, assumeDate };
        const { lowPointDelta } = simulate([lever], base);
        if (lowPointDelta <= 0) continue;
        const neededBy = assumeDate < gapDate ? assumeDate : gapDate;
        items.push(makeItem("projected_cash_gap", lever, lowPointDelta, neededBy, ev.confidence, c, base));
      }
      // Delay a purchase or plan that isn't placed yet (status likely), with a leg before the low point.
      for (const c of allCommitments()) {
        if (!["purchase_order", "plan"].includes(c.type) || c.status !== "likely") continue;
        const ev = base.events.find((e) => e.commitmentId === c.id && e.direction === "out");
        if (!ev || ev.date > base.lowPoint.date || ev.date <= asOf) continue;
        const lever = { kind: "defer", commitmentId: c.id, days: 21 };
        const { lowPointDelta } = simulate([lever], base);
        if (lowPointDelta <= 0) continue;
        items.push(makeItem("projected_cash_gap", lever, lowPointDelta, addDays(ev.date, -1), 0.9, c, base));
      }
      // Defer: payables a supplier will flex on (confirmed rule), or suppliers without a penalty tag.
      for (const c of allCommitments()) {
        const pt = party(c.partyId);
        if (!pt || STATUTORY_KINDS.has(pt.kind) || pt.kind === "customer") continue;
        const rule = fixture.rules.find((r) => r.state === "confirmed" && r.kind === "flexibility" && r.scope.partyId === pt.id);
        const penalized = pt.tags.some((t) => p.thresholds.relationshipPenalty[t] !== undefined);
        if (!rule && (penalized || pt.kind !== "supplier")) continue;
        const ev = base.events.find((e) => e.commitmentId === c.id && e.direction === "out");
        if (!ev || ev.date > base.lowPoint.date || ev.date <= asOf) continue;
        const days = rule ? rule.params.extraDays : 10;
        const lever = { kind: "defer", commitmentId: c.id, days };
        const { lowPointDelta } = simulate([lever], base);
        if (lowPointDelta <= 0) continue;
        items.push(makeItem("projected_cash_gap", lever, lowPointDelta, addDays(ev.date, -1), rule ? 0.85 : 0.6, c, base, rule));
      }
    }

    // Early-pay discounts, only when free cash covers them through the discount date.
    for (const c of allCommitments()) {
      if (!c.discount || c.discount.byDate < asOf) continue;
      const fc = base.freeCash.find((f) => f.week === mondayOf(c.discount.byDate));
      if (!fc || fc.amount < c.amount) continue;
      const lever = { kind: "pay_early", commitmentId: c.id };
      const saved = Math.round((c.amount * c.discount.pct) / 100);
      items.push(makeItem("early_pay_discount", lever, saved, c.discount.byDate, 0.98, c, base));
    }

    // Idle cash (watch).
    const idle = p.thresholds.idleBalanceOver;
    if (idle) {
      const win = base.freeCash.find((f) => f.amount > idle.amount && f.weeksFree >= idle.minWeeks);
      if (win) {
        const nextBig = base.events.find((e) => e.direction === "out" && e.date >= addDays(win.week, win.weeksFree * 7) && e.amountBase >= idle.amount / 4);
        items.push({
          id: `wi-idle-${win.week}`, warning: "idle_balance_over", kind: "watch",
          title: `About ${money(win.amount)} is free from the week of ${shortDate(win.week)}`,
          why: `Cash stays at least ${money(win.amount)} above your ${money(state.safetyLine)} line for ${win.weeksFree} week${win.weeksFree > 1 ? "s" : ""}${nextBig ? `, before ${partyName(commitmentById(nextBig.commitmentId)?.partyId)} (${money(nextBig.amountBase)}) on ${shortDate(nextBig.date)}` : ""}. Short-term options include a high-yield business savings or sweep account; Neri explains amounts and timing, not where to invest.`,
          cashEffect: win.amount, neededBy: win.week, confidence: 0.75, score: 0,
          evidenceRefs: [], actions: [{ kind: "mark_done" }],
          partnerAction: { label: "Compare business savings and sweep accounts", sample: true, disclosure: "Sample card. If Neri lists partners, they pay a referral fee, and Neri is paid the same whichever you choose." },
          state: "open",
        });
      }
    }

    // Receivables concentration (watch).
    const pct = p.thresholds.arConcentrationPct;
    if (pct) {
      const open = allCommitments().filter((c) => c.type === "invoice" && c.settlement === "open");
      const total = open.reduce((s, c) => s + c.amount, 0);
      const byParty = new Map();
      for (const c of open) byParty.set(c.partyId, (byParty.get(c.partyId) ?? 0) + c.amount);
      for (const [pid, amt] of byParty) {
        const share = Math.round((amt / total) * 100);
        if (share > pct) {
          items.push({
            id: `wi-conc-${pid}`, warning: "ar_concentration_risk", kind: "watch",
            title: `${partyName(pid)} owes you ${share}% of everything outstanding`,
            why: `${money(amt)} of ${money(total)} in open invoices. If they paid late, it would hit hard${(party(pid)?.lagStats?.medianDaysLate ?? 0) > 0 ? ", and they already pay late on average" : ""}. Consider a deposit or tighter terms on their next ${p.vocabulary.deal ?? "order"}.`,
            cashEffect: amt, neededBy: asOf, confidence: 1, score: 0,
            evidenceRefs: open.filter((c) => c.partyId === pid).map((c) => c.id),
            actions: [{ kind: "draft_email" }], partyId: pid, state: "open",
          });
        }
      }
    }

    // Rank actionable items.
    const act = items.filter((i) => i.kind === "act").map((i) => ({ ...i, state: state.done.has(i.id) ? "done" : "open" }));
    for (const i of act) i.score = Math.round(i.cashEffect * (1 / (1 + Math.max(0, daysBetween(asOf, i.neededBy)) / 7)) * i.confidence * i.relationship);
    act.sort((a, b) => b.score - a.score);
    const ranked = act.filter((i) => i.score >= p.thresholds.rankFloor);
    const three = ranked.slice(0, 3);
    const rest = ranked.slice(3);

    // Combined effect of the open three, and any shortfall left after them.
    const openLevers = three.filter((i) => i.state === "open" && i.warning === "projected_cash_gap").map((i) => i.lever);
    let combined = null;
    if (openLevers.length > 1) {
      const sim = simulate(openLevers, base);
      combined = { lowPointDelta: sim.lowPointDelta, lowPoint: sim.run.lowPoint };
    }
    const after = combined ? combined.lowPoint.amount : openLevers.length === 1 ? base.lowPoint.amount + three.find((i) => i.lever === openLevers[0]).cashEffect : base.lowPoint.amount;
    const residual = gapDate ? state.safetyLine - after : 0;
    const shortfall = residual > 0
      ? {
          amount: residual,
          title: `Even with these, you'd be ${money(residual)} under your line around ${shortDate(base.lowPoint.date)}`,
          why: "If chasing and timing can't close the rest, you could look at short-term working capital. Whether to borrow is your call; Neri only shows the gap and the dates.",
          partnerAction: { label: "See sample working-capital options", sample: true, disclosure: "Sample card. If Neri lists partners, they pay a referral fee, and Neri is paid the same whichever you choose." },
        }
      : null;

    const watch = items.filter((i) => i.kind === "watch");
    return { asOf, three, rest, watch, combined, shortfall, run: base };
  }

  function makeItem(warning, lever, value, neededBy, confidence, c, base, rule) {
    const pt = party(c.partyId);
    const rel = lever.kind === "defer"
      ? pt.tags.reduce((m, t) => m * (fixture.profile.thresholds.relationshipPenalty[t] ?? 1), 1)
      : 1;
    const ev = base.events.find((e) => e.commitmentId === c.id);
    const ref = c.sourceRef.record;
    const base$ = base.events.filter((e) => e.commitmentId === c.id).reduce((t, e) => t + e.amountBase, 0) || c.amount;
    const amt = c.currency === fixture.profile.baseCurrency ? money(c.amount) : `${money(c.amount, { currency: c.currency })} (${money(base$)})`;
    let title;
    let why;
    let actions;
    if (lever.kind === "defer" && !["supplier", "agency"].includes(pt.kind)) {
      title = `Move the ${pt.name.toLowerCase()} (${amt}) back ${lever.days / 7} weeks`;
      why = `It's planned for ${shortDate(ev.date)}, right as cash is lowest. Moving it to ${shortDate(addDays(ev.date, lever.days))} lifts your low point ${money(value)}.`;
      actions = [{ kind: "mark_done" }];
    } else if (lever.kind === "chase") {
      const lag = pt.lagStats;
      title = `Call ${pt.name} about the ${amt} ${ref.startsWith("INV") ? `invoice (${ref})` : "invoice"}`;
      const reason = lag && lag.medianDaysLate > 0
        ? `${pt.name} pays ${lag.medianDaysLate} days late on average (last ${lag.n} payments), so it's expected ${shortDate(ev.date)}`
        : `it's expected ${shortDate(ev.date)}${/\(([^)]*note[^)]*)\)/.test(ev.basis) ? ` (${ev.basis.match(/\(([^)]*note[^)]*)\)/)[1].replace(/^owner note: /, "your note: ")})` : ""}`;
      why = `It's due ${shortDate(c.anchors.due)}, but ${reason}. Paid on its due date, your low point rises ${money(value)}.`;
      actions = [{ kind: "draft_email" }, { kind: "mark_done" }];
    } else if (lever.kind === "defer") {
      title = `Ask ${pt.name} for ${lever.days} more days on ${amt}`;
      why = `${rule ? `You noted: “${rule.fromNote}.” ` : ""}Moving it from ${shortDate(ev.date)} to ${shortDate(addDays(ev.date, lever.days))} lifts your low point ${money(value)}.`;
      actions = [{ kind: "draft_email" }, { kind: "mark_done" }];
    } else {
      title = `Pay ${pt.name} by ${shortDate(c.discount.byDate)} to keep the ${c.discount.pct}% discount`;
      why = `${amt} is due ${shortDate(c.anchors.due)}. Paying early saves ${money(value)}, and you have room above your line through then.`;
      actions = [{ kind: "mark_done" }];
    }
    return {
      id: `wi-${lever.kind}-${c.id}`,
      warning, kind: "act", title, why, lever,
      cashEffect: value, neededBy, confidence, relationship: rel, score: 0,
      evidenceRefs: [c.id], actions, partyId: pt.id, state: "open",
    };
  }

  function partyName(id) {
    return party(id)?.name ?? "Someone";
  }

  // ---- review / signals ---------------------------------------------------------
  function review() {
    const base = forecast();
    return state.signals
      .filter((s) => s.state === "proposed")
      .map((s) => {
        const msg = fixture.messages.find((m) => m.id === s.sourceRef.record);
        const c = commitmentById(s.commitmentRef);
        const ev = base.events.find((e) => e.commitmentId === c.id);
        // price it: what-if with the signal applied
        s.state = "applied";
        const after = forecast();
        s.state = "proposed";
        return {
          signal: { ...s, effect: { lowPointDelta: after.lowPoint.amount - base.lowPoint.amount, week: after.lowPoint.week } },
          message: msg,
          commitment: c,
          party: party(s.partyId),
          from: ev.date,
          to: s.claim.newDate,
          before: base.lowPoint,
          after: after.lowPoint,
        };
      });
  }

  function decideSignal(id, decision) {
    const s = state.signals.find((x) => x.id === id);
    if (!s) throw new Error("No such signal");
    const before = forecast().lowPoint;
    s.state = decision === "apply" ? "applied" : "dismissed";
    const after = forecast().lowPoint;
    const c = commitmentById(s.commitmentRef);
    return {
      alert: decision === "apply"
        ? { title: `${partyName(s.partyId)} emailed: ${c.sourceRef.record} slips to ${shortDate(s.claim.newDate)}`, detail: `Your low point is now ${money(after.amount)} on ${shortDate(after.date)}${after.amount < before.amount ? `, down ${money(before.amount - after.amount)}` : ""}.`, weekLabel: weekLabel(after.week) }
        : null,
    };
  }

  // ---- drafts ----------------------------------------------------------------------
  function draft(itemId) {
    const b = brief();
    const item = [...b.three, ...b.rest, ...b.watch].find((i) => i.id === itemId);
    if (!item) throw new Error("No such item");
    const pt = party(item.partyId);
    const owner = fixture.business.owner;
    const biz = fixture.business.name;
    if (item.lever?.kind === "chase") {
      const c = commitmentById(item.lever.commitmentId);
      return {
        to: pt.contacts?.emailDomains?.[0] ? `ap@${pt.contacts.emailDomains[0]}` : "",
        subject: `${c.sourceRef.record}: ${money(c.amount)} due ${shortDate(c.anchors.due)}`,
        body: `Hi ${pt.name} team,\n\nA quick note on ${c.sourceRef.record} for ${money(c.amount)}, due ${shortDate(c.anchors.due)}. We have a large supplier payment going out right after it, so payment on the due date would really help us this month.\n\n${c.invoiceUrl ? `You can view the invoice here: ${c.invoiceUrl}\n\n` : ""}Could you confirm the date it will go out? Happy to talk if anything is holding it up.\n\nThanks,\n${owner}\n${biz}`,
      };
    }
    if (item.lever?.kind === "defer") {
      const c = commitmentById(item.lever.commitmentId);
      const ev = forecast().events.find((e) => e.commitmentId === c.id);
      const amtText = money(c.amount, { currency: c.currency });
      return {
        to: "",
        subject: `${c.sourceRef.record}: request to move payment to ${shortDate(addDays(ev.date, item.lever.days))}`,
        body: `Hi ${pt.name} team,\n\nWe have ${amtText} scheduled to you on ${shortDate(ev.date)} for ${c.sourceRef.record}. Could we move it to ${shortDate(addDays(ev.date, item.lever.days))}? Everything else on the order stays the same, and we'll confirm the transfer the day it goes out.\n\nThank you for working with us on this.\n\n${owner}\n${biz}`,
      };
    }
    return {
      to: "",
      subject: `Deposit on our next ${fixture.profile.vocabulary.deal ?? "order"}`,
      body: `Hi ${pt.name} team,\n\nAs our volume together grows, we'd like to ask for a 30% deposit at order on new ${fixture.profile.vocabulary.deal ?? "order"}s, with the balance on the usual terms. It helps us secure supplier capacity for you earlier.\n\nHappy to talk it through.\n\n${owner}\n${biz}`,
    };
  }

  function markDone(itemId) {
    state.done.add(itemId);
  }

  // ---- Ask Neri (preview) ---------------------------------------------------------------
  // Pattern-matched answers built by code from engine numbers, in the Answer shape from 08-claude-layer.md.
  // The real build replaces this with Claude using tools; numbers still come from the engine.
  function ask(question) {
    const q = question.toLowerCase();
    const base = forecast();
    const amount = parseAmount(question);

    const whatIf = q.match(/what if (.+?) pays? (\d+) days? late/);
    if (whatIf) {
      const pt = findParty(whatIf[1]);
      if (!pt) return { text: `I couldn't match “${whatIf[1]}” to anyone in your books.`, citations: [], missingData: "party" };
      const days = Number(whatIf[2]);
      const levers = allCommitments().filter((c) => c.partyId === pt.id && c.settlement === "open").map((c) => ({ kind: "shift", commitmentId: c.id, days }));
      const sim = simulate(levers, base);
      return {
        text: `If ${pt.name} pays ${days} more days late on everything open, your low point moves from ${money(base.lowPoint.amount)} (${shortDate(base.lowPoint.date)}) to ${money(sim.run.lowPoint.amount)} (${shortDate(sim.run.lowPoint.date)}). The chart now shows that case.`,
        citations: levers.map((l) => l.commitmentId),
        scenario: { label: `${pt.name} +${days} days`, run: sim.run },
      };
    }

    if (/payroll/.test(q)) {
      const payrolls = base.events.filter((e) => party(commitmentById(e.commitmentId)?.partyId)?.kind === "employee" && e.direction === "out");
      const risky = payrolls.filter((e) => (base.days.find((d) => d.date === e.date)?.closing ?? 0) < 0);
      if (!risky.length) {
        const tight = payrolls.filter((e) => (base.days.find((d) => d.date === e.date)?.closing ?? 0) < state.safetyLine);
        return {
          text: `Yes. Every payroll in the next 13 weeks clears${tight.length ? `, but on ${tight.map((e) => shortDate(e.date)).join(" and ")} you'll be under your ${money(state.safetyLine)} line afterwards` : " with room to spare"}.`,
          citations: payrolls.map((e) => e.commitmentId),
        };
      }
      const e = risky[0];
      const close = base.days.find((d) => d.date === e.date).closing;
      return {
        text: `Not as things stand. The ${shortDate(e.date)} payroll (${money(e.amountBase)}) leaves you at ${money(close)} that day. The three things on your Today list close most of that gap.`,
        citations: [e.commitmentId],
      };
    }

    if (/\b(who|call|chase|owes?)\b/.test(q)) {
      const b = brief();
      const chase = [...b.three, ...b.rest].filter((i) => i.lever?.kind === "chase");
      if (!chase.length) return { text: "No one needs a call right now. Every open invoice is expected on or before its due date.", citations: [] };
      return {
        text: `Start with ${chase.map((i) => `${partyName(i.partyId)} (${commitmentById(i.lever.commitmentId).sourceRef.record}, lifts your low point ${money(i.cashEffect)})`).join(", then ")}.`,
        citations: chase.map((i) => i.lever.commitmentId),
      };
    }

    if (amount && /(afford|hire|buy|spend|plan|deposit|purchase|order)/.test(q)) {
      const date = parseWhen(q, asOf);
      const ev = {
        id: `evt-plan-preview-0`, commitmentId: "plan-preview", legIndex: 0, date, amount, currency: "USD", amountBase: amount,
        direction: "out", status: "likely", confidence: 0.9, basis: `your plan, typed in Ask Neri: “${question}”`,
        sourceRef: { system: "owner", record: "Ask Neri" }, overriddenBy: [],
      };
      const sim = simulate([{ kind: "add", event: ev }], base);
      const ok = sim.run.lowPoint.amount >= state.safetyLine;
      return {
        text: `A ${money(amount)} payment on ${shortDate(date)} moves your low point from ${money(base.lowPoint.amount)} to ${money(sim.run.lowPoint.amount)} on ${shortDate(sim.run.lowPoint.date)}. ${ok ? "You stay above your line." : `That's ${money(state.safetyLine - sim.run.lowPoint.amount)} under your ${money(state.safetyLine)} line.`}`,
        citations: [],
        scenario: { label: `${money(amount)} on ${shortDate(date)}`, run: sim.run },
        proposal: { kind: "plan", amount, date, note: question },
      };
    }

    if (/\b(low|lowest|short|gap|worst|tightest)\b/.test(q)) {
      return {
        text: `Your lowest point is ${money(base.lowPoint.amount)} on ${shortDate(base.lowPoint.date)}${base.firstBelowSafety ? `. You first drop under your ${money(state.safetyLine)} line on ${shortDate(base.firstBelowSafety)}` : ", above your line the whole way"}.`,
        citations: base.days.find((d) => d.date === base.lowPoint.date).eventIds.map((id) => id.replace(/^evt-/, "").replace(/-\d+$/, "")),
      };
    }

    return {
      text: "In this preview I can answer questions about payroll, who to call, your lowest point, “what if a customer pays 10 days late”, and plans like “a $40K supplier deposit in December”. The full version answers anything from your books through Claude.",
      citations: [],
      missingData: "preview",
    };
  }

  function confirmPlan(proposal) {
    const id = `plan-owner-${state.plans.length + 1}`;
    const direction = proposal.direction ?? "out";
    const status = proposal.status ?? "likely";
    const type = status === "possible" ? "sales_deal" : "plan";
    state.plans.push({
      id, type, partyId: proposal.partyId, amount: proposal.amount, currency: "USD", anchors: { order: proposal.date }, status,
      probability: proposal.probability,
      sourceRef: { system: "owner", record: `${proposal.via ?? "Ask Neri"}: “${proposal.note}”` },
      legs: [{ legIndex: 0, date: proposal.date, amount: proposal.amount, direction, status, confidence: status === "possible" ? proposal.probability ?? 0.4 : 0.9, basis: `your note: “${proposal.note}”` }],
    });
    return { id };
  }

  // ---- parked thoughts ------------------------------------------------------------------
  // Unstructured owner notes (typed or spoken). Neri proposes a reading; nothing reaches the
  // forecast until the owner confirms it. The real build runs these through the signals pipeline
  // (owner channel, docs/design/06-signals.md) with Claude extraction; this preview uses keyword rules.
  const KINDS = [
    { kind: "investment", re: /\b(invest|investment|equipment|machine|cooler|truck|forklift|warehouse|expan\w*|loan|capex|renovat\w*|upgrade)\b/, direction: "out", status: "likely" },
    { kind: "new_business", re: /\b(rfq|quote|quoted|lead|prospect|new customer|might order|could order|order from|spring order|deal|catering|booking|tender|bid)\b/, direction: "in", status: "possible" },
    { kind: "collection", re: /\b(collect|owes?|owe us|chase|will pay|can pay|pay by|pay us|payment from|receivable|overdue|paying late|pays late)\b/, direction: "in", status: "likely" },
    { kind: "spend", re: /\b(buy|spend|pay|paying|deposit|hire|hiring|purchase|rent|bonus|tax|container|fix|repair|order)\b/, direction: "out", status: "likely" },
  ];

  state.thoughts = (fixture.thoughts ?? []).map((t) => ({ state: "new", ...t, reading: readThought(t.text) }));

  function readThought(text) {
    const q = text.toLowerCase();
    // A note that names one of your open invoices is about collecting it, whatever verbs it uses.
    const named = allCommitments().find((c) => c.type === "invoice" && c.settlement === "open" && q.includes(c.sourceRef.record.toLowerCase()));
    const match = named ? KINDS.find((k) => k.kind === "collection") : KINDS.find((k) => k.re.test(q)) ?? { kind: "note", direction: null, status: null };
    const amount = parseAmount(text);
    const hasWhen = MONTH_NAMES.some((m) => new RegExp(`\\b(${m}|${m.slice(0, 3)})\\b`).test(q)) || /next (week|month)/.test(q);
    const date = hasWhen ? parseWhen(q, asOf) : null;
    const ref = allCommitments().find((c) => c.sourceRef.record.length > 3 && q.includes(c.sourceRef.record.toLowerCase()));
    const pt = ref ? party(ref.partyId) : fixture.parties.find((p) => {
      const first = p.name.toLowerCase().split(" ")[0];
      return first.length >= 4 && new RegExp(`\\b${first}\\b`).test(q);
    });
    let probability;
    if (match.status === "possible") probability = /\b(likely|probably|confirmed|verbal)\b/.test(q) ? 0.6 : /\b(maybe|might|hinted|long shot)\b/.test(q) ? 0.3 : 0.4;

    // A collection note about a party with an open invoice becomes a timing proposal on that invoice.
    let invoice;
    if (match.kind === "collection" && pt) {
      invoice = ref?.type === "invoice" ? ref : allCommitments().find((c) => c.partyId === pt.id && c.type === "invoice" && c.settlement === "open");
    }
    const missing = [];
    if (match.kind !== "note" && !invoice && amount == null) missing.push("amount");
    if (match.kind !== "note" && date == null) missing.push("date");
    return {
      kind: match.kind,
      direction: match.direction,
      status: match.status,
      probability,
      amount: invoice && amount == null ? invoice.amount : amount,
      date,
      partyId: pt?.id,
      invoiceId: invoice?.id,
      missing,
    };
  }

  function priceThought(t) {
    const r = t.reading;
    if (r.kind === "note" || r.amount == null || !r.date) return null;
    if (r.date > horizonEnd) return { outside: true };
    const base = forecast();
    if (r.invoiceId) {
      const sim = simulate([{ kind: "chase", commitmentId: r.invoiceId, assumeDate: r.date }], base);
      return { lowPointDelta: sim.lowPointDelta, lowPoint: sim.run.lowPoint };
    }
    const ev = {
      id: `evt-thought-${t.id}`, commitmentId: `thought-${t.id}`, legIndex: 0, date: r.date, amount: r.amount, currency: "USD", amountBase: r.amount,
      direction: r.direction, status: r.status, confidence: 0.8, basis: "parked thought", sourceRef: { system: "owner", record: t.id }, overriddenBy: [],
    };
    if (r.status === "possible") {
      return { pipeline: Math.round(r.amount * (r.probability ?? 0.4)) };
    }
    const sim = simulate([{ kind: "add", event: ev }], base);
    return { lowPointDelta: sim.lowPointDelta, lowPoint: sim.run.lowPoint };
  }

  function thoughts() {
    return state.thoughts.map((t) => ({ ...t, effect: t.state === "new" ? priceThought(t) : null }));
  }

  function parkThought(text, via = "typed") {
    const t = { id: `th-${Date.now().toString(36)}`, text: text.trim(), via, createdAt: new Date().toISOString(), state: "new" };
    t.reading = readThought(t.text);
    state.thoughts.unshift(t);
    return { ...t, effect: priceThought(t) };
  }

  function updateThought(id, edits) {
    const t = state.thoughts.find((x) => x.id === id);
    if (!t) throw new Error("No such note");
    Object.assign(t.reading, edits);
    t.reading.missing = t.reading.missing.filter((m) => edits[m] == null);
    return { ...t, effect: priceThought(t) };
  }

  function decideThought(id, decision) {
    const t = state.thoughts.find((x) => x.id === id);
    if (!t) throw new Error("No such note");
    const r = t.reading;
    if (decision === "add") {
      if (r.invoiceId) {
        state.signals.push({
          id: `sig-${t.id}`, channel: "owner", receivedAt: t.createdAt, partyId: r.partyId, commitmentRef: r.invoiceId,
          claim: { kind: "date_change", newDate: r.date }, confidence: 0.9, state: "applied", sourceRef: { system: "owner", record: t.id },
        });
      } else {
        confirmPlan({ amount: r.amount, date: r.date, direction: r.direction, status: r.status, probability: r.probability, note: t.text, partyId: r.partyId, via: "Parked thought" });
      }
      t.state = "added";
    } else if (decision === "keep") {
      t.state = "kept";
    } else if (decision === "remove") {
      state.thoughts = state.thoughts.filter((x) => x.id !== id);
    }
  }

  function findParty(text) {
    const t = text.toLowerCase().trim();
    return fixture.parties.find((p) => p.name.toLowerCase().includes(t) || t.includes(p.name.toLowerCase().split(" ")[0]));
  }

  function record(id) {
    const c = commitmentById(id);
    if (!c) return null;
    const ev = forecast().events.filter((e) => e.commitmentId === id);
    return {
      commitment: c,
      party: party(c.partyId),
      events: ev,
      signals: state.signals.filter((s) => s.commitmentRef === id),
      rules: fixture.rules.filter((r) => r.scope.partyId === c.partyId),
      message: fixture.messages.find((m) => state.signals.some((s) => s.commitmentRef === id && s.sourceRef.record === m.id)),
    };
  }

  function setSafetyLine(cents) {
    state.safetyLine = cents;
  }

  return {
    business: fixture.business,
    profile: fixture.profile,
    parties: fixture.parties,
    rules: fixture.rules,
    party,
    commitmentById,
    forecast,
    simulate,
    brief,
    review,
    decideSignal,
    draft,
    markDone,
    ask,
    confirmPlan,
    record,
    setSafetyLine,
    thoughts,
    parkThought,
    updateThought,
    decideThought,
    get safetyLine() {
      return state.safetyLine;
    },
  };
}

function hashLevers(levers = []) {
  let h = 0;
  const s = JSON.stringify(levers);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function parseAmount(text) {
  // Ignore identifiers like INV-1187 or PO-2291 and four-digit years.
  const cleaned = text.replace(/\b[A-Za-z]+-\d+\b/g, " ").replace(/\b20\d\d\b/g, " ");
  const m = cleaned.match(/(\$)?\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m|thousand|million|grand)?\b/i);
  if (!m) return null;
  let v = Number(m[2].replace(/,/g, ""));
  const unit = (m[3] ?? "").toLowerCase();
  if (unit === "k" || unit === "thousand" || unit === "grand") v *= 1e3;
  if (unit === "m" || unit === "million") v *= 1e6;
  if (!m[1] && !unit && v < 1000) return null;
  return Math.round(v * 100);
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function parseWhen(q, asOf) {
  const [y, mo] = asOf.split("-").map(Number);
  let best = null;
  for (let i = 0; i < 12; i++) {
    const re = new RegExp(`\\b(${MONTH_NAMES[i]}|${MONTH_NAMES[i].slice(0, 3)})\\b\\.?\\s*(\\d{1,2})?(?:st|nd|rd|th)?\\b`);
    const m = q.match(re);
    if (m && (best === null || m.index < best.index)) best = { index: m.index, month: i, day: m[2] ? Number(m[2]) : null };
  }
  if (best) {
    const year = best.month + 1 < mo ? y + 1 : y;
    const day = best.day ?? (/early/.test(q) ? 5 : /\b(end|late)\b/.test(q) ? 26 : 15);
    return `${year}-${String(best.month + 1).padStart(2, "0")}-${String(Math.min(day, 28)).padStart(2, "0")}`;
  }
  if (/next week/.test(q)) return addDays(asOf, 7);
  if (/next month/.test(q)) return addDays(asOf, 30);
  return addDays(asOf, 14);
}
