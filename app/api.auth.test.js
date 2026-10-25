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
  vi.stubGlobal("window", { NERI_API_BASE: "same-origin" });
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
    expect(request.mock.calls[0][1].headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer token" });
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
