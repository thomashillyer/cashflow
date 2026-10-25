import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = { access_token: "test-token", user: { email: "owner@example.com" } };
let clientAuth;
let auth;

beforeEach(async () => {
  vi.resetModules();
  clientAuth = {
    signUp: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    signInWithPassword: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    signInWithOtp: vi.fn(),
  };
  vi.stubGlobal("window", {
    NERI_SUPABASE_URL: "https://example.supabase.co",
    NERI_SUPABASE_ANON_KEY: "public-test-key",
    supabase: { createClient: () => ({ auth: clientAuth }) },
  });
  auth = await import("./auth.js");
});
afterEach(() => vi.unstubAllGlobals());

describe("email and password accounts", () => {
  it("creates an authenticated account without requesting an email code", async () => {
    expect(await auth.createAccount("owner@example.com", "test password 123")).toBe(session);
    expect(clientAuth.signUp).toHaveBeenCalledWith({ email: "owner@example.com", password: "test password 123" });
    expect(clientAuth.signInWithOtp).not.toHaveBeenCalled();
  });

  it("signs in an existing account without requesting an email code", async () => {
    expect(await auth.signIn("owner@example.com", "test password 123")).toBe(session);
    expect(clientAuth.signInWithPassword).toHaveBeenCalledWith({ email: "owner@example.com", password: "test password 123" });
    expect(clientAuth.signUp).not.toHaveBeenCalled();
    expect(clientAuth.signInWithOtp).not.toHaveBeenCalled();
  });

  it("does not treat a signup without a session as signed in", async () => {
    clientAuth.signUp.mockResolvedValue({ data: { user: session.user, session: null }, error: null });
    await expect(auth.createAccount("owner@example.com", "test password 123")).rejects.toThrow(/sign-in.*ready/i);
  });

  it("rejects a short password before making a signup request", async () => {
    await expect(auth.createAccount("owner@example.com", "short")).rejects.toThrow("Use at least 8 characters for your password.");
    expect(clientAuth.signUp).not.toHaveBeenCalled();
  });

  it("does not impose the new-password length on returning users", async () => {
    await auth.signIn("owner@example.com", "old123");
    expect(clientAuth.signInWithPassword).toHaveBeenCalled();
  });

  it("explains invalid credentials without showing provider text", async () => {
    clientAuth.signInWithPassword.mockResolvedValue({ data: {}, error: { code: "invalid_credentials", message: "private provider detail" } });
    await expect(auth.signIn("owner@example.com", "wrong password")).rejects.toThrow("Email or password didn't match. Try again.");
  });

  it("does not silently sign up or replace credentials for an existing email", async () => {
    clientAuth.signUp.mockResolvedValue({ data: {}, error: { code: "user_already_exists", message: "User already registered" } });
    await expect(auth.createAccount("owner@example.com", "test password 123")).rejects.toThrow(/already has an account.*sign in/i);
    expect(clientAuth.signInWithPassword).not.toHaveBeenCalled();
  });
});
