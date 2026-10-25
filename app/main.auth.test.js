import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let nodes;
let api;
let auth;
let account;
let location;
let handlers;
let demoAllowed;
const session = { user: { email: "owner@example.com" } };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  location = new URL("https://neri.example/");
  nodes = new Map(["#top", "#bottom", "#preview-note", "#talk", "#view"].map((id) => [id, { innerHTML: "", clientWidth: 640 }]));
  handlers = new Map();
  vi.stubGlobal("location", location);
  vi.stubGlobal("history", { replaceState: (_state, _title, path) => { location.href = new URL(path, location).href; } });
  vi.stubGlobal("window", { addEventListener: vi.fn(), innerWidth: 1024 });
  vi.stubGlobal("document", {
    querySelector: (id) => nodes.get(id) ?? null,
    getElementById: () => null,
    addEventListener: (name, handler) => handlers.set(name, handler),
    documentElement: { dataset: {} },
    body: { classList: { toggle: vi.fn() } },
  });
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("FormData", class {
    constructor(form) { this.values = form.values; }
    get(key) { return this.values[key] ?? null; }
  });
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  account = null;
  demoAllowed = false;
  const run = JSON.parse(readFileSync(new URL("../fixtures/cascade_trade/forecast_run.json", import.meta.url), "utf8"));
  const context = { business: { name: "Owner Co", synthetic: false, sources: [] }, profile: { displayName: "Trading" }, parties: [], rules: [] };
  api = {
    mode: "live",
    account: () => account,
    restoreAccount: vi.fn().mockResolvedValue(null),
    createAccount: vi.fn().mockResolvedValue(session),
    signIn: vi.fn().mockResolvedValue(session),
    startSignup: vi.fn(),
    open: vi.fn(), context: vi.fn().mockResolvedValue(context),
    brief: vi.fn().mockResolvedValue({ run, three: [], rest: [], watch: [] }),
    review: vi.fn().mockResolvedValue([]), notes: vi.fn().mockResolvedValue([]),
  };
  auth = { consumeEmailLink: vi.fn().mockResolvedValue(null), currentSession: vi.fn().mockResolvedValue(null) };
  vi.doMock("./api.js", () => ({ api, SANDBOXES: [{ id: "cascade_trade" }], suggestBusinessName: () => "", authLive: true, get demoAllowed() { return demoAllowed; } }));
  vi.doMock("./ui/auth.js", () => auth);
});

const submit = (kind, values) => handlers.get("submit")({
  target: { closest: () => ({ dataset: { submit: kind }, values }) },
  preventDefault: vi.fn(),
});

