import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = { access_token: "token", user: { email: "owner@example.com" } };
let values;
let request;

beforeEach(() => {
  vi.resetModules();
  values = new Map([["neri.account", JSON.stringify({ sample: true, sandbox: "pike_noodle" })]]);
  vi.stubGlobal("localStorage", {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  });
  vi.stubGlobal("location", new URL("https://neri.example/"));
  vi.stubGlobal("window", { NERI_API_BASE: "same-origin", NERI_DEMO_MODE: true });
  request = vi.fn();
  vi.stubGlobal("fetch", request);
  vi.doMock("./ui/auth.js", () => ({ authConfigured: true, accessToken: async () => "token" }));
});
afterEach(() => {
  vi.doUnmock("./ui/auth.js");
  vi.unstubAllGlobals();
});

describe("restore the signed-in business", () => {
  it("loads the owner's existing business without a cached sample header or setup write", async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ business: {
      id: "owner-biz", name: "Owner Co", owner: "Owner", synthetic: false,
      sources: [{ id: "bank_csv", label: "Bank", state: "ok" }],
    } })));
    const { api } = await import("./api.js");
    await api.open("pike_noodle");
    const account = await api.restoreAccount(session);
    expect(account).toMatchObject({ businessId: "owner-biz", email: "owner@example.com", businessName: "Owner Co", reserveApplied: true });
    expect(api.account()).toEqual(account);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe("https://neri.example/context");
    const { "X-Neri-Visitor": visitor, ...headers } = request.mock.calls[0][1].headers;
    expect(headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer token" });
    expect(visitor).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("leaves a newly authenticated user ready for setup when demo mode returns a sample", async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ business: { synthetic: true } })));
    const { api } = await import("./api.js");
    expect(await api.restoreAccount(session)).toBeNull();
    expect(api.account()).toBeNull();
  });

  it("allows first setup when the authenticated API has no business", async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "No business" } }), { status: 404 }));
    const { api } = await import("./api.js");
    expect(await api.restoreAccount(session)).toBeNull();
  });

  it("does not turn a server failure into a new-business setup that could overwrite a profile", async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ error: { code: "INTERNAL", message: "Try later" } }), { status: 500 }));
    const { api } = await import("./api.js");
    await expect(api.restoreAccount(session)).rejects.toThrow("Try later");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("production owner isolation", () => {
  it("clears a cached sample and an older preview account without a business id", async () => {
    window.NERI_DEMO_MODE = false;
    const { api, demoAllowed } = await import("./api.js");
    expect(demoAllowed).toBe(false);
    expect(api.account()).toBeNull();
    expect(values.has("neri.account")).toBe(false);
    values.set("neri.account", JSON.stringify({ email: "owner@example.com", sandbox: "cascade_trade" }));
    expect(api.account()).toBeNull();
    await expect(api.useSample("cascade_trade")).rejects.toThrow("not available");
  });

  it("sends neither sample nor visitor routing headers in production", async () => {
    window.NERI_DEMO_MODE = false;
    request.mockResolvedValue(new Response(JSON.stringify({ business: { id: "private", synthetic: false }, partyByCommitment: {} })));
    const { api } = await import("./api.js");
    await api.open("pike_noodle");
    await api.context();
    expect(request.mock.calls[0][1].headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer token" });
  });

  it("refuses a server's accidental synthetic fallback during owner restoration", async () => {
    window.NERI_DEMO_MODE = false;
    request.mockResolvedValue(new Response(JSON.stringify({ business: { synthetic: true } })));
    const { api } = await import("./api.js");
    await expect(api.restoreAccount(session)).rejects.toThrow("server returned sample data");
    expect(api.account()).toBeNull();
  });

  it("uses actual tenant-scoped connector and pasted-import routes", async () => {
    window.NERI_DEMO_MODE = false;
    request.mockResolvedValueOnce(new Response(JSON.stringify({ connections: [{ id: "zoho_books", available: true }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ imported: 2 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ preview: { candidates: 1 } })));
    const { api } = await import("./api.js");
    expect(await api.connections()).toEqual([{ id: "zoho_books", available: true }]);
    await api.syncConnection("zoho_books");
    await api.importText("Invoice INV-1, $20 due tomorrow");
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://neri.example/connections", "https://neri.example/connections/zoho_books/sync", "https://neri.example/import/paste",
    ]);
    expect(request.mock.calls[1][1].method).toBe("POST");
    expect(JSON.parse(request.mock.calls[2][1].body)).toEqual({ text: "Invoice INV-1, $20 due tomorrow" });
  });
});

describe("imported document decisions", () => {
  it("loads proposals and sends their revision with an idempotency key", async () => {
    window.NERI_DEMO_MODE = false;
    request.mockResolvedValueOnce(new Response(JSON.stringify({ storeRevision: 7, proposals: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ storeRevision: 8 })));
    const { api } = await import("./api.js");
    expect(await api.reviewProposals()).toEqual({ storeRevision: 7, proposals: [] });
    await api.decideProposal("proposal/1", "confirm", 7);
    expect(request.mock.calls[1][0]).toBe("https://neri.example/review/proposal%2F1/confirm");
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ expectedRevision: 7 });
    expect(request.mock.calls[1][1].headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("owner-entered bank balance", () => {
  it("stores a signed balance snapshot through the balance route, not as a note", async () => {
    window.NERI_DEMO_MODE = false;
    request.mockResolvedValue(new Response(JSON.stringify({ storeRevision: 9 })));
    const { api } = await import("./api.js");
    await api.setBalance(-12345, "2026-10-25");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe("https://neri.example/balance");
    expect(request.mock.calls[0][1].method).toBe("PUT");
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ amount: -12345, asOf: "2026-10-25", account: "main" });
  });
});
