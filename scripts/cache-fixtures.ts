// Source segments for the cascade_trade intake fixtures, built the way the intake pipeline builds them
// (PDF text per page, email body text). Shared by the cache scripts and the document tests so the
// cache keys line up exactly.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractPdfText } from "../ai/extract/pdf";
import { parseEmail, parseWhatsApp } from "../ai/extract/message";
import type { BusinessIdentity } from "../ai/extract/document";
import type { SourceSegment } from "../ai/normalize";

export const INTAKE_DIR = join(import.meta.dirname, "../fixtures/cascade_trade/intake");

export const CASCADE_BUSINESS: BusinessIdentity = { name: "Cascade Trade Co.", aliases: ["Cascade Trade"] };

// Every fixture the live refresh covers.
export const FIXTURE_NAMES = [
  "inv1187.pdf",
  "inv1187-cad.pdf",
  "inv1187-revised-total.pdf",
  "ningbo-bill-0042.pdf",
  "harbor-po-552.pdf",
  "email-inv1187.eml",
  "email-harbor-inv1203.eml",
  "email-injection.eml",
  "whatsapp-evergreen.txt",
] as const;

export const evidenceIdFor = (name: string) => `ev-${name.replace(/\.[^.]+$/, "")}`;

export async function loadFixtureSegments(name: string): Promise<SourceSegment[]> {
  const evidenceId = evidenceIdFor(name);
  const path = join(INTAKE_DIR, name);
  if (name.endsWith(".pdf")) {
    const pdf = await extractPdfText(new Uint8Array(readFileSync(path)), { evidenceId });
    if (pdf.status !== "ok") throw new Error(`${name}: ${pdf.status} ${pdf.reason ?? ""}`);
    return pdf.pages.map((p) => ({ evidenceId, page: p.page, text: p.text }));
  }
  const raw = readFileSync(path, "utf8");
  const bundle = name.endsWith(".eml") ? parseEmail(raw, { evidenceId }) : parseWhatsApp(raw, { evidenceId });
  return [{ evidenceId, text: bundle.text }];
}
