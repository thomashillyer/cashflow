// Read-only Zoho Books API client. GET only, no write method exists. The base URL comes from a fixed
// list of Zoho data centers, never from caller input, so it cannot be pointed at another host.
// Pages and requests are bounded. Response bodies are data.

import { ConnectorFailure, type Fetch, type TokenProvider } from "../connector";

export const ZOHO_REGIONS = ["com", "eu", "in", "com.au", "jp", "ca", "sa"] as const;
export type ZohoRegion = (typeof ZOHO_REGIONS)[number];

export const PAGE_SIZE = 200;
export const MAX_PAGES = 20;
export const REQUEST_TIMEOUT_MS = 10_000;

export type ZohoRecord = Record<string, unknown>;

export type ZohoClientOptions = {
  region: ZohoRegion;
  token: TokenProvider;
  fetch?: Fetch;
  organizationId?: string;
};

export class ZohoClient {
  private organizationId: string | undefined;
  private readonly fetchImpl: Fetch;
  constructor(private readonly opts: ZohoClientOptions) {
    if (!ZOHO_REGIONS.includes(opts.region)) {
      throw new ConnectorFailure({ kind: "config", message: "That Zoho region is not supported.", nextStep: "Choose your Zoho region again, or upload an export instead.", fallback: "file" });
    }
    this.organizationId = opts.organizationId;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  private base = () => `https://www.zohoapis.${this.opts.region}/books/v3`;

  private async get(path: string, query: Record<string, string | number> = {}): Promise<Record<string, unknown>> {
    const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
    const url = `${this.base()}/${path}?${params}`;
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Zoho-oauthtoken ${await this.opts.token("zoho_books")}`, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof ConnectorFailure) throw err;
      throw new ConnectorFailure({ kind: "network", message: "Zoho Books did not answer.", nextStep: "Try again in a minute, or upload an export from Zoho Books.", fallback: "file" });
    }
    if (res.status === 401) throw new ConnectorFailure({ kind: "auth", message: "Zoho Books access has expired or was removed.", nextStep: "Reconnect Zoho Books, or upload an export instead.", fallback: "file" });
    if (res.status === 403) throw new ConnectorFailure({ kind: "auth", message: "The Zoho Books connection is not allowed to read this data.", nextStep: "Reconnect Zoho Books and allow read access, or upload an export instead.", fallback: "file" });
    if (res.status === 429) throw new ConnectorFailure({ kind: "rate_limit", message: "Zoho Books asked us to slow down.", nextStep: "Wait a few minutes and import again, or upload an export instead.", fallback: "file" });
    if (res.status < 200 || res.status >= 300) throw new ConnectorFailure({ kind: "network", message: `Zoho Books returned an error (${res.status}).`, nextStep: "Try again later, or upload an export from Zoho Books.", fallback: "file" });
    let body: unknown;
    try { body = await res.json(); } catch { body = undefined; }
    if (typeof body !== "object" || body === null) {
      throw new ConnectorFailure({ kind: "unsupported", message: "Zoho Books sent an answer Neri could not read.", nextStep: "Upload an export from Zoho Books instead.", fallback: "file" });
    }
    return body as Record<string, unknown>;
  }

  // The organization to read. With exactly one it is chosen; with several the owner must pick.
  async resolveOrganization(): Promise<string> {
    if (this.organizationId) return this.organizationId;
    const body = await this.get("organizations");
    const orgs = Array.isArray(body.organizations) ? (body.organizations as ZohoRecord[]) : [];
    if (orgs.length === 1 && typeof orgs[0]!.organization_id === "string") return (this.organizationId = orgs[0]!.organization_id);
    throw new ConnectorFailure({
      kind: "config",
      message: orgs.length === 0 ? "No Zoho Books organization was found for this account." : "This Zoho account has more than one organization.",
      nextStep: orgs.length === 0 ? "Check the account you connected, or upload an export instead." : "Pick which organization to import.",
      fallback: "file",
    });
  }

  // Every record of a list endpoint, newest pages first-come, bounded. `truncated` says more existed.
  async list(path: string, key: string): Promise<{ records: ZohoRecord[]; truncated: boolean }> {
    const organization_id = await this.resolveOrganization();
    const records: ZohoRecord[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.get(path, { organization_id, page, per_page: PAGE_SIZE });
      const rows = body[key];
      if (Array.isArray(rows)) records.push(...(rows as ZohoRecord[]));
      const ctx = body.page_context as { has_more_page?: boolean } | undefined;
      if (!ctx?.has_more_page) return { records, truncated: false };
    }
    return { records, truncated: true };
  }

  async detail(path: string, id: string, key: string): Promise<ZohoRecord | undefined> {
    const organization_id = await this.resolveOrganization();
    const body = await this.get(`${path}/${encodeURIComponent(id)}`, { organization_id });
    const rec = body[key];
    return typeof rec === "object" && rec !== null ? (rec as ZohoRecord) : undefined;
  }
}
