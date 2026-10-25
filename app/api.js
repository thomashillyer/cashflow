// One place the app talks to data. Two modes:
//   preview (default): the bundled preview engine + synthetic fixtures, no server needed.
//   live: the team's API (docs/design/09-api-repo-lanes.md). Turn on with ?api=http://localhost:8787
//         or window.NERI_API_BASE in app/config.js.
//
// The UI only calls the functions below, so wiring the real API means filling in `live` and nothing else.

import { createEngine } from "./mock/engine.js";

export const SANDBOXES = [
  { id: "cascade_trade", label: "Cascade Trade Co.", kind: "Trading and import" },
  { id: "pike_noodle", label: "Pike Street Noodle Bar", kind: "Restaurant" },
];

const params = new URLSearchParams(location.search);
// Live mode only from config.js (a URL, or "same-origin" when the API serves the app). A ?api= override is
// accepted only for localhost, so a shared link can't point the app at someone else's server.
const fromQuery = params.get("api");
const API_BASE =
  window.NERI_API_BASE === "same-origin" ? location.origin
  : window.NERI_API_BASE || (fromQuery && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(fromQuery) ? fromQuery : "");

let engine = null;

async function loadPreview(id) {
  const fx = await import(`./mock/${id}.js`);
  engine = createEngine(fx);
}

// ---- preview implementation ------------------------------------------------------
const preview = {
  mode: "preview",
  async open(id) {
    await loadPreview(id);
  },
  async context() {
    return { business: engine.business, profile: engine.profile, parties: engine.parties, rules: engine.rules, safetyLine: engine.safetyLine, partyOf: (cid) => engine.commitmentById(cid)?.partyId };
  },
  async brief() {
    return engine.brief(); // { three, rest, watch, combined, shortfall, run }
  },
  async forecast(scenario = "base") {
    return engine.forecast({ scenario });
  },
  async review() {
    return engine.review();
  },
  async decideSignal(id, decision) {
    return engine.decideSignal(id, decision);
  },
  async draft(itemId) {
    return engine.draft(itemId);
  },
  async approve(itemId) {
    engine.markDone(itemId);
  },
  async ask(question) {
    return engine.ask(question);
  },
  async confirmPlan(proposal) {
    return engine.confirmPlan(proposal);
  },
  async record(id) {
    return engine.record(id);
  },
  async setSafetyLine(cents) {
    engine.setSafetyLine(cents);
  },
  // Parked thoughts (owner notes). Neri proposes a reading; owner confirms before it touches cash.
  async notes() {
    return engine.thoughts();
  },
  async parkNote(text, via) {
    return engine.parkThought(text, via);
  },
  async updateNote(id, edits) {
    return engine.updateThought(id, edits);
  },
  async decideNote(id, decision) {
    return engine.decideThought(id, decision);
  },
};

// ---- live implementation (team API) ------------------------------------------------
async function http(path, init) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { "Content-Type": "application/json" }, ...init });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed (${res.status})`);
  return res.status === 204 ? null : res.json();
}

const live = {
  mode: "live",
  async open() {},
  // Needs one small addition to the API table: business name, sources with freshness, parties, rules.
  async context() {
    return http("/context");
  },
  // Expected: { three: WorkItem[], rest: WorkItem[], watch: WorkItem[], combined?, shortfall?, run: ForecastRun }
  async brief() {
    return http("/brief");
  },
  async forecast(scenario = "base") {
    return http(`/forecast?scenario=${encodeURIComponent(scenario)}`);
  },
  async review() {
    return http("/review");
  },
  async decideSignal(id, decision) {
    return http(`/signals/${encodeURIComponent(id)}/${decision === "apply" ? "apply" : "dismiss"}`, { method: "POST" });
  },
  async draft(itemId) {
    return http(`/work-items/${encodeURIComponent(itemId)}/draft`, { method: "POST" });
  },
  async approve(itemId) {
    return http(`/work-items/${encodeURIComponent(itemId)}/approve`, { method: "POST" });
  },
  async ask(question) {
    return http("/ask", { method: "POST", body: JSON.stringify({ question }) });
  },
  async confirmPlan(proposal) {
    return http("/plans", { method: "POST", body: JSON.stringify(proposal) });
  },
  async record(id) {
    return http(`/records/${encodeURIComponent(id)}`);
  },
  async setSafetyLine(cents) {
    return http("/profile", { method: "PUT", body: JSON.stringify({ safetyLine: { kind: "fixed", amount: cents } }) });
  },
  // Owner notes go through the signals pipeline as channel "owner" (06-signals.md).
  async notes() {
    return http("/notes");
  },
  async parkNote(text, via) {
    return http("/notes", { method: "POST", body: JSON.stringify({ text, via }) });
  },
  async updateNote(id, edits) {
    return http(`/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(edits) });
  },
  async decideNote(id, decision) {
    return http(`/notes/${encodeURIComponent(id)}/${decision}`, { method: "POST" });
  },
};

export const api = API_BASE ? live : preview;
