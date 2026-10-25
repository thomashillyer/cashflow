// POST /sources/:source/pull: read a connected source (Zoho Books, Zoho CRM, Outlook) and bring it in.
// Records (books, CRM) are persisted idempotently through persistImport; messages (Outlook) go through the same
// intake as an upload, so they become Review items and change nothing until the owner confirms. Read-only
// against the source; signed-in members of their own business only (samples and anonymous callers are refused).

import type { FastifyInstance } from "fastify";
import { ingest } from "../../ai/intake";
import type { ConnectorError } from "../../adapters/connector";
import { isSourceId, pullSource, type SourceId } from "../../adapters/pull";
import type { Deps } from "../app";
import { businessIdentity } from "../engine";
import { businessOf, HttpError, userOf } from "../http";
import { persistImport } from "../persist";

const LABEL: Record<SourceId, string> = { zoho_books: "Zoho Books", zoho_crm: "Zoho CRM", outlook: "Outlook", quickbooks: "QuickBooks", xero: "Xero" };
// The app calls Microsoft 365 "m365"; the adapter reads Outlook.
const ALIAS: Record<string, SourceId> = { m365: "outlook" };
const MAX_MESSAGES = 15;     // each message can cost model calls: the rest wait for the next pull

const STATUS: Record<ConnectorError["kind"], { status: number; code: string; retryable: boolean }> = {
  auth: { status: 424, code: "CONNECTION_NEEDS_ATTENTION", retryable: false },
  rate_limit: { status: 429, code: "SOURCE_RATE_LIMITED", retryable: true },
  network: { status: 502, code: "SOURCE_UNAVAILABLE", retryable: true },
  config: { status: 422, code: "SOURCE_NOT_SET_UP", retryable: false },
  unsupported: { status: 502, code: "SOURCE_UNREADABLE", retryable: false },
};
const httpFor = (e: ConnectorError) => new HttpError(STATUS[e.kind].status, STATUS[e.kind].code, `${e.message} ${e.nextStep}`, { retryable: STATUS[e.kind].retryable });

