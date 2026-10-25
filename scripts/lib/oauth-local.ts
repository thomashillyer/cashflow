// Local one-time OAuth consent for connector probes. Starts a server on the registered redirect address
// (http://localhost:8790/<path>), opens the provider's consent page, hands the callback to `exchange`,
// and saves what it returns into .env. Prints no secrets. Not used by the hosted app.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

export const PORT = 8790;

export const need = (k: string): string => {
  const v = process.env[k];
  if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
  return v;
};

export function updateEnv(updates: Record<string, string>): void {
  let env = readFileSync(".env", "utf8");
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    env = re.test(env) ? env.replace(re, () => `${k}=${v}`) : `${env.replace(/\n?$/, "\n")}${k}=${v}\n`;
  }
  writeFileSync(".env", env, { mode: 0o600 });
}

export const basicAuth = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

export function runConsent(opts: {
  path: string;
  buildAuthUrl: (redirect: string, state: string) => string;
  exchange: (code: string, redirect: string, params: URLSearchParams) => Promise<{ updates: Record<string, string>; info: string }>;
}): void {
  const redirect = `http://localhost:${PORT}${opts.path}`;
  const state = randomBytes(16).toString("hex");
  const done = (code: number, msg: string) => { console.log(msg); setTimeout(() => process.exit(code), 200); };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (url.pathname !== opts.path) { res.writeHead(404).end("Not found"); return; }
    const page = (t: string) => { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(t); };
    if (url.searchParams.get("state") !== state) { page("State mismatch. Close this tab and run the script again."); return done(1, "State mismatch; aborted."); }
    const err = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (err || !code) { page(`No code from the provider (${err ?? "none"}). Close this tab.`); return done(1, `Consent failed: ${err ?? "no code"}`); }
    try {
      const { updates, info } = await opts.exchange(code, redirect, url.searchParams);
      updateEnv(updates);
      page("Connected for Neri (read-only). You can close this tab.");
      done(0, `saved ${Object.keys(updates).join(", ")} to .env (${info})`);
    } catch (e) {
      page("Token exchange failed. Close this tab.");
      done(1, `Token exchange failed: ${(e as Error).message}`);
    }
  });
  server.on("error", (e: NodeJS.ErrnoException) => done(1, e.code === "EADDRINUSE" ? `Port ${PORT} is in use. Stop whatever is using it and run again.` : `Server error: ${e.message}`));
  server.listen(PORT, "localhost", () => {
    const authUrl = opts.buildAuthUrl(redirect, state);
    console.log(`Waiting for consent on ${redirect} ...`);
    console.log("Opening the consent page in your browser. If it does not open, copy this address into it:");
    console.log(authUrl);
    execFile("open", [authUrl], () => {});
  });
  setTimeout(() => done(1, "Timed out after 15 minutes without consent."), 15 * 60_000);
}
