// A server-configured, read-only Books connection belongs to exactly one private business.
// Credentials stay inside this service; neither discovery nor sync returns provider payloads.
import { pullZoho } from "../adapters/zoho_books";
import { pullOutlook } from "../adapters/outlook";
import { pullZohoCrm } from "../adapters/zoho_crm";
import { ZohoCrmClient } from "../adapters/zoho_crm/client";
import { ingest } from "../ai/intake";
import type { AiMode } from "./engine";
import { ZOHO_REGIONS, type ZohoRegion } from "../adapters/zoho_books/client";
import { HttpError } from "./http";
import { persistImport, type PersistSummary } from "./persist";
import { refreshPending } from "./routes/review";
import type { Business, Store } from "./store";

export type ConnectionId = "zoho_books" | "zoho_crm" | "outlook";
export type ConnectionStatus = {
  id: ConnectionId;
  name: "Zoho Books" | "Zoho CRM" | "Outlook";
  available: boolean;
  state: "waiting" | "ok" | "error";
  lastSyncedAt?: string;
  message?: string;
};
export type ConnectionList = { connections: ConnectionStatus[] };
export type ConnectionSyncResult = {
  connection: ConnectionStatus;
  counts: { parties: number; commitments: number; settlements: number; evidence: number; rejected: number; balances?: number; proposals?: number; signals?: number; messages?: number; duplicates?: number; failed?: number };
  summary?: PersistSummary;
  storeRevision: number;
};
export interface ConnectionService {
  list(business: Business): ConnectionList;
  sync(business: Business, store: Store, now: () => Date, provider?: ConnectionId): Promise<ConnectionSyncResult>;
  salesActions?(business: Business, now: () => Date): Promise<SalesAction[]>;
}
// An open pipeline record (an RFQ in play) that needs a follow-up. Read-only; no amounts are invented.
export type SalesAction = { id: string; title: string; customer?: string; stage: string; daysInStage?: number; nextAction?: string; nextActionDate?: string; quoteSent?: string; quoteValidUntil?: string };
export type ConnectionOptions = { pull?: typeof pullZoho; crmPull?: typeof pullZohoCrm; fetch?: typeof fetch; outlookPull?: typeof pullOutlook; ingest?: typeof ingest; aiMode?: AiMode };

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

