// One-time QuickBooks Online consent for the app in .env. Register
// http://localhost:8790/oauth/quickbooks/callback on its development keys. QUICKBOOKS_ENV=sandbox (default) or production.
//   npx tsx --env-file=.env scripts/quickbooks-connect.ts
// The company (realm) id arrives with the callback and is saved with the refresh token.

import { basicAuth, need, runConsent } from "./lib/oauth-local";

runConsent({
  path: "/oauth/quickbooks/callback",
  buildAuthUrl: (redirect, state) => `https://appcenter.intuit.com/connect/oauth2?${new URLSearchParams({
    client_id: need("QUICKBOOKS_CLIENT_ID"), response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: redirect, state,
  })}`,
  exchange: async (code, redirect, params) => {
    const realm = params.get("realmId");
    if (!realm || !/^\d{1,20}$/.test(realm)) throw new Error("no company (realm) id in the callback");
    const r = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: basicAuth(need("QUICKBOOKS_CLIENT_ID"), need("QUICKBOOKS_CLIENT_SECRET")) },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect }),
    });
    const b = (await r.json()) as { refresh_token?: string; error?: string };
    if (!b.refresh_token) throw new Error(b.error ?? String(r.status));
    return { updates: { QUICKBOOKS_REFRESH_TOKEN: b.refresh_token, QUICKBOOKS_REALM_ID: realm }, info: `company ${realm}` };
  },
});
