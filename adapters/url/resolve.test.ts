import { describe, expect, it } from "vitest";
import { checkUrl, isPrivateAddress } from "./guard";
import { httpsTransport, resolveInvoiceUrl, type Transport } from "./resolve";

const at = "2026-10-25T18:00:00Z";
const enc = (s: string) => new TextEncoder().encode(s);
const page = (html: string, status = 200, type = "text/html; charset=utf-8") => ({ status, headers: { "content-type": type }, body: enc(html) });
const INVOICE = "https://invoice.zoho.com/SecurePayment?CInvoiceID=abc123";

describe("address guard", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1",
    "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "ff02::1", "not-an-ip",
  ])("blocks %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(["8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it("only accepts https links to supported providers", () => {
    expect(checkUrl(INVOICE)).toMatchObject({ ok: true, provider: "zoho_books" });
    expect(checkUrl("https://app.qbo.intuit.com/app/invoices?txnId=1")).toMatchObject({ ok: true, provider: "quickbooks" });
    for (const bad of [
      "http://invoice.zoho.com/x", "https://127.0.0.1/x", "https://[::1]/x", "https://2130706433/x", "https://localhost/x",
      "https://user:pw@invoice.zoho.com/x", "https://invoice.zoho.com:8443/x", "https://evil.example.com/zoho.com", "https://zoho.com.evil.io/x", "javascript:alert(1)", "nonsense",
    ]) expect(checkUrl(bad).ok, bad).toBe(false);
  });
});

describe("resolveInvoiceUrl", () => {
  it("reads a supported public page into bounded evidence", async () => {
    const transport: Transport = async () => page("<html><script>x()</script><body><h1>Invoice INV-1187</h1><p>Total&nbsp;$28,000.00</p></body></html>");
    const r = await resolveInvoiceUrl(INVOICE, { receivedAt: at, transport });
    expect(r.read).toBe(true);
    expect(r.evidence).toMatchObject({ channel: "url", url: INVOICE, extraction: "ok", sourceRef: { system: "zoho_books", url: INVOICE } });
    expect(r.evidence.text).toBe("Invoice INV-1187 Total $28,000.00");
    expect(r.evidence.fileHash).toHaveLength(64);
  });

  it("follows redirects only to supported hosts, up to the limit", async () => {
    let n = 0;
    const ok: Transport = async () => (n++ === 0 ? { status: 302, headers: { location: "/final" }, body: new Uint8Array() } : page("<p>Invoice INV-9</p>"));
    expect((await resolveInvoiceUrl(INVOICE, { receivedAt: at, transport: ok })).read).toBe(true);

    for (const location of ["https://169.254.169.254/latest/meta-data", "http://invoice.zoho.com/x", "https://evil.example.com/x"]) {
      const bad: Transport = async () => ({ status: 302, headers: { location }, body: new Uint8Array() });
      const r = await resolveInvoiceUrl(INVOICE, { receivedAt: at, transport: bad });
      expect(r.read, location).toBe(false);
      expect(r.evidence.url).toBe(INVOICE);
    }
    const loop: Transport = async () => ({ status: 302, headers: { location: "/again" }, body: new Uint8Array() });
    const r = await resolveInvoiceUrl(INVOICE, { receivedAt: at, transport: loop });
    expect(r.fallback).toMatch(/too many times/);
  });

  it.each([
    [401, "needs a login"], [403, "needs a login"], [404, "expired"], [500, "error"],
  ])("status %s keeps the source and asks for a fallback", async (status, words) => {
    const r = await resolveInvoiceUrl(INVOICE, { receivedAt: at, transport: async () => page("nope", status) });
    expect(r.read).toBe(false);
    expect(r.evidence).toMatchObject({ url: INVOICE, extraction: "unreadable" });
    expect(r.evidence.text).toBeUndefined();
    expect(r.fallback).toContain(words);
    expect(r.fallback).toMatch(/Upload the invoice PDF/);
  });

  it("handles timeouts, oversize pages, PDFs, and empty pages without throwing", async () => {
    const t = (e: Error): Transport => async () => { throw e; };
    expect((await resolveInvoiceUrl(INVOICE, { receivedAt: at, transport: t(new Error("timeout")) })).fallback).toMatch(/too long/);
    expect((await resolveInvoiceUrl(INVOICE, { receivedAt: at, transport: t(new Error("too large")) })).fallback).toMatch(/too large/);
    expect((await resolveInvoiceUrl(INVOICE, { receivedAt: at, transport: t(new Error("ECONNRESET")) })).fallback).toMatch(/could not be reached/);
    expect((await resolveInvoiceUrl(INVOICE, { receivedAt: at, transport: async () => page("%PDF", 200, "application/pdf") })).evidence.extraction).toBe("unsupported");
    expect((await resolveInvoiceUrl(INVOICE, { receivedAt: at, transport: async () => page("<script>x</script>") })).read).toBe(false);
  });

  it("captures a payment link without opening it, and never as payment evidence", async () => {
    let called = false;
    const transport: Transport = async () => { called = true; return page("x"); };
    const r = await resolveInvoiceUrl("https://payments.zoho.com/pay/abc", { receivedAt: at, transport });
    expect(called).toBe(false);
    expect(r.kind).toBe("payment");
    expect(r.read).toBe(false);
    expect(r.evidence.url).toBe("https://payments.zoho.com/pay/abc");
  });

  it("never calls the network for an unsupported or private link, but keeps it", async () => {
    let called = false;
    const transport: Transport = async () => { called = true; return page("x"); };
    for (const url of ["https://10.0.0.5/invoice/1", "https://example.com/invoice/1", "ftp://x/y", "not a url"]) {
      const r = await resolveInvoiceUrl(url, { receivedAt: at, transport });
      expect(r.read).toBe(false);
      expect(r.evidence.url).toBe(url);
      expect(r.fallback).toMatch(/Upload the invoice PDF/);
    }
    expect(called).toBe(false);
  });

  it("gives the same evidence id for the same link, so a re-import upserts", async () => {
    const a = await resolveInvoiceUrl(INVOICE, { receivedAt: at, transport: async () => page("<p>1</p>") });
    const b = await resolveInvoiceUrl(INVOICE, { receivedAt: "2026-10-26T00:00:00Z", transport: async () => page("<p>2</p>") });
    expect(a.evidence.id).toBe(b.evidence.id);
  });

  it("default transport refuses a private destination before connecting", async () => {
    await expect(httpsTransport(new URL("https://localhost/x"), { timeoutMs: 1000, maxBytes: 1000 })).rejects.toThrow();
  });
});
