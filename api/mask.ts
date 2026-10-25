// Masking at the edge (docs/design/04-adapters.md): a per-business alias table swaps real party names for stage
// names in API responses, so a real account can be shown on a screen or in a demo. Presentation only: record
// ids, numbers, dates and links are never changed, so the app keeps working. Applied when the request asks
// (x-neri-mask: 1 or ?mask=1) or the business has masking switched on.
//
//  - party names, their other names and the name without "Pvt Ltd" -> Customer A, Supplier A, ...
//  - the business's own name -> "Your business"; the owner's name -> "Owner"
//  - email addresses -> contact@example.com
//  - phone numbers (international format) and long digit runs (bank accounts) -> blanked, in every string
//
// WHAT IT CANNOT KNOW: a real name that is not a party record (a bank payee with no matching party, a name
// inside an owner note or a CRM text) is not masked. Check a real account's screens before showing them.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { nameTokens } from "../ai/reconcile/parties";
import type { Party } from "../schema/records";
import type { Deps } from "./app";
import { businessOf, HttpError, type NeriRequest } from "./http";
import type { Business } from "./store";

const LABEL: Record<Party["kind"], string> = { customer: "Customer", supplier: "Supplier", agency: "Agency", employee: "Employee", other: "Party" };
// Design default: words too generic to stand for one company on their own (used by the first-word rule only).
const GENERIC = new Set(["packaging", "supply", "supplies", "trading", "trade", "group", "foods", "food", "market", "home", "industries", "international", "solutions", "services", "global", "logistics", "sales", "first", "best", "new", "pacific", "atlantic", "national", "american", "united", "general"]);

const SEP = "[\\s\\-_.&]+";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const letters = (i: number): string => (i >= 26 ? letters(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + (i % 26));
const words = (s: string) => s.normalize("NFKC").split(new RegExp(SEP)).filter(Boolean);
const norm = (s: string) => words(s).join(" ").toLowerCase();

// Whole-word boundaries that understand letters beyond ASCII ("Müller").
const BEFORE = "(?<![\\p{L}\\p{N}])";
const AFTER = "(?![\\p{L}\\p{N}])";

export type Mask = {
  loose: Map<string, string>;       // multi-word names: matched ignoring case, spacing and punctuation
  exact: Map<string, string>;       // single words: matched with their own capitalisation only
  looseRe: RegExp | null;
  exactRe: RegExp | null;
};

export function buildMask(
  parties: Pick<Party, "name" | "kind" | "aliases">[],
  business: { name: string; aliases?: string[]; owner?: string },
  explicit: Record<string, string> = {},
): Mask {
  const counters: Record<string, number> = {};
  const sorted = [...parties].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));   // stable across requests
  const entries: { phrase: string; to: string }[] = [];

  const firstOwners = new Map<string, number>();
  for (const p of sorted) { const w = nameTokens(p.name)[0]; if (w) firstOwners.set(w, (firstOwners.get(w) ?? 0) + 1); }
  const firstWords: { word: string; to: string }[] = [];

  for (const p of sorted) {
    const own = Object.hasOwn(explicit, p.name) ? explicit[p.name]! : `${LABEL[p.kind] ?? "Party"} ${letters((counters[p.kind] = (counters[p.kind] ?? -1) + 1))}`;
    for (const n of new Set([p.name, ...(p.aliases ?? []), nameTokens(p.name).join(" ")])) if (n.trim().length > 1) entries.push({ phrase: n, to: own });
    // A distinctive capitalised first word ("Carry" for "Carry Well Packaging"), only when it is unique among
    // parties and not an everyday word, so ordinary words in labels and warnings are left alone.
    const toks = nameTokens(p.name);
    const first = words(p.name).find((w) => w.toLowerCase() === toks[0]);
    if (first && toks.length > 1 && first.length >= 5 && /^\p{Lu}/u.test(first) && !GENERIC.has(first.toLowerCase()) && firstOwners.get(toks[0]!) === 1) firstWords.push({ word: first, to: own });
  }
  for (const n of [business.name, ...(business.aliases ?? [])]) if (n.trim().length > 1) entries.push({ phrase: n, to: "Your business" });
  if (business.owner && business.owner.trim().length > 2) entries.push({ phrase: business.owner, to: "Owner" });
  for (const [real, stage] of Object.entries(explicit)) if (real.trim().length > 1) entries.push({ phrase: real, to: stage });

  const loose = new Map<string, string>();
  const exact = new Map<string, string>();
  for (const { phrase, to } of entries) {
    const w = words(phrase);
    if (w.length === 0) continue;
    if (w.length === 1) { if (w[0]!.length >= 3) exact.set(w[0]!, to); } else if (!loose.has(norm(phrase))) loose.set(norm(phrase), to);
  }
  for (const { word, to } of firstWords) if (!exact.has(word) && !loose.has(norm(word))) exact.set(word, to);

  // One pattern per group, longest first: a mask for a thousand parties is still one pass over each string.
  const looseKeys = [...loose.keys()].sort((a, b) => b.length - a.length);
  const exactKeys = [...exact.keys()].sort((a, b) => b.length - a.length);
  return {
    loose, exact,
    looseRe: looseKeys.length ? new RegExp(`${BEFORE}(?:${looseKeys.map((p) => p.split(" ").map(escapeRe).join(SEP)).join("|")})${AFTER}`, "giu") : null,
    exactRe: exactKeys.length ? new RegExp(`${BEFORE}(?:${exactKeys.map(escapeRe).join("|")})${AFTER}`, "gu") : null,
  };
}

