// Masking at the edge (docs/design/04-adapters.md): a per-business alias table swaps real party names for stage
// names in API responses, so a real account can be shown on a screen or in a demo. Presentation only: ids,
// numbers, dates and links are never changed, so the app keeps working. Applied when the request asks
// (x-neri-mask: 1 or ?mask=1) or the business has masking switched on.
//
//  - party names (and their other names, and a distinctive first word) -> Customer A, Supplier A, ...
//  - the business's own name -> "Your business"
//  - email addresses -> contact@example.com
//  - inside free text only: international phone numbers and long digit runs (bank accounts) are blanked

import type { FastifyInstance, FastifyRequest } from "fastify";
import { nameTokens } from "../ai/reconcile/parties";
import type { Party } from "../schema/records";
import type { Deps } from "./app";
import { businessOf, HttpError, type NeriRequest } from "./http";
import type { Business } from "./store";

const LABEL: Record<Party["kind"], string> = { customer: "Customer", supplier: "Supplier", agency: "Agency", employee: "Employee", other: "Party" };
// Words too generic to stand for one company on their own.
const GENERIC = new Set(["packaging", "supply", "supplies", "trading", "trade", "group", "foods", "food", "market", "home", "industries", "international", "solutions", "services", "global", "logistics", "sales"]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const letters = (i: number): string => (i >= 26 ? letters(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + (i % 26));

export type Mask = { names: { re: RegExp; to: string }[] };

export function buildMask(parties: Pick<Party, "name" | "kind" | "aliases">[], business: { name: string; aliases?: string[] }, explicit: Record<string, string> = {}): Mask {
  const counters: Record<string, number> = {};
  const sorted = [...parties].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));   // stable across requests
  const phrases: { phrase: string; to: string }[] = [];
  const firstWordOwners = new Map<string, number>();
  for (const p of sorted) { const w = nameTokens(p.name)[0]; if (w) firstWordOwners.set(w, (firstWordOwners.get(w) ?? 0) + 1); }

  for (const p of sorted) {
    const own = Object.hasOwn(explicit, p.name) ? explicit[p.name]! : `${LABEL[p.kind] ?? "Party"} ${letters((counters[p.kind] = (counters[p.kind] ?? -1) + 1))}`;
    const names = new Set([p.name, ...(p.aliases ?? []), nameTokens(p.name).join(" ")].filter((n) => n.trim().length > 1));
    const first = nameTokens(p.name)[0];
    if (first && first.length >= 4 && !GENERIC.has(first) && firstWordOwners.get(first) === 1 && nameTokens(p.name).length > 1) names.add(first);
    for (const n of names) phrases.push({ phrase: n, to: own });
  }
  for (const n of [business.name, ...(business.aliases ?? [])]) if (n.trim().length > 1) phrases.push({ phrase: n, to: "Your business" });
  for (const [real, stage] of Object.entries(explicit)) if (real.trim().length > 1) phrases.push({ phrase: real, to: stage });

  phrases.sort((a, b) => b.phrase.length - a.phrase.length);   // longest first: "Carry Well Packaging" before "Carry"
  return {
    names: phrases.map(({ phrase, to }) => ({
      re: new RegExp(`(?<![A-Za-z0-9])${escapeRe(phrase.trim()).replace(/\s+/g, "\\s+")}(?![A-Za-z0-9])`, "gi"), to,
    })),
  };
}

// Keys whose values are identifiers or links the app uses: never touched.
const ID_KEY = /^(id|record|fileHash|hash|storageKey|url|invoiceUrl|paymentUrl|parentId|system|channel|format|currency|state|status|kind|type)$|(Id|Ids|_id)$/;
// Keys that hold free text, where phone numbers and long digit runs are also blanked.
const FREE_TEXT = /^(text|excerpt|note|notes|message|quote|description|basis|body|subject|summary|title|label|headline|detail|reason|reasons|draft|content|words|instructions)$/i;

// A string that looks like a record id (party-evergreen-home, inv-INV-1187, ev-email-ab12~cd34) is never rewritten,
// even under a key we do not know: the app follows these to other calls.
const ID_LIKE = /^[a-z]+(?:_[a-z]+)?-[A-Za-z0-9._~:-]+$/;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE = /\+\d[\d\s().-]{8,}\d/g;
const LONG_DIGITS = /(?<![\d.,])\d{9,}(?![\d.,])/g;

