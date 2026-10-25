import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Party } from "../../schema/records";
import { parseEmail } from "../extract/message";
import { nameSimilarity, resolveParty } from "./parties";

const dir = join(import.meta.dirname, "../../fixtures/cascade_trade/intake");
const base = JSON.parse(readFileSync(join(dir, "base_records.json"), "utf8")) as { parties: Party[] };
const parties = base.parties;

describe("resolveParty", () => {
  it("resolves the INV-1187 email sender by confirmed domain", () => {
    const b = parseEmail(readFileSync(join(dir, "email-inv1187.eml"), "utf8"), { evidenceId: "e" });
    expect(resolveParty({ email: b.sender!.email, name: b.sender!.name }, parties))
      .toEqual({ partyId: "party-evergreen-home", via: "email_domain" });
  });

  it("matches subdomains of a confirmed domain", () => {
    expect(resolveParty({ email: "ap@billing.evergreenhome.example" }, parties))
      .toEqual({ partyId: "party-evergreen-home", via: "email_domain" });
  });

  it("uses provider ID aliases first", () => {
    const aliases = [{ providerId: "zoho-cust-77", partyId: "party-puget-market" }];
    expect(resolveParty({ providerId: "zoho-cust-77", email: "x@evergreenhome.example" }, parties, aliases))
      .toEqual({ partyId: "party-puget-market", via: "provider_id" });
  });

  it("matches a confirmed phone with formatting differences", () => {
    const withPhone: Party[] = [...parties, {
      id: "party-ferry", name: "Ferry Supply", kind: "supplier", tags: [], notes: [],
      contacts: { phones: ["+1 206-555-0101"] },
    }];
    expect(resolveParty({ phone: "(206) 555 0101" }, withPhone)).toEqual({ partyId: "party-ferry", via: "phone" });
  });

  it("never auto-matches on a similar name", () => {
    const r = resolveParty({ name: "Evergreen Home LLC" }, parties);
    expect(r).not.toHaveProperty("partyId");
    expect("candidates" in r && r.candidates[0]).toMatchObject({ partyId: "party-evergreen-home" });
  });

  it("returns unknown for an unrecognized sender", () => {
    const r = resolveParty({ email: "someone@unknown.example", name: "Totally Different Ltd" }, parties);
    expect(r).toMatchObject({ unknown: true, candidate: { emails: ["someone@unknown.example"] } });
  });

  it("treats a domain shared by two parties as ambiguous", () => {
    const shared: Party[] = parties.map((p) =>
      p.id === "party-puget-market" ? { ...p, contacts: { emailDomains: ["evergreenhome.example"] } } : p);
    const r = resolveParty({ email: "ap@evergreenhome.example" }, shared);
    expect("candidates" in r && r.candidates.map((c) => c.partyId).sort())
      .toEqual(["party-evergreen-home", "party-puget-market"]);
  });
});

describe("free-mail domains", () => {
  it("never auto-match even when a party lists one", () => {
    const withGmail: Party[] = parties.map((p) =>
      p.id === "party-puget-market" ? { ...p, contacts: { emailDomains: ["gmail.com"] } } : p);
    const r = resolveParty({ email: "random.person@gmail.com" }, withGmail);
    expect(r).not.toHaveProperty("partyId");
  });
});

describe("nameSimilarity", () => {
  it("ignores suffixes and punctuation", () => {
    expect(nameSimilarity("Shenzhen Ceramics Co., Ltd.", "Shenzhen Ceramics Co.")).toBeGreaterThanOrEqual(0.8);
    expect(nameSimilarity("Harbor & Hearth", "Harbor and Hearth")).toBe(1);
    expect(nameSimilarity("Ningbo Pack", "Puget Market")).toBe(0);
  });
});
