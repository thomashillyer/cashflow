// How the server gets a connected source's token for a business. The hosted Connect flow (per-owner OAuth,
// tokens in the store) is #128; until it lands, a deployment can allow the operator to use the server's own Zoho
// and Microsoft app credentials: the business named by NERI_SOURCE_BUSINESS, or the signed-in user whose VERIFIED
// email is NERI_SOURCE_EMAIL (the email comes from the verified session token, never from the request body).
// Everyone else gets "not connected", so one owner can never pull the operator's accounts into their own books.

import { ConnectorFailure } from "../adapters/connector";
import type { SourceAccess, SourceId } from "../adapters/pull";
import { ZOHO_REGIONS, type ZohoRegion } from "../adapters/zoho_books/client";

export type SourceCtx = { business: { id: string; isSynthetic: boolean }; user?: { id: string; email?: string } };
export type SourceAccessFn = (ctx: SourceCtx, source: SourceId) => SourceAccess | undefined | Promise<SourceAccess | undefined>;

type Cached = { token: string; until: number };

export function envSourceAccess(env: NodeJS.ProcessEnv, now: () => number = Date.now, doFetch: typeof fetch = fetch): SourceAccessFn | undefined {
  const onlyBusiness = env.NERI_SOURCE_BUSINESS;
  const onlyEmail = env.NERI_SOURCE_EMAIL?.trim().toLowerCase();
  if (!onlyBusiness && !onlyEmail) return undefined;
  const cache = new Map<string, Cached>();
  // A refused or failed token exchange is an auth/network problem the owner can act on, never "unreadable data".
  // The provider's answer is never put in the message.
  const cached = async (key: string, provider: string, fallback: "file" | "paste", mint: () => Promise<{ token: string; expiresIn: number } | undefined>): Promise<string> => {
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.token;
    const alt = fallback === "paste" ? "paste the message instead" : "upload an export instead";
    let fresh: { token: string; expiresIn: number } | undefined;
    try { fresh = await mint(); } catch {
      throw new ConnectorFailure({ kind: "network", message: `${provider} did not answer the server's sign-in.`, nextStep: `Try again in a minute, or ${alt}.`, fallback });
    }
    if (!fresh) throw new ConnectorFailure({ kind: "auth", message: `${provider} refused the server's connection.`, nextStep: `Ask whoever runs this server to reconnect ${provider}, or ${alt}.`, fallback });
    cache.set(key, { token: fresh.token, until: now() + Math.max(0, fresh.expiresIn - 60) * 1000 });
    return fresh.token;
  };

  const zohoRegion = ((): ZohoRegion | undefined => {
    try {
      const r = new URL(env.ZOHO_API_DOMAIN ?? "").hostname.replace(/^www\.zohoapis\./, "");
      return (ZOHO_REGIONS as readonly string[]).includes(r) ? (r as ZohoRegion) : undefined;
    } catch { return undefined; }
  })();
  const zohoToken = (region: ZohoRegion) => () => cached("zoho", "Zoho", "file", async () => {
    if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET || !env.ZOHO_REFRESH_TOKEN) return undefined;
    const r = await doFetch(`https://accounts.zoho.${region}/oauth/v2/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: env.ZOHO_REFRESH_TOKEN, client_id: env.ZOHO_CLIENT_ID, client_secret: env.ZOHO_CLIENT_SECRET }),
    });
    const b = (await r.json()) as { access_token?: string; expires_in?: number };
    return b.access_token ? { token: b.access_token, expiresIn: b.expires_in ?? 3600 } : undefined;
  });
  const msToken = () => cached("microsoft", "Microsoft", "paste", async () => {
    if (!env.MICROSOFT_TENANT_ID || !env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) return undefined;
    const r = await doFetch(`https://login.microsoftonline.com/${encodeURIComponent(env.MICROSOFT_TENANT_ID)}/oauth2/v2.0/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.MICROSOFT_CLIENT_ID, client_secret: env.MICROSOFT_CLIENT_SECRET, scope: "https://graph.microsoft.com/.default" }),
    });
    const b = (await r.json()) as { access_token?: string; expires_in?: number };
    return b.access_token ? { token: b.access_token, expiresIn: b.expires_in ?? 3600 } : undefined;
  });

  return ({ business, user }, source) => {
    if (business.isSynthetic) return undefined;
    const allowed = (onlyBusiness !== undefined && business.id === onlyBusiness) || (onlyEmail !== undefined && user?.email?.trim().toLowerCase() === onlyEmail);
    if (!allowed) return undefined;
    if ((source === "zoho_books" || source === "zoho_crm") && zohoRegion && env.ZOHO_REFRESH_TOKEN) {
      return { token: zohoToken(zohoRegion), region: zohoRegion, ...(source === "zoho_books" && env.ZOHO_ORG_ID ? { organizationId: env.ZOHO_ORG_ID } : {}) };
    }
    if (source === "outlook" && env.MICROSOFT_MAILBOX_UPN && env.MICROSOFT_CLIENT_SECRET) return { token: msToken, mailbox: env.MICROSOFT_MAILBOX_UPN };
    return undefined;
  };
}
