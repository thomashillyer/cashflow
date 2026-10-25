// Outlook connector: recent mail that looks money-related -> inputs for ingest(). Read-only.
//
// Nothing here interprets message text. A message becomes an IntakeInput { kind: "email" } carrying
// its text and its PDF/XLSX/CSV attachments, with stable evidence ids. Interpretation, party matching,
// and anything that could change cash happen in ai/ and need the owner's confirmation. Mail that does
// not look money-related is left out so the rest of the inbox never reaches extraction.

import type { Attachment, IntakeInput } from "../../ai/intake";
import type { SheetContent } from "../../ai/extract/sheet";
import { ConnectorFailure, type Fetch, type PullResult, type TokenProvider } from "../connector";
import { summarize, type ImportDiagnostics, type RowError } from "../core/diagnostics";
import { childEvidenceId, recordEvidenceId } from "../core/ids";
import { readCsv } from "../generic_file/csv";
import { readXlsx } from "../generic_file/xlsx";
import { MAX_ATTACHMENT_BYTES, OutlookClient, type GraphRecord } from "./client";

export type OutlookPullInput = {
  token: TokenProvider;
  now: string;
  since: string;                      // ISO instant; how far back to read
  knownDomains?: string[];            // sender domains of known customers and suppliers
  mailbox?: string;                   // read this user's mail (app-only token); default: the signed-in user
  fetch?: Fetch;
};

export type OutlookPull = {
  inputs: Extract<IntakeInput, { kind: "email" }>[];
  diagnostics: ImportDiagnostics;
};

