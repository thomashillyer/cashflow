// Network safety for the invoice-link resolver: public HTTPS only, supported providers only,
// never a private, loopback, link-local, or reserved address.

import { isIP } from "node:net";

export const SUPPORTED_PROVIDERS: { id: string; hosts: RegExp }[] = [
  { id: "zoho_books", hosts: /(^|\.)(zoho\.(com|eu|in|com\.au|jp|ca|sa)|zohosecurepay\.(com|eu|in|com\.au)|zohoinvoice\.(com|eu|in|com\.au))$/ },
  { id: "quickbooks", hosts: /(^|\.)(intuit\.com|quickbooks\.com)$/ },
];

export const providerFor = (host: string): string | undefined =>
  SUPPORTED_PROVIDERS.find((p) => p.hosts.test(host.toLowerCase()))?.id;

function v4Private(a: number, b: number, c: number): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

// Expand an IPv6 address to 8 hextets; undefined when malformed.
function hextets(ip: string): number[] | undefined {
  let s = ip.toLowerCase().split("%")[0]!;
  const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [x, y, z, w] = dotted.slice(1).map(Number) as [number, number, number, number];
    s = s.replace(dotted[0], `${((x << 8) | y).toString(16)}:${((z << 8) | w).toString(16)}`);
  }
  const [head, tail, extra] = s.split("::");
  if (extra !== undefined) return undefined;
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  if (fill < 0 || (tail === undefined && h.length !== 8)) return undefined;
  const all = [...h, ...Array(fill).fill("0"), ...t].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : undefined;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number];
    return v4Private(a, b, c);
  }
  if (kind === 6) {
    const h = hextets(ip);
    if (!h) return true;
    if (h.slice(0, 5).every((n) => n === 0) && (h[5] === 0xffff || h[5] === 0)) {   // ::ffff:a.b.c.d, ::a.b.c.d (incl. :: and ::1)
      const [hi, lo] = [h[6]!, h[7]!];
      if (h[5] === 0 && hi === 0 && lo <= 1) return true;
      return v4Private(hi >> 8, hi & 255, lo >> 8);
    }
    return (h[0]! & 0xfe00) === 0xfc00 || (h[0]! & 0xffc0) === 0xfe80 || (h[0]! & 0xff00) === 0xff00 ||
      (h[0] === 0x64 && h[1] === 0xff9b) || h[0] === 0x2002 || h[0] === 0x2001 && h[1] === 0;   // ULA, link-local, multicast, NAT64, 6to4, Teredo
  }
  return true;   // not an IP at all: never treat as safe
}

export type UrlCheck = { ok: true; url: URL; provider: string } | { ok: false; reason: string };

// Syntactic check before any network use. Redirect targets go through the same check.
export function checkUrl(raw: string): UrlCheck {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return { ok: false, reason: "This is not a valid web address." }; }
  if (url.protocol !== "https:") return { ok: false, reason: "Only secure (https) links can be read." };
  if (url.username || url.password) return { ok: false, reason: "Links with a password in them are not read." };
  if (url.port && url.port !== "443") return { ok: false, reason: "Links to unusual ports are not read." };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivateAddress(host)) return { ok: false, reason: "Links to private or local addresses are not read." };
  if (isIP(host)) return { ok: false, reason: "Links to bare IP addresses are not read." };
  const provider = providerFor(host);
  if (!provider) return { ok: false, reason: "Neri can only read Zoho and QuickBooks invoice links." };
  return { ok: true, url, provider };
}
