// Fake Microsoft Graph shaped like the v1.0 mail API (from the public docs, not a live mailbox).
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseEmail } from "../../ai/extract/message";
import type { Fetch } from "../connector";
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
    const a = u.pathname.match(/\/me\/messages\/(.+)\/attachments$/);
    if (a) return ok({ value: attachments[decodeURIComponent(a[1]!)] ?? [] });
    if (u.pathname === "/v1.0/me/messages") return ok({ value: messages, ...(extra.nextLink ? { "@odata.nextLink": extra.nextLink } : {}) });
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
    expect(input).toMatchObject({ kind: "email", source: { evidenceId: "ev-email-AAA", receivedAt: "2026-10-24T15:00:00Z", sourceRef: { system: "email", record: "<AAA@mail.example>" } } });
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
    expect(atts[0]!.source!.evidenceId).toBe("ev-email-B1-f1");
    expect(r.data.inputs[0]!.raw).toContain("X-Attachments: ar.xlsx, inv.pdf");
    expect(r.data.diagnostics.warnings.join(" ")).toMatch(/1 message skipped because it was not about invoices or payments/);
    expect(r.data.diagnostics).toMatchObject({ rowsRead: 1, rowsImported: 1 });
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
    expect(r.data.diagnostics.errors[0]!.nextStep).toMatch(/upload/);
  });

  it("recognises known senders and money words", () => {
    const known = new Set(["evergreenhome.com"]);
    expect(isMoneyRelated("Hello", "see you", "a@evergreenhome.com", known, [])).toBe(true);
    expect(isMoneyRelated("PO-2291 confirmed", "", "x@y.com", known, [])).toBe(true);
    expect(isMoneyRelated("Lunch", "pizza", "x@y.com", known, [])).toBe(false);
  });
});
