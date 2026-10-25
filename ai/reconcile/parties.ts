// Counterparty resolution. Automatic only on confirmed identity: a provider ID
// alias, a confirmed email domain, or a confirmed phone number. Similar names
// produce review candidates, never a match.

import type { Party } from "../../schema/records";
import type { PartyCandidate } from "../../schema/intake";

export type PartyHint = { providerId?: string; email?: string; phone?: string; name?: string };

export type ProviderAlias = { providerId: string; partyId: string };

export type PartyResolution =
  | { partyId: string; via: "provider_id" | "email_domain" | "phone" }
  | { candidates: PartyCandidate[] }
  | { unknown: true; candidate: PartyCandidate };

const SUFFIXES = new Set([
  "llc", "inc", "incorporated", "co", "company", "corp", "corporation", "ltd", "limited",
  "plc", "gmbh", "pvt", "the", "and",
]);

export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !SUFFIXES.has(t));
}

// Jaccard overlap of normalized tokens, with subset counted as a strong match.
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  if (inter === Math.min(ta.size, tb.size)) return Math.max(0.8, inter / Math.max(ta.size, tb.size));
  return inter / (ta.size + tb.size - inter);
}

export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

function phonesMatch(a: string, b: string): boolean {
  const x = normalizePhone(a);
  const y = normalizePhone(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length >= 10 && y.length >= 10 && x.slice(-10) === y.slice(-10);
}

function emailDomain(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  return at === -1 ? undefined : email.slice(at + 1).trim().toLowerCase().replace(/>$/, "");
}

function domainMatches(domain: string, confirmed: string): boolean {
  const c = confirmed.toLowerCase();
  return domain === c || domain.endsWith("." + c);
}

const NAME_THRESHOLD = 0.5;

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "qq.com", "163.com",
]);

export function resolveParty(
  hint: PartyHint,
  parties: Party[],
  aliases: ProviderAlias[] = [],
): PartyResolution {
  const hintCandidate: PartyCandidate = {
    name: hint.name, providerId: hint.providerId,
    emails: hint.email ? [hint.email.toLowerCase()] : undefined,
    phones: hint.phone ? [hint.phone] : undefined,
    reason: "no confirmed identity matched",
  };
  const known = new Set(parties.map((p) => p.id));

  // 1. Provider ID alias (confirmed mapping from a connector/export).
  if (hint.providerId) {
    const ids = [...new Set(aliases.filter((a) => a.providerId === hint.providerId && known.has(a.partyId)).map((a) => a.partyId))];
    if (ids.length === 1) return { partyId: ids[0]!, via: "provider_id" };
  }

  // 2. Confirmed email domain. Several parties sharing a domain, or a free-mail
  //    domain that anyone can use, is a candidate only.
  const domain = hint.email ? emailDomain(hint.email) : undefined;
  if (domain) {
    const hits = parties.filter((p) => p.contacts?.emailDomains?.some((d) => domainMatches(domain, d)));
    if (hits.length === 1 && !FREE_MAIL.has(domain)) return { partyId: hits[0]!.id, via: "email_domain" };
    if (hits.length >= 1) {
      return { candidates: hits.map((p) => ({ ...hintCandidate, partyId: p.id, reason: `shares email domain ${domain}` })) };
    }
  }

  // 3. Confirmed phone.
  if (hint.phone) {
    const hits = parties.filter((p) => p.contacts?.phones?.some((ph) => phonesMatch(hint.phone!, ph)));
    if (hits.length === 1) return { partyId: hits[0]!.id, via: "phone" };
    if (hits.length > 1) {
      return { candidates: hits.map((p) => ({ ...hintCandidate, partyId: p.id, reason: "shares phone number" })) };
    }
  }

  // 4. Similar names: candidates only.
  if (hint.name) {
    const scored = parties
      .map((p) => ({ p, score: nameSimilarity(hint.name!, p.name) }))
      .filter((s) => s.score >= NAME_THRESHOLD)
      .sort((a, b) => b.score - a.score);
    if (scored.length) {
      return {
        candidates: scored.map(({ p, score }) => ({
          ...hintCandidate, partyId: p.id, reason: `similar name to "${p.name}" (${Math.round(score * 100)}%)`,
        })),
      };
    }
  }

  return { unknown: true, candidate: hintCandidate };
}
