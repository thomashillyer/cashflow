// One place the app talks to data. Two modes:
//   preview (default): the bundled preview engine + synthetic fixtures, no server needed.
//   live: the team's API (docs/design/09-api-repo-lanes.md). Turn on with ?api=http://localhost:8787
//         or window.NERI_API_BASE in app/config.js.
//
// The UI only calls the functions below, so wiring the real API means filling in `live` and nothing else.

import { createEngine } from "./mock/engine.js";
import * as auth from "./ui/auth.js";

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

// ---- account (multi-tenant sign-up) ------------------------------------------------
// Preview keeps the account in this browser only. Live mode uses the API's auth routes
// (business-email sign-in with a one-time code; Supabase auth behind the API).
const ACCOUNT_KEY = "neri.account";
function readAccount() {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNT_KEY));
  } catch {
    return null;
  }
}
function writeAccount(acc) {
  try {
    acc ? localStorage.setItem(ACCOUNT_KEY, JSON.stringify(acc)) : localStorage.removeItem(ACCOUNT_KEY);
  } catch {}
  memAccount = acc;
}
let memAccount = null;
const FREE_MAIL = /^(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|me|aol|proton|protonmail)\./i;

export function suggestBusinessName(email) {
  const domain = (email.split("@")[1] ?? "").toLowerCase();
  if (!domain || FREE_MAIL.test(domain)) return "";
  const base = domain.split(".")[0].replace(/[-_]+/g, " ");
  return base.replace(/\b\w/g, (c) => c.toUpperCase());
}
export function ownerNameFrom(email) {
  const local = (email.split("@")[0] ?? "").split(/[._-]/)[0];
  return local ? local[0].toUpperCase() + local.slice(1).toLowerCase() : "";
}

// ---- preview implementation ------------------------------------------------------
const preview = {
  mode: "preview",
  account() {
    return readAccount() ?? memAccount;
  },
  async startSignup(email) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter your work email, like you@yourbusiness.com.");
    if (auth.authConfigured) await auth.sendCode(email);
    return { suggestedName: suggestBusinessName(email), personal: FREE_MAIL.test(email.split("@")[1] ?? ""), realCode: auth.authConfigured };
  },
  async verifyCode(email, code) {
    if (!/^\d{6}$/.test(code.trim())) throw new Error("Enter the 6-digit code from the email.");
    if (auth.authConfigured) await auth.verifyCode(email, code);
    return { ok: true };
  },
  async completeSetup({ email, businessName, kind, reserve, connect }) {
    const sandbox = kind === "restaurant" ? "pike_noodle" : "cascade_trade";
    const { CONNECTORS } = await import("./catalog/connectors.js");
    const acc = {
      email,
      owner: ownerNameFrom(email),
      businessName,
      kind,
      sandbox,
      reserve,
      connections: connect.map((id) => {
        const c = CONNECTORS.find((x) => x.id === id);
        return { id, name: c?.name ?? id, state: c?.availability === "live" ? "ok" : "waiting" };
      }),
      createdAt: new Date().toISOString(),
    };
    writeAccount(acc);
    return acc;
  },
  async useSample(sandbox) {
    const acc = { sample: true, sandbox, connections: null, createdAt: new Date().toISOString() };
    writeAccount(acc);
    return acc;
  },
  async signOut({ everywhere = false } = {}) {
    await auth.signOut({ everywhere }).catch(() => {});
    writeAccount(null);
  },
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
  async decideRule(id, decision) {
    return engine.decideRule(id, decision);
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
// The sample the owner picked (welcome screen or switcher). Sent as X-Neri-Business so the server shows
// that sample instead of its default. A signed-in owner's own business comes from their session, so a
// non-sample account sends no header.
let openedBiz = null;
function businessHeader() {
  const acc = readAccount() ?? memAccount;
  return openedBiz && (!acc || acc.sample) ? { "X-Neri-Business": openedBiz } : {};
}

async function http(path, init) {
  const token = await auth.accessToken().catch(() => null);
  const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...businessHeader() };
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    await auth.signOut().catch(() => {});
    writeAccount(null);
    location.hash = "#/welcome";
    throw new Error("Your session ended. Sign in again with a new code.");
  }
  if (!res.ok) {
    // The API words its errors for the owner: { error: { code, message, fieldIssues, retryable } }.
    const body = await res.json().catch(() => null);
    const e = body?.error;
    const err = new Error(e?.message || `Neri couldn't reach the server (${res.status}). Try again in a moment.`);
    Object.assign(err, { status: res.status, code: e?.code, fieldIssues: e?.fieldIssues, retryable: e?.retryable, path });
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const live = {
  mode: "live",
  account() {
    return readAccount() ?? memAccount;
  },
  // Sign-in goes straight to Supabase Auth (one-time code). The API only ever sees the session token.
  async startSignup(email) {
    if (!auth.authConfigured) throw new Error("Sign-in isn't configured on this server yet.");
    await auth.sendCode(email);
    return { suggestedName: suggestBusinessName(email), personal: FREE_MAIL.test(email.split("@")[1] ?? ""), realCode: true };
  },
  async verifyCode(email, code) {
    await auth.verifyCode(email, code);
    return { ok: true };
  },
  // Creates the tenant (business), sets the starter profile and reserve, starts the chosen connectors.
  async completeSetup(setup) {
    const acc = await http("/setup", { method: "POST", body: JSON.stringify(setup) });
    writeAccount(acc);
    return acc;
  },
  async useSample(sandbox) {
    const acc = { sample: true, sandbox, connections: null };
    writeAccount(acc);
    return acc;
  },
  async signOut({ everywhere = false } = {}) {
    await auth.signOut({ everywhere }).catch(() => {});
    writeAccount(null);
  },
  async open(id) {
    openedBiz = id ?? null;
  },
  // partyByCommitment (commitment id -> party id) becomes the same partyOf() the preview context offers.
  async context() {
    const c = await http("/context");
    return { ...c, partyOf: (cid) => c.partyByCommitment?.[cid] };
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
  async decideRule(id, decision) {
    return http(`/rules/${encodeURIComponent(id)}/${decision === "confirm" ? "confirm" : "dismiss"}`, { method: "POST" });
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
  // null for an id the books don't have, so the "Not found" sheet shows.
  async record(id) {
    return http(`/records/${encodeURIComponent(id)}`).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
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
export const authLive = auth.authConfigured;
