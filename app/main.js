import { api, SANDBOXES, suggestBusinessName, authLive } from "./api.js";
import { currentSession } from "./ui/auth.js";
import { CATEGORIES, CONNECTORS, AVAILABILITY_LABEL } from "./catalog/connectors.js";
import { ASK_HINTS } from "./catalog/ask-hints.js";
import { cashChart } from "./ui/chart.js";
import { icon, logo, logoLarge } from "./ui/icons.js?v=2";
import { speak, listen, canSpeak, canListen, speakable, spokenMoney } from "./ui/speech.js";
import { addDays, dayDate, esc, greeting, money, moneyShort, parseDate, shortDate, weekLabel } from "./ui/format.js";

const $ = (sel, root = document) => root.querySelector(sel);

const app = {
  account: api.account(),
  bizId: null,
  signup: { step: "email", email: "", name: "", error: "", personal: false },
  setup: { kind: "trading", picked: new Set(), reserve: "", connecting: false },
  ctx: null,
  brief: null,
  review: [],
  notes: [],
  scenario: "base",
  stressRun: null,
  whatIf: null,
  askLog: [],
  mask: false,
  fresh: new Set(),
  noteFilter: "all",
  stopSpeak: null,
  speakingIndex: -1,
  stopListen: null,
  drive: false,
  interest: new Set(),
};

try {
  app.mask = localStorage.getItem("neri.mask") === "1";
  const theme = localStorage.getItem("neri.theme");
  if (theme) document.documentElement.dataset.theme = theme;
} catch {}

// ---------------------------------------------------------------- data
async function load() {
  app.account = api.account();
  if (!app.account) {
    app.ctx = null;
    if (!["welcome", "setup"].includes(rawRoute())) history.replaceState(null, "", "#/welcome");
    return render();
  }
  app.bizId = app.account.sandbox ?? SANDBOXES[0].id;
  await api.open(app.bizId);
  app.ctx = await api.context();
  if (app.account.reserve && !app.account.reserveApplied) {
    await api.setSafetyLine(app.account.reserve);
    app.account = { ...app.account, reserveApplied: true };
    try { localStorage.setItem("neri.account", JSON.stringify(app.account)); } catch {}
  }
  await refresh();
}

async function refresh() {
  const prevThree = new Set((app.brief?.three ?? []).map((i) => i.id + i.cashEffect));
  // Context too, so names for commitments added by Review, notes or plans (live partyByCommitment) stay current.
  [app.brief, app.review, app.notes, app.ctx] = await Promise.all([api.brief(), api.review(), api.notes(), api.context()]);
  app.ctx.safetyLine = app.brief.run.safetyLine;
  if (app.scenario === "stress") app.stressRun = await api.forecast("stress");
  if (prevThree.size) {
    app.fresh = new Set(app.brief.three.filter((i) => !prevThree.has(i.id + i.cashEffect)).map((i) => i.id));
  }
  render();
}

// ---------------------------------------------------------------- masking (stage mode)
function aliasMap() {
  const map = new Map();
  const counters = { customer: 0, supplier: 0, agency: 0 };
  const labels = { customer: "Customer", supplier: "Supplier", agency: "Vendor" };
  for (const p of app.ctx.parties) {
    if (!(p.kind in counters)) continue;
    map.set(p.name, `${labels[p.kind]} ${String.fromCharCode(65 + counters[p.kind]++)}`);
  }
  // first words too ("Evergreen" in a suggestion), when they belong to exactly one party
  for (const [name, alias] of [...map]) {
    const first = name.split(" ")[0];
    if (first.length > 3 && app.ctx.parties.filter((p) => p.name.startsWith(first + " ") || p.name === first).length === 1) map.set(first, alias);
  }
  return map;
}
function masked(html) {
  if (!app.mask || !app.ctx) return html;
  let out = html;
  for (const [name, alias] of aliasMap()) out = out.split(name).join(alias).split(esc(name)).join(alias);
  return out;
}

// ---------------------------------------------------------------- summary sentences (screen + voice share one source)
function summary() {
  const b = app.brief;
  const run = b.run;
  const safety = run.safetyLine;
  const low = run.lowPoint;
  const name = (pid) => app.ctx.parties.find((p) => p.id === pid)?.name;
  if (run.firstBelowSafety) {
    const short = safety - low.amount;
    const holdsUntil = addDays(run.firstBelowSafety, -1);
    // what causes the dip: the biggest outflows in the week up to the low point
    const window = run.events.filter((e) => e.direction === "out" && e.date <= low.date && e.date > addDays(low.date, -8));
    const causes = window.sort((a, b2) => b2.amountBase - a.amountBase).slice(0, 2).map((e) => {
      const c = e.sourceRef?.record ?? "";
      const pn = name(commitmentParty(e.commitmentId));
      return pn ? `${pn} (${money(e.amountBase)})` : `${c} (${money(e.amountBase)})`;
    });
    return {
      headline: holdsUntil <= run.asOf
        ? `Cash is ${money(short)} below your line right now.`
        : `Cash holds until ${shortDate(holdsUntil)}, then drops ${money(short)} below your line.`,
      sub: `Lowest point ${money(low.amount)} on ${dayDate(low.date)}${causes.length ? `, when ${causes.join(" and ")} go out` : ""}.`,
      take: cfoTake(),
      tone: "short",
    };
  }
  const idle = b.watch.find((w) => w.warning === "idle_balance_over");
  return {
    headline: `You're above your line for all ${run.weeks.length} weeks.`,
    sub: `Lowest point ${money(low.amount)} on ${dayDate(low.date)}.`,
    take: idle ? `You're in good shape. The real question is the idle cash: ${idle.title.charAt(0).toLowerCase()}${idle.title.slice(1)}, and that money should be working.` : "You're in good shape. Nothing needs a decision this week.",
    tone: "ok",
  };
}

// Neri's read, the way a CFO would say it: the diagnosis, then what closes it, then what's left to decide.
// Every figure comes from the forecast run and the ranked items; nothing here is estimated.
function cfoTake() {
  const b = app.brief;
  const run = b.run;
  const end = run.weeks[run.weeks.length - 1].closing;
  const timing = end >= run.safetyLine;
  const open = b.three.filter((i) => i.state === "open" && i.lever);
  const diag = timing ? "This is a timing problem, not a profit problem." : `This isn't only timing: you finish the 13 weeks at ${money(end)}, still under your line.`;
  if (!open.length) return `${diag} ${timing ? "Hold spending until the late money lands." : "The fix is margin or spend, not chasing."}`;
  const after = b.combined?.lowPoint.amount ?? run.lowPoint.amount + open[0].cashEffect;
  const fixes = open.length === 1 ? "Today's one move" : `Today's ${["", "", "two", "three"][open.length]} moves`;
  if (after >= run.safetyLine) return `${diag} ${fixes} keep you above your line.`;
  const rest = run.safetyLine - after;
  return `${diag} ${fixes} lift the low point to ${money(after)}. The last ${money(rest)} needs a decision from you before ${shortDate(run.firstBelowSafety)}.`;
}
function ownerName() {
  return app.account?.owner || app.ctx?.business.owner || "";
}
function commitmentParty(cid) {
  return app.ctx.partyOf?.(cid);
}

function spokenBrief() {
  const s = summary();
  const b = app.brief;
  const open = b.three.filter((i) => i.state !== "done");
  const parts = [`${greeting(new Date().getHours())}, ${ownerName()}. ${speakable(s.headline)} ${speakable(s.take ?? s.sub)}`];
  if (open.length) {
    parts.push(open.length === 1 ? "One thing today." : `${["", "One", "Two", "Three"][open.length]} things today.`);
    open.forEach((i, n) => parts.push(`${open.length > 1 ? ["First", "Second", "Third"][n] + ". " : ""}${speakable(i.title)}.`));
  } else {
    parts.push("Nothing needs you today.");
  }
  const waiting = app.review.length + app.notes.filter((n) => n.state === "new").length;
  if (waiting) parts.push(`${waiting === 1 ? "One item is" : `${waiting} items are`} waiting for your OK when you're parked.`);
  return parts;
}

