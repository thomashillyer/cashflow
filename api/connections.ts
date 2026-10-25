// A server-configured, read-only Books connection belongs to exactly one private business.
// Credentials stay inside this service; neither discovery nor sync returns provider payloads.
import { pullZoho } from "../adapters/zoho_books";
import { ZOHO_REGIONS, type ZohoRegion } from "../adapters/zoho_books/client";
import { HttpError } from "./http";
import { persistImport, type PersistSummary } from "./persist";
import { refreshPending } from "./routes/review";
import type { Business, Store } from "./store";

export type ConnectionStatus = {
  id: "zoho_books";
  name: "Zoho Books";
  available: boolean;
  state: "waiting" | "ok" | "error";
  lastSyncedAt?: string;
  message?: string;
};
export type ConnectionList = { connections: ConnectionStatus[] };
export type ConnectionSyncResult = {
  connection: ConnectionStatus;
  counts: { parties: number; commitments: number; settlements: number; evidence: number; rejected: number };
  summary: PersistSummary;
  storeRevision: number;
};
export interface ConnectionService {
  list(business: Business): ConnectionList;
  sync(business: Business, store: Store, now: () => Date): Promise<ConnectionSyncResult>;
}
export type ConnectionOptions = { pull?: typeof pullZoho; fetch?: typeof fetch };

const identity = { id: "zoho_books", name: "Zoho Books" } as const;
const unavailable = "Zoho Books isn't configured for this business. Ask your team to connect it, or upload an export.";
const failed = "Zoho Books couldn't be read. Check the connection and try again, or upload an export.";
const authFailed = "Zoho Books access couldn't be renewed. Ask your team to reconnect it, or upload an export.";

function regionOf(domain: string | undefined): ZohoRegion | undefined {
  try {
    const url = new URL(domain ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) return;
    return ZOHO_REGIONS.find((r) => url.hostname === `www.zohoapis.${r}`);
  } catch { return; }
}

export function buildConnectionService(env: NodeJS.ProcessEnv, options: ConnectionOptions = {}): ConnectionService {
  const businessId = env.NERI_CONNECTOR_BUSINESS_ID?.trim();
  const region = regionOf(env.ZOHO_API_DOMAIN);
  const clientId = env.ZOHO_CLIENT_ID;
  const clientSecret = env.ZOHO_CLIENT_SECRET;
  const refreshToken = env.ZOHO_REFRESH_TOKEN;
  const organizationId = env.ZOHO_ORGANIZATION_ID?.trim();
  const configured = Boolean(businessId && region && clientId && clientSecret && refreshToken);
  const fetchImpl = options.fetch ?? fetch;
  const pull = options.pull ?? pullZoho;
  let access: { value: string; expiresAt: number } | undefined;
  let renewing: Promise<string> | undefined;
  let errorMessage: string | undefined;
  let syncing: Promise<ConnectionSyncResult> | undefined;

  const bound = (b: Business) => !b.isSynthetic && Boolean(businessId) && b.id === businessId;
  function status(b: Business): ConnectionStatus {
    if (!bound(b) || !configured) return { ...identity, available: false, state: "waiting", message: unavailable };
    const account = b.profile.account;
    const previous = account?.connections?.find((c) => c.id === identity.id);
    const lastSyncedAt = previous?.state === "ok" ? account?.syncedAt : undefined;
    return {
      ...identity, available: true, state: errorMessage ? "error" : lastSyncedAt ? "ok" : "waiting",
      ...(lastSyncedAt ? { lastSyncedAt } : {}),
      message: errorMessage ?? (lastSyncedAt ? "Books were read successfully. Sync again to check for changes." : "Ready to read your books. No data has been imported yet."),
    };
  }

  async function token(): Promise<string> {
    if (access && access.expiresAt > Date.now()) return access.value;
    if (renewing) return renewing;
    renewing = (async () => {
      try {
        const response = await fetchImpl(`https://accounts.zoho.${region}/oauth/v2/token`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken!, client_id: clientId!, client_secret: clientSecret! }),
        });
        if (!response.ok) throw new Error("token rejected");
        const body = await response.json() as { access_token?: unknown; expires_in?: unknown };
        if (typeof body.access_token !== "string" || !body.access_token.trim()) throw new Error("token missing");
        const expires = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0 ? Math.min(body.expires_in, 3600) : 3600;
        access = { value: body.access_token, expiresAt: Date.now() + Math.max(1, expires - 60) * 1000 };
        return access.value;
      } catch {
        access = undefined;
        throw new HttpError(502, "CONNECTOR_AUTH", authFailed, { retryable: true });
      }
    })();
    try { return await renewing; } finally { renewing = undefined; }
  }

  async function perform(b: Business, store: Store, now: () => Date): Promise<ConnectionSyncResult> {
    const at = now().toISOString();
    try {
      const { records } = await store.load(b.id);
      const result = await pull({
        region: region!, token, now: at, existingEvidence: records.evidence,
        ...(organizationId ? { organizationId } : {}),
        fetch: (url, init) => fetchImpl(url, { ...init, redirect: "error" }),
      });
      if (!result.ok) {
        if (result.error.kind === "auth") access = undefined;
        throw new HttpError(502, "CONNECTOR_UNAVAILABLE", failed, { retryable: true });
      }
      const data = result.data;
      const summary = await persistImport(store, b.id, data);
      if (summary.written) {
        const latest = await store.load(b.id);
        await refreshPending(store, b.id, latest.records, latest.storeRevision, at);
      }
      // Reload the profile after the remote read, preserving owner changes made in the meantime.
      const latestBusiness = await store.getBusiness(b.id);
      if (!latestBusiness || !bound(latestBusiness)) throw new HttpError(403, "FORBIDDEN", unavailable);
      const account = latestBusiness.profile.account ?? {};
      await store.saveProfile(b.id, {
        ...latestBusiness.profile, account: {
          ...account, syncedAt: at,
          connections: [...(account.connections ?? []).filter((c) => c.id !== identity.id), { ...identity, state: "ok" }],
        },
      });
      errorMessage = undefined;
      return {
        connection: { ...identity, available: true, state: "ok", lastSyncedAt: at },
        counts: { parties: data.parties.length, commitments: data.commitments.length, settlements: data.settlements.length, evidence: data.evidence.length, rejected: data.diagnostics.rowsRejected },
        summary, storeRevision: summary.storeRevision,
      };
    } catch (error) {
      errorMessage = error instanceof HttpError && error.code === "CONNECTOR_AUTH" ? authFailed : failed;
      // Never expose a provider response, token, private URL or database diagnostic.
      throw new HttpError(502, "CONNECTOR_UNAVAILABLE", errorMessage, { retryable: true });
    }
  }

  return {
    list: (b) => ({ connections: [status(b)] }),
    async sync(b, store, now) {
      if (b.isSynthetic || (businessId && b.id !== businessId)) throw new HttpError(403, "FORBIDDEN", "This business cannot use that connection.");
      if (!configured || !bound(b)) throw new HttpError(503, "CONNECTOR_NOT_CONFIGURED", unavailable);
      // One in-flight pull per configured company prevents duplicate revision bumps on double-click.
      if (syncing) return syncing;
      syncing = perform(b, store, now);
      try { return await syncing; } finally { syncing = undefined; }
    },
  };
}