function maskString(s: string, mask: Mask, freeText: boolean): string {
  let out = s;
  for (const { re, to } of mask.names) out = out.replace(re, to);
  out = out.replace(EMAIL, "contact@example.com");
  if (freeText) out = out.replace(PHONE, "+•• •••• ••••").replace(LONG_DIGITS, (d) => `••••${d.slice(-4)}`);
  return out;
}

export function maskJson(value: unknown, mask: Mask, key = "", free = false): unknown {
  if (typeof value === "string") return ID_KEY.test(key) || ID_LIKE.test(value) ? value : maskString(value, mask, free || FREE_TEXT.test(key));
  if (Array.isArray(value)) return value.map((v) => maskJson(v, mask, key, free));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskJson(v, mask, k, free)]));
  }
  return value;
}

const maskRequested = (req: FastifyRequest, b: Business): boolean => {
  const q = (req.query ?? {}) as Record<string, unknown>;
  return req.headers["x-neri-mask"] === "1" || q.mask === "1" || b.profile.account?.maskNames === true;
};

export function installMask(app: FastifyInstance, deps: Deps): void {
  app.addHook("onSend", async (req, reply, payload) => {
    const b = (req as NeriRequest).business;
    if (!b || typeof payload !== "string" || reply.statusCode >= 400 || !maskRequested(req, b)) return payload;
    if (!String(reply.getHeader("content-type") ?? "").includes("application/json")) return payload;
    let json: unknown;
    try { json = JSON.parse(payload); } catch { return payload; }
    const { records } = await deps.store.load(b.id);
    const mask = buildMask(records.parties, { name: b.name, ...(b.profile.account?.aliases ? { aliases: b.profile.account.aliases } : {}) }, b.profile.account?.maskAliases);
    reply.removeHeader("content-length");
    reply.header("x-neri-masked", "1");
    return JSON.stringify(maskJson(json, mask));
  });
}

// PUT /profile/masking { maskNames, maskAliases? }: switch masking on for this business and name the stage aliases.
export const maskRoutes = (deps: Deps) => async (app: FastifyInstance) => {
  app.put("/profile/masking", async (req) => {
    const b = businessOf(req);
    if (b.isSynthetic) throw new HttpError(403, "SAMPLE_BUSINESS", "The samples are shared, so masking can't be switched on for them. Use Hide names in Settings, or open your own business.");
    const body = (req.body ?? {}) as { maskNames?: unknown; maskAliases?: unknown };
    if (typeof body.maskNames !== "boolean") throw new HttpError(400, "INVALID_ARGUMENT", "Say whether to mask names: true or false.", { fieldIssues: [{ field: "maskNames", issue: "must be true or false" }] });
    let aliases: Record<string, string> | undefined;
    if (body.maskAliases !== undefined) {
      const e = body.maskAliases;
      const entries = typeof e === "object" && e !== null && !Array.isArray(e) ? Object.entries(e as Record<string, unknown>) : null;
      const okEntries = entries && entries.length <= 200 && entries.every(([k, v]) => k.trim().length > 1 && k.length <= 120 && typeof v === "string" && v.trim().length > 0 && v.length <= 80 && !/[\u0000-\u001f]/.test(k + v));
      if (!okEntries) throw new HttpError(400, "INVALID_ARGUMENT", "Aliases must be a list of real name to stage name, each a short line of text.", { fieldIssues: [{ field: "maskAliases", issue: "invalid" }] });
      aliases = Object.fromEntries(entries!.map(([k, v]) => [k.trim(), String(v).trim()]));
    }
    const acc = b.profile.account ?? {};
    await deps.store.saveProfile(b.id, { ...b.profile, account: { ...acc, maskNames: body.maskNames, ...(aliases ? { maskAliases: aliases } : {}) } });
    return { maskNames: body.maskNames, aliases: aliases ? Object.keys(aliases).length : Object.keys(acc.maskAliases ?? {}).length };
  });
};
