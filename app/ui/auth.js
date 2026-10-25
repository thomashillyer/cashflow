// Sign-in for real businesses: Supabase Auth, passwordless. The owner gets a one-time code at their
// business email; Supabase issues a short-lived session (JWT) that every API and database call carries.
// Row-level security in the database decides which business that session can see (see
// supabase/migrations/*_tenant_access.sql). Nothing here holds a secret: the anon key is public by design,
// and it can only read what row-level security allows.
//
// Turn on by setting window.NERI_SUPABASE_URL and window.NERI_SUPABASE_ANON_KEY in app/config.js.
// Without them the app runs the preview sign-up, which never leaves this browser.

const CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";

export const authConfigured = Boolean(window.NERI_SUPABASE_URL && window.NERI_SUPABASE_ANON_KEY);

let client = null;
async function sb() {
  if (client) return client;
  if (!window.supabase?.createClient) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = CDN;
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

/** Send a one-time code to the email. Creates the user on first sign-in. */
export async function sendCode(email) {
  const c = await sb();
  const { error } = await c.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) throw new Error(friendly(error));
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
  if (/rate|too many|security purposes/i.test(m)) return "Too many tries. Wait a minute, then ask for a new code.";
  if (/expired|invalid|token/i.test(m)) return "That code didn't work or has expired. Ask for a new one.";
  if (/email/i.test(m)) return "Check the email address and try again.";
  return "Sign-in didn't go through. Try again in a moment.";
}
