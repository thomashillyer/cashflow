// Local probe: run the read-only Outlook connector against a real mailbox with an app-only token.
// Run with `npx tsx --env-file=.env scripts/probe-outlook.ts`. Prints counts and error codes only:
// no subjects, senders, bodies, tokens, or secrets.

import { pullOutlook } from "../adapters/outlook";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
  return v;
};

const tenant = need("MICROSOFT_TENANT_ID");
const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: need("MICROSOFT_CLIENT_ID"), client_secret: need("MICROSOFT_CLIENT_SECRET"), scope: "https://graph.microsoft.com/.default" }),
});
const body = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
if (!body.access_token) { console.error(`Token exchange failed: ${res.status} ${body.error ?? "no access_token"}`); process.exit(1); }
const roles = (() => { try { return (JSON.parse(Buffer.from(body.access_token.split(".")[1]!, "base64url").toString()) as { roles?: string[] }).roles ?? []; } catch { return []; } })();
console.log("token ok; app roles:", roles);

const now = new Date();
const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
const r = await pullOutlook({ token: async () => body.access_token!, now: now.toISOString(), since, mailbox: need("MICROSOFT_MAILBOX_UPN") });
if (!r.ok) { console.error("pull failed:", r.error); process.exit(1); }
const d = r.data;
console.log("money-related messages kept:", d.inputs.length);
console.log("attachments kept:", d.inputs.reduce((n, i) => n + (i.attachments?.length ?? 0), 0), "with sheets:", d.inputs.reduce((n, i) => n + (i.attachments ?? []).filter((a) => a.sheets).length, 0));
console.log("diagnostics:", { rowsRead: d.diagnostics.rowsRead, rowsImported: d.diagnostics.rowsImported, completeness: d.diagnostics.completeness, newestRecordAt: d.diagnostics.newestRecordAt });
console.log("error codes:", d.diagnostics.errors.map((e) => e.code));
console.log("warnings:", d.diagnostics.warnings);
