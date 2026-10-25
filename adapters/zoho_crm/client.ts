// Read-only Zoho CRM client (v6). GET only. The host comes from the fixed Zoho region list; module and
// field names are validated before they touch a URL. CRM needs an explicit `fields` list, answers 204 for an
// empty module, and pages with `info.more_records`.

import { ConnectorFailure, httpFailure, type Fetch, type TokenProvider } from "../connector";
import { ZOHO_REGIONS, type ZohoRegion } from "../zoho_books/client";

export const PAGE_SIZE = 200;
export const MAX_PAGES = 10;
export const REQUEST_TIMEOUT_MS = 10_000;

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
type Rec = Record<string, unknown>;

export class ZohoCrmClient {
  private readonly fetchImpl: Fetch;
  constructor(private readonly opts: { region: ZohoRegion; token: TokenProvider; fetch?: Fetch }) {
    if (!ZOHO_REGIONS.includes(opts.region)) {
      throw new ConnectorFailure({ kind: "config", message: "That Zoho region is not supported.", nextStep: "Choose your Zoho region again, or upload a CRM export instead.", fallback: "file" });
    }
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  async records(module: string, fields: string[]): Promise<{ records: Rec[]; truncated: boolean }> {
    if (!NAME.test(module) || fields.length === 0 || !fields.every((f) => NAME.test(f))) {
      throw new ConnectorFailure({ kind: "config", message: "The CRM module or field names are not valid.", nextStep: "Check the CRM mapping, or upload a CRM export instead.", fallback: "file" });
    }
    const out: Rec[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const q = new URLSearchParams({ fields: fields.join(","), per_page: String(PAGE_SIZE), page: String(page), sort_by: "Modified_Time", sort_order: "desc" });
      const url = `https://www.zohoapis.${this.opts.region}/crm/v6/${module}?${q}`;
      let res: Awaited<ReturnType<Fetch>>;
      try {
        res = await this.fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Zoho-oauthtoken ${await this.opts.token("zoho_crm")}`, Accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (err instanceof ConnectorFailure) throw err;
        throw new ConnectorFailure({ kind: "network", message: "Zoho CRM did not answer.", nextStep: "Try again in a minute, or upload a CRM export instead.", fallback: "file" });
      }
      if (res.status === 204) return { records: out, truncated: false };   // an empty module is not an error
      if (res.status === 401) throw new ConnectorFailure({ kind: "auth", message: "Zoho CRM access has expired, was removed, or was not allowed for CRM.", nextStep: "Reconnect Zoho and allow CRM read access, or upload a CRM export instead.", fallback: "file" });
      if (res.status < 200 || res.status >= 300) throw new ConnectorFailure(httpFailure("Zoho CRM", res.status, "file"));
      let body: unknown;
      try { body = await res.json(); } catch { body = undefined; }
      if (typeof body !== "object" || body === null) {
        throw new ConnectorFailure({ kind: "unsupported", message: "Zoho CRM sent an answer Neri could not read.", nextStep: "Upload a CRM export instead.", fallback: "file" });
      }
      const b = body as { data?: unknown; info?: { more_records?: boolean } };
      if (Array.isArray(b.data)) out.push(...(b.data as Rec[]));
      if (!b.info?.more_records) return { records: out, truncated: false };
    }
    return { records: out, truncated: true };
  }
}
