// Fake Microsoft Graph shaped like the v1.0 mail API (from the public docs, not a live mailbox).
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseEmail } from "../../ai/extract/message";
import type { Fetch } from "../connector";
import { childEvidenceId, recordEvidenceId } from "../core/ids";
import { pullOutlook, isMoneyRelated } from "./index";

const NOW = "2026-10-25T18:00:00Z";
const token = async () => "tok";
const ok = (body: unknown) => ({ status: 200, json: async () => body });

async function xlsxB64(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("AR");
  ws.addRow(["Invoice #", "Customer", "Amount"]);
  ws.addRow(["INV-7", "Acme", 100]);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
}

const msg = (id: string, over: Record<string, unknown> = {}) => ({
  id, internetMessageId: `<${id}@mail.example>`, subject: "Invoice INV-1187", receivedDateTime: "2026-10-24T15:00:00Z",
  from: { emailAddress: { name: "Maria Santos", address: "maria@evergreenhome.com" } }, toRecipients: [{ emailAddress: { address: "me@cascade.com" } }],
  body: { contentType: "text", content: "Hi, attached is the invoice. We will pay on Nov 20." }, hasAttachments: false, ...over,
});

function graph(messages: unknown[], attachments: Record<string, unknown[]> = {}, extra: { nextLink?: string; status?: number } = {}): { fetch: Fetch; urls: string[]; methods: string[]; headers: Record<string, string>[] } {
  const urls: string[] = [], methods: string[] = [], headers: Record<string, string>[] = [];
  const f: Fetch = async (url, init) => {
    urls.push(url); methods.push(init.method); headers.push(init.headers);
    if (extra.status) return { status: extra.status, json: async () => ({}) };
    const u = new URL(url);
    const one = u.pathname.match(/\/(?:me|users\/[^/]+)\/messages\/(.+)\/attachments\/(.+)$/);
    if (one) {
      const hit = (attachments[decodeURIComponent(one[1]!)] ?? []).find((x) => (x as { id?: string }).id === decodeURIComponent(one[2]!));
      return hit ? ok(hit) : { status: 404, json: async () => ({}) };
    }
    const a = u.pathname.match(/\/(?:me|users\/[^/]+)\/messages\/(.+)\/attachments$/);
    if (a) return ok({ value: (attachments[decodeURIComponent(a[1]!)] ?? []).map((x) => { const { contentBytes: _c, ...meta } = x as Record<string, unknown>; return meta; }) });
    if (/^\/v1\.0\/(me|users\/[^/]+)\/messages$/.test(u.pathname)) return ok({ value: messages, ...(extra.nextLink ? { "@odata.nextLink": extra.nextLink } : {}) });
    return { status: 404, json: async () => ({}) };
  };
  return { fetch: f, urls, methods, headers };
}

