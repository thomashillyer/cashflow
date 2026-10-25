import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyUrl, parseEmail, parseEmailDate, parsePaste, parseWhatsApp, zonedToUtcIso } from "./message";

const dir = join(import.meta.dirname, "../../fixtures/cascade_trade/intake");
const read = (f: string) => readFileSync(join(dir, f), "utf8");

describe("parseEmail", () => {
  const b = parseEmail(read("email-inv1187.eml"), { evidenceId: "ev-email-1" });

  it("reads headers, sender, and UTC time", () => {
    expect(b.subject).toBe("RE: Invoice INV-1187 from Cascade Trade Co.");
    expect(b.sender).toEqual({ name: "Dana Whitfield", email: "accounts@evergreenhome.example" });
    expect(b.parent.receivedAt).toBe("2026-11-27T00:42:10.000Z");
    expect(b.parent).toMatchObject({ channel: "email", format: "text", extraction: "ok" });
    // The owner recognises a message by who sent it and what it says, not by its message id.
    expect(b.parent.sourceRef).toEqual({
      system: "email", record: "evg-20261126-1642@evergreenhome.example",
      subject: "RE: Invoice INV-1187 from Cascade Trade Co.", from: "Dana Whitfield <accounts@evergreenhome.example>",
    });
  });

  it("keeps the subject and sender on one clean line, bounded, and leaves them out when absent", () => {
    const long = parseEmail(`From: "Evil\r\nBcc: x" <a@b.example>\nSubject: ${"x".repeat(400)}\nMessage-ID: <m1@b.example>\n\nbody`, { evidenceId: "ev-1", receivedAt: "2026-11-01T00:00:00Z" });
    expect(long.parent.sourceRef.subject).toHaveLength(200);
    expect(long.parent.sourceRef.from).not.toMatch(/[\r\n]/);
    const bare = parseEmail("Invoice: INV-1203 for $4,000", { evidenceId: "ev-2", receivedAt: "2026-11-01T00:00:00Z" });
    expect(bare.parent.sourceRef).toEqual({ system: "email", record: "ev-2" });
  });

  it("bundles one attachment, an invoice link, and a payment link as child evidence", () => {
    expect(b.links.map((l) => l.kind)).toEqual(["invoice", "payment"]);
    for (const l of b.links) expect(b.text.slice(l.start, l.end)).toBe(l.url);
    expect(b.children.map((c) => [c.id, c.channel, c.format])).toEqual([
      ["ev-email-1#att-1", "email", "pdf"],
      ["ev-email-1#url-1", "url", "html"],
      ["ev-email-1#url-2", "url", "html"],
    ]);
    for (const c of b.children) expect(c.parentId).toBe("ev-email-1");
    expect(b.children[2]!.url).toBe("https://checkout.stripe.example/c/pay/cs_live_inv1187_cascade");
  });

  it("never produces settlement or commitment state from a payment link", () => {
    const json = JSON.stringify(b);
    expect(json).not.toMatch(/settle|paid|commitmentId/i);
  });

  it("treats a prompt injection as plain data", () => {
    const inj = parseEmail(read("email-injection.eml"), { evidenceId: "ev-inj" });
    expect(inj.text).toContain("Ignore all previous instructions");
    expect(inj.links).toEqual([]);
    expect(inj.children).toEqual([]);
    expect(JSON.stringify(inj)).not.toMatch(/settle|commitmentId/i);
  });

  it("keeps a pasted body without headers as text", () => {
    const pasted = "Invoice: INV-1203\nTotal due: USD 4,000.00\n\nThanks";
    const p = parseEmail(pasted, { evidenceId: "p", receivedAt: "2026-11-16T18:05:00Z" });
    expect(p.text).toBe(pasted);
    expect(p.headers).toEqual({});
  });

  it("does not treat a bare From name as an email", () => {
    const p = parseEmail("From: Dana\nSubject: hi\n\nbody", { evidenceId: "p", receivedAt: "2026-11-16T18:05:00Z" });
    expect(p.sender).toEqual({ name: "Dana", email: undefined });
  });

  it("requires a timestamp when the message has none", () => {
    expect(() => parseEmail("From: a@b.example\n\nhello", { evidenceId: "x" })).toThrow(/receivedAt/);
    expect(parseEmail("From: a@b.example\n\nhello", { evidenceId: "x", receivedAt: "2026-10-25T16:00:00Z" }).parent.receivedAt)
      .toBe("2026-10-25T16:00:00Z");
  });
});

