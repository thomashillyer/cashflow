// Invoice-link resolver: keep the link as Evidence, and read it only when it is a supported provider's
// public page. Read-only (GET), HTTPS only, bounded by redirects, time, and size. A link that cannot be
// read keeps its Evidence and asks the owner for a PDF or the fields; Neri never pretends it was read.
// A payment ("Pay now") link is captured but never fetched, and is never evidence of payment.

import { lookup as dnsLookup } from "node:dns";
import { request } from "node:https";
import type { Evidence } from "../../schema/records";
import { classifyUrl, type LinkKind } from "../../ai/extract/message";
import { sha256Hex } from "../core/hash";
import { fileEvidenceId } from "../core/ids";
import { checkUrl, isPrivateAddress } from "./guard";

export const MAX_REDIRECTS = 3;
export const TIMEOUT_MS = 8000;
export const MAX_BYTES = 1_000_000;
export const MAX_TEXT_CHARS = 20_000;

export type TransportResponse = { status: number; headers: Record<string, string | undefined>; body: Uint8Array };
export type Transport = (url: URL, limits: { timeoutMs: number; maxBytes: number }) => Promise<TransportResponse>;

export type LinkResult = {
  evidence: Evidence;
  kind: LinkKind;
  read: boolean;                 // true only when page text was actually fetched
  fallback?: string;             // plain-words next step when it was not read
};

const FALLBACK = "Upload the invoice PDF or enter the amount and due date yourself.";

// Default transport: node:https with a connect-time DNS guard, so a name that resolves to a private
// address is refused on the connection actually used (no check-then-connect gap).
export const httpsTransport: Transport = (url, { timeoutMs, maxBytes }) =>
  new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET", timeout: timeoutMs, headers: { accept: "text/html,application/pdf,text/plain", "user-agent": "NeriCash/1.0 (read-only)" },
      lookup: (host, opts, cb) => dnsLookup(host, { ...opts, all: true }, (err, addrs) => {
        if (err) return (cb as any)(err);
        const list = addrs as { address: string; family: number }[];
        if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) return (cb as any)(new Error("private address"));
        if ((opts as { all?: boolean }).all) return (cb as any)(null, list);
        return (cb as any)(null, list[0]!.address, list[0]!.family);
      }),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error("too large")); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])),
        body: new Uint8Array(Buffer.concat(chunks)),
      }));
      res.on("error", reject);
    });
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs);   // overall, not just idle
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
    req.end();
  });

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

function keep(url: string, receivedAt: string, extraction: Evidence["extraction"], extra: Partial<Evidence> = {}, provider = "url", parentId?: string): Evidence {
  return {
    id: fileEvidenceId("url", sha256Hex(url)), channel: "url", format: "html", receivedAt, url,
    ...(parentId ? { parentId } : {}), extraction, sourceRef: { system: provider, record: url, url }, ...extra,
  };
}

export async function resolveInvoiceUrl(
  rawUrl: string,
  opts: { receivedAt: string; parentId?: string; label?: string; transport?: Transport },
): Promise<LinkResult> {
  const transport = opts.transport ?? httpsTransport;
  const kind = classifyUrl(rawUrl, opts.label);
  const first = checkUrl(rawUrl);
  const exact = rawUrl.trim();
  const unread = (reason: string, extraction: Evidence["extraction"], provider?: string): LinkResult => ({
    evidence: keep(exact, opts.receivedAt, extraction, {}, provider, opts.parentId), kind, read: false, fallback: `${reason} ${FALLBACK}`,
  });

  if (!first.ok) return unread(first.reason, "unsupported");
  if (kind === "payment") return unread("This is a payment link, so Neri kept it but did not open it.", "unsupported", first.provider);

  let current = first.url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await transport(current, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.location;
        if (!loc) return unread("The link redirected without saying where.", "unreadable", first.provider);
        const next = checkUrl(new URL(loc, current).toString());
        if (!next.ok) return unread(`The link redirected somewhere Neri will not open (${next.reason.replace(/\.$/, "").toLowerCase()}).`, "unsupported", first.provider);
        current = next.url;
        continue;
      }
      if (res.status === 401 || res.status === 403) return unread("The link needs a login.", "unreadable", first.provider);
      if (res.status === 404 || res.status === 410) return unread("The link has expired or no longer exists.", "unreadable", first.provider);
      if (res.status < 200 || res.status >= 300) return unread(`The link returned an error (${res.status}).`, "unreadable", first.provider);
      const type = (res.headers["content-type"] ?? "").toLowerCase();
      if (!/^(text\/(html|plain)|application\/(xhtml\+xml|json))/.test(type)) {
        return unread(type.includes("pdf") ? "The link opens a PDF, which Neri reads only when uploaded." : "The link is not a page Neri can read.", "unsupported", first.provider);
      }
      const text = htmlToText(new TextDecoder("utf-8").decode(res.body));
      if (!text) return unread("The page had no readable text.", "unreadable", first.provider);
      const hash = sha256Hex(res.body);
      return {
        evidence: keep(exact, opts.receivedAt, "ok", { text, fileHash: hash, mime: type.split(";")[0]! }, first.provider, opts.parentId),
        kind, read: true,
      };
    }
    return unread("The link redirected too many times.", "unreadable", first.provider);
  } catch (err) {
    const m = err instanceof Error ? err.message : "";
    return unread(/timeout/.test(m) ? "The link took too long to answer." : /too large/.test(m) ? "The page was too large to read." : "The link could not be reached.", "unreadable", first.provider);
  }
}