describe("pullOutlook", () => {
  it("turns money-related mail into email inputs with stable evidence ids and sources", async () => {
    const g = graph([msg("AAA")]);
    const r = await pullOutlook({ token, now: NOW, since: "2026-10-01T00:00:00Z", fetch: g.fetch });
    if (!r.ok) throw new Error("expected ok");
    const [input] = r.data.inputs;
    expect(input).toMatchObject({ kind: "email", source: { evidenceId: recordEvidenceId("email", "<AAA@mail.example>"), receivedAt: "2026-10-24T15:00:00Z", sourceRef: { system: "email", record: "<AAA@mail.example>" } } });
    const bundle = parseEmail(input!.raw, { evidenceId: "ev-email-AAA", receivedAt: "2026-10-24T15:00:00Z" });
    expect(bundle.text).toContain("We will pay on Nov 20.");
    expect(bundle.headers?.subject).toBe("Invoice INV-1187");
    expect(r.data.diagnostics).toMatchObject({ rowsRead: 1, rowsImported: 1, completeness: 1 });
  });

  it("passes supported attachments with sheets read, skips everything else, and leaves unrelated mail out", async () => {
    const files = [
      { "@odata.type": "#microsoft.graph.fileAttachment", id: "f1", name: "ar.xlsx", size: 100, contentBytes: await xlsxB64() },
      { "@odata.type": "#microsoft.graph.fileAttachment", id: "f2", name: "inv.pdf", size: 3, contentBytes: Buffer.from("%PDF").toString("base64") },
      { "@odata.type": "#microsoft.graph.fileAttachment", id: "f3", name: "photo.png", size: 3, contentBytes: "AAAA" },
      { "@odata.type": "#microsoft.graph.itemAttachment", id: "f4", name: "forwarded.pdf" },
    ];
    const g = graph([msg("B1", { hasAttachments: true }), msg("B2", { subject: "Lunch?", body: { content: "Pizza Friday" }, from: { emailAddress: { address: "friend@gmail.com" } } })], { B1: files });
    const r = await pullOutlook({ token, now: NOW, since: "2026-10-01T00:00:00Z", fetch: g.fetch });
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.inputs).toHaveLength(1);
    const atts = r.data.inputs[0]!.attachments!;
    expect(atts.map((a) => a.fileName)).toEqual(["ar.xlsx", "inv.pdf"]);
    expect(atts[0]!.sheets![0]!.rows[1]).toEqual(["INV-7", "Acme", 100]);
    expect(atts[0]!.source!.evidenceId).toBe(childEvidenceId(recordEvidenceId("email", "<B1@mail.example>"), "f1"));
    expect(r.data.inputs[0]!.raw).toContain("X-Attachments: ar.xlsx, inv.pdf");
    expect(r.data.diagnostics.warnings.join(" ")).toMatch(/1 message skipped because it was not about invoices or payments/);
    expect(r.data.diagnostics).toMatchObject({ rowsRead: 1, rowsImported: 1 });
  });

  it("gives the same evidence ids when a message moves folders and its Graph id changes", async () => {
    const files = [{ "@odata.type": "#microsoft.graph.fileAttachment", id: "f1", name: "inv.pdf", size: 3, contentBytes: Buffer.from("%PDF").toString("base64") }];
    const before = await pullOutlook({ token, now: NOW, since: "2026-10-01T00:00:00Z", fetch: graph([msg("OLD", { internetMessageId: "<same@mail.example>", hasAttachments: true })], { OLD: files }).fetch });
    const after = await pullOutlook({ token, now: NOW, since: "2026-10-01T00:00:00Z", fetch: graph([msg("NEW", { internetMessageId: "<same@mail.example>", hasAttachments: true })], { NEW: files }).fetch });
    if (!before.ok || !after.ok) throw new Error("expected ok");
    expect(after.data.inputs[0]!.source!.evidenceId).toBe(before.data.inputs[0]!.source!.evidenceId);
    expect(after.data.inputs[0]!.attachments![0]!.source!.evidenceId).toBe(before.data.inputs[0]!.attachments![0]!.source!.evidenceId);
  });

  it("downloads attachment content only for files it keeps, and never inline images", async () => {
    const files = [
      { "@odata.type": "#microsoft.graph.fileAttachment", id: "f1", name: "inv.pdf", size: 3, contentBytes: Buffer.from("%PDF").toString("base64") },
      { "@odata.type": "#microsoft.graph.fileAttachment", id: "f2", name: "logo.png", size: 3, isInline: true, contentBytes: "AAAA" },
    ];
    const g = graph([msg("G1", { hasAttachments: true })], { G1: files });
    const r = await pullOutlook({ token, now: NOW, since: "2026-10-01T00:00:00Z", fetch: g.fetch });
    if (!r.ok) throw new Error("expected ok");
    expect(g.urls.filter((u) => /\/attachments\/[^?]/.test(u)).map((u) => u.split("/attachments/")[1])).toEqual(["f1"]);
    expect(r.data.inputs[0]!.attachments!.map((a) => a.fileName)).toEqual(["inv.pdf"]);
  });

  it("one message whose attachments cannot be listed becomes a row error, not a failed pull", async () => {
    const f: Fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/attachments")) return { status: 404, json: async () => ({}) };
      return ok({ value: [msg("H1", { hasAttachments: true }), msg("H2")] });
    };
    const r = await pullOutlook({ token, now: NOW, since: "2026-10-01T00:00:00Z", fetch: f });
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.inputs).toHaveLength(2);
    expect(r.data.inputs[0]!.attachments).toEqual([]);
    expect(r.data.diagnostics.errors[0]).toMatchObject({ code: "unsupported" });
    expect(r.data.diagnostics.errors[0]!.nextStep).toMatch(/upload/);
  });

  it("says a download failure is a download failure, not a size problem", async () => {
    const files = [{ "@odata.type": "#microsoft.graph.fileAttachment", id: "gone", name: "inv.pdf", size: 3 }];
    const g = graph([msg("N1", { hasAttachments: true })], { N1: [] });
    const f: Fetch = async (url, init) => {
      if (/\/attachments\?/.test(url)) return ok({ value: files });
      return g.fetch(url, init);
    };
    const r = await pullOutlook({ token, now: NOW, since: "2026-10-01T00:00:00Z", fetch: f });
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.diagnostics.errors[0]!.message).toMatch(/could not be downloaded from Outlook/);
  });

  it("reads a named mailbox with /users/{upn}, and rejects an address that could change the path", async () => {
    const g = graph([msg("M1")]);
    const r = await pullOutlook({ token, now: NOW, since: "2026-10-01T00:00:00Z", mailbox: "owner@cascade.com", fetch: g.fetch });
    expect(r.ok).toBe(true);
    expect(new URL(g.urls[0]!).pathname).toBe("/v1.0/users/owner%40cascade.com/messages");
    for (const bad of ["../me", "a/b@c.com", "owner", "x@y.com/../z"]) {
      const g2 = graph([]);
      const res = await pullOutlook({ token, now: NOW, since: "2026-10-01T00:00:00Z", mailbox: bad, fetch: g2.fetch });
      expect(res, bad).toMatchObject({ ok: false, error: { kind: "config", fallback: "paste" } });
      expect(g2.urls).toEqual([]);
    }
  });

  it("keeps sender-controlled text out of the headers it builds", async () => {
    const evil = msg("C1", { subject: "Invoice 1\r\nX-Attachments: evil.pdf\r\nBcc: x@y.z", from: { emailAddress: { name: "A\nSubject: hijack", address: "a@b.com" } } });
    const r = await pullOutlook({ token, now: NOW, since: "2026-10-01T00:00:00Z", fetch: graph([evil]).fetch });
    if (!r.ok) throw new Error("expected ok");
    const head = r.data.inputs[0]!.raw.split("\n\n")[0]!;
    expect(head.split("\n").filter((l) => /^X-Attachments:/i.test(l))).toEqual([]);
    expect(head.split("\n").filter((l) => /^Subject:/i.test(l))).toHaveLength(1);
    expect(head).not.toMatch(/^Bcc:/im);
  });

  it("only sends GET to Graph with a read-only request, and refuses a paging link to another host", async () => {
    const g = graph([msg("D1")], {}, { nextLink: "https://evil.example.com/steal" });
    const r = await pullOutlook({ token, now: NOW, since: "2026-10-01T00:00:00Z", fetch: g.fetch });
    expect(r).toMatchObject({ ok: false, error: { kind: "unsupported", fallback: "paste" } });
    expect(g.urls.every((u) => new URL(u).origin === "https://graph.microsoft.com")).toBe(true);
    expect(new Set(g.methods)).toEqual(new Set(["GET"]));
    expect(g.headers[0]!.Authorization).toBe("Bearer tok");
  });

  it("follows Graph paging, bounded at four pages", async () => {
    const link = "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=1";
    const g = graph([msg("E1")], {}, { nextLink: link });
    const r = await pullOutlook({ token, now: NOW, since: "2026-10-01T00:00:00Z", fetch: g.fetch });
    if (!r.ok) throw new Error("expected ok");
    expect(g.urls).toHaveLength(4);
    expect(r.data.diagnostics.warnings.join(" ")).toMatch(/Only the newest 4 messages were read/);
  });

  it.each([[401, "auth", /Reconnect Outlook/], [403, "auth", /allow read access/], [429, "rate_limit", /few minutes/], [503, "network", /paste the message/]])(
    "status %s gives a plain next step and the paste fallback", async (status, kind, next) => {
      const r = await pullOutlook({ token, now: NOW, since: "2026-10-01T00:00:00Z", fetch: graph([], {}, { status }).fetch });
      expect(r).toMatchObject({ ok: false, error: { kind, fallback: "paste" } });
      if (!r.ok) expect(r.error.nextStep).toMatch(next);
    });

  it("reports an oversized or undownloadable attachment instead of dropping it silently", async () => {
    const files = [{ "@odata.type": "#microsoft.graph.fileAttachment", id: "f1", name: "huge.pdf", size: 50_000_000 }];
    const r = await pullOutlook({ token, now: NOW, since: "2026-10-01T00:00:00Z", fetch: graph([msg("F1", { hasAttachments: true })], { F1: files }).fetch });
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.diagnostics.errors[0]).toMatchObject({ code: "unsupported" });
    expect(r.data.diagnostics.errors[0]!.message).toMatch(/is 50\.0 MB; Neri reads attachments up to 10\.0 MB/);
    expect(r.data.diagnostics.errors[0]!.nextStep).toMatch(/Upload only the pages/);
  });

  it("recognises known senders and money words", () => {
    const known = new Set(["evergreenhome.com"]);
    expect(isMoneyRelated("Hello", "see you", "a@evergreenhome.com", known, [])).toBe(true);
    expect(isMoneyRelated("PO-2291 confirmed", "", "x@y.com", known, [])).toBe(true);
    expect(isMoneyRelated("Lunch", "pizza", "x@y.com", known, [])).toBe(false);
  });
});