export const sourceRoutes = (deps: Deps) => async (app: FastifyInstance) => {
  const running = new Set<string>();

  // What the Sources screen shows for this connection: connected with a time, or the plain reason it is not.
  async function mark(businessId: string, id: string, state: "ok" | "error", message: string | undefined, now: string) {
    const fresh = await deps.store.getBusiness(businessId);
    if (!fresh) return;
    const acc = fresh.profile.account ?? {};
    const prev = (acc.connections ?? []).find((c) => c.id === id);
    // A repeat pull that changes nothing writes nothing (so the store revision, and pending Review items, stay put).
    if (prev && prev.state === state && (prev.message ?? undefined) === message) return;
    const rest = (acc.connections ?? []).filter((c) => c.id !== id);
    const entry = { id, name: LABEL[ALIAS[id] ?? (isSourceId(id) ? id : "zoho_books")] ?? id, state, ...(message ? { message } : {}), ...(state === "ok" ? { syncedAt: now } : {}) };
    await deps.store.saveProfile(businessId, { ...fresh.profile, account: { ...acc, connections: [...rest, entry], ...(state === "ok" ? { syncedAt: now } : {}) } });
  }

  app.post("/sources/:source/pull", async (req) => {
    const b = businessOf(req);
    const { source: asked } = req.params as { source: string };
    const source = ALIAS[asked] ?? asked;
    if (!isSourceId(source)) throw new HttpError(404, "NOT_FOUND", "That source isn't available. Upload a file or paste the text instead.");
    if (b.isSynthetic) throw new HttpError(403, "SAMPLE_BUSINESS", "The samples already have their data. Sign in and set up your own business to connect a source.");
    const access = await deps.sourceAccess?.({ business: b, ...(userOf(req) ? { user: userOf(req)! } : {}) }, source);
    if (!access) throw new HttpError(422, "SOURCE_NOT_SET_UP", `${LABEL[source]} isn't connected for this business yet. Connect it in Sources, or upload an export or paste the text instead.`);

    const lock = `${b.id}:${source}`;
    if (running.has(lock)) throw new HttpError(409, "PULL_RUNNING", `${LABEL[source]} is already being read. Wait a moment and check Sources.`, { retryable: true });
    running.add(lock);
    try {
      const body = (req.body ?? {}) as { sinceDays?: unknown };
      const now = deps.now().toISOString();
      const { records, storeRevision } = await deps.store.load(b.id);
      const pulled = await pullSource(source, access, {
        now, existingEvidence: records.evidence,
        ...(b.profile.crm ? { crm: b.profile.crm } : {}),
        ...(typeof body.sinceDays === "number" ? { sinceDays: body.sinceDays } : {}),
        baseCurrency: b.profile.baseCurrency,
        ...(deps.sourceFetch ? { fetch: deps.sourceFetch } : {}),
        knownDomains: [...new Set(records.parties.flatMap((p) => p.contacts?.emailDomains ?? []))],
      });
      if (!pulled.ok) {
        await mark(b.id, asked, "error", `${pulled.error.message} ${pulled.error.nextStep}`, now).catch(() => undefined);
        throw httpFor(pulled.error);
      }
      const p = pulled.data;

      if (p.kind === "records") {
        const summary = await persistImport(deps.store, b.id, p.records);
        // Opening cash: the books' bank balances, written like any record (latest per account wins in the engine).
        // Written only when it changed, so a repeat pull leaves the store revision (and pending Review items) alone.
        const stored = new Map(records.balances.map((x) => [x.id, x]));
        const changed = (p.balances ?? []).filter((x) => { const o = stored.get(x.id); return !o || o.amount !== x.amount || o.asOf !== x.asOf || o.currency !== x.currency; });
        if (changed.length) await deps.store.upsertRecords(b.id, { balances: changed });
        await mark(b.id, asked, "ok", undefined, now).catch(() => undefined);
        return { source, kind: "records", summary: { ...summary, balances: p.balances?.length ?? 0 }, diagnostics: p.diagnostics, ...(p.unallocatedPayments ? { unallocatedPayments: p.unallocatedPayments.length } : {}) };
      }

      // Messages: the same intake as an upload. Nothing is applied here.
      const known = new Map((await deps.store.listProposals(b.id)).map((x) => [x.id, x]));
      const seenSignals = new Set(records.signals.map((s) => s.id));
      const todo = p.inputs.slice(0, MAX_MESSAGES);
      let candidates = 0, proposals = 0, signals = 0;
      for (const input of todo) {
        const r = await ingest(input, {
          records, storeRevision, business: businessIdentity(b), mode: deps.aiMode, now,
          ...(b.profile.account?.timezone ? { timeZone: b.profile.account.timezone } : {}),
        });
        const fresh = r.proposals.filter((x) => known.get(x.id)?.state !== "confirmed" && known.get(x.id)?.state !== "dismissed");
        const newSignals = r.signals.filter((s) => !seenSignals.has(s.id));
        // Evidence last: it carries the hash that makes a later pull a repeat, so a failure leaves it retryable.
        await deps.store.saveIntake(b.id, { evidence: [], candidates: r.candidates, proposals: fresh, signals: newSignals });
        await deps.store.saveIntake(b.id, { evidence: r.evidence, candidates: [], proposals: [], signals: [] });
        candidates += r.candidates.length; proposals += fresh.length; signals += newSignals.length;
        newSignals.forEach((s) => seenSignals.add(s.id));
      }
      const waiting = p.inputs.length - todo.length;
      await mark(b.id, asked, "ok", undefined, now).catch(() => undefined);
      return {
        source, kind: "messages", diagnostics: p.diagnostics,
        summary: { messages: todo.length, waiting, alreadyRead: p.diagnostics.rowsDuplicate, candidates, proposals, signals },
      };
    } finally {
      running.delete(lock);
    }
  });
};
