// Read-only Microsoft Graph client for Outlook mail (scope Mail.Read). GET only. The host is fixed;
// a paging link from the server is followed only when it points back at the same Graph host, so the
// access token can never be sent anywhere else.

import { ConnectorFailure, httpFailure, type Fetch, type TokenProvider } from "../connector";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const REQUEST_TIMEOUT_MS = 10_000;
export const PAGE_SIZE = 50;
export const MAX_PAGES = 4;                 // 200 messages per pull
export const MAX_ATTACHMENT_BYTES = 10_000_000;

export type GraphRecord = Record<string, unknown>;

const FALLBACK = "paste" as const;
const fail = (kind: "network" | "unsupported", message: string, nextStep: string) =>
  new ConnectorFailure({ kind, message, nextStep, fallback: FALLBACK });

export class OutlookClient {
  private readonly fetchImpl: Fetch;
  constructor(private readonly token: TokenProvider, fetchImpl?: Fetch) {
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  private async get(url: string): Promise<GraphRecord> {
    const u = new URL(url);
    if (u.origin !== "https://graph.microsoft.com" || !u.pathname.startsWith("/v1.0/")) {
      throw fail("unsupported", "Outlook sent an unexpected link.", "Paste the message instead.");
    }
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${await this.token("outlook")}`, Accept: "application/json", Prefer: 'outlook.body-content-type="text", IdType="ImmutableId"' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof ConnectorFailure) throw err;
      throw fail("network", "Outlook did not answer.", "Try again in a minute, or paste the message instead.");
    }
    if (res.status < 200 || res.status >= 300) throw new ConnectorFailure(httpFailure("Outlook", res.status, FALLBACK));
    let body: unknown;
    try { body = await res.json(); } catch { body = undefined; }
    if (typeof body !== "object" || body === null) throw fail("unsupported", "Outlook sent an answer Neri could not read.", "Paste the message instead.");
    return body as GraphRecord;
  }

  // Newest first, bounded. `since` is an ISO instant; Graph filters on receivedDateTime.
  async messages(since: string): Promise<{ records: GraphRecord[]; truncated: boolean }> {
    const select = "id,internetMessageId,subject,from,toRecipients,receivedDateTime,body,hasAttachments";
    const q = new URLSearchParams({ $top: String(PAGE_SIZE), $select: select, $orderby: "receivedDateTime desc", $filter: `receivedDateTime ge ${since}` });
    let url: string | undefined = `${GRAPH_BASE}/me/messages?${q}`;
    const records: GraphRecord[] = [];
    for (let page = 0; page < MAX_PAGES && url; page++) {
      const body = await this.get(url);
      if (Array.isArray(body.value)) records.push(...(body.value as GraphRecord[]));
      url = typeof body["@odata.nextLink"] === "string" ? body["@odata.nextLink"] : undefined;
    }
    return { records, truncated: url !== undefined };
  }

  // Metadata only: names and sizes decide what is worth downloading.
  async attachments(messageId: string): Promise<GraphRecord[]> {
    const q = new URLSearchParams({ $top: "20", $select: "id,name,size,isInline,contentType" });
    const body = await this.get(`${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}/attachments?${q}`);
    return Array.isArray(body.value) ? (body.value as GraphRecord[]) : [];
  }

  // One attachment with its content (base64).
  async attachment(messageId: string, attachmentId: string): Promise<GraphRecord> {
    return this.get(`${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
  }
}
