// Deterministic parsing of pasted/exported messages into an evidence bundle.
// No model calls. Message text is data: nothing here interprets instructions,
// and no output field can express settlement (a Pay now link is not payment).

import type { Evidence } from "../../schema/records";

export type LinkKind = "invoice" | "payment" | "other";

export type BundleLink = { url: string; kind: LinkKind; start: number; end: number };

export type BundleMessage = { at: string; sender: string; text: string; start: number; end: number };

export type MessageBundle = {
  parent: Evidence;
  children: Evidence[];          // attachments and links, each its own Evidence
  text: string;                  // the content to extract from; link/message offsets index into it
  subject?: string;
  headers?: Record<string, string>;
  sender?: { name?: string; email?: string; phone?: string };
  messages?: BundleMessage[];    // chat exports: one per message
  links: BundleLink[];
};

export type ParseOptions = {
  evidenceId: string;
  receivedAt?: string;           // ISO; overrides what the message says
  timeZone?: string;             // for timestamps without an offset; default America/Los_Angeles
  dateOrder?: "MDY" | "DMY";     // chat export date order; depends on the phone's locale; default MDY
};

const DEFAULT_TZ = "America/Los_Angeles";

// ---------------------------------------------------------------------------
// Time

// Offset (ms) of `timeZone` from UTC at the given instant.
function tzOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

// Wall-clock time in `timeZone` -> ISO UTC string.
export function zonedToUtcIso(
  y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string,
): string {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = wall - tzOffsetMs(wall, timeZone);
  utc = wall - tzOffsetMs(utc, timeZone); // second pass settles DST edges
  return new Date(utc).toISOString();
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// RFC 2822 date ("Thu, 26 Nov 2026 16:42:10 -0800") -> ISO UTC. Undefined if unparseable.
export function parseEmailDate(value: string, timeZone = DEFAULT_TZ): string | undefined {
  const m = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+([+-]\d{4}|GMT|UTC|UT|Z))?/.exec(value);
  if (!m) return undefined;
  const [, d, mon, y, h, mi, s = "0", zone] = m;
  const mo = MONTHS[mon!.toLowerCase()];
  if (!mo) return undefined;
  const nums = [Number(y), mo, Number(d), Number(h), Number(mi), Number(s)] as const;
  if (!zone) return zonedToUtcIso(...nums, timeZone);
  let offsetMin = 0;
  if (/^[+-]\d{4}$/.test(zone)) {
    const sign = zone.startsWith("-") ? -1 : 1;
    offsetMin = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
  }
  const utc = Date.UTC(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5]) - offsetMin * 60_000;
  return new Date(utc).toISOString();
}

// ---------------------------------------------------------------------------
// Links

const URL_RE = /https?:\/\/[^\s<>"'()[\]]+/g;

export function classifyUrl(url: string, label = ""): LinkKind {
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = (u.pathname + u.search).toLowerCase();
  } catch {
    return "other";
  }
  if (/(^|\.)(stripe|paypal|squareup|square)\./.test(host) || /(^|\.)(checkout|pay)\./.test(host)) return "payment";
  if (/\/(pay|checkout|payment|payments)(\/|$|\?)/.test(path)) return "payment";
  if (/\bpay\s*now\b/i.test(label)) return "payment";
  if (/invoice|\/portal\/|\/secure/.test(path) || /\binvoice\b/i.test(label)) return "invoice";
  return "other";
}

export function extractLinks(text: string): BundleLink[] {
  const links: BundleLink[] = [];
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    while (/[.,;:!?]$/.test(url)) url = url.slice(0, -1);
    const start = m.index!;
    const lineStart = text.lastIndexOf("\n", start) + 1;
    const label = text.slice(lineStart, start);
    links.push({ url, kind: classifyUrl(url, label), start, end: start + url.length });
  }
  return links;
}

// ---------------------------------------------------------------------------
// Evidence helpers

function formatFromName(name: string): Evidence["format"] {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "pdf") return "pdf";
  if (ext === "xlsx") return "xlsx";
  if (ext === "csv") return "csv";
  if (ext === "html" || ext === "htm") return "html";
  return "text";
}

function buildChildren(parent: Evidence, attachments: string[], links: BundleLink[]): Evidence[] {
  const children: Evidence[] = [];
  attachments.forEach((name, i) => {
    children.push({
      id: `${parent.id}#att-${i + 1}`, channel: parent.channel, format: formatFromName(name),
      receivedAt: parent.receivedAt, parentId: parent.id,
      extraction: "unsupported", // until the file itself is uploaded and linked
      sourceRef: { system: parent.sourceRef.system, record: `${parent.sourceRef.record}#att-${i + 1}:${name}` },
    });
  });
  links.forEach((link, i) => {
    children.push({
      id: `${parent.id}#url-${i + 1}`, channel: "url", format: "html",
      receivedAt: parent.receivedAt, parentId: parent.id, url: link.url,
      extraction: "unsupported", // not fetched; the URL resolver (person 1) may upgrade it
      sourceRef: { system: parent.sourceRef.system, record: `${parent.sourceRef.record}#url-${i + 1}`, url: link.url },
    });
  });
  return children;
}

function requireReceivedAt(value: string | undefined, kind: string): string {
  if (!value) throw new Error(`${kind}: no timestamp in the message; pass opts.receivedAt`);
  return value;
}

const PHONE_RE = /^\+?[\d\s().-]{7,}$/;

// ---------------------------------------------------------------------------
// Email