function buildZohoConnectionService(env: NodeJS.ProcessEnv, options: ConnectionOptions = {}): ConnectionService {
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
  // Both providers replace the saved profile after reading it. Serialize them so their
  // connection state survives simultaneous Books/CRM requests; repeats still coalesce below.
  let zohoQueue: Promise<unknown> = Promise.resolve();
  function enqueue(work: () => Promise<ConnectionSyncResult>): Promise<ConnectionSyncResult> {
    const next = zohoQueue.then(work);
    zohoQueue = next.catch(() => undefined);
    return next;
  }

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
      // The Books adapter may also return actual bank balances. Keep repeats revision-neutral,
      // and leave saved opening cash untouched when Banking permission returned no balances.
      const balances = data.balances.filter((next) => !records.balances.some((old) => old.id === next.id
        && old.account === next.account && old.amount === next.amount && old.currency === next.currency && old.asOf === next.asOf
        && old.sourceRef.system === next.sourceRef.system && old.sourceRef.record === next.sourceRef.record));
      if (balances.length) {
        summary.storeRevision = await store.upsertRecords(b.id, { balances });
        summary.written = true;
      }
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
        counts: { parties: data.parties.length, commitments: data.commitments.length, settlements: data.settlements.length, evidence: data.evidence.length, rejected: data.diagnostics.rowsRejected, balances: data.balances.length },
        summary, storeRevision: summary.storeRevision,
      };
    } catch (error) {
      errorMessage = error instanceof HttpError && error.code === "CONNECTOR_AUTH" ? authFailed : failed;
      // Never expose a provider response, token, private URL or database diagnostic.
      throw new HttpError(502, "CONNECTOR_UNAVAILABLE", errorMessage, { retryable: true });
    }
  }

  // Zoho CRM: the same Zoho client and refresh token as Books (one consent covers both). Open deals and quoted
  // RFQs become sales_deal commitments with the certainty the business's profile.crm mapping gives each stage,
  // so quoted RFQs stay "possible" and never enter the main forecast line. Read-only.
  const crm = { id: "zoho_crm", name: "Zoho CRM" } as const;
  const crmMissing = "Zoho CRM isn't configured for this business. Ask your team to connect it, or upload a CRM export.";
  const crmFailed = "Zoho CRM couldn't be read. Check that the connection allows CRM read access and try again, or upload a CRM export.";
  const crmAttention = "Some deals need a check or could not be read. Check CRM stage mappings, probabilities and closing dates, including deals already invoiced, then sync again or upload a CRM export.";
  const crmPull = options.crmPull ?? pullZohoCrm;
  let crmError: string | undefined;
  let crmSyncing: Promise<ConnectionSyncResult> | undefined;
  function crmStatus(b: Business): ConnectionStatus {
    if (!bound(b) || !configured) return { ...crm, available: false, state: "waiting", message: crmMissing };
    const prior = b.profile.account?.connections?.find((c) => c.id === crm.id);
    const lastSyncedAt = prior?.syncedAt;
    const problem = crmError ?? (prior?.state === "error" ? crmAttention : undefined);
    return {
      ...crm, available: true, state: problem ? "error" : lastSyncedAt ? "ok" : "waiting", ...(lastSyncedAt ? { lastSyncedAt } : {}),
      message: problem ?? (lastSyncedAt ? "Deals and RFQs were read. Sync again to check for changes." : "Ready to read your open deals and RFQs. Nothing has been imported yet."),
    };
  }
  async function performCrm(b: Business, store: Store, now: () => Date): Promise<ConnectionSyncResult> {
    const at = now().toISOString();
    try {
      const { records } = await store.load(b.id);
      const result = await crmPull({
        region: region!, token, now: at, existingEvidence: records.evidence,
        ...(b.profile.crm ? { mapping: b.profile.crm } : {}),
        fetch: (url, init) => fetchImpl(url, { ...init, redirect: "error" }),
      });
      if (!result.ok) {
        if (result.error.kind === "auth") access = undefined;
        throw new HttpError(502, "CONNECTOR_UNAVAILABLE", crmFailed, { retryable: true });
      }
      const data = result.data;
      // A lost/already-invoiced deal must stop contributing cash. Only retire explicit
      // skips: absence from a paginated or partial read is not proof a deal disappeared.
      const skipped = new Set(data.skipped.map((deal) => deal.dealId));
      const latest = await store.load(b.id);
      const retired = latest.records.commitments.filter((c) => c.type === "sales_deal" && c.sourceRef.system === "crm" && skipped.has(c.sourceRef.record))
        .map((c) => ({ ...c, settlement: "cancelled" as const }));
      const summary = await persistImport(store, b.id, { parties: data.parties, commitments: [...data.commitments, ...retired], settlements: [], evidence: data.evidence });
      if (summary.written) {
        const latest = await store.load(b.id);
        await refreshPending(store, b.id, latest.records, latest.storeRevision, at);
      }
      const latestBusiness = await store.getBusiness(b.id);
      if (!latestBusiness || !bound(latestBusiness)) throw new HttpError(403, "FORBIDDEN", crmMissing);
      const account = latestBusiness.profile.account ?? {};
      const needsAttention = data.diagnostics.rowsRejected > 0 || data.diagnostics.warnings.length > 0;
      const connection: ConnectionStatus = { ...crm, available: true, state: needsAttention ? "error" : "ok", lastSyncedAt: at, ...(needsAttention ? { message: crmAttention } : {}) };
      await store.saveProfile(b.id, {
        ...latestBusiness.profile, account: {
          ...account, connections: [...(account.connections ?? []).filter((c) => c.id !== crm.id), { ...crm, state: connection.state, syncedAt: at }],
        },
      });
      crmError = needsAttention ? crmAttention : undefined;
      return {
        connection,
        counts: { parties: data.parties.length, commitments: data.commitments.length, settlements: 0, evidence: data.evidence.length, rejected: data.diagnostics.rowsRejected },
        summary, storeRevision: summary.storeRevision,
      };
    } catch (error) {
      crmError = crmFailed;
      throw new HttpError(502, "CONNECTOR_UNAVAILABLE", crmError, { retryable: true });
    }
  }

  // Open RFQs (or any custom pipeline module) as sales follow-ups, ranked by the profile's actionStages
  // (closest to money first), then longest in stage. Read-only; only header fields, never invented amounts.
  async function salesActions(b: Business, now: () => Date): Promise<SalesAction[]> {
    if (!configured || !bound(b)) return [];
    const m = b.profile.crm ?? {};
    const client = new ZohoCrmClient({ region: region!, token, fetch: (url, init) => fetchImpl(url, { ...init, redirect: "error" }) });
    const { records } = await client.records(m.rfqModule ?? "RFQs", ["Name", "Status", "Existing_Account", "Next_Action", "Next_Action_Date", "Quote_Sent_Date", "Quote_Valid_Until", "Stage_Entered_On"]);
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const order = m.actionStages ?? [];
    const today = now().toISOString().slice(0, 10);
    const days = (d?: string) => (d ? Math.max(0, Math.round((Date.parse(today) - Date.parse(d)) / 86_400_000)) : undefined);
    const out: SalesAction[] = [];
    for (const r of records) {
      const stage = str(r.Status);
      if (!stage || (order.length ? !order.includes(stage) : /^(lost|won|closed)/i.test(stage))) continue;
      const acct = r.Existing_Account as { name?: unknown } | null;
      const customer = str(acct?.name);
      const a: SalesAction = { id: String(r.id ?? ""), title: str(r.Name) ?? "RFQ", stage };
      if (customer) a.customer = customer;
      const dis = days(str(r.Stage_Entered_On)); if (dis !== undefined) a.daysInStage = dis;
      const na = str(r.Next_Action); if (na) a.nextAction = na.slice(0, 200);
      const nad = str(r.Next_Action_Date); if (nad) a.nextActionDate = nad;
      const qs = str(r.Quote_Sent_Date); if (qs) a.quoteSent = qs;
      const qv = str(r.Quote_Valid_Until); if (qv) a.quoteValidUntil = qv;
      out.push(a);
    }
    const rank = (a: SalesAction) => (order.length ? order.indexOf(a.stage) : 0);
    return out.sort((x, y) => rank(x) - rank(y) || (y.daysInStage ?? 0) - (x.daysInStage ?? 0)).slice(0, 10);
  }

  return {
    salesActions,
    list: (b) => ({ connections: [status(b), crmStatus(b)] }),
    async sync(b, store, now, provider = "zoho_books") {
      if (b.isSynthetic || (businessId && b.id !== businessId)) throw new HttpError(403, "FORBIDDEN", "This business cannot use that connection.");
      if (provider === "zoho_crm") {
        if (!configured || !bound(b)) throw new HttpError(503, "CONNECTOR_NOT_CONFIGURED", crmMissing);
        if (crmSyncing) return crmSyncing;
        crmSyncing = enqueue(() => performCrm(b, store, now));
        try { return await crmSyncing; } finally { crmSyncing = undefined; }
      }
      if (!configured || !bound(b)) throw new HttpError(503, "CONNECTOR_NOT_CONFIGURED", unavailable);
      // One in-flight pull per configured company prevents duplicate revision bumps on double-click.
      if (syncing) return syncing;
      syncing = enqueue(() => perform(b, store, now));
      try { return await syncing; } finally { syncing = undefined; }
    },
  };
}