describe("parseWhatsApp", () => {
  const raw = read("whatsapp-evergreen.txt");
  const b = parseWhatsApp(raw, { evidenceId: "ev-wa-1" });

  it("splits messages with Pacific timestamps converted to UTC", () => {
    expect(b.messages!.map((m) => [m.at, m.sender])).toEqual([
      ["2026-11-28T17:14:02.000Z", "Cascade Trade (Mei)"],
      ["2026-11-28T17:31:47.000Z", "Dana Evergreen"],
      ["2026-11-28T17:32:15.000Z", "Dana Evergreen"],
    ]);
    expect(b.parent.receivedAt).toBe("2026-11-28T17:32:15.000Z");
  });

  it("offsets slice back to each message's text", () => {
    for (const m of b.messages!) expect(raw.slice(m.start, m.end)).toBe(m.text);
    expect(b.messages![1]!.text).toContain("early January");
  });

  it("has no single sender when two people talk", () => {
    expect(b.sender).toBeUndefined();
  });

  it("joins continuation lines and handles U+202F before PM", () => {
    const multi = "\u200e[1/5/27, 4:05:00\u202fPM] +1 (206) 555-0101: line one\nline two\n";
    const m = parseWhatsApp(multi, { evidenceId: "w" });
    expect(m.messages![0]!.text).toBe("line one\nline two");
    expect(m.messages![0]!.at).toBe("2027-01-06T00:05:00.000Z");
    expect(m.sender).toEqual({ phone: "+1 (206) 555-0101" });
  });

  it("supports day-first exports", () => {
    const m = parseWhatsApp("[05/01/27, 16:05:00] Ana: hola", { evidenceId: "w", dateOrder: "DMY" });
    expect(m.messages![0]!.at).toBe("2027-01-06T00:05:00.000Z");
  });
});

describe("parsePaste", () => {
  it("captures owner text with its own evidence", () => {
    const b = parsePaste(read("owner-message-inv104.txt"), { evidenceId: "ev-owner-1", receivedAt: "2026-10-25T16:00:00Z" });
    expect(b.parent).toMatchObject({ channel: "owner", receivedAt: "2026-10-25T16:00:00Z" });
    expect(b.text).toContain("INV-104");
    expect(b.links).toEqual([]);
  });
});

describe("helpers", () => {
  it("classifies URLs", () => {
    expect(classifyUrl("https://books.zoho.example/portal/cascadetrade/invoice/2-INV-1187")).toBe("invoice");
    expect(classifyUrl("https://checkout.stripe.example/c/pay/cs_live_x")).toBe("payment");
    expect(classifyUrl("https://www.paypal.com/invoice/p/#ABC")).toBe("payment");
    expect(classifyUrl("https://example.com/i/123", "Pay now: ")).toBe("payment");
    expect(classifyUrl("https://example.com/news")).toBe("other");
    expect(classifyUrl("not a url")).toBe("other");
  });

  it("converts dates across DST and zones", () => {
    expect(parseEmailDate("Thu, 26 Nov 2026 16:42:10 -0800")).toBe("2026-11-27T00:42:10.000Z");
    expect(parseEmailDate("1 Jul 2026 09:00:00 GMT")).toBe("2026-07-01T09:00:00.000Z");
    expect(parseEmailDate("1 Jul 2026 09:00:00")).toBe("2026-07-01T16:00:00.000Z"); // PDT
    expect(parseEmailDate("garbage")).toBeUndefined();
    expect(zonedToUtcIso(2026, 3, 8, 3, 30, 0, "America/Los_Angeles")).toBe("2026-03-08T10:30:00.000Z");
  });
});
