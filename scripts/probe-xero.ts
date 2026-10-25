// Local probe: read the Xero Demo Company (or your org) through the read-only connector and print counts only.
//   npx tsx --env-file=.env scripts/probe-xero.ts
// Xero rotates refresh tokens: every refresh returns a new one, which is saved back to .env.

import { pullXero } from "../adapters/xero";
import { basicAuth, need, updateEnv } from "./lib/oauth-local";

const res = await fetch("https://identity.xero.com/connect/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(need("XERO_CLIENT_ID"), need("XERO_CLIENT_SECRET")) },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: need("XERO_REFRESH_TOKEN") }),
});
const t = (await res.json()) as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
if (!t.access_token) { console.error(`Token refresh failed: ${t.error ?? res.status}. Run scripts/xero-connect.ts again.`); process.exit(1); }
if (t.refresh_token) updateEnv({ XERO_REFRESH_TOKEN: t.refresh_token });
console.log(`token ok (scopes: ${t.scope ?? "unknown"})`);

const r = await pullXero({ token: async () => t.access_token!, now: new Date().toISOString() });
if (!r.ok) { console.error("pull failed:", r.error); process.exit(1); }
const d = r.data;
const by = <T>(xs: T[], f: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
console.log("commitments:", d.commitments.length, by(d.commitments, (c) => `${c.type}/${c.settlement}`));
console.log("parties:", d.parties.length, "settlements:", d.settlements.length, "unapplied payments:", d.unallocatedPayments.length, "paymentHistory:", d.paymentHistory.length);
console.log("missing due date:", d.commitments.filter((c) => !c.anchors.due).length, "currencies:", [...new Set(d.commitments.map((c) => c.currency))]);
console.log("diagnostics:", { rowsRead: d.diagnostics.rowsRead, rowsImported: d.diagnostics.rowsImported, completeness: d.diagnostics.completeness });
console.log("error codes:", by(d.diagnostics.errors, (e) => e.code), "warnings:", d.diagnostics.warnings);