// Keys and strings that are record ids or links: never rewritten, so the app can follow them.
const ID_KEY = /^(id|record|fileHash|hash|storageKey|url|invoiceUrl|paymentUrl|parentId|system|channel|format|currency|state|status|kind|type)$|(Id|Ids|_id)$/;
const ID_PREFIX = /^(?:party|inv|bill|deal|ev|evt|cand|cp|sig|rule|wi|set|unalloc|plan|thought)-[A-Za-z0-9._~:-]+$/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE = /\+\d[\d\s().-]{8,}\d/g;
const LONG_DIGITS = /(?<![\d.,])\d{9,}(?![\d.,])/g;

function maskNames(s: string, mask: Mask): string {
  let out = s.normalize("NFKC");
  if (mask.looseRe) out = out.replace(mask.looseRe, (m) => mask.loose.get(norm(m)) ?? m);
  if (mask.exactRe) out = out.replace(mask.exactRe, (m) => mask.exact.get(m) ?? m);
  return out;
}

function maskString(s: string, mask: Mask): string {
  return maskNames(s, mask)
    .replace(EMAIL, "contact@example.com")
    .replace(PHONE, "+•• •••• ••••")
    .replace(LONG_DIGITS, (d) => `••••${d.slice(-4)}`);
}

export function maskJson(value: unknown, mask: Mask, key = ""): unknown {
  if (typeof value === "string") {
    if (ID_PREFIX.test(value) || (ID_KEY.test(key) && !/\s/.test(value))) return value;
    return maskString(value, mask);
  }
  if (Array.isArray(value)) return value.map((v) => maskJson(v, mask, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [ID_PREFIX.test(k) ? k : maskNames(k, mask), maskJson(v, mask, k)]));
  }
  return value;
}

const maskRequested = (req: FastifyRequest, b: Business): boolean => {
  const q = (req.query ?? {}) as Record<string, unknown>;
  return req.headers["x-neri-mask"] === "1" || q.mask === "1" || b.profile.account?.maskNames === true;
};

const CACHE_MS = 30_000;

export function installMask(app: FastifyInstance, deps: Deps): void {
  const cache = new Map<string, { at: number; fingerprint: string; mask: Mask }>();
  app.addHook("onSend", async (req, reply, payload) => {
    const b = (req as NeriRequest).business;
    if (!b || typeof payload !== "string") return payload;
    if (!String(reply.getHeader("content-type") ?? "").includes("application/json")) return payload;
    reply.header("vary", [String(reply.getHeader("vary") ?? ""), "x-neri-mask"].filter(Boolean).join(", "));   // the body depends on this header
    if (!maskRequested(req, b)) return payload;
    let json: unknown;
    try { json = JSON.parse(payload); } catch { return payload; }

    const acc = b.profile.account;
    const fingerprint = JSON.stringify([b.name, acc?.owner, acc?.aliases, acc?.maskAliases]);
    const now = deps.now().getTime();
    let hit = cache.get(b.id);
    if (!hit || hit.fingerprint !== fingerprint || now - hit.at > CACHE_MS) {
      const { records } = await deps.store.load(b.id);
      hit = {
        at: now, fingerprint,
        mask: buildMask(records.parties, { name: b.name, ...(acc?.aliases ? { aliases: acc.aliases } : {}), ...(acc?.owner ? { owner: acc.owner } : {}) }, acc?.maskAliases),
      };
      cache.set(b.id, hit);
    }
    reply.removeHeader("content-length");
    reply.header("x-neri-masked", "1");
    return JSON.stringify(maskJson(json, hit.mask));
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
