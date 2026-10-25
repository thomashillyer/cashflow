import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let url;
let createClient;
let auth;
const session = { access_token: "session-token", user: { email: "owner@example.com" } };

beforeEach(() => {
  vi.resetModules();
  url = new URL("https://neri.example/#/welcome");
  auth = {
    signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
    exchangeCodeForSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    verifyOtp: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
  };
  createClient = vi.fn(() => {
    // auth-js can auto-consume a PKCE callback during construction, even with URL detection off.
    expect(url.searchParams.has("code")).toBe(false);
    return { auth };
  });
  vi.stubGlobal("window", {
    NERI_SUPABASE_URL: "https://example.supabase.co",
    NERI_SUPABASE_ANON_KEY: "public-key",
    supabase: { createClient },
    get location() { return url; },
    history: { state: null, replaceState: vi.fn((_state, _title, next) => { url = new URL(next, url); }) },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("passwordless email sign-in", () => {
  it("requests the default email using PKCE and the configured Supabase Site URL", async () => {
    const { sendCode } = await import("./auth.js");
    await sendCode("owner@example.com");
    expect(auth.signInWithOtp).toHaveBeenCalledWith({ email: "owner@example.com", options: { shouldCreateUser: true } });
    expect(createClient.mock.calls[0][2].auth).toMatchObject({ flowType: "pkce", detectSessionInUrl: false, persistSession: true });
  });

  it.each(["", "#/welcome", "#/today"])("exchanges a root callback once and preserves the hash route %s", async (hash) => {
    url = new URL(`https://neri.example/?code=one-time-code&keep=yes${hash}`);
    const { consumeEmailLink } = await import("./auth.js");
    expect(await consumeEmailLink()).toBe(session);
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("one-time-code");
    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(url.search).toBe("?keep=yes");
    expect(url.hash).toBe(hash);
    expect(await consumeEmailLink()).toBeNull();
    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
  });

  it("shows a safe error and cleans an expired link without rendering provider text", async () => {
    url = new URL("https://neri.example/#error=access_denied&error_code=otp_expired&error_description=untrusted-private-text");
    const { consumeEmailLink } = await import("./auth.js");
    await expect(consumeEmailLink()).rejects.toThrow("expired or was already used");
    expect(url.href).toBe("https://neri.example/");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("cleans callback failures inside an app hash route", async () => {
    url = new URL("https://neri.example/?keep=yes#/welcome?error=access_denied&error_description=private");
    const { consumeEmailLink } = await import("./auth.js");
    await expect(consumeEmailLink()).rejects.toThrow("open it in the browser where you started");
    expect(url.href).toBe("https://neri.example/?keep=yes#/welcome");
  });

  it("consumes an email code appended inside the welcome hash route", async () => {
    url = new URL("https://neri.example/#/welcome?code=one-time-code");
    const { consumeEmailLink } = await import("./auth.js");
    expect(await consumeEmailLink()).toBe(session);
    expect(url.href).toBe("https://neri.example/#/welcome");
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("one-time-code");
  });

  it("explains a missing verifier or failed exchange and removes the consumed code", async () => {
    url = new URL("https://neri.example/?code=used-code#/welcome");
    auth.exchangeCodeForSession.mockResolvedValue({ data: { session: null }, error: { message: "invalid code verifier: private" } });
    const { consumeEmailLink } = await import("./auth.js");
    await expect(consumeEmailLink()).rejects.toThrow("opened in a different browser");
    expect(url.href).toBe("https://neri.example/#/welcome");
  });

  it("does not expose a thrown exchange error or return a partial session", async () => {
    url = new URL("https://neri.example/?code=one-time-code");
    auth.exchangeCodeForSession.mockRejectedValue(new Error("private server response"));
    const { consumeEmailLink } = await import("./auth.js");
    await expect(consumeEmailLink()).rejects.toThrow("Check your connection");
    expect(url.search).toBe("");
  });

  it("rejects implicit token injection instead of accepting an attacker-supplied session", async () => {
    url = new URL("https://neri.example/#access_token=attacker&refresh_token=secret&type=magiclink");
    const { consumeEmailLink } = await import("./auth.js");
    await expect(consumeEmailLink()).rejects.toThrow("Ask for a new sign-in email");
    expect(url.href).toBe("https://neri.example/");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("leaves ordinary app URLs alone and does not initialize auth", async () => {
    const { consumeEmailLink } = await import("./auth.js");
    expect(await consumeEmailLink()).toBeNull();
    expect(url.href).toBe("https://neri.example/#/welcome");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("keeps code verification and session tokens working for OTP templates", async () => {
    const { verifyCode, accessToken } = await import("./auth.js");
    expect(await verifyCode("owner@example.com", " 123456 ")).toBe(session);
    expect(auth.verifyOtp).toHaveBeenCalledWith({ email: "owner@example.com", token: "123456", type: "email" });
    expect(await accessToken()).toBe("session-token");
  });

  it.each([
    [{ code: "email_address_not_authorized", message: "Email address not authorized" }, "isn't enabled for demo sign-in"],
    [{ message: "email rate limit exceeded" }, "Try later, or explore a sample business"],
  ])("explains the sender restriction with an actionable next step %j", async (error, message) => {
    auth.signInWithOtp.mockResolvedValue({ error });
    const { sendCode } = await import("./auth.js");
    await expect(sendCode("owner@example.com")).rejects.toThrow(message);
  });
});