const MONEY_WORDS = /\b(invoice|inv[-# ]?\d+|payment|paid|pay(ing)?|remit(tance)?|receipt|po[-# ]?\d+|purchase order|overdue|balance due|amount due|bill)\b/i;
const SUPPORTED = /\.(pdf|xlsx|csv)$/i;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
// One line, no control characters: header values come from the sender and must not add headers.
const oneLine = (s: string) => s.replace(/[\r\n\u0000-\u001f]+/g, " ").trim();

function sender(m: GraphRecord): { name?: string; address?: string } {
  const e = (m.from as { emailAddress?: { name?: string; address?: string } } | undefined)?.emailAddress;
  return { ...(str(e?.name) ? { name: oneLine(e!.name!) } : {}), ...(str(e?.address) ? { address: oneLine(e!.address!) } : {}) };
}

export const isMoneyRelated = (subject: string, body: string, address: string | undefined, known: Set<string>, attachmentNames: string[]): boolean =>
  attachmentNames.some((n) => SUPPORTED.test(n)) ||
  MONEY_WORDS.test(`${subject}\n${body}`) ||
  (address !== undefined && known.has(address.split("@")[1]?.toLowerCase() ?? ""));

export async function pullOutlook(input: OutlookPullInput): Promise<PullResult<OutlookPull>> {
  try {
    return { ok: true, data: await pull(input) };
  } catch (err) {
    if (err instanceof ConnectorFailure) return { ok: false, error: err.error };
    return { ok: false, error: { kind: "unsupported", message: "Something in the Outlook data could not be read.", nextStep: "Paste the message instead.", fallback: "paste" } };
  }
}

async function pull(input: OutlookPullInput): Promise<OutlookPull> {
  const client = new OutlookClient(input.token, input.fetch, input.mailbox);
  const known = new Set((input.knownDomains ?? []).map((d) => d.toLowerCase()));
  const { records, truncated } = await client.messages(input.since);
  const errors: RowError[] = [];
  const warnings: string[] = [];
  const inputs: OutlookPull["inputs"] = [];
  let skipped = 0;
  if (truncated) warnings.push(`Only the newest ${records.length} messages were read; narrow the date range to see older ones.`);

  for (const [i, m] of records.entries()) {
    const id = str(m.id);
    if (!id) continue;
    const row = i + 1;
    const subject = oneLine(str(m.subject) ?? "(no subject)");
    const body = str((m.body as { content?: string } | undefined)?.content) ?? "";
    const from = sender(m);
    let files: GraphRecord[] = [];
    if (m.hasAttachments) {
      try { files = await client.attachments(id); } catch (err) {
        if (err instanceof ConnectorFailure && (err.error.kind === "auth" || err.error.kind === "rate_limit")) throw err;
        errors.push({ row, code: "unsupported", message: `The attachments on "${subject}" could not be listed.`, nextStep: "Download them from Outlook and upload them on the import screen." });
      }
    }
    const names = files.map((f) => str(f.name) ?? "");
    if (!isMoneyRelated(subject, body, from.address, known, names)) { skipped++; continue; }

    // internetMessageId survives moving the message between folders; the Graph id may not.
    const messageKey = str(m.internetMessageId) ?? id;
    const messageEvidence = recordEvidenceId("email", messageKey);
    const receivedAt = str(m.receivedDateTime) ?? input.now;
    const attachments: Attachment[] = [];
    for (const f of files) {
      const name = oneLine(str(f.name) ?? "attachment");
      const kind = f["@odata.type"];
      if (kind !== "#microsoft.graph.fileAttachment" || !SUPPORTED.test(name)) continue;
      const size = typeof f.size === "number" ? f.size : 0;
      let b64: string | undefined;
      if (size <= MAX_ATTACHMENT_BYTES && !f.isInline) {
        const fid = str(f.id);
        try { b64 = fid ? str((await client.attachment(id, fid)).contentBytes) : undefined; } catch (err) {
          if (err instanceof ConnectorFailure && (err.error.kind === "auth" || err.error.kind === "rate_limit")) throw err;
        }
      }
      if (f.isInline && !b64) continue;
      if (size > MAX_ATTACHMENT_BYTES) {
        const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;
        errors.push({ row, code: "unsupported", message: `"${name}" on "${subject}" is ${mb(size)}; Neri reads attachments up to ${mb(MAX_ATTACHMENT_BYTES)}.`, nextStep: "Upload only the pages or sheets you need on the import screen, or a smaller export." });
        continue;
      }
      if (!b64) {
        errors.push({ row, code: "unsupported", message: `"${name}" on "${subject}" could not be downloaded from Outlook.`, nextStep: "Download it from Outlook and upload it on the import screen." });
        continue;
      }
      const bytes = new Uint8Array(Buffer.from(b64, "base64"));
      const evidenceId = childEvidenceId(messageEvidence, str(f.id) ?? name);
      let sheets: SheetContent[] | undefined;
      try {
        if (/\.xlsx$/i.test(name)) sheets = await readXlsx(bytes, evidenceId);
        else if (/\.csv$/i.test(name)) sheets = [readCsv(bytes, evidenceId, name)];
      } catch {
        errors.push({ row, code: "unsupported", message: `"${name}" on "${subject}" could not be opened.`, nextStep: "Open it in Excel, save it again, and upload it on the import screen." });
      }
      attachments.push({
        fileName: name, bytes, ...(sheets ? { sheets } : {}),
        source: { evidenceId, receivedAt, sourceRef: { system: "email", record: `${str(m.internetMessageId) ?? id}#${name}` } },
      });
    }

    const to = ((m.toRecipients as { emailAddress?: { address?: string } }[] | undefined) ?? []).map((r) => oneLine(r.emailAddress?.address ?? "")).filter(Boolean).join(", ");
    const raw = [
      `From: ${from.name ? `${from.name} <${from.address ?? ""}>` : from.address ?? ""}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${new Date(receivedAt).toUTCString()}`,
      `Message-ID: ${oneLine(str(m.internetMessageId) ?? id)}`,
      ...(attachments.length ? [`X-Attachments: ${attachments.map((a) => a.fileName.replace(/,/g, " ")).join(", ")}`] : []),
      "",
      body.replace(/\r\n/g, "\n"),
    ].join("\n");

    inputs.push({
      kind: "email", raw, attachments,
      source: { evidenceId: messageEvidence, receivedAt, sourceRef: { system: "email", record: str(m.internetMessageId) ?? id } },
    });
  }
  if (skipped) warnings.push(`${skipped} message${skipped === 1 ? "" : "s"} skipped because ${skipped === 1 ? "it was" : "they were"} not about invoices or payments.`);
  return {
    inputs,
    diagnostics: summarize({
      evidenceId: "outlook", source: "email", startedAt: input.now, rowsRead: records.length - skipped,
      rowsImported: inputs.length, rowsDuplicate: 0, errors, warnings, syncedAt: input.now,
      ...(str(records[0]?.receivedDateTime) ? { newestRecordAt: str(records[0]?.receivedDateTime)! } : {}),
    }),
  };
}