// Email messages become proposed intake only. Scan at most 50 recent messages, then process at most
// ten financial messages so a click cannot trigger an unbounded set of model calls.
export function buildConnectionService(env: NodeJS.ProcessEnv, options: ConnectionOptions = {}): ConnectionService {
  const zoho = buildZohoConnectionService(env, options);
  const businessId = env.NERI_CONNECTOR_BUSINESS_ID?.trim();
  const tenant = env.MICROSOFT_TENANT_ID?.trim();
  const clientId = env.MICROSOFT_CLIENT_ID;
  const clientSecret = env.MICROSOFT_CLIENT_SECRET;
  const mailbox = env.MICROSOFT_MAILBOX_UPN?.trim();
  const configured = Boolean(businessId && tenant && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant) && clientId && clientSecret && mailbox && /^[^\s/?#]+@[^\s/?#]+$/.test(mailbox));
  const name = { id: "outlook", name: "Outlook" } as const;
  const missing = "Outlook isn't configured for this business. Ask your team to connect it, or upload an email.";
  const failed = "Outlook couldn't finish reading your messages. Check the connection and try again, or upload an email.";
  const fetchImpl = options.fetch ?? fetch;
  const pull = options.outlookPull ?? pullOutlook;
  const read = options.ingest ?? ingest;
  let access: { value: string; expiresAt: number } | undefined;
  let renewing: Promise<string> | undefined;
  let syncing: Promise<ConnectionSyncResult> | undefined;
  let errorMessage: string | undefined;
  const bound = (b: Business) => !b.isSynthetic && b.id === businessId;
  function status(b: Business): ConnectionStatus {
    if (!configured || !bound(b)) return { ...name, available: false, state: "waiting", message: missing };
    const prior = b.profile.account?.connections?.find((c) => c.id === "outlook") as { state: string; lastSyncedAt?: string } | undefined;
    return { ...name, available: true, state: errorMessage || prior?.state === "error" ? "error" : prior?.state === "ok" ? "ok" : "waiting",
      ...(prior?.lastSyncedAt ? { lastSyncedAt: prior.lastSyncedAt } : {}),
      message: errorMessage ?? "Sync scans up to 50 recent messages from the last 30 days and processes up to 10 financial messages. Changes wait for your review." };
  }
  async function token(): Promise<string> {
    if (access && access.expiresAt > Date.now()) return access.value;
    if (renewing) return renewing;
    renewing = (async () => {
      try {
        const response = await fetchImpl(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId!, client_secret: clientSecret!, scope: "https://graph.microsoft.com/.default" }),
        });
        if (!response.ok) throw new Error("token rejected");
        const body = await response.json() as { access_token?: unknown; expires_in?: unknown };
        if (typeof body.access_token !== "string" || !body.access_token) throw new Error("token missing");
        const expires = typeof body.expires_in === "number" && body.expires_in > 0 ? Math.min(body.expires_in, 3600) : 3600;
        access = { value: body.access_token, expiresAt: Date.now() + Math.max(1, expires - 60) * 1000 };
        return access.value;
      } catch { access = undefined; throw new HttpError(502, "CONNECTOR_AUTH", failed, { retryable: true }); }
    })();
    try { return await renewing; } finally { renewing = undefined; }
  }
  async function perform(b: Business, store: Store, now: () => Date): Promise<ConnectionSyncResult> {
    const at = now().toISOString();
    try {
      const result = await pull({ token, mailbox, now: at, since: new Date(Date.parse(at) - 30 * 86400000).toISOString(), fetch: async (raw, init) => {
        const url = new URL(raw);
        if (url.origin !== "https://graph.microsoft.com") throw new Error("unsupported host");
        const list = /\/messages$/.test(url.pathname);
        if (list) url.searchParams.set("$top", "50");
        const response = await fetchImpl(url.toString(), { ...init, redirect: "error" });
        return { status: response.status, json: async () => {
          const body = await response.json() as Record<string, unknown>;
          if (list && body && typeof body === "object") {
            delete body["@odata.nextLink"];
            if (Array.isArray(body.value)) body.value = body.value.slice(0, 50);
          }
          return body;
        } };
      } });
      if (!result.ok) { if (result.error.kind === "auth") access = undefined; throw new Error("pull failed"); }
      const inputs = result.data.inputs.slice(0, 10);
      const counts = { parties: 0, commitments: 0, settlements: 0, evidence: 0, rejected: result.data.diagnostics.rowsRejected, proposals: 0, signals: 0, messages: inputs.length, duplicates: 0, failed: 0 };
      for (const input of inputs) {
        try {
          const { records, storeRevision } = await store.load(b.id);
          if (input.source?.evidenceId && records.evidence.some((e) => e.id === input.source!.evidenceId && e.extraction === "ok")) { counts.duplicates++; continue; }
          const out = await read(input, { records, storeRevision, business: { name: b.name, aliases: b.profile.account?.aliases }, mode: options.aiMode ?? "cache_only", now: at,
            ...(b.profile.account?.timezone ? { timeZone: b.profile.account.timezone } : {}) });
          const prior = new Map((await store.listProposals(b.id)).map((p) => [p.id, p]));
          const proposals = out.proposals.filter((p) => prior.get(p.id)?.state !== "confirmed" && prior.get(p.id)?.state !== "dismissed")
            .map((p) => ({ ...p, state: "proposed" as const }));
          const known = new Set(records.signals.map((s) => s.id));
          const signals = out.signals.filter((s) => !known.has(s.id)).map((s) => ({ ...s, state: "proposed" as const }));
          const incomplete = out.candidates.some((c) => c.extraction !== "ok") || out.evidence.some((e) => e.extraction === "partial" || e.extraction === "unreadable" || e.extraction === "unsupported")
            || out.notes.some((n) => /could not|no cached|unreadable|unavailable/i.test(n.text));
          // A successful source read can still have failed interpretation. Keep that message retryable.
          const evidence = incomplete ? out.evidence.map((e) => e.id === input.source?.evidenceId ? { ...e, extraction: "partial" as const } : e) : out.evidence;
          await store.saveIntake(b.id, { evidence: [], candidates: out.candidates, proposals, signals });
          await store.saveIntake(b.id, { evidence, candidates: [], proposals: [], signals: [] });
          if (incomplete) counts.failed++;
          counts.evidence += out.evidence.filter((e) => !records.evidence.some((old) => old.id === e.id)).length;
          counts.proposals += proposals.length; counts.signals += signals.length;
        } catch { counts.failed++; }
      }
      const revision = (await store.load(b.id)).storeRevision;
      const partial = counts.failed > 0 || counts.rejected > 0;
      const message = partial ? "Some messages couldn't be read. Successfully read items are waiting in Review; sync again to retry the rest." : "Recent messages were read. Proposed changes wait for your review.";
      const latest = await store.getBusiness(b.id);
      if (!latest || !bound(latest)) throw new Error("business unavailable");
      const account = latest.profile.account ?? {};
      const saved = { ...name, state: partial ? "error" as const : "ok" as const, lastSyncedAt: at };
      await store.saveProfile(b.id, { ...latest.profile, account: { ...account, connections: [...(account.connections ?? []).filter((c) => c.id !== name.id), saved] } });
      errorMessage = partial ? message : undefined;
      return { connection: { ...name, available: true, state: partial ? "error" : "ok", lastSyncedAt: at, message }, counts, storeRevision: revision };
    } catch { errorMessage = failed; throw new HttpError(502, "CONNECTOR_UNAVAILABLE", failed, { retryable: true }); }
  }
  return {
    ...(zoho.salesActions ? { salesActions: zoho.salesActions } : {}),
    list: (b) => ({ connections: [...zoho.list(b).connections, status(b)] }),
    async sync(b, store, now, provider = "zoho_books") {
      if (provider === "zoho_books" || provider === "zoho_crm") return zoho.sync(b, store, now, provider);
      if (provider !== "outlook") throw new HttpError(404, "NOT_FOUND", "That connection isn't available.");
      if (b.isSynthetic || (businessId && b.id !== businessId)) throw new HttpError(403, "FORBIDDEN", "This business cannot use that connection.");
      if (!configured || !bound(b)) throw new HttpError(503, "CONNECTOR_NOT_CONFIGURED", missing);
      if (syncing) return syncing;
      syncing = perform(b, store, now);
      try { return await syncing; } finally { syncing = undefined; }
    },
  };
}