// ---------------------------------------------------------------- routing + shell
const ROUTES = ["today", "details", "notes", "review", "sources", "settings", "welcome", "setup"];
const ALIASES = { forecast: "details", ask: "today", home: "today", signup: "welcome" };
function rawRoute() {
  return location.hash.replace(/^#\/?/, "") || "today";
}
function route() {
  let r = ALIASES[rawRoute()] ?? rawRoute();
  if (!app.account) return r === "setup" && app.signup.step === "done" ? "setup" : "welcome";
  if (r === "welcome") return "today";
  return ROUTES.includes(r) ? r : "today";
}
window.addEventListener("hashchange", () => {
  render();
  window.scrollTo(0, 0);
});

function waitingCount() {
  return app.review.length;
}
function notesWaiting() {
  return app.notes.filter((n) => n.state === "new").length;
}

function renderShell() {
  const r = route();
  const portal = r === "welcome" || r === "setup";
  document.body.classList.toggle("portal", portal);
  if (portal) {
    $("#top").innerHTML = `<div class="top-inner"><span class="brand">${logo}<b>Neri <span>Cash</span></b></span></div>`;
    $("#bottom").innerHTML = "";
    $("#preview-note").innerHTML = "";
    $("#talk").hidden = true;
    return;
  }
  const tab = (id, label, count) =>
    `<a class="tab" href="#/${id}" ${r === id ? 'aria-current="page"' : ""}>${label}${count ? `<span class="count" aria-label="${count} waiting">${count}</span>` : ""}</a>`;
  $("#top").innerHTML = `
    <div class="top-inner">
      <a class="brand" href="#/today" aria-label="Neri Cash home">${logo}<b>Neri <span>Cash</span></b></a>
      <nav class="tabs" aria-label="Main">
        ${tab("today", "Home")}${tab("details", "Details")}${tab("notes", "Notes", notesWaiting())}${tab("review", "Review", waitingCount())}${tab("sources", "Sources")}
      </nav>
      <div class="top-right">
        ${statusDots()}
        <a class="icon-btn" href="#/settings" title="Settings">${icon.gear}<span class="sr">Settings</span></a>
      </div>
    </div>`;
  const nav = (id, label, ic, count) =>
    `<a href="#/${id}" ${r === id ? 'aria-current="page"' : ""}>${ic}${label}${count ? `<span class="count">${count}</span>` : ""}</a>`;
  $("#bottom").innerHTML =
    nav("today", "Home", icon.ask) + nav("details", "Details", icon.chart) +
    `<span class="nav-slot" aria-hidden="true"></span>` +
    nav("notes", "Notes", icon.note, notesWaiting() + waitingCount()) + nav("sources", "Sources", icon.plug);
  $("#talk").hidden = false;
  $("#preview-note").innerHTML = app.ctx.business.synthetic
    ? app.account?.sample
      ? `Sample business with fictional data<span class="wide-only">. Today is set to ${dayDate(app.ctx.business.asOf)}</span>.`
      : `Preview: your connections are simulated, so Neri shows a sample ${esc(app.ctx.profile.displayName.toLowerCase())} business<span class="wide-only">. Today is set to ${dayDate(app.ctx.business.asOf)}</span>.`
    : "";
}

// Connection health as dots: green connected, yellow waiting (file or setup), red needs attention.
function connections() {
  if (app.account?.connections?.length) return app.account.connections;
  return app.ctx.business.sources.map((src) => ({ id: src.id, name: src.label, state: src.state === "ok" ? "ok" : src.state === "error" ? "error" : "waiting", syncedAt: src.syncedAt }));
}
function statusDots() {
  const list = connections();
  const label = list.map((c) => `${c.name}: ${c.state === "ok" ? "connected" : c.state === "error" ? "needs attention" : "waiting for a file"}`).join(", ");
  return `<a class="dots" href="#/sources" title="${esc(label)}" aria-label="Connections. ${esc(label)}">${list.slice(0, 8).map((c) => `<i class="d ${c.state === "ok" ? "" : c.state === "error" ? "red" : "amber"}"></i>`).join("")}${list.length > 8 ? `<small>+${list.length - 8}</small>` : ""}</a>`;
}

function render() {
  const r = route();
  if (!app.ctx && r !== "welcome" && r !== "setup") return;
  renderShell();
  const views = { today: viewToday, details: viewDetails, notes: viewNotes, review: viewReview, sources: viewSources, settings: viewSettings, welcome: viewWelcome, setup: viewSetup };
  const prevDeck = document.getElementById("deck");
  const keepLeft = prevDeck ? prevDeck.scrollLeft : 0;
  const keepFocus = document.activeElement?.closest?.("#deck") ? document.activeElement.dataset.action + ":" + document.activeElement.dataset.id : null;
  $("#view").innerHTML = masked(views[r]());
  const deck = document.getElementById("deck");
  if (deck && keepLeft) deck.scrollLeft = keepLeft;
  if (deck && keepFocus) {
    const [act, fid] = keepFocus.split(":");
    [...deck.querySelectorAll(`[data-action="${act}"]`)].find((b) => b.dataset.id === fid)?.focus({ preventScroll: true });
  }
  requestAnimationFrame(syncDeck);
  document.title = `${{ today: "Home", details: "Details", notes: "Notes", review: "Review", sources: "Sources", settings: "Settings", welcome: "Sign up", setup: "Set up" }[r]} · Neri Cash`;
  if (app.drive) renderDrive();
}

// ---------------------------------------------------------------- Today
function viewToday() {
  const b = app.brief;
  const s = summary();
  const n = b.three.length;
  const waitingRev = app.review.length;
  const waitingNotes = notesWaiting();
  const waiting = [waitingRev ? `${waitingRev} ${waitingRev === 1 ? "message" : "messages"}` : "", waitingNotes ? `${waitingNotes} ${waitingNotes === 1 ? "note" : "notes"}` : ""].filter(Boolean).join(" and ");
  return `
  <div class="home">
    <section class="home-top">
      <h1 class="headline">${esc(s.headline)}</h1>
      <p class="subhead">${esc(s.sub)}</p>
      ${s.take ? `<p class="take"><span class="sunmark" aria-hidden="true"></span>${esc(s.take)}</p>` : ""}
      <div class="home-links">
        ${canSpeak ? `<button class="listen" data-action="listen" aria-pressed="${app.stopSpeak ? "true" : "false"}"><span class="disc">${app.stopSpeak ? icon.stop : icon.play}</span>${app.stopSpeak ? "Stop" : "Play brief"} <small>${spokenLength()} sec</small></button>` : ""}
        <button class="btn quiet" data-action="drive">${icon.car}Drive mode</button>
        <a class="btn quiet" href="#/details">See the numbers</a>
      </div>
    </section>

    <section class="today-list" aria-labelledby="today-h">
      <div class="deck-head">
        <h2 class="section-title" id="today-h">${n ? (n === 1 ? "One thing today" : `${["", "One", "Two", "Three"][n]} things today`) : "Today"}</h2>
        ${n > 1 ? `<div class="deck-nav"><button class="deck-arrow" data-action="deck" data-dir="-1" aria-label="Previous">${arrow("left")}</button><button class="deck-arrow" data-action="deck" data-dir="1" aria-label="Next">${arrow("right")}</button></div>` : ""}
      </div>
      ${n ? `<ol class="deck ${n === 1 ? "single" : ""}" id="deck" aria-label="Today's things" tabindex="0">${b.three.map((i, k) => homeCard(i, k, n)).join("")}</ol>
        ${n > 1 ? `<div class="deck-dots" aria-hidden="true">${b.three.map((_, k) => `<i class="${k === 0 ? "on" : ""}"></i>`).join("")}</div>` : ""}` : `<p class="calm">Nothing needs you today. Neri will speak up if a payment moves.</p>`}
      ${waiting ? `<a class="waiting" href="#/${waitingRev ? "review" : "notes"}"><span class="sunmark"></span>${waiting} waiting for your OK</a>` : ""}
    </section>

    <section class="convo" aria-label="Conversation with Neri">${app.askLog.map(turnHtml).join("")}</section>
    <div class="dock stick">
      ${app.askLog.length ? "" : `<div class="dock-hints" role="group" aria-label="Try asking">${askHints().map((h) => `<button class="hint" data-action="hint" data-q="${esc(h)}">${esc(h)}</button>`).join("")}</div>`}
      ${askBar("Ask Neri, or park a thought", [], true)}
    </div>
  </div>`;
}

// Fixed text, shared with the demo intent cache, so every hint gets a real answer with no API key.
function askHints() {
  return ASK_HINTS;
}

// One card per thing, side by side. The focused card fills the column; the next one peeks in as a lead-in.
function homeCard(i, k, n) {
  const done = i.state === "done";
  const ref = i.evidenceRefs?.[0];
  const draft = i.actions.some((a) => a.kind === "draft_email");
  return `
  <li class="card ${done ? "done" : ""} ${app.fresh.has(i.id) ? "fresh" : ""}" aria-label="Thing ${k + 1} of ${n}">
    <p class="card-effect"><b>${money(i.cashEffect, { signed: true })}</b><span>${i.warning === "early_pay_discount" ? "saved" : "to your low point"}</span></p>
    <h3 class="card-title">${esc(i.title)}</h3>
    <p class="card-why">${esc(i.why)}</p>
    <div class="card-actions">
      ${done ? "" : `<span class="card-by">Act by <b>${shortDate(i.neededBy)}</b></span>`}
      ${draft && !done ? `<button class="btn small primary" data-action="draft" data-id="${esc(i.id)}">${icon.mail}Draft email</button>` : ""}
      <button class="btn small ${done ? "" : "quiet"}" data-action="done" data-id="${esc(i.id)}" aria-pressed="${done}">${icon.check}${done ? "Done" : "Mark done"}</button>
      ${ref ? `<button class="src" data-action="record" data-id="${esc(ref)}" title="Where this number comes from">${esc(refLabel(ref))}</button>` : ""}
    </div>
  </li>`;
}
function arrow(dir) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${dir === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"}"/></svg>`;
}
function deckIndex(deck) {
  const cards = [...deck.children];
  const left = deck.getBoundingClientRect().left;
  let best = 0;
  cards.forEach((c, k) => {
    if (Math.abs(c.getBoundingClientRect().left - left) < Math.abs(cards[best].getBoundingClientRect().left - left)) best = k;
  });
  return best;
}
function syncDeck() {
  const deck = document.getElementById("deck");
  if (!deck) return;
  const k = deckIndex(deck);
  document.querySelectorAll(".deck-dots i").forEach((d, n) => d.classList.toggle("on", n === k));
  [...deck.children].forEach((c, n) => c.classList.toggle("focus", n === k));
  const [prev, next] = document.querySelectorAll(".deck-arrow");
  if (prev) prev.disabled = k === 0;
  if (next) next.disabled = k === deck.children.length - 1;
}
function moveDeck(dir) {
  const deck = document.getElementById("deck");
  if (!deck) return;
  const k = Math.max(0, Math.min(deck.children.length - 1, deckIndex(deck) + dir));
  deck.scrollTo({ left: deck.children[k].offsetLeft - deck.children[0].offsetLeft, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
document.addEventListener("scroll", (e) => {
  if (e.target?.id === "deck") syncDeck();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.target?.id !== "deck") return;
  if (e.key === "ArrowRight") moveDeck(1);
  if (e.key === "ArrowLeft") moveDeck(-1);
});

function thingRow(i) {
  const done = i.state === "done";
  const ref = i.evidenceRefs?.[0];
  const actions = i.actions.map((a) => (a.kind === "draft_email" ? `<button class="btn small" data-action="draft" data-id="${esc(i.id)}">${icon.mail}Draft email</button>` : "")).join("");
  return `
  <li class="thing ${done ? "done" : ""}">
    <button class="check" data-action="done" data-id="${esc(i.id)}" aria-pressed="${done}" aria-label="${done ? "Done" : "Mark done"}: ${esc(i.title)}">${icon.check}</button>
    <div><h3>${esc(i.title)}</h3><p>${esc(i.why)}</p></div>
    <div class="effect"><b>${money(i.cashEffect, { signed: true })}</b><span>${i.warning === "early_pay_discount" ? "saved" : "to your low point"}</span></div>
    <div class="thing-actions"><span class="by">Act by <b>${shortDate(i.neededBy)}</b></span>${actions}${ref ? `<button class="src" data-action="record" data-id="${esc(ref)}">${esc(refLabel(ref))}</button>` : ""}</div>
  </li>`;
}

function refLabel(id) {
  const m = id.replace(/^(inv|po|bill|deal|rfq|rec|plan)-/, "").match(/^(INV|PO|BILL|SO|RFQ|DUT|PF|B)-[\w-]+/);
  return m ? m[0].replace(/-(dep|bal)$/, "") : "Source";
}

function sampleCard(pa) {
  if (!pa) return "";
  return `<div class="sample-card"><span class="tag">Sample</span><div>${esc(pa.label)}<small>${esc(pa.disclosure)}</small></div></div>`;
}

function inboxPanel() {
  const rev = app.review;
  const notes = app.notes.filter((n) => n.state === "new");
  if (!rev.length && !notes.length) return "";
  return `<section class="panel"><h2>Waiting for your OK</h2>
    ${rev.map((r) => `<a class="inbox-item" href="#/review" style="text-decoration:none;color:inherit"><span class="ico">${icon.mail}</span><span><b>${esc(r.party?.name ?? "A message")} wrote about ${esc(r.commitment.sourceRef.record)}</b><span>Could move your low point ${money(r.signal.effect.lowPointDelta, { signed: true })}</span></span></a>`).join("")}
    ${notes.length ? `<a class="inbox-item" href="#/notes" style="text-decoration:none;color:inherit"><span class="ico">${icon.note}</span><span><b>${notes.length} parked ${notes.length === 1 ? "thought" : "thoughts"}</b><span>Neri has a reading for each. Add them to the forecast or keep them as notes.</span></span></a>` : ""}
  </section>`;
}

// Times show in the business's own timezone (set at onboarding), not the viewer's.
function tz() {
  return app.ctx?.business?.timezone ?? undefined;
}
function clock(iso) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz() });
}
function dayOf(iso) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz() });
}
function syncTime(iso) {
  const day = new Date(iso).toLocaleDateString("en-CA", { timeZone: tz() });
  return day === app.ctx.business.asOf ? clock(iso) : `${dayOf(iso)}, ${clock(iso)}`;
}

function spokenLength() {
  const words = spokenBrief().join(" ").split(/\s+/).length;
  return Math.max(10, Math.round(words / 2.6));
}

function askBar(placeholder, hints = [], branded = false) {
  return `
  <form class="askbar ${branded ? "branded" : ""}" data-submit="ask">
    ${branded ? `<span class="ask-mark" aria-hidden="true">${logo}</span>` : ""}
    <label class="sr" for="askq">Ask Neri</label>
    <input id="askq" name="q" placeholder="${esc(placeholder)}" autocomplete="off" />
    ${canListen ? `<button type="button" class="mic" data-action="mic-ask" aria-pressed="${app.stopListen ? "true" : "false"}" title="Speak">${icon.mic}<span class="sr">Speak</span></button>` : ""}
    <button class="send" type="submit" title="Ask">${icon.send}<span class="sr">Ask</span></button>
  </form>
  ${hints.length ? `<div class="ask-hints">${hints.map((h) => `<button class="hint" data-action="hint" data-q="${esc(h)}">${esc(h)}</button>`).join("")}</div>` : ""}`;
}

// ---------------------------------------------------------------- Forecast
function chartWidth() {
  const main = $("#view");
  const w = (main?.clientWidth ?? 900) - 50;
  return Math.max(300, Math.min(1130, w));
}

function viewDetails() {
  const b = app.brief;
  const run = b.run;
  const figures = `
  <div class="kpis">
    <div class="fig"><small>Cash today</small><b>${money(run.openingBalance)}</b><span>Bank, ${shortDate(addDays(run.asOf, -1))}</span></div>
    <div class="fig"><small>Lowest point</small><b class="${run.lowPoint.amount < 0 ? "below" : ""}">${money(run.lowPoint.amount)}</b><span>${dayDate(run.lowPoint.date)}</span></div>
    <div class="fig"><small>Your line</small><b>${money(run.safetyLine)}</b><a class="link" href="#/settings">Change</a></div>
    <div class="fig"><small>Weeks under your line</small><b>${run.weeksBelowSafety.length}</b><span>of ${run.weeks.length}</span></div>
  </div>`;
  const together = b.combined && b.three.filter((i) => i.state === "open").length > 1
    ? `<p class="together">Do all of today's things and your low point goes from <b>${money(run.lowPoint.amount)}</b> to <b>${money(b.combined.lowPoint.amount)}</b>.</p>` : "";
  const shortfall = b.shortfall ? `<div class="shortfall"><h4>${esc(b.shortfall.title)}</h4><p>${esc(b.shortfall.why)}</p>${sampleCard(b.shortfall.partnerAction)}</div>` : "";
  const rest = b.rest.length ? `<h2 class="section-title" style="margin-top:40px">More you could do</h2><ol class="things">${b.rest.map(thingRow).join("")}</ol>` : "";
  const watch = b.watch.length
    ? `<h2 class="section-title" style="margin-top:40px">Keep an eye on</h2><p class="section-note">Nothing to do yet. Neri tells you if these turn into actions.</p>
       ${b.watch.map((w) => `<div class="watch-item"><h4>${esc(w.title)}</h4>${w.warning === "ar_concentration_risk" ? `<button class="btn small quiet" data-action="draft" data-id="${esc(w.id)}">${icon.mail}Draft a terms note</button>` : ""}<p>${esc(w.why)}</p>${w.partnerAction ? `<div style="grid-column:1/-1;margin-top:8px">${sampleCard(w.partnerAction)}</div>` : ""}</div>`).join("")}` : "";
  return `
  <div class="page-head"><div><h1>Details</h1><p>The numbers behind today's brief. Tap any week or source to see where a number comes from.</p></div></div>
  ${figures}
  ${forecastBody()}
  <div class="details-grid">
    <div>${together}${shortfall}${rest}${watch}</div>
    <aside class="side">${inboxPanel()}
      <section class="panel"><h2>Reading from</h2>
        ${app.ctx.business.sources.map((src) => `<div class="source-row"><span class="dot ${src.state === "ok" ? "" : "warn"}"></span>${esc(src.label)}<time>${syncTime(src.syncedAt)}</time></div>`).join("")}
        <div class="more"><span></span><a href="#/sources">Add a source</a></div></section>
    </aside>
  </div>`;
}

function forecastBody() {
  const run = app.scenario === "stress" && app.stressRun ? app.stressRun : app.brief.run;
  const base = app.brief.run;
  const narrow = window.innerWidth < 760;
  const chart = cashChart(run, {
    width: chartWidth(),
    height: narrow ? 240 : 320,
    ghost: app.scenario === "stress" ? base : null,
    whatIf: app.whatIf?.run ?? null,
    selectedWeek: app.selectedWeek,
  });
  const lowWeek = run.lowPoint.week;
  return `
  <div class="page-head sub">
    <div><h2 class="section-title" style="font-size:18px">Next 13 weeks</h2></div>
    <div class="seg" role="group" aria-label="Scenario">
      <button data-action="scenario" data-s="base" aria-pressed="${app.scenario === "base"}">Expected</button>
      <button data-action="scenario" data-s="stress" aria-pressed="${app.scenario === "stress"}">If customers pay a week late</button>
    </div>
  </div>
  ${app.whatIf ? `<div class="together" style="margin:0 0 14px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center"><span>Showing what-if: <b>${esc(app.whatIf.label)}</b>. Low point ${money(app.whatIf.run.lowPoint.amount)} on ${shortDate(app.whatIf.run.lowPoint.date)}.</span><button class="btn small" data-action="clear-whatif">Clear what-if</button></div>` : ""}
  <section class="panel chart-panel">
    <div data-chart="main">${chart}</div>
    <div class="legend">
      <span><i></i>${app.scenario === "stress" ? "Customers a week late" : "Expected cash"}</span>
      ${app.scenario === "stress" ? `<span><i class="ghost"></i>Expected</span>` : `<span><i class="ghost"></i>With quoted ${esc(app.ctx.profile.vocabulary?.quote ?? "deal")}s (weighted by chance)</span>`}
      ${app.whatIf ? `<span><i class="whatif"></i>What-if</span>` : ""}
      <span><i class="safety"></i>Your line, ${money(run.safetyLine)}</span>
      <span><i class="dip"></i>Under your line</span>
    </div>
  </section>
  <table class="weeks">
    <thead><tr><th>Week</th><th>Money in</th><th>Money out</th><th class="hide-sm">Lowest day</th><th>End of week</th></tr></thead>
    <tbody>
      ${run.weeks.map((w) => `<tr class="row ${w.start === lowWeek ? "low" : ""}" data-action="week" data-week="${esc(w.start)}" tabindex="0">
        <td>${w.start === lowWeek ? '<span class="mark" aria-hidden="true"></span>' : ""}${weekLabel(w.start)}</td>
        <td class="in">${w.inflow ? money(w.inflow) : "—"}</td>
        <td>${w.outflow ? money(-w.outflow) : "—"}</td>
        <td class="hide-sm ${w.minClosing < 0 ? "below" : ""}">${money(w.minClosing)}</td>
        <td class="${w.closing < 0 ? "below" : ""}"><b>${money(w.closing)}</b></td>
      </tr>`).join("")}
    </tbody>
  </table>`;
}

// ---------------------------------------------------------------- Notes (parked thoughts)
const KIND_LABEL = { spend: "Spend", collection: "Collection", new_business: "New business", investment: "Investment", note: "Note" };

function viewNotes() {
  const list = app.notes.filter((n) => app.noteFilter === "all" || n.reading.kind === app.noteFilter);
  const counts = Object.fromEntries(Object.keys(KIND_LABEL).map((k) => [k, app.notes.filter((n) => n.reading.kind === k).length]));
  return `
  <div class="page-head"><div><h1>Notes</h1><p>Park a thought the moment you have it. Neri works out what it means for cash and waits for your OK.</p></div></div>
  <div class="notes">
    <div>
      <form class="capture" data-submit="park">
        <label class="sr" for="thought">New thought</label>
        <textarea id="thought" name="text" placeholder="A spend coming up, money someone promised, a deal that might land, an investment you're weighing…"></textarea>
        <div class="capture-row">
          ${canListen ? `<button type="button" class="mic" data-action="mic-note" aria-pressed="${app.stopListen ? "true" : "false"}" title="Say it">${icon.mic}<span class="sr">Say it</span></button>` : ""}
          <span class="grow" style="font-size:13px;color:var(--ink-faint)" id="capture-status">${canListen ? "Type or tap the mic." : ""}</span>
          <button class="btn primary" type="submit">Park it</button>
        </div>
      </form>
      <div class="kinds" role="group" aria-label="Filter notes">
        <button class="kind-filter" data-action="note-filter" data-k="all" aria-pressed="${app.noteFilter === "all"}">All ${app.notes.length}</button>
        ${Object.entries(KIND_LABEL).filter(([k]) => counts[k]).map(([k, l]) => `<button class="kind-filter" data-action="note-filter" data-k="${k}" aria-pressed="${app.noteFilter === k}">${l} ${counts[k]}</button>`).join("")}
      </div>
      ${list.length ? list.map(noteRow).join("") : `<p style="color:var(--ink-soft);padding:20px 0">No notes here yet.</p>`}
    </div>
    <aside class="side">
      <section class="panel">
        <h2>How Neri reads a note</h2>
        <p style="margin:0 0 10px;font-size:14px">It looks for money in or out, the amount, the date, who it's with, and how sure you sound.</p>
        <p style="margin:0 0 10px;font-size:14px">A spend or investment becomes a planned payment. Money a customer promised moves that invoice. A possible deal counts only on the dotted pipeline line, weighted by its chance.</p>
        <p style="margin:0;font-size:14px;color:var(--ink-soft)">Nothing reaches your forecast until you add it. Notes you keep stay here, searchable, for when they matter.</p>
      </section>
    </aside>
  </div>`;
}

function noteRow(n) {
  const r = n.reading;
  const meta = `<div class="meta"><span class="kind-chip ${esc(r.kind)}">${KIND_LABEL[r.kind]}</span><span>${n.via === "voice" ? "Said" : "Typed"} ${dayOf(n.createdAt)}, ${clock(n.createdAt)}</span>${n.state === "added" ? `<span class="settled-tag">Added to forecast</span>` : n.state === "kept" ? `<span class="settled-tag" style="color:var(--ink-faint)">Kept as a note</span>` : ""}</div>`;
  if (n.state !== "new") return `<article class="note settled"><blockquote>${esc(n.text)}</blockquote>${meta}</article>`;

  const party = r.partyId ? app.ctx.parties.find((p) => p.id === r.partyId)?.name : null;
  const dir = r.direction === "in" ? "Money in" : r.direction === "out" ? "Money out" : "—";
  const field = (k, label, v, input) => `<div><dt>${label}</dt><dd>${v != null ? v : input}</dd></div>`;
  const amountInput = `<input inputmode="decimal" placeholder="$ amount" data-note-field="amount" data-id="${esc(n.id)}" aria-label="Amount" />`;
  const dateInput = `<input type="date" data-note-field="date" data-id="${esc(n.id)}" aria-label="Date" />`;
  const reading = r.kind === "note"
    ? `<div class="reading"><h5>Neri's reading</h5><p class="impact" style="margin:0">No amount or date, so this stays a note. Neri will bring it up if it becomes relevant.</p>
        <div class="actions"><button class="btn small" data-action="note-decide" data-d="keep" data-id="${esc(n.id)}">Keep as a note</button><button class="btn small quiet" data-action="note-decide" data-d="remove" data-id="${esc(n.id)}">Remove</button></div></div>`
    : `<div class="reading"><h5>Neri's reading</h5>
        <dl>
          ${field("dir", "Direction", dir)}
          ${field("amount", "Amount", r.amount != null ? money(r.amount) : null, amountInput)}
          ${field("date", "When", r.date ? shortDate(r.date) : null, dateInput)}
          ${party ? field("party", "With", esc(party)) : ""}
          ${r.status === "possible" ? field("p", "Chance", `${Math.round((r.probability ?? 0.4) * 100)}%`) : field("p", "Certainty", r.invoiceId ? "Promised" : "Planned")}
        </dl>
        <p class="impact">${noteImpact(n)}</p>
        <div class="actions">
          <button class="btn small primary" data-action="note-decide" data-d="add" data-id="${esc(n.id)}" ${r.missing.length || n.effect?.outside ? "disabled" : ""}>Add to forecast</button>
          <button class="btn small" data-action="note-decide" data-d="keep" data-id="${esc(n.id)}">Keep as a note</button>
          <button class="btn small quiet" data-action="note-decide" data-d="remove" data-id="${esc(n.id)}">Remove</button>
        </div></div>`;
  return `<article class="note"><blockquote>${esc(n.text)}</blockquote>${meta}${reading}</article>`;
}

function noteImpact(n) {
  const r = n.reading;
  const e = n.effect;
  if (r.missing.length) return `Add the ${r.missing.join(" and ")} to see what it does to your cash.`;
  if (!e) return "";
  if (e.outside) return `That's after this 13-week view. Neri keeps it and brings it in when it's in range.`;
  if (e.pipeline != null) return `Possible income. It adds ${money(e.pipeline)} to the dotted pipeline line (${Math.round((r.probability ?? 0.4) * 100)}% of ${money(r.amount)}), never to the main forecast.`;
  if (r.invoiceId) {
    return e.lowPointDelta > 0
      ? `If that payment lands ${shortDate(r.date)}, your low point rises ${money(e.lowPointDelta)} to ${money(e.lowPoint.amount)}.`
      : `That doesn't change your low point (${money(e.lowPoint.amount)} on ${shortDate(e.lowPoint.date)}).`;
  }
  if (e.lowPointDelta < 0) return `Your low point drops ${money(-e.lowPointDelta)}, to ${money(e.lowPoint.amount)} on ${shortDate(e.lowPoint.date)}.`;
  if (e.lowPointDelta > 0) return `Your low point rises ${money(e.lowPointDelta)}, to ${money(e.lowPoint.amount)}.`;
  return `Your low point stays ${money(e.lowPoint.amount)} on ${shortDate(e.lowPoint.date)}. This lands after your tightest week.`;
}

// ---------------------------------------------------------------- Review
function viewReview() {
  const items = app.review;
  return `
  <div class="page-head"><div><h1>Review</h1><p>Messages and uploads that could change your forecast. Nothing changes until you apply it.</p></div></div>
  <div style="max-width:760px">
  ${items.length ? items.map(reviewCard).join("") : `<section class="panel"><p style="margin:0">Nothing to review. When an email, WhatsApp message or upload could move your cash, it waits here for your OK.</p></section>`}
  </div>`;
}

function reviewCard(rv) {
  const s = rv.signal;
  const m = rv.message;
  const body = m ? esc(m.body).replace(esc(m.excerpt), `<mark>${esc(m.excerpt)}</mark>`) : "";
  return `
  <article class="review-card">
    <header><span class="ico">${s.channel === "whatsapp" ? icon.chat : icon.mail}</span><div><b>${esc(rv.party?.name ?? "Unknown sender")} about ${esc(rv.commitment.sourceRef.record)}</b><span>${esc(sourceName(s.channel))}${m?.from ? ` from ${esc(m.from)}` : ""}, ${dayOf(s.receivedAt)} at ${clock(s.receivedAt)}</span></div></header>
    ${m ? `<div class="message">${body}</div>` : ""}
    <div class="change">
      <div><small>${esc(rv.commitment.sourceRef.record)}, ${money(rv.commitment.amount, { currency: rv.commitment.currency })}, expected</small><b>${shortDate(rv.from)}</b><span class="arrow">→</span><b>${shortDate(rv.to)}</b></div>
      <div><small>Your low point</small><b class="${rv.before.amount < 0 ? "below" : ""}">${money(rv.before.amount)}</b><span class="arrow">→</span><b class="${rv.after.amount < 0 ? "below" : ""}">${money(rv.after.amount)}</b></div>
    </div>
    <footer>
      <button class="btn primary" data-action="signal" data-d="apply" data-id="${esc(s.id)}">Apply change</button>
      <button class="btn" data-action="signal" data-d="dismiss" data-id="${esc(s.id)}">Dismiss</button>
      <button class="btn quiet small" data-action="record" data-id="${esc(rv.commitment.id)}">See invoice</button>
      <span class="conf">Neri is ${Math.round(s.confidence * 100)}% sure of this reading</span>
    </footer>
  </article>`;
}

// ---------------------------------------------------------------- Sources
const LOGO_COLORS = ["#4a5fd9", "#2f7d5b", "#b25a1f", "#7a4fd0", "#1f7a99", "#a8366e", "#5a6b2a", "#3d4a6b"];
function logoTile(c) {
  let h = 0;
  for (const ch of c.id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const words = c.name.replace(/[^A-Za-z ]/g, " ").split(" ").filter((w) => w && !/^(and|the|of)$/i.test(w));
  const initials = (c.mark ?? (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2))).toUpperCase();
  return `<span class="logo" style="background:${LOGO_COLORS[Math.abs(h) % LOGO_COLORS.length]}" aria-hidden="true">${initials}</span>`;
}

function viewSources() {
  const connected = new Map(app.ctx.business.sources.map((s) => [s.id, s]));
  const live = CONNECTORS.filter((c) => c.availability === "live").length;
  return `
  <div class="page-head"><div><h1>Sources</h1><p>Connect the systems your business already runs on. Neri only reads. It never writes back, sends or pays.</p></div></div>
  <div class="upload-band">
    <p><b>No connector? Use a file.</b> Upload a CSV, Excel or PDF export, or paste an email or WhatsApp message. Every source works this way, today.</p>
    <label class="btn">${icon.upload}Upload a file<input type="file" accept=".csv,.xlsx,.xls,.pdf,.eml,.txt" data-change="upload" hidden /></label>
    <a class="btn quiet" href="#/review">Paste a message</a>
  </div>
  ${CATEGORIES.map((cat) => {
    const list = CONNECTORS.filter((c) => c.category === cat.id);
    return `<section class="cat"><h2>${cat.label}</h2><p>${cat.why}</p><div class="conn-grid">
      ${list.map((c) => {
        const on = connected.get(c.id);
        return `<div class="conn">${logoTile(c)}<b>${esc(c.name)}</b>
          <div class="state ${on ? "on" : ""}">${on ? `<i class="dot"></i>Connected` : `<button class="btn" data-action="connect" data-id="${esc(c.id)}">${c.availability === "live" ? "Connect" : app.interest.has(c.id) ? "Requested" : c.availability === "next" ? "Coming next" : "Request"}</button>`}</div>
          <p class="reads">${on ? esc(on.detail) : esc(c.reads)}</p></div>`;
      }).join("")}
    </div></section>`;
  }).join("")}
  <p class="fineprint" style="margin-top:28px">${live} sources are ready now, ${CONNECTORS.length - live} more are on the way. Each one is read-only and can be turned off at any time.</p>`;
}

// ---------------------------------------------------------------- Ask
// Source chips: readable labels ("INV-1187", "Payroll Dec 24"), at most four, then a count.
// A cite may be an event id ("evt-inv-INV-1187-0", "evt-rec-payroll-3", "evt-daily-sales-2027-01-15"): label what it points at.
function citeLabel(cid) {
  const d = cid.match(/(\d{4}-\d{2}-\d{2})$/);
  const base = cid.startsWith("evt-") ? (d ? cid.slice(4, -11) : cid.slice(4).replace(/-\d+$/, "")) : cid;
  const ref = refLabel(base);
  if (ref !== "Source") return ref;
  const name = app.ctx.profile?.recurring?.find((r) => r.id === base)?.name
    ?? (base === "daily-sales" ? "Daily sales" : null)
    ?? app.ctx.parties.find((p) => p.id === app.ctx.partyOf?.(base))?.name ?? "Record";
  return d ? `${name} ${shortDate(d[1])}` : name;
}
function citeChips(cites) {
  if (!cites?.length) return "";
  const uniq = [...new Set(cites)];
  const shown = uniq.slice(0, 4);
  return `<div class="cites">${shown.map((c) => `<button class="src" data-action="record" data-id="${esc(c)}">${esc(citeLabel(c))}</button>`).join("")}${uniq.length > 4 ? `<span class="by">+${uniq.length - 4} more</span>` : ""}</div>`;
}

function turnHtml(t, idx) {
  if (t.pending) return `<div class="turn"><div class="q">${esc(t.q)}</div><div class="a missing">${t.parking ? "Parking it…" : "Thinking…"}</div></div>`;
  if (t.note) {
    const n = app.notes.find((x) => x.id === t.note);
    if (!n) return `<div class="turn"><div class="q">${esc(t.q)}</div><div class="a missing">Removed.</div></div>`;
    return `<div class="turn"><div class="q">${esc(t.q)}</div><div class="a">${n.state === "new" ? "Parked in your notes. Here's how I read it." : n.state === "added" ? "Added to your forecast." : "Kept as a note."}</div>${n.state === "new" ? noteRow(n).replace('<article class="note">', '<article class="note inline">') : ""}</div>`;
  }
  const a = t.a;
  return `<div class="turn">
    <div class="q">${esc(t.q)}</div>
    <div class="a ${a.missingData ? "missing" : ""}">${esc(a.text)}</div>
    ${citeChips(a.citations)}
    ${a.scenario ? `<div class="scenario"><header><span>What-if: ${esc(a.scenario.label)}</span><span style="display:flex;gap:6px"><button class="btn small" data-action="show-whatif" data-i="${idx}">Show in details</button>${a.proposal && !t.added ? `<button class="btn small primary" data-action="add-plan" data-i="${idx}">Add to forecast</button>` : t.added ? `<span class="settled-tag">Added</span>` : ""}</span></header>
      <div data-chart="ask-${idx}">${cashChart(app.brief.run, { width: Math.min(620, chartWidth()), height: 130, mini: true, whatIf: a.scenario.run })}</div></div>` : ""}
  </div>`;
}

// ---------------------------------------------------------------- Settings
function viewSettings() {
  const theme = document.documentElement.dataset.theme || "auto";
  return `
  <div class="page-head"><div><h1>Settings</h1><p>${esc(app.ctx.business.name)}, set up as ${esc(app.ctx.profile.displayName.toLowerCase())}.</p></div></div>
  <div class="settings">
    <div class="setting"><h3>Your line</h3><p>The least cash you want to keep. Neri warns you before you go under it.</p>
      <form class="control" data-submit="safety" style="display:flex;gap:8px"><label class="money-input"><span>$</span><input name="amt" inputmode="numeric" value="${Math.round(app.brief.run.safetyLine / 100)}" aria-label="Your line in dollars" /></label><button class="btn small" type="submit">Save</button></form></div>
    <div class="setting"><h3>Account</h3><p>${app.account?.sample ? "You're looking at a sample business." : `${esc(app.account?.email ?? "")}${app.account?.businessName ? `, ${esc(app.account.businessName)}` : ""}`}</p>
      <div class="control" style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">${app.account?.sample ? `<button class="btn small primary" data-action="signout">Create your account</button>` : `<button class="btn small" data-action="signout">Sign out</button>`}</div></div>
    <h2 class="section-title" style="margin-top:28px">Security</h2>
    <p class="section-note">How your business's data is protected.</p>
    <div class="setting"><h3>Sign-in</h3><p>${authLive ? "One-time codes to your business email. No passwords are stored." : "Preview sign-up. On a Neri server, sign-in uses one-time codes to your business email."}</p>
      ${authLive && !app.account?.sample ? `<button class="btn small control" data-action="signout-all">Sign out everywhere</button>` : ""}</div>
    <div class="setting"><h3>Who can see your numbers</h3><p>Only members of ${esc(app.account?.businessName || "your business")}. You're the owner from sign-up; inviting teammates is coming.</p></div>
    <div class="setting"><h3>Your connected apps</h3><p>Read-only. Neri never writes back, sends or pays.</p></div>
    <div class="setting"><h3>Screen lock</h3><p>${LOCK_MS ? `Numbers hide after ${Math.round(LOCK_MS / 60000)} minutes away.` : "Off."}</p></div>
    <div class="setting"><h3>Sample data</h3><p>Switch between the fictional businesses this preview runs on.</p>
      <select class="biz control" data-change="biz" aria-label="Sample business">${SANDBOXES.map((x) => `<option value="${x.id}" ${x.id === app.bizId ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</select></div>
    <div class="setting"><h3>Hide names</h3><p>Show customers and suppliers as Customer A, Supplier B. For demos and screen sharing.</p>
      <button class="switch control" role="switch" aria-checked="${app.mask}" data-action="mask" aria-label="Hide names"></button></div>
    <div class="setting"><h3>Appearance</h3><p>Light, dark, or follow your device.</p>
      <div class="seg control" role="group" aria-label="Appearance">${["auto", "light", "dark"].map((t) => `<button data-action="theme" data-t="${t}" aria-pressed="${theme === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div></div>
    <h2 class="section-title" style="margin-top:32px">Rules from your notes</h2>
    <p class="section-note">Things you told Neri about how people pay and get paid. They shape every forecast.</p>
    ${app.ctx.rules.filter((r) => r.state !== "dismissed").length ? app.ctx.rules.filter((r) => r.state !== "dismissed").map((r) => `<div class="rule-item"><q>${esc(r.fromNote)}</q><div>${esc(app.ctx.parties.find((p) => p.id === r.scope.partyId)?.name ?? "Everyone")}: ${r.kind === "flexibility" ? `can move payments up to ${r.params.extraDays} days` : r.kind === "lag_offset" ? `pays about ${r.params.offsetDays} days late` : esc(r.kind)}${r.state === "confirmed" ? "" : " (waiting for your OK)"}</div></div>`).join("") : `<p>No rules yet.</p>`}
  </div>`;
}

// ---------------------------------------------------------------- Sign up (business email + code)
function viewWelcome() {
  const su = app.signup;
  const err = su.error ? `<p class="form-error" role="alert">${esc(su.error)}</p>` : "";
  if (su.step === "code") {
    return `
    <div class="portal-wrap">
      <div class="portal-mark">${logoLarge}</div>
      <h1 class="portal-title">Check your email</h1>
      <p class="portal-sub">We sent a 6-digit code to <b>${esc(su.email)}</b>.</p>
      <form class="portal-form" data-submit="verify" novalidate>
        <label for="code">Code</label>
        <input id="code" name="code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" required />
        <label for="bizname">Business name</label>
        <input id="bizname" name="biz" value="${esc(su.name)}" placeholder="Your business" autocomplete="organization" required />
        ${err}
        <button class="btn primary big" type="submit">Create account</button>
      </form>
      <p class="portal-fine">${authLive ? "The code works once and expires soon." : "Preview: any 6 digits work."}</p>
      <p class="portal-fine"><button class="linklike" data-action="resend" ${resendWait() ? "disabled" : ""}>${resendWait() ? `Send a new code in ${resendWait()}s` : "Send a new code"}</button> <span aria-hidden="true">&nbsp;</span> <button class="linklike" data-action="signup-back">Use a different email</button></p>
    </div>`;
  }
  return `
  <div class="portal-wrap">
    <div class="portal-mark">${logoLarge}</div>
    <h1 class="portal-title">Your CFO, in your pocket.</h1>
    <p class="portal-sub">Neri reads your books, bank and messages, and every morning tells you where cash is headed and what to do about it.</p>
    <form class="portal-form" data-submit="signup" novalidate>
      <label for="email">Work email</label>
      <input id="email" name="email" type="email" autocomplete="email" placeholder="you@yourbusiness.com" value="${esc(su.email)}" required />
      ${err}
      <button class="btn primary big" type="submit">Continue</button>
    </form>
    <p class="portal-fine">No password to remember or leak: we email you a one-time code.</p>
    <p class="portal-fine"><button class="linklike" data-action="sample">Look around with a sample business first</button></p>
  </div>`;
}

function resendWait() {
  const left = Math.ceil(((app.signup.sentAt ?? 0) + 60000 - Date.now()) / 1000);
  return left > 0 ? left : 0;
}
let resendTimer;
function tickResend() {
  clearInterval(resendTimer);
  resendTimer = setInterval(() => {
    if (route() !== "welcome" || app.signup.step !== "code") return clearInterval(resendTimer);
    const b = document.querySelector('[data-action="resend"]');
    if (!b) return;
    const w = resendWait();
    b.disabled = w > 0;
    b.textContent = w ? `Send a new code in ${w}s` : "Send a new code";
    if (!w) clearInterval(resendTimer);
  }, 1000);
}

// ---------------------------------------------------------------- idle lock
// After NERI_LOCK_MINUTES with no activity (or that long in the background), the numbers are hidden.
// With real sign-in, unlocking checks the session is still valid; an ended session goes back to sign-in.
const LOCK_MS = (Number(window.NERI_LOCK_MINUTES ?? 15) || 0) * 60000;
let lastActive = Date.now();
let hiddenAt = 0;
function lockIfIdle() {
  if (!LOCK_MS || !app.account || app.account.sample || document.querySelector(".lock")) return;
  if (Date.now() - lastActive >= LOCK_MS) lockScreen();
}
function lockScreen() {
  app.stopSpeak?.();
  app.stopSpeak = null;
  const el = document.createElement("div");
  el.className = "lock";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Neri is locked");
  el.innerHTML = `<div class="lock-card">${logoLarge}<h2>Locked</h2><p>Your numbers are hidden after ${Math.round(LOCK_MS / 60000)} minutes away.</p><button class="btn primary big" data-action="unlock">Unlock</button></div>`;
  document.body.append(el);
  document.body.classList.add("locked");
}
async function unlock() {
  let session = true;
  if (authLive) session = await currentSession().catch(() => null);
  if (!session) {
    document.querySelector(".lock")?.remove();
    document.body.classList.remove("locked");
    await api.signOut();
    app.signup = { step: "email", email: app.account?.email ?? "", name: "", error: "Your session ended. Sign in again with a new code." };
    location.hash = "#/welcome";
    return load();
  }
  document.querySelector(".lock")?.remove();
  document.body.classList.remove("locked");
  lastActive = Date.now();
}
for (const ev of ["pointerdown", "keydown", "scroll", "touchstart"]) addEventListener(ev, () => (lastActive = Date.now()), { passive: true });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && LOCK_MS && Date.now() - hiddenAt >= LOCK_MS) {
    lastActive = 0;
    lockIfIdle();
  }
});
setInterval(lockIfIdle, 30000);

// ---------------------------------------------------------------- Set up (one page)
const KINDS = [
  { id: "trading", label: "Trading and import" },
  { id: "restaurant", label: "Restaurant and retail" },
  { id: "services", label: "Services" },
  { id: "other", label: "Something else" },
];
const SUGGESTED = {
  trading: ["zoho_books", "quickbooks", "bank_feed", "zoho_crm", "m365", "whatsapp"],
  restaurant: ["quickbooks", "bank_feed", "square", "toast", "gusto", "google"],
  services: ["quickbooks", "xero", "bank_feed", "hubspot", "gusto", "google"],
  other: ["quickbooks", "bank_feed", "google"],
};
function viewSetup() {
  const st = app.setup;
  const name = app.signup.name || "your business";
  const suggested = SUGGESTED[st.kind].map((id) => CONNECTORS.find((c) => c.id === id)).filter(Boolean);
  const more = CATEGORIES.flatMap((cat) => CONNECTORS.filter((c) => c.category === cat.id && !SUGGESTED[st.kind].includes(c.id)));
  let tz = "";
  try {
    tz = new Intl.DateTimeFormat("en-US", { timeZoneName: "longGeneric" }).formatToParts(new Date()).find((x) => x.type === "timeZoneName")?.value ?? "";
  } catch {}
  const n = st.picked.size;
  const viaFile = [...st.picked].filter((id) => CONNECTORS.find((c) => c.id === id)?.availability !== "live").length;
  const tile = (c) => {
    const on = st.picked.has(c.id);
    const state = st.connecting && on ? (c.availability === "live" ? "ok" : "waiting") : "";
    return `<button class="app-tile ${on ? "on" : ""}" data-action="pick" data-id="${esc(c.id)}" aria-pressed="${on}" title="${esc(c.reads)}">
      ${logoTile(c)}<span class="app-name">${esc(c.name)}</span>
      <span class="tick" aria-hidden="true">${state ? `<i class="d ${state === "ok" ? "" : "amber"}"></i>` : icon.check}</span>
    </button>`;
  };
  return `
  <div class="setup">
    <h1 class="portal-title">Set up ${esc(name)}</h1>
    <p class="portal-sub">Tick the apps you use, then connect them all at once. Neri only reads.</p>
    <div class="kind-row" role="radiogroup" aria-label="Type of business">
      ${KINDS.map((k) => `<button class="kind-pill" role="radio" aria-checked="${st.kind === k.id}" data-action="kind" data-k="${k.id}">${k.label}</button>`).join("")}
    </div>
    <section class="rail" aria-label="Suggested apps">
      <h2>Suggested for ${esc(KINDS.find((k) => k.id === st.kind).label.toLowerCase())}</h2>
      <div class="rail-track">${suggested.map(tile).join("")}</div>
    </section>
    <section class="rail" aria-label="More apps">
      <h2>More apps</h2>
      <div class="rail-track">${more.map(tile).join("")}</div>
    </section>
    <div class="reserve-row">
      <label for="reserve">Keep at least</label>
      <span class="money-input"><span>$</span><input id="reserve" inputmode="numeric" placeholder="35,000" value="${esc(st.reserve)}" data-change="reserve" /></span>
      <span class="reserve-note">in the bank. Neri warns you before you go under it.${tz ? ` Times in ${esc(tz)}.` : ""}</span>
    </div>
    <div class="connect-bar">
      <span class="bar-note" id="bar-note">${viaFile ? `${viaFile} of these connect by file upload until their connector is ready.` : `<label class="linklike">${icon.upload}No app? Upload a file<input type="file" accept=".csv,.xlsx,.xls,.pdf" data-change="upload" hidden /></label>`}</span>
      <button class="btn primary big" data-action="connect-all" ${st.connecting ? "disabled" : ""}>${st.connecting ? "Connecting…" : n ? `Connect ${n} ${n === 1 ? "app" : "apps"}` : "Skip for now"}</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- sheets
function openSheet(html, { mask = true } = {}) {
  closeSheet();
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.dataset.action = "close-sheet";
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.innerHTML = mask ? masked(html) : html;
  document.body.append(scrim, sheet);
  sheet.querySelector("button, input, textarea")?.focus();
}
function closeSheet() {
  document.querySelectorAll(".scrim, .sheet").forEach((n) => n.remove());
}
const sheetHead = (title, sub) => `<div class="sheet-head"><div style="flex:1"><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ""}</div><button class="icon-btn" data-action="close-sheet" aria-label="Close">${icon.close}</button></div>`;

async function showRecord(id) {
  const rec = await api.record(id);
  if (!rec) {
    openSheet(sheetHead("Not found", "That record isn't in this business."));
    return;
  }
  const c = rec.commitment;
  const p = rec.party;
  const lag = p?.lagStats;
  const statusWord = { actual: "In the bank", committed: "Committed", likely: "Likely", possible: "Possible" };
  openSheet(`
    ${sheetHead(esc(c.sourceRef.record), `${esc(p?.name ?? "Your plan")}${c.type ? `, ${esc(c.type.replace("_", " "))}` : ""}`)}
    <dl class="kv">
      <dt>Amount</dt><dd>${money(c.amount, { currency: c.currency })}${c.currency !== (app.ctx.profile.baseCurrency ?? "USD") && rec.events[0] ? ` <span style="color:var(--ink-faint)">(${money(rec.events.reduce((t, e) => t + e.amountBase, 0))})</span>` : ""}</dd>
      ${c.anchors.due ? `<dt>Due</dt><dd>${dayDate(c.anchors.due)}</dd>` : ""}
      ${c.anchors.order ? `<dt>Order date</dt><dd>${dayDate(c.anchors.order)}</dd>` : ""}
      <dt>Status</dt><dd>${esc(statusWord[c.status] ?? c.status)}${c.probability ? `, ${Math.round(c.probability * 100)}% chance` : ""}</dd>
      ${lag ? `<dt>How they pay</dt><dd>${Math.abs(lag.medianDaysLate)} days ${lag.medianDaysLate >= 0 ? "late" : "early"}, last ${lag.n} payments</dd>` : ""}
      ${c.discount ? `<dt>Discount</dt><dd>${c.discount.pct}% if paid by ${shortDate(c.discount.byDate)}</dd>` : ""}
      <dt>Source</dt><dd>${/^https?:\/\//.test(c.sourceRef.url ?? "") ? `<a href="${esc(c.sourceRef.url)}" target="_blank" rel="noopener">${esc(sourceName(c.sourceRef.system))}: ${esc(c.sourceRef.record)}</a>` : `${esc(sourceName(c.sourceRef.system))}: ${esc(c.sourceRef.record)}`}</dd>
    </dl>
    <h3 class="section-title">In the forecast</h3>
    ${rec.events.map((e) => `<div class="event"><b>${dayDate(e.date)}<span class="status">${esc(statusWord[e.status] ?? e.status)}</span></b><span class="amt ${e.direction === "in" ? "in" : "out"}">${e.direction === "in" ? "+" : "−"}${money(e.amountBase)}</span><p>${esc(e.basis)}</p></div>`).join("") || `<p style="color:var(--ink-soft)">Outside the 13-week view.</p>`}
    ${rec.message ? `<h3 class="section-title" style="margin-top:18px">The message behind the date</h3><div class="message">${esc(rec.message.body).replace(esc(rec.message.excerpt), `<mark>${esc(rec.message.excerpt)}</mark>`)}</div>` : ""}
    ${rec.rules.length ? `<h3 class="section-title" style="margin-top:18px">Your notes about ${esc(p?.name ?? "")}</h3>${rec.rules.map((r) => `<div class="rule-item"><q>${esc(r.fromNote)}</q></div>`).join("")}` : ""}
    <p class="fineprint">A payment link or a promise is never treated as paid. Only the bank confirms that.</p>`);
}

function sourceName(sys) {
  return { zoho_books: "Zoho Books", bank_csv: "Bank statement", email: "Email", whatsapp: "WhatsApp", crm: "Zoho CRM", owner: "Your note", generic_file: "Uploaded file", profile: "Your setup" }[sys] ?? sys;
}

function showWeek(start) {
  const run = app.scenario === "stress" && app.stressRun ? app.stressRun : app.brief.run;
  const w = run.weeks.find((x) => x.start === start);
  if (!w) return;
  app.selectedWeek = start;
  const evs = run.events.filter((e) => e.date >= start && e.date <= addDays(start, 6) && e.status !== "possible");
  openSheet(`
    ${sheetHead(`Week of ${weekLabel(start)}`, `Ends at ${money(w.closing)}. Lowest day ${money(w.minClosing)}.`)}
    ${evs.length ? evs.map((e) => `<div class="event"><b>${esc(partyNameFor(e))}<span class="status">${dayDate(e.date)}</span></b><span class="amt ${e.direction === "in" ? "in" : "out"}">${e.direction === "in" ? "+" : "−"}${money(e.amountBase)}</span><p>${esc(e.basis)}</p><button class="src" data-action="record" data-id="${esc(e.id)}">${esc(e.sourceRef.record)}</button></div>`).join("") : `<p>No money moves this week.</p>`}`);
}
function partyNameFor(e) {
  const pid = commitmentParty(e.commitmentId);
  return app.ctx.parties.find((p) => p.id === pid)?.name ?? (e.sourceRef.system === "owner" ? "Your plan" : e.sourceRef.record);
}

async function showDraft(itemId) {
  const d = await api.draft(itemId);
  openSheet(`
    ${sheetHead("Draft email", "Edit it, then copy it or open it in your mail app.")}
    <div class="draft-field"><label for="d-to">To</label><input id="d-to" value="${esc(d.to)}" /></div>
    <div class="draft-field"><label for="d-sub">Subject</label><input id="d-sub" value="${esc(d.subject)}" /></div>
    <div class="draft-field"><label for="d-body">Message</label><textarea id="d-body">${esc(d.body)}</textarea></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn primary" data-action="copy-draft">${icon.copy}Copy</button>
      <button class="btn" data-action="mail-draft">${icon.mail}Open in mail app</button>
      <button class="btn quiet" data-action="done" data-id="${esc(itemId)}" data-close="1">Mark as done</button>
    </div>
    <p class="fineprint">Neri never sends anything for you. You send it, from your own mail.</p>`, { mask: false });
}

function showConnect(id) {
  const c = CONNECTORS.find((x) => x.id === id);
  const cat = CATEGORIES.find((x) => x.id === c.category);
  const isLive = c.availability === "live";
  openSheet(`
    ${sheetHead(`${esc(c.name)}`, esc(cat.label))}
    <dl class="kv"><dt>Neri reads</dt><dd>${esc(c.reads)}</dd><dt>Access</dt><dd>Read-only. Turn it off any time.</dd><dt>Status</dt><dd>${AVAILABILITY_LABEL[c.availability]}</dd></dl>
    ${isLive
      ? `<p>You'll sign in with ${esc(c.name)} and pick which company to share. The first import takes a couple of minutes, then Neri keeps it fresh.</p>
         <button class="btn primary" data-action="connect-go" data-id="${esc(c.id)}">Connect ${esc(c.name)}</button>
         <p class="fineprint">${api.mode === "preview" ? "This preview uses a fictional business, so sign-in opens on your Neri server, not here." : ""}</p>`
      : `<p>${c.availability === "next" ? "This connector is being built next." : "This connector is on the list."} You don't have to wait: export from ${esc(c.name)} and upload the file. Neri reads it the same way.</p>
         <div style="display:flex;gap:8px;flex-wrap:wrap"><label class="btn primary">${icon.upload}Upload an export<input type="file" accept=".csv,.xlsx,.xls,.pdf" data-change="upload" hidden /></label>
         <button class="btn" data-action="interest" data-id="${esc(c.id)}">${app.interest.has(c.id) ? "We'll tell you" : "Tell me when it's ready"}</button></div>`}`);
}

// ---------------------------------------------------------------- toast
let toastTimer;
function toast(title, detail, actionLabel, onAction) {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast";
  t.setAttribute("role", "status");
  t.innerHTML = masked(`<span class="sunmark"></span><div><b>${esc(title)}</b>${detail ? `<span>${esc(detail)}</span>` : ""}</div>${actionLabel ? `<button>${esc(actionLabel)}</button>` : ""}`);
  if (actionLabel) t.querySelector("button").onclick = () => { onAction?.(); t.remove(); };
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 7000);
}

// ---------------------------------------------------------------- listen (play brief) + drive mode
function toggleListen() {
  if (app.stopSpeak) {
    app.stopSpeak();
    app.stopSpeak = null;
    app.speakingIndex = -1;
    render();
    return;
  }
  const parts = spokenBrief();
  app.stopSpeak = speak(parts, {
    onPart: (i) => {
      app.speakingIndex = i;
      if (app.drive) renderDrive();
    },
    onEnd: () => {
      app.stopSpeak = null;
      app.speakingIndex = -1;
      render();
    },
  });
  render();
}

let wakeLock = null;
async function openDrive() {
  app.drive = true;
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {}
  renderDrive();
  if (!app.stopSpeak) toggleListen();
}
function closeDrive() {
  app.drive = false;
  app.stopSpeak?.();
  app.stopSpeak = null;
  app.stopListen?.();
  app.stopListen = null;
  wakeLock?.release?.();
  document.querySelector(".drive")?.remove();
  render();
}

function renderDrive() {
  let el = document.querySelector(".drive");
  if (!el) {
    el = document.createElement("div");
    el.className = "drive";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Drive mode");
    document.body.append(el);
  }
  const s = summary();
  const open = app.brief.three.filter((i) => i.state !== "done");
  // parts: [0]=headline, [1]=count, [2..]=items
  const itemSpeaking = (n) => app.speakingIndex === n + 2;
  el.innerHTML = masked(`
    <div class="drive-top"><span class="drive-brand">${logo}${dayDate(app.ctx.business.asOf)}</span><button data-action="drive-close">Done</button></div>
    <div class="drive-body">
      <p class="drive-line">${esc(s.headline)}</p>
      <ol class="drive-list">${open.map((i, n) => `<li class="${itemSpeaking(n) ? "speaking" : ""}"><span>${n + 1}</span>${esc(i.title.replace(/\s*\([A-Z]+-[\w-]+\)/, ""))}</li>`).join("")}</ol>
    </div>
    <div class="drive-controls">
      <button class="drive-btn main" data-action="listen" aria-label="${app.stopSpeak ? "Stop" : "Play brief"}">${app.stopSpeak ? icon.stop : icon.play}</button>
      ${canListen ? `<button class="drive-btn rec" data-action="mic-drive" aria-pressed="${app.stopListen ? "true" : "false"}" aria-label="Park a thought">${icon.mic}</button>` : ""}
    </div>
    <div class="drive-caption" id="drive-caption">${canListen ? (app.stopListen ? "Listening…" : "Tap the mic to park a thought. Neri will ask you to confirm when you're parked.") : ""}</div>`);
}

// ---------------------------------------------------------------- Talk to Neri (the big mic)
function openTalk() {
  app.stopSpeak?.();
  app.stopSpeak = null;
  let el = document.querySelector(".voice");
  if (!el) {
    el = document.createElement("div");
    el.className = "voice";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Talk to Neri");
    document.body.append(el);
  }
  const paint = (heard, status) => {
    el.innerHTML = `
      <div class="voice-card">
        <div class="orb ${app.stopListen ? "live" : ""}" aria-hidden="true">${icon.mic}</div>
        <p class="voice-heard" aria-live="polite">${heard ? esc(heard) : "Ask about cash, or tell me what's on your mind."}</p>
        <p class="voice-status">${esc(status)}</p>
        ${canListen ? "" : `<form class="askbar" data-submit="talk-typed"><input name="q" placeholder="Type it instead" aria-label="Type your question" /><button class="send" type="submit">${icon.send}<span class="sr">Ask</span></button></form>`}
        <div class="voice-actions">${app.stopListen ? `<button class="btn primary" data-action="talk-stop">I'm done</button>` : ""}<button class="btn" data-action="talk-close">Close</button></div>
      </div>`;
  };
  if (!canListen) {
    paint("", "Voice needs Chrome or Safari, with microphone access allowed.");
    el.querySelector("input")?.focus();
    return;
  }
  app.stopListen = listen({
    onText: (t) => paint(t, "Listening…"),
    onError: (msg) => {
      app.stopListen = null;
      paint("", msg);
    },
    onEnd: async (text) => {
      app.stopListen = null;
      if (!text) return paint("", "Didn't catch that. Tap the mic and try again.");
      closeTalk();
      await doAsk(text, "voice");
    },
  });
  paint("", "Listening…");
}
function closeTalk() {
  app.stopListen?.();
  app.stopListen = null;
  document.querySelector(".voice")?.remove();
}

// ---------------------------------------------------------------- voice capture
function startCapture(target) {
  if (app.stopListen) {
    app.stopListen();
    return;
  }
  app.stopSpeak?.();
  app.stopSpeak = null;
  const caption = () => (target === "drive" ? $("#drive-caption") : target === "note" ? $("#capture-status") : null);
  app.stopListen = listen({
    onText: (text) => {
      if (target === "note") $("#thought").value = text;
      if (target === "ask") $("#askq").value = text;
      if (caption()) caption().textContent = text;
    },
    onError: (msg) => {
      if (caption()) caption().textContent = msg;
      else toast(msg);
    },
    onEnd: async (text) => {
      app.stopListen = null;
      if (target === "drive") {
        if (text) {
          try {
            const n = await api.parkNote(text, "voice");
            app.notes = await api.notes();
            speak([`Parked. ${readingSentence(n)} I'll ask you to confirm when you're parked.`]);
          } catch (err) {
            speak([`I couldn't park that. ${speakable(err.message)}`]);
            failed(err);
          }
        }
        renderDrive();
      } else if (target === "ask") {
        if (text) await doAsk(text, "voice");
        else render();
      } else {
        const btn = document.querySelector('[data-action="mic-note"]');
        btn?.setAttribute("aria-pressed", "false");
        if (caption()) caption().textContent = text ? "Got it. Check it and park it." : "Didn't catch that. Try again.";
      }
    },
  });
  if (target === "drive") renderDrive();
  else {
    document.querySelectorAll(`[data-action="mic-${target}"]`).forEach((b) => b.setAttribute("aria-pressed", "true"));
    if (caption()) caption().textContent = "Listening…";
  }
}

