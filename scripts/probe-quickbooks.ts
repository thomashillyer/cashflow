// Local probe: read a QuickBooks Online company (sandbox by default) through the read-only connector, counts only.
//   npx tsx --env-file=.env scripts/probe-quickbooks.ts
// QuickBooks may return a new refresh token on refresh; it is saved back to .env.

import { pullQuickBooks } from "../adapters/quickbooks";
import { basicAuth, need, updateEnv } from "./lib/oauth-local";

const res = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: basicAuth(need("QUICKBOOKS_CLIENT_ID"), need("QUICKBOOKS_CLIENT_SECRET")) },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: need("QUICKBOOKS_REFRESH_TOKEN") }),
});
const t = (await res.json()) as { access_token?: string; refresh_token?: string; error?: string };
if (!t.access_token) { console.error(`Token refresh failed: ${t.error ?? res.status}. Run scripts/quickbooks-connect.ts again.`); process.exit(1); }
if (t.refresh_token) updateEnv({ QUICKBOOKS_REFRESH_TOKEN: t.refresh_token });
console.log("token ok");

const environment = process.env.QUICKBOOKS_ENV === "production" ? "production" : "sandbox";
const r = await pullQuickBooks({ token: async () => t.access_token!, realmId: need("QUICKBOOKS_REALM_ID"), environment, now: new Date().toISOString() });
if (!r.ok) { console.error("pull failed:", r.error); process.exit(1); }
const d = r.data;
const by = <T>(xs: T[], f: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
console.log("environment:", environment);
console.log("commitments:", d.commitments.length, by(d.commitments, (c) => `${c.type}/${c.settlement}`));
console.log("parties:", d.parties.length, "settlements:", d.settlements.length, "unapplied payments:", d.unallocatedPayments.length, "paymentHistory:", d.paymentHistory.length);
console.log("missing due date:", d.commitments.filter((c) => !c.anchors.due).length, "currencies:", [...new Set(d.commitments.map((c) => c.currency))]);
console.log("diagnostics:", { rowsRead: d.diagnostics.rowsRead, rowsImported: d.diagnostics.rowsImported, completeness: d.diagnostics.completeness });
console.log("error codes:", by(d.diagnostics.errors, (e) => e.code), "warnings:", d.diagnostics.warnings);
