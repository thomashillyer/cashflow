// Exchange a Zoho Self Client grant code for a refresh token and store it in .env (ZOHO_REFRESH_TOKEN).
// A grant code lives about 10 minutes and works once, so generate it right before running this:
//   npx tsx --env-file=.env scripts/zoho-exchange-code.ts <grant-code>
// Prints only whether it worked and the granted scopes. The token is written to .env, never printed.

import { readFileSync, writeFileSync } from "node:fs";

const code = process.argv[2];
const need = (k: string) => {
  const v = process.env[k];
  if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
  return v;
};
if (!code) { console.error("Usage: tsx --env-file=.env scripts/zoho-exchange-code.ts <grant-code>"); process.exit(1); }

const region = new URL(need("ZOHO_API_DOMAIN")).hostname.replace(/^www\.zohoapis\./, "");
const res = await fetch(`https://accounts.zoho.${region}/oauth/v2/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: need("ZOHO_CLIENT_ID"), client_secret: need("ZOHO_CLIENT_SECRET") }),
});
const body = (await res.json()) as { refresh_token?: string; scope?: string; error?: string };
if (!body.refresh_token) {
  console.error(`Exchange failed: ${body.error ?? res.status}. The code may have expired or already been used; generate a new one.`);
  process.exit(1);
}
const env = readFileSync(".env", "utf8");
const line = `ZOHO_REFRESH_TOKEN=${body.refresh_token}`;
writeFileSync(".env", /^ZOHO_REFRESH_TOKEN=.*$/m.test(env) ? env.replace(/^ZOHO_REFRESH_TOKEN=.*$/m, () => line) : `${env.replace(/\n?$/, "\n")}${line}\n`, { mode: 0o600 });
console.log(`refresh token saved to .env (scopes: ${body.scope ?? "unknown"})`);
