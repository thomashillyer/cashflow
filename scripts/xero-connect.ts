// One-time Xero consent for the app in .env. Register http://localhost:8790/oauth/xero/callback on it.
//   npx tsx --env-file=.env scripts/xero-connect.ts
// Scopes are read-only. Override with XERO_SCOPES if your app was created before Xero's granular scopes
// (then use: offline_access accounting.transactions.read accounting.contacts.read).

import { basicAuth, need, runConsent } from "./lib/oauth-local";

const scopes = process.env.XERO_SCOPES ?? "offline_access accounting.invoices.read accounting.payments.read accounting.contacts.read";

runConsent({
  path: "/oauth/xero/callback",
  buildAuthUrl: (redirect, state) => `https://login.xero.com/identity/connect/authorize?${new URLSearchParams({
    response_type: "code", client_id: need("XERO_CLIENT_ID"), redirect_uri: redirect, scope: scopes, state,
  })}`,
  exchange: async (code, redirect) => {
    const r = await fetch("https://identity.xero.com/connect/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(need("XERO_CLIENT_ID"), need("XERO_CLIENT_SECRET")) },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect }),
    });
    const b = (await r.json()) as { refresh_token?: string; scope?: string; error?: string };
    if (!b.refresh_token) throw new Error(b.error ?? String(r.status));
    return { updates: { XERO_REFRESH_TOKEN: b.refresh_token }, info: `scopes: ${b.scope ?? "unknown"}` };
  },
});