function readingSentence(n) {
  const r = n.reading;
  if (r.kind === "note") return "I'll keep it as a note.";
  const parts = [KIND_LABEL[r.kind]];
  if (r.amount != null) parts.push(spokenMoney(r.amount));
  if (r.date) parts.push(`around ${speakable(shortDate(r.date))}`);
  return `${parts.join(", ")}.`;
}

// ---------------------------------------------------------------- actions
// One bar for everything: questions get answers; anything else is a thought to park.
const QUESTION = /\?\s*$|^(what|when|where|who|whom|why|how|can|could|will|would|should|shall|is|are|was|do|does|did|am|show|tell|give|list|explain)\b/i;

async function doAsk(q, via = "typed") {
  q = q.trim();
  if (!q) return;
  if (route() !== "today") location.hash = "#/today";
  const parking = !QUESTION.test(q);
  const turn = { q, pending: true, parking };
  app.askLog.push(turn);
  render();
  scrollToDock();
  try {
    if (parking) {
      const n = await api.parkNote(q, via);
      turn.note = n.id;
      // The note is saved; a failed list reload shouldn't make the owner park it twice.
      app.notes = await api.notes().catch(() => app.notes);
      if (via === "voice") speak([`Got it. ${readingSentence(n)} It's in your notes, and nothing changes until you add it.`]);
    } else {
      turn.a = await api.ask(q);
      if (via === "voice") speak([speakable(turn.a.text)]);
    }
  } catch (err) {
    // Drop the half-finished turn so it doesn't spin forever, then say why.
    app.askLog.splice(app.askLog.indexOf(turn), 1);
    render();
    return failed(err);
  }
  turn.pending = false;
  render();
  scrollToDock();
}

