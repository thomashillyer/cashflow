// Sign-in for real businesses: Supabase Auth with email and password. Email confirmations are
// disabled for this demo; every API call still carries the owner's authenticated session.
// Row-level security in the database decides which business that session can see (see
// supabase/migrations/*_tenant_access.sql). Nothing here holds a secret: the anon key is public by design,
// and it can only read what row-level security allows.
//
// Turn on by setting window.NERI_SUPABASE_URL and window.NERI_SUPABASE_ANON_KEY in app/config.js.
// Without them the app runs the preview sign-up, which never leaves this browser.

// TODO before real data: add an integrity (SRI) hash for this file, or bundle supabase-js with the app.
const CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js";

export const authConfigured = Boolean(window.NERI_SUPABASE_URL && window.NERI_SUPABASE_ANON_KEY);

let client = null;
async function sb() {
  if (client) return client;
  if (!window.supabase?.createClient) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = CDN;
      s.crossOrigin = "anonymous";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Couldn't reach the sign-in service. Check your connection and try again."));
      document.head.append(s);
    });
  }
  client = window.supabase.createClient(window.NERI_SUPABASE_URL, window.NERI_SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: "pkce" },
  });
  return client;
}

function passwordError(error) {
  if (error?.code === "invalid_credentials") return "Email or password didn't match. Try again.";
  if (error?.code === "user_already_exists" || error?.code === "email_exists") return "This email already has an account. Choose Sign in instead. If you previously used email links, ask the Neri team for help.";
  if (error?.code === "weak_password") return "Choose a stronger password with at least 8 characters.";
  if (error?.code === "email_not_confirmed") return "This account needs help signing in. Contact the Neri team, or use a sample business.";
  if (error?.code === "over_request_rate_limit" || error?.status === 429) return "Too many sign-in attempts. Wait a few minutes and try again.";
  if (error?.code === "email_address_invalid" || error?.code === "validation_failed") return "Check the email address and try again.";
  return "Sign-in didn't go through. Try again in a moment.";
}

function checkCredentials(email, password, creating = false) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter your work email, like you@yourbusiness.com.");
  if (!password) throw new Error("Enter your password.");
  if (creating && password.length < 8) throw new Error("Use at least 8 characters for your password.");
}

/** Passwords go directly to Supabase; Neri never stores them in its account or business data. */
export async function createAccount(email, password) {
  checkCredentials(email, password, true);
  const c = await sb();
  const { data, error } = await c.auth.signUp({ email, password });
  if (error) throw new Error(passwordError(error));
  if (!data?.session) throw new Error("Account sign-in isn't ready. Contact the Neri team, or try signing in.");
  return data.session;
}

export async function signIn(email, password) {
  checkCredentials(email, password);
  const c = await sb();
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(passwordError(error));
  if (!data?.session) throw new Error("Sign-in didn't go through. Try again in a moment.");
  return data.session;
}

/** Legacy email sign-in remains compatible with links already sent before password accounts. */
export async function sendCode(email) {
  const c = await sb();
  // No redirect override: Supabase uses its configured Site URL, also for the built-in sender.
  const { error } = await c.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) throw new Error(friendly(error));
}

/** Consume a PKCE email callback before the app reads its hash route or initializes Supabase. */
export async function consumeEmailLink() {
  if (!authConfigured) return null;
  const url = new URL(window.location.href);
  const hash = url.hash.slice(1);
  const route = hash.startsWith("/") ? hash.split("?")[0] : "";
  const fragment = new URLSearchParams(route ? (hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "") : hash);
  const authKeys = ["code", "error", "error_code", "error_description", "access_token", "refresh_token", "expires_in", "expires_at", "token_type", "type"];
  const hasCode = url.searchParams.has("code") || fragment.has("code");
  const hasError = ["error", "error_code", "error_description"].some((k) => url.searchParams.has(k) || fragment.has(k));
  const implicit = fragment.has("access_token") || fragment.has("refresh_token");
  if (!hasCode && !hasError && !implicit) return null;
  const code = url.searchParams.get("code") ?? fragment.get("code");
  const errorCode = url.searchParams.get("error_code") || fragment.get("error_code");
  for (const key of authKeys) {
    url.searchParams.delete(key);
    fragment.delete(key);
  }
  url.hash = route ? route + (fragment.size ? `?${fragment}` : "") : (fragment.size ? fragment.toString() : "");
  // Clean credentials before creating the client: older auth-js versions auto-exchange PKCE callbacks
  // even with detectSessionInUrl:false. Explicit exchange below must happen exactly once.
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  if (hasError) throw new Error(errorCode === "otp_expired"
    ? "That sign-in link has expired or was already used. Ask for a new email."
    : "That sign-in link didn't work. Ask for a new email and open it in the browser where you started.");
  if (implicit || !code) throw new Error("Ask for a new sign-in email, then open its link in the browser where you started.");
  const c = await sb();
  try {
    const { data, error } = await c.auth.exchangeCodeForSession(code);
    if (error || !data?.session) throw new Error("exchange failed");
    return data.session;
  } catch {
    throw new Error("Couldn't finish sign-in. The link may have expired, been used, or opened in a different browser. Check your connection, then ask for a new email and open it where you started.");
  }
}

/** Check the code; on success Supabase stores a session in this browser. */
export async function verifyCode(email, code) {
  const c = await sb();
  const { data, error } = await c.auth.verifyOtp({ email, token: code.trim(), type: "email" });
  if (error) throw new Error(friendly(error));
  return data.session;
}

export async function currentSession() {
  if (!authConfigured) return null;
  const c = await sb();
  const { data } = await c.auth.getSession();
  return data.session ?? null;
}

/** Bearer token for API calls. */
export async function accessToken() {
  return (await currentSession())?.access_token ?? null;
}

/** "Sign out everywhere" ends every session for this user, on every device. */
export async function signOut({ everywhere = false } = {}) {
  if (!authConfigured) return;
  const c = await sb();
  await c.auth.signOut({ scope: everywhere ? "global" : "local" });
}

function friendly(error) {
  const m = String(error?.message ?? "");
  if (error?.code === "email_address_not_authorized" || /email address not authorized|only.*authorized.*email/i.test(m)) return "This email address isn't enabled for demo sign-in. Use a sample business, or ask the team for access.";
  if (/rate|too many|security purposes/i.test(m)) return "The sign-in email limit was reached. Try later, or explore a sample business without signing in.";
  if (/expired|invalid|token/i.test(m)) return "That code didn't work or has expired. Ask for a new one.";
  if (/email/i.test(m)) return "Check the email address and try again.";
  return "Sign-in didn't go through. Try again in a moment.";
}
