// The one call the API makes to pull a connected source: Zoho Books, Zoho CRM, Outlook (and the built
// QuickBooks and Xero). Read-only. Returns either records for the store (accounting, CRM) or message inputs
// for ingest() (Outlook), plus the diagnostics the Sources screen shows. A failure is a ConnectorError with a
// plain next step and the file/paste fallback; nothing here throws for a provider problem and nothing writes
// to the store or to the source system.

import type { IntakeInput } from "../ai/intake";
import type { CrmMapping } from "../schema/profile";
import type { BalanceSnapshot, Evidence, Records } from "../schema/records";
import type { Fetch, PullResult, TokenProvider } from "./connector";
import type { ImportDiagnostics } from "./core/diagnostics";
import { pullOutlook } from "./outlook";
import { pullQuickBooks } from "./quickbooks";
import { pullXero } from "./xero";
import { pullZoho as pullBooks } from "./zoho_books";
import { pullZohoCrm } from "./zoho_crm";
import type { ZohoRegion } from "./zoho_books/client";

export const SOURCES = ["zoho_books", "zoho_crm", "outlook", "quickbooks", "xero"] as const;
export type SourceId = (typeof SOURCES)[number];
export const isSourceId = (v: string): v is SourceId => (SOURCES as readonly string[]).includes(v);

// What a connection gives us. The API lane supplies it per business; connectors never see the OAuth flow.
export type SourceAccess = {
  token: TokenProvider;
  region?: ZohoRegion;
  organizationId?: string;     // Zoho Books organization
  realmId?: string;            // QuickBooks company
  tenantId?: string;           // Xero organisation
  mailbox?: string;            // Outlook: read this user's mail with an app-only token
};

export type PullOptions = {
  now: string;
  existingEvidence?: Evidence[];
  crm?: CrmMapping;            // profile.crm
  sinceDays?: number;          // Outlook look-back, 1..90, default 30
  knownDomains?: string[];     // Outlook: sender domains of known customers and suppliers
  baseCurrency?: string;       // QuickBooks fallback when a document names none
  fetch?: Fetch;
};

export type AdapterRecords = Pick<Records, "parties" | "commitments" | "settlements" | "evidence">;

export type Pulled =
  | { kind: "records"; source: SourceId; records: AdapterRecords; balances?: BalanceSnapshot[]; diagnostics: ImportDiagnostics; unallocatedPayments?: unknown[] }
  | { kind: "messages"; source: "outlook"; inputs: Extract<IntakeInput, { kind: "email" }>[]; diagnostics: ImportDiagnostics };

const fail = (message: string, nextStep: string): PullResult<Pulled> => ({ ok: false, error: { kind: "config", message, nextStep, fallback: "file" } });

export async function pullSource(source: SourceId, access: SourceAccess, o: PullOptions): Promise<PullResult<Pulled>> {
  const common = { token: access.token, now: o.now, ...(o.fetch ? { fetch: o.fetch } : {}) };
  const existing = o.existingEvidence ? { existingEvidence: o.existingEvidence } : {};
  switch (source) {
    case "zoho_books": {
      if (!access.region) return fail("Zoho Books is not set up for this business yet.", "Connect Zoho Books, or upload an export from Zoho Books instead.");
      const r = await pullBooks({ ...common, ...existing, region: access.region, ...(access.organizationId ? { organizationId: access.organizationId } : {}) });
      if (!r.ok) return r;
      const { unallocatedPayments, diagnostics, balances, ...records } = r.data;
      return { ok: true, data: { kind: "records", source, records: { parties: records.parties, commitments: records.commitments, settlements: records.settlements, evidence: records.evidence }, balances, diagnostics, unallocatedPayments } };
    }
    case "zoho_crm": {
      if (!access.region) return fail("Zoho CRM is not set up for this business yet.", "Connect Zoho and allow CRM read access, or upload a CRM export instead.");
      const r = await pullZohoCrm({ ...common, ...existing, region: access.region, ...(o.crm ? { mapping: o.crm } : {}) });
      if (!r.ok) return r;
      return { ok: true, data: { kind: "records", source, records: { parties: r.data.parties, commitments: r.data.commitments, settlements: [], evidence: r.data.evidence }, diagnostics: r.data.diagnostics } };
    }
    case "quickbooks": {
      if (!access.realmId) return fail("QuickBooks is not set up for this business yet.", "Connect QuickBooks, or upload an export from QuickBooks instead.");
      const r = await pullQuickBooks({ ...common, ...existing, realmId: access.realmId, ...(o.baseCurrency ? { defaultCurrency: o.baseCurrency } : {}) });
      if (!r.ok) return r;
      const d = r.data;
      return { ok: true, data: { kind: "records", source, records: { parties: d.parties, commitments: d.commitments, settlements: d.settlements, evidence: d.evidence }, diagnostics: d.diagnostics, unallocatedPayments: d.unallocatedPayments } };
    }
    case "xero": {
      const r = await pullXero({ ...common, ...existing, ...(access.tenantId ? { tenantId: access.tenantId } : {}) });
      if (!r.ok) return r;
      const d = r.data;
      return { ok: true, data: { kind: "records", source, records: { parties: d.parties, commitments: d.commitments, settlements: d.settlements, evidence: d.evidence }, diagnostics: d.diagnostics, unallocatedPayments: d.unallocatedPayments } };
    }
    case "outlook": {
      const days = Math.min(90, Math.max(1, Math.trunc(o.sinceDays ?? 30)));
      const since = new Date(Date.parse(o.now) - days * 86_400_000).toISOString();
      const r = await pullOutlook({ ...common, ...existing, since, ...(access.mailbox ? { mailbox: access.mailbox } : {}), ...(o.knownDomains?.length ? { knownDomains: o.knownDomains } : {}) });
      if (!r.ok) return r;
      return { ok: true, data: { kind: "messages", source, inputs: r.data.inputs, diagnostics: r.data.diagnostics } };
    }
  }
}
