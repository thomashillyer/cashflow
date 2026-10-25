import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let nodes;
let api;
let auth;
let account;
let location;
const session = { user: { email: "owner@example.com" } };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  location = new URL("https://neri.example/");
  nodes = new Map(["#top", "#bottom", "#preview-note", "#talk", "#view"].map((id) => [id, { innerHTML: "", clientWidth: 640 }]));
  vi.stubGlobal("location", location);
  vi.stubGlobal("history", { replaceState: (_state, _title, path) => { location.href = new URL(path, location).href; } });
  vi.stubGlobal("window", { addEventListener: vi.fn(), innerWidth: 1024 });
  vi.stubGlobal("document", {
    querySelector: (id) => nodes.get(id) ?? null,
    getElementById: () => null,
    addEventListener: vi.fn(),
    documentElement: { dataset: {} },
    body: { classList: { toggle: vi.fn() } },
  });
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  account = null;
  const run = JSON.parse(readFileSync(new URL("../fixtures/cascade_trade/forecast_run.json", import.meta.url), "utf8"));
  const context = { business: { name: "Owner Co", synthetic: false, sources: [] }, profile: { displayName: "Trading" }, parties: [], rules: [] };
  api = {
    mode: "live",
    account: () => account,
    restoreAccount: vi.fn().mockResolvedValue(null),
    open: vi.fn(), context: vi.fn().mockResolvedValue(context),
    brief: vi.fn().mockResolvedValue({ run, three: [], rest: [], watch: [] }),
    review: vi.fn().mockResolvedValue([]), notes: vi.fn().mockResolvedValue([]),
  };
  auth = { consumeEmailLink: vi.fn().mockResolvedValue(null), currentSession: vi.fn().mockResolvedValue(null) };
  vi.doMock("./api.js", () => ({ api, SANDBOXES: [{ id: "cascade_trade" }], suggestBusinessName: () => "", authLive: true }));
  vi.doMock("./ui/auth.js", () => auth);
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

  it("keeps a selected sample available even when a team session exists", async () => {
    account = { sample: true, sandbox: "cascade_trade" };
    auth.currentSession.mockResolvedValue(session);
    const html = await start();
    expect(api.restoreAccount).not.toHaveBeenCalled();
    expect(html).toContain('class="home"');
  });
});