function scrollToDock() {
  requestAnimationFrame(() => document.querySelector(".dock")?.scrollIntoView({ block: "end", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
}

// A failed action tells the owner why, in the API's own words, instead of silently doing nothing.
// A work item that's gone (404) or a stale Review (409) means the list moved on: reload it.
async function failed(err) {
  console.error(err);
  const stale = err?.status === 409 || (err?.status === 404 && /^\/work-items\//.test(err.path ?? ""));
  toast("Couldn't do that", err?.message || "Something went wrong. Try again.");
  if (stale && app.ctx) {
    closeSheet();
    await refresh().catch((e) => console.error(e));
  }
}

document.addEventListener("click", (ev) => onClick(ev).catch(failed));
async function onClick(ev) {
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action;
  const id = el.dataset.id;
  if (a === "close-sheet") {
    closeSheet();
    if (app.selectedWeek) {
      app.selectedWeek = null;
      if (route() === "details") render();
    }
    return;
  }
  if (a === "talk") return openTalk();
  if (a === "deck") return moveDeck(Number(el.dataset.dir));
  if (a === "unlock") return unlock();
  if (a === "resend") {
    try {
      await api.startSignup(app.signup.email);
      app.signup.sentAt = Date.now();
      app.signup.error = "";
      toast("New code sent", `Check ${app.signup.email}.`);
    } catch (e) {
      app.signup.error = e.message;
    }
    render();
    tickResend();
    return;
  }
  if (a === "signout-all") {
    await api.signOut({ everywhere: true });
    app.signup = { step: "email", email: "", name: "", error: "" };
    app.askLog = [];
    location.hash = "#/welcome";
    await load();
    toast("Signed out everywhere", "Other devices are signed out within the hour.");
    return;
  }
  if (a === "talk-stop") return app.stopListen?.();
  if (a === "talk-close") return closeTalk();
  if (a === "signup-back") {
    app.signup = { step: "email", email: app.signup.email, name: "", error: "" };
    return render();
  }
  if (a === "sample") {
    await api.useSample(SANDBOXES[0].id);
    history.replaceState(null, "", "#/today");
    return load();
  }
  if (a === "signout") {
    await api.signOut();
    app.signup = { step: "email", email: "", name: "", error: "" };
    app.setup = { kind: "trading", picked: new Set(), reserve: "", connecting: false };
    app.askLog = [];
    location.hash = "#/welcome";
    return load();
  }
  if (a === "kind") {
    app.setup.kind = el.dataset.k;
    return render();
  }
  if (a === "pick") {
    const p = app.setup.picked;
    p.has(id) ? p.delete(id) : p.add(id);
    el.classList.toggle("on", p.has(id));
    el.setAttribute("aria-pressed", String(p.has(id)));
    const btn = document.querySelector('[data-action="connect-all"]');
    if (btn) btn.textContent = p.size ? `Connect ${p.size} ${p.size === 1 ? "app" : "apps"}` : "Skip for now";
    const viaFile = [...p].filter((x) => CONNECTORS.find((c) => c.id === x)?.availability !== "live").length;
    const note = document.getElementById("bar-note");
    if (note && viaFile) note.textContent = `${viaFile} of these connect by file upload until their connector is ready.`;
    return;
  }
  if (a === "connect-all") {
    const st = app.setup;
    st.connecting = true;
    render();
    const dollars = Number(String(st.reserve).replace(/[^\d.]/g, ""));
    // Preview: connectors marked Ready sign in on the Neri server; here they show as connected. Others wait for a file.
    try {
      await new Promise((r) => setTimeout(r, st.picked.size ? 1100 : 0));
      await api.completeSetup({ email: app.signup.email, businessName: app.signup.name, kind: st.kind, reserve: dollars ? Math.round(dollars * 100) : null, connect: [...st.picked] });
    } catch (e) {
      st.connecting = false;
      render();
      toast("Couldn't finish setup", `${e.message} Try again, or upload a file instead.`);
      return;
    }
    st.connecting = false;
    history.replaceState(null, "", "#/today");
    await load();
    const c = app.account.connections;
    const ok = c.filter((x) => x.state === "ok").length;
    toast("All set", c.length ? `${ok} connected${c.length - ok ? `, ${c.length - ok} waiting for a file` : ""}. Here's today.` : "Upload a file or connect an app whenever you're ready.");
    return;
  }
  if (a === "done") {
    ev.preventDefault();
    await api.approve(id);
    if (el.dataset.close) closeSheet();
    await refresh();
    toast("Marked as done", "It stays on today's list, ticked off.");
    return;
  }
  if (a === "draft") return showDraft(id);
  if (a === "record") return showRecord(id);
  if (a === "week") {
    showWeek(el.dataset.week);
    if (route() === "details") {
      const holder = $('[data-chart="main"]');
      if (holder) holder.innerHTML = masked(viewForecastChartOnly());
    }
    return;
  }
  if (a === "listen") return toggleListen();
  if (a === "drive") return openDrive();
  if (a === "drive-close") return closeDrive();
  if (a === "mic-ask") return startCapture("ask");
  if (a === "mic-note") return startCapture("note");
  if (a === "mic-drive") return startCapture("drive");
  if (a === "hint") return doAsk(el.dataset.q);
  if (a === "scenario") {
    app.scenario = el.dataset.s;
    if (app.scenario === "stress") app.stressRun = await api.forecast("stress");
    return render();
  }
  if (a === "clear-whatif") {
    app.whatIf = null;
    return render();
  }
  if (a === "show-whatif") {
    const t = app.askLog[Number(el.dataset.i)];
    app.whatIf = t.a.scenario;
    location.hash = "#/details";
    return;
  }
  if (a === "add-plan") {
    const t = app.askLog[Number(el.dataset.i)];
    await api.confirmPlan(t.a.proposal);
    t.added = true;
    app.whatIf = null;
    await refresh();
    toast("Added to your forecast", `${money(t.a.proposal.amount)} on ${shortDate(t.a.proposal.date)}. Today's list is updated.`);
    return;
  }
  if (a === "signal") {
    const res = await api.decideSignal(id, el.dataset.d);
    await refresh();
    if (el.dataset.d === "apply") {
      location.hash = "#/today";
      const low = app.brief.run.lowPoint;
      toast(res?.alert?.title ?? "Change applied", res?.alert?.detail ? `${res.alert.detail} Today's list is re-ranked.` : `Your low point is now ${money(low.amount)} on ${shortDate(low.date)}. Today's list is re-ranked.`, "Details", () => (location.hash = "#/details"));
    } else {
      toast("Dismissed", "The forecast stays as it was.");
    }
    return;
  }
  if (a === "note-filter") {
    app.noteFilter = el.dataset.k;
    return render();
  }
  if (a === "note-decide") {
    const d = el.dataset.d;
    await api.decideNote(id, d);
    await refresh();
    toast(d === "add" ? "Added to your forecast" : d === "keep" ? "Kept as a note" : "Removed", d === "add" ? "Today's list and the chart are updated." : "");
    return;
  }
  if (a === "connect") return showConnect(id);
  if (a === "connect-go") {
    toast("Sign-in opens on your Neri server", "This preview runs a fictional business with sample data.");
    return;
  }
  if (a === "interest") {
    app.interest.add(id);
    closeSheet();
    render();
    toast("Noted", "You'll hear when it's ready. Upload an export meanwhile.");
    return;
  }
  if (a === "mask") {
    app.mask = !app.mask;
    try { localStorage.setItem("neri.mask", app.mask ? "1" : "0"); } catch {}
    return render();
  }
  if (a === "theme") {
    const t = el.dataset.t;
    if (t === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    try { t === "auto" ? localStorage.removeItem("neri.theme") : localStorage.setItem("neri.theme", t); } catch {}
    return render();
  }
  if (a === "copy-draft") {
    const text = `Subject: ${$("#d-sub").value}\n\n${$("#d-body").value}`;
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied", "Paste it into your email.");
    } catch {
      toast("Couldn't copy", "Select the text and copy it instead.");
    }
    return;
  }
  if (a === "mail-draft") {
    const href = `mailto:${encodeURIComponent($("#d-to").value)}?subject=${encodeURIComponent($("#d-sub").value)}&body=${encodeURIComponent($("#d-body").value)}`;
    location.href = href;
    return;
  }
}

function viewForecastChartOnly() {
  const run = app.scenario === "stress" && app.stressRun ? app.stressRun : app.brief.run;
  return cashChart(run, { width: chartWidth(), height: window.innerWidth < 760 ? 240 : 320, ghost: app.scenario === "stress" ? app.brief.run : null, whatIf: app.whatIf?.run ?? null, selectedWeek: app.selectedWeek });
}

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    if (document.querySelector(".sheet")) closeSheet();
    else if (app.drive) closeDrive();
  }
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches("tr[data-action='week']")) {
    ev.preventDefault();
    showWeek(ev.target.dataset.week);
  }
});

