import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { CONNECTORS, CATEGORIES } from "./catalog/connectors.js";

const main = readFileSync(new URL("./main.js", import.meta.url), "utf8");
const ui = main.slice(0, main.lastIndexOf("\nstart().catch")).replace(/^import .*;\n/gm, "");
const baseRun = JSON.parse(readFileSync(new URL("../fixtures/cascade_trade/forecast_run.json", import.meta.url), "utf8"));
const escape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function screen(expression, { sources = [], connections = [], missing = false, demo = false, api = {} } = {}) {
  const run = structuredClone(baseRun);
  if (missing) run.review = { needed: true, reasons: [{ code: "no_opening_balance", message: "No opening balance; assumed $0.00", refs: [] }] };
  const supplied = {
    account: { businessId: "private-biz", businessName: "Owner Co", email: "owner@example.com" },
    ctx: { business: { id: "private-biz", name: "Owner Co", synthetic: false, sources, asOf: run.asOf }, profile: { displayName: "Trading" }, parties: [], rules: [] },
    brief: { run, three: [], rest: [], watch: [] }, connections,
  };
  return runInNewContext(`${ui}; Object.assign(app, supplied); ${expression}`, {
    supplied, api: { account: () => null, mode: "live", ...api }, authLive: true, demoAllowed: demo,
    window: { addEventListener() {}, NERI_LOCK_MINUTES: 0 },
    document: { addEventListener() {}, querySelector: () => null, documentElement: { dataset: {} } },
    localStorage: { getItem: () => null }, addEventListener() {}, setInterval() {},
    money: String, dayDate: String, shortDate: String, esc: escape, greeting: () => "Hello", speakable: String,
    addDays: (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10),
    canSpeak: false, canListen: false, ASK_HINTS: [], CONNECTORS, CATEGORIES,
    logo: "", logoLarge: "", icon: {}, SANDBOXES: [{ id: "cascade_trade", label: "Cascade Trade" }],
    location: { hash: "#/sources" },
    FormData: class { constructor(form) { this.values = form.values; } get(k) { return this.values[k] ?? null; } },
  });
}

