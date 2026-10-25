// One-time Zoho Books consent on this machine, for the "server-based" OAuth client in .env.
// Runs the standard web flow: opens Zoho's consent screen, receives the code at the redirect URI
// registered on the client (http://localhost:8790/oauth/zoho/callback), exchanges it, and saves the
// refresh token to .env (ZOHO_REFRESH_TOKEN). Read-only Books scopes (no CRM until a CRM adapter exists:
// a scope the account does not offer fails the whole consent). Sign in as a user who can see the Books org. Prints no secrets.
//   npx tsx --env-file=.env scripts/zoho-connect.ts

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
  return v;
};
const PORT = 8790;
const REDIRECT = `http://localhost:${PORT}/oauth/zoho/callback`;
const region = new URL(need("ZOHO_API_DOMAIN")).hostname.replace(/^www\.zohoapis\./, "");
const accounts = `https://accounts.zoho.${region}/oauth/v2`;
const SCOPES = [
  "ZohoBooks.invoices.READ", "ZohoBooks.bills.READ", "ZohoBooks.contacts.READ",
  "ZohoBooks.customerpayments.READ", "ZohoBooks.vendorpayments.READ", "ZohoBooks.purchaseorders.READ", "ZohoBooks.settings.READ", "ZohoBooks.banking.READ",
].join(",");
const state = randomBytes(16).toString("hex");

const authUrl = `${accounts}/auth?${new URLSearchParams({
  scope: SCOPES, client_id: need("ZOHO_CLIENT_ID"), response_type: "code", access_type: "offline", redirect_uri: REDIRECT, prompt: "consent", state,
})}`;

const done = (code: number, msg: string) => { console.log(msg); setTimeout(() => process.exit(code), 200); };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/oauth/zoho/callback") { res.writeHead(404).end("Not found"); return; }
  const page = (text: string) => { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(text); };
  if (url.searchParams.get("state") !== state) { page("State mismatch. Close this tab and run the script again."); return done(1, "State mismatch; aborted."); }
  const err = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (err || !code) { page(`Zoho did not give a code (${err ?? "none"}). Close this tab.`); return done(1, `Consent failed: ${err ?? "no code"}`); }
  const r = await fetch(`${accounts}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: need("ZOHO_CLIENT_ID"), client_secret: need("ZOHO_CLIENT_SECRET"), redirect_uri: REDIRECT }),
  });
  const body = (await r.json()) as { refresh_token?: string; scope?: string; error?: string };
  if (!body.refresh_token) { page("Token exchange failed. Close this tab."); return done(1, `Token exchange failed: ${body.error ?? r.status}`); }
  const env = readFileSync(".env", "utf8");
  const line = `ZOHO_REFRESH_TOKEN=${body.refresh_token}`;
  writeFileSync(".env", /^ZOHO_REFRESH_TOKEN=.*$/m.test(env) ? env.replace(/^ZOHO_REFRESH_TOKEN=.*$/m, () => line) : `${env.replace(/\n?$/, "\n")}${line}\n`, { mode: 0o600 });
  page("Zoho Books is connected for Neri (read-only). You can close this tab.");
  done(0, `refresh token saved to .env (scopes: ${body.scope ?? "unknown"})`);
});

server.on("error", (e: NodeJS.ErrnoException) => done(1, e.code === "EADDRINUSE" ? `Port ${PORT} is in use (is the Neri prototype running?). Stop it and run again.` : `Server error: ${e.message}`));
server.listen(PORT, "localhost", () => {
  console.log(`Waiting for Zoho consent on ${REDIRECT} ...`);
  console.log("Opening the consent page in your browser. If it does not open, copy this address into it:");
  console.log(authUrl);
  execFile("open", [authUrl], () => {});
});
setTimeout(() => done(1, "Timed out after 15 minutes without consent."), 15 * 60_000);