document.addEventListener("submit", (ev) => onSubmit(ev).catch(failed));
async function onSubmit(ev) {
  const f = ev.target.closest("[data-submit]");
  if (!f) return;
  ev.preventDefault();
  const kind = f.dataset.submit;
  if (kind === "ask") return doAsk(new FormData(f).get("q") ?? "");
  if (kind === "talk-typed") {
    const q = String(new FormData(f).get("q") ?? "");
    closeTalk();
    return doAsk(q);
  }
  if (kind === "signup") {
    const email = String(new FormData(f).get("email") ?? "").trim();
    try {
      const r = await api.startSignup(email);
      app.signup = { step: "code", email, name: r.suggestedName ?? suggestBusinessName(email), error: "", sentAt: Date.now() };
      tickResend();
    } catch (e) {
      app.signup.error = e.message;
      app.signup.email = email;
    }
    render();
    $("#code")?.focus();
    return;
  }
  if (kind === "verify") {
    const fd = new FormData(f);
    const name = String(fd.get("biz") ?? "").trim();
    try {
      if (!name) throw new Error("Add your business name.");
      await api.verifyCode(app.signup.email, String(fd.get("code") ?? ""));
      app.signup = { ...app.signup, name, step: "done", error: "" };
      location.hash = "#/setup";
    } catch (e) {
      app.signup.error = e.message;
      app.signup.name = name;
      render();
    }
    return;
  }
  if (kind === "park") {
    const text = (new FormData(f).get("text") ?? "").toString().trim();
    if (!text) return;
    await api.parkNote(text, app.lastVia ?? "typed");
    app.notes = await api.notes();
    app.noteFilter = "all";
    render();
    return;
  }
  if (kind === "safety") {
    const dollars = Number(String(new FormData(f).get("amt")).replace(/[^\d.]/g, ""));
    if (!Number.isFinite(dollars) || dollars < 0) return toast("Enter an amount in dollars");
    await api.setSafetyLine(Math.round(dollars * 100));
    await refresh();
    toast("Your line is updated", `${money(Math.round(dollars * 100))}. The forecast and today's list are recalculated.`);
  }
}