describe("production uses the owner's data", () => {
  it("has no sample entry point or sample business selector", () => {
    expect(screen("viewWelcome()" )).not.toContain('data-action="sample"');
    expect(screen("viewSettings()" )).not.toContain('data-change="biz"');
    expect(screen("viewWelcome()", { demo: true })).toContain('data-action="sample"');
    expect(screen("viewSettings()", { demo: true })).toContain('data-change="biz"');
  });

  it("keeps missing opening cash out of Home, Details and spoken summaries", () => {
    const output = screen("({ home: viewToday(), details: viewDetails(), spoken: spokenBrief().join(' ') })", { missing: true });
    for (const text of Object.values(output)) {
      expect(text).not.toMatch(/14500000|550000|\$0|Lowest point|above your line for all/);
      expect(text).toMatch(/forecast|Forecast/);
    }
    expect(output.home).toContain("Add your first source");
    expect(output.details).not.toContain('class="chart"');
  });

  it("never narrates ranked cash effects before opening cash is known", () => {
    const text = screen("app.brief.three = [{ state: 'open', title: 'Invented $5000 improvement' }]; spokenBrief().join(' ')", { missing: true });
    expect(text).not.toContain("$5000");
    expect(text).toContain("No forecast is ready yet");
  });

  it("requires an actual typed bank amount and uses the business date and currency", () => {
    const html = screen("app.ctx.profile.baseCurrency = 'GBP'; viewToday()", { missing: true });
    expect(html).toContain("Current bank balance (GBP)");
    expect(html).toContain('name="amount" inputmode="decimal" placeholder="Enter your actual balance"');
    expect(html).not.toContain('name="amount" value=');
    expect(screen("viewSources()")).not.toContain('data-submit="bank-balance"');
    expect(html).toContain(`name="asOf" type="date" value="${baseRun.asOf}"`);
    expect(screen("parseBalance('-1,234.56')")).toBe(-123456);
    for (const value of ["", "balance unknown", "12.345", "1,23"]) {
      expect(() => screen(`parseBalance(${JSON.stringify(value)})`)).toThrow("Enter the bank balance");
    }
  });

  it("saves a typed balance through the balance API without turning it into a note", async () => {
    const setBalance = vi.fn().mockResolvedValue({ storeRevision: 2 });
    const parkNote = vi.fn();
    await screen(`render = () => {}; refresh = async () => {}; toast = () => {};
      onSubmit({ target: { closest: () => ({ dataset: { submit: 'bank-balance' }, values: { amount: '-123.45', asOf: '2026-10-25' } }) }, preventDefault() {} })`, { api: { setBalance, parkNote } });
    expect(setBalance).toHaveBeenCalledWith(-12345, "2026-10-25", "main");
    expect(parkNote).not.toHaveBeenCalled();
  });

  it("updates existing accounts explicitly without offering a second default main account", async () => {
    const html = screen(`app.ctx.profile.baseCurrency = 'USD'; app.ctx.balanceAccounts = [{account:'operating',currency:'USD',asOf:'2026-10-24'}, {account:'savings',currency:'USD',asOf:'2026-10-24'}]; viewSources()`);
    expect(html).toContain("Update your bank balance");
    expect(html).toContain('name="account" required');
    expect(html).toContain('value="operating"');
    expect(html).toContain('value="savings"');
    expect(html).not.toContain('name="account" value="main"');
    const setBalance = vi.fn().mockResolvedValue({});
    await screen(`app.ctx.profile.baseCurrency = 'USD'; app.ctx.balanceAccounts = [{account:'operating',currency:'USD'}]; refresh=async()=>{}; toast=()=>{};
      onSubmit({target:{closest:()=>({dataset:{submit:'bank-balance'},values:{amount:'99.12',asOf:'2026-10-25',account:'operating'}})},preventDefault(){}})`, {api:{setBalance}});
    expect(setBalance).toHaveBeenCalledWith(9912, '2026-10-25', 'operating');
  });

  it("distinguishes imported records from a waiting setup preference", () => {
    const html = screen("viewSources()", { sources: [
      { id: "zoho_books", state: "waiting", detail: "Waiting for the first file or sync" },
      { id: "quickbooks", state: "ok", detail: "4 records" },
    ] });
    expect(html).toContain("Waiting for data");
    expect(html).toContain("Records imported");
    expect(html).not.toContain(">Connected");
    expect(html).not.toContain("Sync now");
    expect(html).not.toContain("ready now");
    expect(html).toContain('data-submit="source-paste"');
  });

  it("offers sync only when this server explicitly reports an available connection", () => {
    const html = screen("viewSources()", { connections: [
      { id: "zoho_books", available: true, state: "ready" },
      { id: "m365", available: false, state: "unavailable" },
    ] });
    expect(html.match(/data-action="connection-sync"/g)).toHaveLength(1);
    expect(html).toContain('data-action="connection-sync" data-id="zoho_books"');
    expect(html).not.toContain('data-action="connection-sync" data-id="m365"');
  });

  it("maps Outlook email to its real server connection without claiming Teams or calendar access", () => {
    const html = screen("viewSources()", { connections: [{ id: "outlook", available: true, state: "waiting" }] });
    expect(html).toContain('data-action="connection-sync" data-id="outlook"');
    expect(html).toContain("Outlook email");
    expect(html).not.toContain("Teams chats");
  });

  it("greys out unavailable sources and keeps imports separate from working sync", () => {
    const html = screen("viewSources()", { connections: [{ id: "zoho_books", available: true, state: "waiting" }] });
    const card = (id) => html.split(`data-connector="${id}">`)[1].split("</button>")[0];
    for (const id of ["quickbooks", "zoho_crm", "whatsapp", "sharepoint", "bank_feed", "slack"]) {
      expect(html).toContain(`class="conn is-unavailable" data-connector="${id}"`);
      expect(card(id)).toContain('<button class="btn" disabled>Not available yet');
      expect(card(id)).not.toContain('data-action="connect"');
      expect(card(id)).not.toContain('data-action="connection-sync"');
    }
    expect(html).toContain('data-action="connection-sync" data-id="zoho_books"');
    expect(card("bank_csv")).toContain('data-action="connect" data-id="bank_csv">Upload an export');
    expect(html).toContain('data-change="upload"');
    expect(html).toContain('data-submit="source-paste"');
  });

  it("omits the Google email connector from Sources and setup even if a server advertises it", () => {
    const sources = screen("viewSources()", { connections: [{ id: "google", available: true, state: "waiting" }] });
    expect(sources).not.toContain('data-connector="google"');
    expect(sources).not.toContain('data-action="connection-sync" data-id="google"');
    expect(sources).not.toContain("Gmail");
    for (const kind of ["trading", "restaurant", "services", "other"]) {
      const setup = screen(`app.setup.kind = '${kind}'; viewSetup()`);
      expect(setup).not.toContain('data-action="pick" data-id="google"');
      expect(setup).not.toContain("Gmail");
    }
  });

  it("disables planned setup choices and ignores attempts to select them", async () => {
    const html = screen("app.setup.picked.add('quickbooks'); viewSetup()");
    for (const id of ["quickbooks", "whatsapp", "sharepoint", "bank_feed"]) {
      expect(html).toMatch(new RegExp(`class="app-tile [^"]*is-unavailable" data-action="pick" data-id="${id}" aria-pressed="false" disabled`));
    }
    expect(html).toContain("Greyed-out connectors are still being built");
    const picked = await screen(`render = () => {}; (async () => {
      await onClick({ target: { closest: () => ({ dataset: { action: 'pick', id: 'slack' } }) } });
      return [...app.setup.picked];
    })()`);
    expect(picked).toEqual([]);
  });

  it("shows real imported proposals and permits confirmation only for resolved operations", () => {
    const html = screen(`app.reviewDocs = { storeRevision: 4, proposals: [
      { proposal: { id: 'resolved', action: 'create', ops: [{}], conflicts: [], reasons: ['Reference matched'] }, candidate: { fields: { reference: { state: 'found', value: 'INV-7' }, amount: { state: 'found', value: 2000 } } }, evidence: [], notes: [] },
      { proposal: { id: 'unresolved', action: 'review', ops: [], conflicts: [], reasons: ['Missing amount'] }, candidate: null, evidence: [], notes: [] }
    ] }; viewReview()`);
    expect(html).toContain("INV-7");
    expect(html).toContain('data-id="resolved" data-d="confirm"');
    expect(html).not.toContain('data-id="unresolved" data-d="confirm"');
    expect(html).toContain("needs more information");
    expect(html).not.toContain("Nothing to review");
  });

  it("describes setup choices as preferences without simulated OAuth or success", () => {
    const html = screen("app.signup.name = 'Owner Co'; app.setup.picked.add('zoho_books'); viewSetup()");
    expect(html).toContain("Your choices are preferences");
    expect(html).toContain("Create business");
    expect(html).not.toContain("connect them all at once");
    expect(html).not.toContain("Connect 1 app");
  });

  it("does not call sync for an unavailable connector", async () => {
    const syncConnection = vi.fn();
    await screen("onClick({ target: { closest: () => ({ dataset: { action: 'connection-sync', id: 'zoho_books' } }) } })", {
      api: { syncConnection }, connections: [{ id: "zoho_books", available: false }],
    });
    expect(syncConnection).not.toHaveBeenCalled();
  });

  it("reports HTTP-200 partial message failures without claiming a completed sync", async () => {
    const syncConnection = vi.fn().mockResolvedValue({ connection: { state: "error", message: "Two messages could not be interpreted." }, counts: { proposals: 1, signals: 0, failed: 2, evidence: 3 } });
    const reports = await screen(`render = () => {}; closeSheet = () => {}; refresh = async () => {}; const reports = []; toast = (...args) => reports.push(args);
      (async () => { await onClick({ target: { closest: () => ({ dataset: { action: 'connection-sync', id: 'outlook' } }) } }); return reports; })()`, {
      api: { syncConnection }, connections: [{ id: "outlook", available: true }],
    });
    expect(reports[0][0]).toBe("Some source records need attention");
    expect(reports[0][1]).toContain("1 imported item is waiting for review");
    expect(reports[0][1]).toContain("Two messages could not be interpreted");
    expect(reports[0][0]).not.toBe("Source sync completed");
  });

  it("shows newly uploaded document proposals in Review without reloading the page", async () => {
    const pending = { proposal: { id: 'uploaded', action: 'create', ops: [{}], conflicts: [], reasons: [] }, candidate: { fields: { reference: {state:'found',value:'UPLOADED-INV-1'} } }, evidence: [], notes: [] };
    const api = {
      uploadFile: vi.fn().mockResolvedValue({}),
      review: async () => [], notes: async () => [],
      brief: async () => ({run:baseRun,three:[],rest:[],watch:[]}),
      context: async () => ({business:{synthetic:false,sources:[]},profile:{baseCurrency:'USD'},parties:[]}),
      reviewProposals: vi.fn().mockResolvedValue({storeRevision:1,proposals:[pending]}),
    };
    const html = await screen(`render=()=>{};toast=()=>{};(async()=>{await sendFiles([{name:'invoice.csv'}]);return viewReview();})()`, {api});
    expect(api.uploadFile).toHaveBeenCalledTimes(1);
    expect(api.reviewProposals).toHaveBeenCalledTimes(1);
    expect(html).toContain('UPLOADED-INV-1');
    expect(html).toContain('data-id="uploaded" data-d="confirm"');
  });

  it("clears sync progress and reports no success when a real sync fails", async () => {
    const syncConnection = vi.fn().mockRejectedValue(new Error("Provider unavailable"));
    const output = screen(`render = () => {}; closeSheet = () => {}; const reports = []; toast = (...args) => reports.push(args);
      (async () => { try { await onClick({ target: { closest: () => ({ dataset: { action: 'connection-sync', id: 'zoho_books' } }) } }); } catch (e) { return { error: e.message, syncing: app.syncing, reports }; } })()`, {
      api: { syncConnection }, connections: [{ id: "zoho_books", available: true }],
    });
    expect(await output).toEqual({ error: "Provider unavailable", syncing: null, reports: [] });
    expect(syncConnection).toHaveBeenCalledWith("zoho_books");
  });
});