describe("password account flow", () => {
  it("shows account creation without an email-code step", async () => {
    const html = await start();
    expect(html).toContain('type="password"');
    expect(html).toContain('autocomplete="new-password"');
    expect(html).toContain("No email verification needed");
    expect(html).not.toContain("Check your email");
  });

  it("creates an account, then asks for the business name without sending an email", async () => {
    await start();
    await submit("signup", { email: "owner@example.com", password: "test password 123" });
    expect(api.createAccount).toHaveBeenCalledWith("owner@example.com", "test password 123");
    expect(api.restoreAccount).toHaveBeenCalledWith(session);
    expect(api.startSignup).not.toHaveBeenCalled();
    expect(nodes.get("#view").innerHTML).toContain('data-submit="setup-name"');
    expect(nodes.get("#view").innerHTML).not.toContain("test password 123");
  });

  it("opens the returning owner's business without setup", async () => {
    await start();
    await handlers.get("click")({ target: { closest: () => ({ dataset: { action: "auth-mode", mode: "signin" } }) } });
    expect(nodes.get("#view").innerHTML).toContain('autocomplete="current-password"');
    api.restoreAccount.mockImplementation(async () => (account = { email: session.user.email, businessName: "Owner Co" }));
    await submit("password-signin", { email: "owner@example.com", password: "test password 123" });
    expect(api.signIn).toHaveBeenCalledWith("owner@example.com", "test password 123");
    expect(api.createAccount).not.toHaveBeenCalled();
    expect(location.hash).toBe("#/today");
    expect(nodes.get("#view").innerHTML).toContain('class="home"');
  });

  it("blocks duplicate submissions while account creation is pending", async () => {
    await start();
    let complete;
    api.createAccount.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = submit("signup", { email: "owner@example.com", password: "test password 123" });
    await submit("signup", { email: "owner@example.com", password: "test password 123" });
    expect(api.createAccount).toHaveBeenCalledTimes(1);
    expect(nodes.get("#view").innerHTML).toContain("Creating account…");
    complete(session);
    await pending;
  });

  it("keeps authentication failures on the form without rendering the password", async () => {
    await start();
    api.signIn.mockRejectedValue(new Error("Email or password didn't match. Try again."));
    await submit("password-signin", { email: "owner@example.com", password: "private password" });
    const html = nodes.get("#view").innerHTML;
    expect(html).toContain("Email or password didn&#39;t match. Try again.");
    expect(html).not.toContain("private password");
    expect(api.restoreAccount).not.toHaveBeenCalled();
  });

  it.each(["context", "brief"])("offers a session-preserving retry when %s fails after successful sign-in", async (method) => {
    await start();
    api.restoreAccount.mockImplementation(async () => (account = { email: session.user.email, businessName: "Owner Co" }));
    api[method].mockRejectedValueOnce(new Error("Temporary API failure"));
    await submit("password-signin", { email: "owner@example.com", password: "private password" });
    const html = nodes.get("#view").innerHTML;
    expect(location.hash).toBe("#/welcome");
    expect(html).toContain("couldn&#39;t load your business");
    expect(html).toContain('data-action="retry-signin"');
    expect(html).not.toContain("Signing in…");
    expect(html).not.toContain("private password");
    auth.currentSession.mockResolvedValue(session);
    await handlers.get("click")({ target: { closest: () => ({ dataset: { action: "retry-signin" } }) } });
    expect(location.hash).toBe("#/today");
    expect(nodes.get("#view").innerHTML).toContain('class="home"');
    expect(api.signIn).toHaveBeenCalledTimes(1);
  });
});
afterEach(() => {
  vi.doUnmock("./api.js");
  vi.doUnmock("./ui/auth.js");
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const start = async () => {
  await import("./main.js");
  await vi.waitFor(() => expect(nodes.get("#view").innerHTML).not.toBe(""));
  return nodes.get("#view").innerHTML;
};

describe("email-link startup", () => {
  it("resumes a new owner's setup after the callback instead of asking for another code", async () => {
    auth.consumeEmailLink.mockResolvedValue(session);
    const html = await start();
    expect(api.restoreAccount).toHaveBeenCalledWith(session);
    expect(html).toContain("You're signed in");
    expect(html).toContain("owner@example.com");
    expect(html).toContain('data-submit="setup-name"');
    expect(html).not.toContain('data-submit="verify"');
  });

  it("restores an existing owner and loads the business without another setup", async () => {
    auth.consumeEmailLink.mockResolvedValue(session);
    api.restoreAccount.mockImplementation(async () => (account = { email: session.user.email, businessName: "Owner Co" }));
    const html = await start();
    expect(api.context).toHaveBeenCalled();
    expect(location.hash).toBe("#/today");
    expect(html).toContain('class="home"');
    expect(html).not.toContain('data-submit="setup-name"');
  });

  it("restores a saved session when setup was interrupted by a reload", async () => {
    auth.currentSession.mockResolvedValue(session);
    expect(await start()).toContain("You're signed in");
    expect(api.restoreAccount).toHaveBeenCalledWith(session);
  });

  it("shows callback failures on sign-in and does not load a cached owner's numbers", async () => {
    account = { email: "other@example.com" };
    auth.consumeEmailLink.mockRejectedValue(new Error("That sign-in link has expired."));
    const html = await start();
    expect(html).toContain("That sign-in link has expired.");
    expect(html).toContain('data-submit="signup"');
    expect(api.context).not.toHaveBeenCalled();
  });

  it("recovers a stale sample into the signed-in owner's business in production", async () => {
    account = { sample: true, sandbox: "cascade_trade" };
    auth.currentSession.mockResolvedValue(session);
    api.restoreAccount.mockImplementation(async () => (account = { businessId: "private", email: session.user.email, businessName: "Owner Co" }));
    const html = await start();
    expect(api.restoreAccount).toHaveBeenCalledWith(session);
    expect(html).toContain('class="home"');
    expect(location.hash).toBe("#/today");
    expect(html).not.toContain('data-action="sample"');
  });

  it("keeps a selected sample available in explicit demo mode", async () => {
    demoAllowed = true;
    account = { sample: true, sandbox: "cascade_trade" };
    auth.currentSession.mockResolvedValue(session);
    const html = await start();
    expect(api.restoreAccount).not.toHaveBeenCalled();
    expect(html).toContain('class="home"');
  });
});
