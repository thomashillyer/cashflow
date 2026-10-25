// Local probe: run the read-only Zoho Books connector against a real account and print what shape it
// found. Reads ZOHO_* from the environment (run with `npx tsx --env-file=.env scripts/probe-zoho.ts`).
// Prints counts, field presence, and row-error codes only: no names, amounts, tokens, or secrets.

import { pullZoho } from "../adapters/zoho_books";
import type { ZohoRegion } from "../adapters/zoho_books/client";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
  return v;
};

const apiDomain = need("ZOHO_API_DOMAIN");
const region = (new URL(apiDomain).hostname.replace(/^www\.zohoapis\./, "")) as ZohoRegion;
const accounts = `https://accounts.zoho.${region}/oauth/v2/token`;

async function accessToken(): Promise<string> {
  const res = await fetch(accounts, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: need("ZOHO_REFRESH_TOKEN"), client_id: need("ZOHO_CLIENT_ID"), client_secret: need("ZOHO_CLIENT_SECRET") }),
  });
  const body = (await res.json()) as { access_token?: string; error?: string; scope?: string };
  if (!body.access_token) { console.error(`Token exchange failed: ${res.status} ${body.error ?? "no access_token"}`); process.exit(1); }
  console.log(`token ok (scopes: ${body.scope ?? "unknown"})`);
  return body.access_token;
}

const token = await accessToken();
const r = await pullZoho({ region, token: async () => token, now: new Date().toISOString() });
if (!r.ok) { console.error("pull failed:", r.error); process.exit(1); }
const d = r.data;
const by = <T>(xs: T[], f: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
console.log("region:", region);
console.log("commitments:", d.commitments.length, by(d.commitments, (c) => `${c.type}/${c.settlement}`));
console.log("parties:", d.parties.length, "settlements:", d.settlements.length, "paymentHistory:", d.paymentHistory.length, "evidence:", d.evidence.length);
console.log("missing due date:", d.commitments.filter((c) => !c.anchors.due).length, "no party:", d.commitments.filter((c) => !c.partyId).length, "currencies:", [...new Set(d.commitments.map((c) => c.currency))]);
console.log("diagnostics:", { rowsRead: d.diagnostics.rowsRead, rowsImported: d.diagnostics.rowsImported, rowsRejected: d.diagnostics.rowsRejected, completeness: d.diagnostics.completeness });
console.log("error codes:", by(d.diagnostics.errors, (e) => e.code));
console.log("warnings:", d.diagnostics.warnings);