// One line of display text from a header value: no control characters, bounded. Undefined when nothing is left.
// Also drops C1 controls and Unicode direction/zero-width characters, which can reorder or hide text on screen.
const oneLine = (v: string | undefined, max: number): string | undefined => {
  const t = (v ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return t === "" ? undefined : t;
};
// An encoded header ("=?UTF-8?B?...?=") is not decoded here: showing it raw would be worse than "Message from <sender>".
const readableSubject = (v: string | undefined): string | undefined => {
  const t = oneLine(v, 200);
  return t && !/=\?[\w-]+\?[bq]\?/i.test(t) ? t : undefined;
};
const displayFrom = (name: string | undefined, email: string | undefined): string | undefined =>
  oneLine(name && email ? `${name} <${email}>` : email ?? name, 200);

export function parseEmail(raw: string, opts: ParseOptions): MessageBundle {
  const src = raw.replace(/\r\n/g, "\n");
  const split = src.search(/\n[ \t]*\n/);
  const headerBlock = split === -1 ? src : src.slice(0, split);

  let headers: Record<string, string> = {};
  let last = "";
  for (const line of headerBlock.split("\n")) {
    if (/^[ \t]/.test(line) && last) { headers[last] += " " + line.trim(); continue; }
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (m) { last = m[1]!.toLowerCase(); headers[last] = m[2]!; }
  }
  // A pasted body without real headers ("Invoice: INV-1203") must not be swallowed as headers.
  const hasHeaders = ["from", "to", "subject", "date", "message-id"].some((h) => h in headers);
  if (!hasHeaders) headers = {};
  const body = !hasHeaders ? src : split === -1 ? "" : src.slice(split).replace(/^\n[ \t]*\n/, "");

  const tz = opts.timeZone ?? DEFAULT_TZ;
  const receivedAt = requireReceivedAt(
    opts.receivedAt ?? (headers.date ? parseEmailDate(headers.date, tz) : undefined), "email");

  const from = headers.from ?? "";
  const fm = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  const bare = from.trim();
  const email = (fm ? fm[2]!.trim() : bare.includes("@") ? bare : "") || undefined;
  const name = (fm ? fm[1]!.trim() : bare.includes("@") ? "" : bare) || undefined;
  const sender = email || name ? { name, email: email?.toLowerCase() } : undefined;

  const messageId = headers["message-id"]?.replace(/[<>]/g, "") || opts.evidenceId;
  const parent: Evidence = {
    id: opts.evidenceId, channel: "email", format: "text", receivedAt, extraction: "ok",
    sourceRef: { system: "email", record: messageId, ...(readableSubject(headers.subject) ? { subject: readableSubject(headers.subject)! } : {}), ...(displayFrom(name, email) ? { from: displayFrom(name, email)! } : {}) },
  };
  const attachments = (headers["x-attachments"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const links = extractLinks(body);
  return {
    parent, children: buildChildren(parent, attachments, links), text: body,
    subject: headers.subject, headers, sender, links,
  };
}

// ---------------------------------------------------------------------------
// WhatsApp export: "[11/28/26, 9:31:47 AM] Name: text", continuation lines join the previous message.

const WA_LINE = /^\u200e?\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),[\s\u202f]+(\d{1,2}):(\d{2})(?::(\d{2}))?[\s\u202f]*([AaPp][Mm])?\][\s\u202f]+([^:]+):[ \t]?/;

export function parseWhatsApp(raw: string, opts: ParseOptions): MessageBundle {
  const text = raw.replace(/\r\n/g, "\n");
  const tz = opts.timeZone ?? DEFAULT_TZ;
  const messages: BundleMessage[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const m = WA_LINE.exec(line);
    if (m) {
      const [prefix, a, b, yy, hh, mi, ss = "0", ampm, who] = m;
      const [mo, d] = opts.dateOrder === "DMY" ? [b, a] : [a, b];
      let h = Number(hh);
      if (ampm) h = (h % 12) + (/p/i.test(ampm) ? 12 : 0);
      const y = yy!.length === 2 ? 2000 + Number(yy) : Number(yy);
      messages.push({
        at: zonedToUtcIso(y, Number(mo), Number(d), h, Number(mi), Number(ss), tz),
        sender: who!.trim(), text: line.slice(prefix.length),
        start: offset + prefix.length, end: offset + line.length,
      });
    } else if (messages.length && line.trim()) {
      const prev = messages[messages.length - 1]!;
      prev.end = offset + line.length;
      prev.text = text.slice(prev.start, prev.end);
    }
    offset += line.length + 1;
  }

  const receivedAt = requireReceivedAt(opts.receivedAt ?? messages[messages.length - 1]?.at, "whatsapp");
  const senders = [...new Set(messages.map((m) => m.sender))];
  const only = senders.length === 1 ? senders[0]! : undefined;
  const sender = only ? (PHONE_RE.test(only) ? { phone: only } : { name: only }) : undefined;

  const parent: Evidence = {
    id: opts.evidenceId, channel: "whatsapp", format: "text", receivedAt,
    extraction: messages.length ? "ok" : "partial",
    sourceRef: { system: "whatsapp", record: opts.evidenceId, ...(only ? { from: oneLine(only, 120)! } : {}) },
  };
  const links = extractLinks(text);
  return { parent, children: buildChildren(parent, [], links), text, sender, messages, links };
}

// ---------------------------------------------------------------------------
// Plain owner text (Ask Neri box, pasted note)

export function parsePaste(raw: string, opts: ParseOptions & { receivedAt: string }): MessageBundle {
  const text = raw.replace(/\r\n/g, "\n");
  const parent: Evidence = {
    id: opts.evidenceId, channel: "owner", format: "text", receivedAt: opts.receivedAt, extraction: "ok",
    sourceRef: { system: "owner", record: opts.evidenceId },
  };
  const links = extractLinks(text);
  return { parent, children: buildChildren(parent, [], links), text, links };
}