document.addEventListener("change", (ev) => onChange(ev).catch(failed));
async function onChange(ev) {
  const el = ev.target;
  if (el.dataset.change === "reserve") {
    app.setup.reserve = el.value;
    return;
  }
  if (el.dataset.change === "biz") {
    app.bizId = el.value;
    if (app.account?.sample) app.account = await api.useSample(el.value);
    else if (app.account) {
      app.account = { ...app.account, sandbox: el.value };
      try { localStorage.setItem("neri.account", JSON.stringify(app.account)); } catch {}
    }
    app.askLog = [];
    app.whatIf = null;
    app.brief = null;
    app.scenario = "base";
    await load();
    return;
  }
  if (el.dataset.change === "upload") {
    const file = el.files?.[0];
    if (file) toast(`${file.name} received`, api.mode === "preview" ? "This preview uses sample data, so the file isn't imported. On your Neri server it goes to Review first." : "Reading it now. New items will wait in Review.");
    el.value = "";
    return;
  }
  if (el.dataset.noteField) {
    const field = el.dataset.noteField;
    let value = el.value;
    if (field === "amount") {
      const d = Number(value.replace(/[^\d.]/g, ""));
      if (!d) return;
      value = Math.round(d * 100);
    }
    if (!value) return;
    await api.updateNote(el.dataset.id, { [field]: value });
    app.notes = await api.notes();
    render();
  }
}

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (["details", "today"].includes(route())) render();
  }, 150);
});

load().catch((err) => {
  $("#view").innerHTML = `<section class="panel" style="max-width:640px;margin-top:40px"><h2 style="color:var(--ink);font-size:18px">Neri couldn't load your numbers</h2><p>${esc(err.message)}</p><p style="color:var(--ink-soft)">If you're running against the API, check the server is up, then reload.</p></section>`;
  console.error(err);
});
