// POST /demo/reset (reseed the synthetic samples) and POST /ask (Ask Neri, ai/ask/index.ts).

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Signal } from "../../schema/records";
import { handleAsk } from "../../ai/ask/index";
import type { Deps } from "../app";
import { loadSample, SAMPLES } from "../demo";
import { runInputs } from "../engine";
import { businessOf, HttpError } from "../http";

export const demoRoutes = (deps: Deps) => async (app: FastifyInstance) => {
  // Body (optional): { business: "cascade_trade" | "pike_noodle" }; default all samples.
  // Synthetic businesses only; never touches a private business with the same id.
  app.post("/demo/reset", async (req) => {
    if (!deps.allowReset) throw new HttpError(403, "FORBIDDEN", "Resetting samples is turned off on this server.");
    const asked = (req.body as { business?: unknown } | undefined)?.business;
    const ids = typeof asked === "string" ? [asked] : SAMPLES.map((s) => s.id);
    const done: string[] = [];
    for (const id of ids) {
      const sample = loadSample(id);
      if (!sample) throw new HttpError(404, "NOT_FOUND", "That sample doesn't exist.");
      const existing = await deps.store.getBusiness(id);
      if (existing && !existing.isSynthetic) throw new HttpError(409, "CONFLICT", "That id belongs to a real business; not resetting it.");
      await deps.store.resetBusiness(sample, sample.records);
      done.push(id);
    }
    return { reset: done };
  });

  // Body: { question, via?: "text" | "voice" }. Returns the CfoAnswer with `text`, `scenario: { label, run }`
  // and `proposal: { kind: "plan", amount, date, note }`. A plan or rule the owner states is stored as
  // proposed (owner Signal or Rule); nothing is applied until the owner confirms.
  app.post("/ask", async (req, reply) => {
    const b = businessOf(req);
    const [{ records }, proposals] = await Promise.all([deps.store.load(b.id), deps.store.listProposals(b.id)]);
    const { profile, asOf, fxRates } = runInputs(b, deps.now);
    const body = (req.body ?? {}) as { question?: unknown };
    const question = typeof body.question === "string" ? body.question : "";
    const r = await handleAsk(req.body, {
      records, profile, asOf, fxRates,
      pendingReviewCount: proposals.filter((p) => p.state === "proposed").length,
      business: { name: b.name },
      mode: deps.aiMode,
      persistProposal: async (p) => {
        const id = `ask-${randomUUID().slice(0, 8)}`;
        if (p.kind === "rule") {
          await deps.store.upsertRecords(b.id, { rules: [{ ...p.rule, id, state: "proposed" }] });
        } else {
          const sourceRef = { system: "owner", record: id, excerpt: { start: 0, end: question.length, text: question } };
          const signal: Signal = {
            id, channel: "owner", receivedAt: deps.now().toISOString(), ...(p.draft.partyId ? { partyId: p.draft.partyId } : {}),
            claim: { kind: "plan", draft: { ...p.draft, sourceRef: p.draft.sourceRef ?? sourceRef } }, confidence: 0.9, state: "proposed", sourceRef,
          };
          await deps.store.upsertRecords(b.id, { signals: [signal] });
        }
        return id;
      },
    });
    if (r.status !== 200) {
      const msg = (r.body as { error?: string }).error ?? "Ask a question about your cash.";
      throw new HttpError(r.status, "INVALID_ARGUMENT", msg, { fieldIssues: [{ field: "question", issue: "invalid" }] });
    }
    return reply.code(200).send(r.body);
  });
};
