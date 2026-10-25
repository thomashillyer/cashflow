// GET /context, GET /brief, GET /forecast, POST /simulate, GET /records/:id.

import type { FastifyInstance } from "fastify";
import type { Lever, Records } from "../../schema/records";
import { forecast } from "../../engine/forecast";
import { simulate } from "../../engine/simulate";
import type { Deps } from "../app";
import { briefFor, runInputs } from "../engine";
import { businessOf, HttpError } from "../http";
import type { Business } from "../store";

const SOURCE_LABELS: Record<string, string> = {
  zoho_books: "Zoho Books", bank_csv: "Bank", email: "Email", whatsapp: "WhatsApp", crm: "CRM", owner: "Your notes",
  upload: "Uploads", generic_file: "Files", quickbooks: "QuickBooks", xero: "Xero", pos: "Point of sale",
};

// Sources the business has data from, with freshness; connectors chosen at setup that have no data yet wait.
function sources(b: Business, records: Records) {
  const acc = b.profile.account ?? {};
  const counts = new Map<string, number>();
  for (const r of [...records.commitments, ...records.balances, ...records.settlements]) {
    counts.set(r.sourceRef.system, (counts.get(r.sourceRef.system) ?? 0) + 1);
  }
  const out = [...counts].map(([id, n]) => ({
    id, label: SOURCE_LABELS[id] ?? id, state: "ok", syncedAt: acc.syncedAt ?? acc.createdAt ?? null, detail: `${n} record${n === 1 ? "" : "s"}`,
  }));
  for (const c of acc.connections ?? []) {
    if (!counts.has(c.id)) out.push({ id: c.id, label: c.name, state: c.state === "ok" ? "waiting" : c.state, syncedAt: null, detail: "Waiting for the first file or sync" });
  }
  return out;
}

const SCENARIOS = new Set(["base", "stress"]);

export const readRoutes = (deps: Deps) => async (app: FastifyInstance) => {
  app.get("/context", async (req) => {
    const b = businessOf(req);
    const { records, storeRevision } = await deps.store.load(b.id);
    const { profile, asOf } = runInputs(b, deps.now);
    const acc = b.profile.account ?? {};
    const partyByCommitment = Object.fromEntries(records.commitments.filter((c) => c.partyId).map((c) => [c.id, c.partyId!]));
    return {
      business: {
        id: b.id, name: b.name, owner: acc.owner ?? "", asOf, synthetic: b.isSynthetic,
        timezone: acc.timezone ?? "UTC", sources: sources(b, records),
      },
      profile,
      parties: records.parties,
      rules: records.rules,
      safetyLine: profile.safetyLine.kind === "fixed" ? profile.safetyLine.amount : undefined,
      partyByCommitment,
      storeRevision,
    };
  });

  // { three, rest, watch, combined, shortfall, run } from one engine run, plus storeRevision and inputsHash.
  app.get("/brief", async (req) => briefFor(deps.store, businessOf(req), deps.aiMode, deps.now));

  app.get("/forecast", async (req) => {
    const b = businessOf(req);
    const scenario = String((req.query as Record<string, unknown>).scenario ?? "base");
    if (!SCENARIOS.has(scenario)) throw new HttpError(400, "INVALID_ARGUMENT", "Pick the base or stress view.", { fieldIssues: [{ field: "scenario", issue: "base or stress" }] });
    const { records } = await deps.store.load(b.id);
    const { profile, asOf, fxRates } = runInputs(b, deps.now);
    return forecast(records, profile, { id: scenario, kind: scenario as "base" | "stress", overrides: [] }, asOf, fxRates);
  });

  // What-if: body { levers: Lever[] }. Returns the run with the levers and the low-point change.
  app.post("/simulate", async (req) => {
    const b = businessOf(req);
    const levers = (req.body as { levers?: unknown } | undefined)?.levers;
    if (!Array.isArray(levers) || levers.length > 20) throw new HttpError(400, "INVALID_ARGUMENT", "Send up to 20 levers to try.");
    const { records } = await deps.store.load(b.id);
    for (const l of levers as Lever[]) {
      if (!l || typeof l !== "object" || !records.commitments.some((c) => c.id === l.commitmentId)) {
        throw new HttpError(400, "INVALID_ARGUMENT", "One of those changes points at a record we don't have.");
      }
    }
    const { profile, asOf, fxRates } = runInputs(b, deps.now);
    const sim = simulate(records, profile, [], levers as Lever[], asOf, fxRates);
    return { run: sim.run, lowPointDelta: sim.lowPointDelta, freeCashDelta: sim.freeCashDelta };
  });

  // A record and everything behind it: the commitment, its party, its dated events, signals, rules, and the message.
  app.get("/records/:id", async (req) => {
    const b = businessOf(req);
    const { id } = req.params as { id: string };
    const { records } = await deps.store.load(b.id);
    const c = records.commitments.find((x) => x.id === id);
    if (!c) throw new HttpError(404, "NOT_FOUND", "That record isn't in your books any more.");
    const { profile, asOf, fxRates } = runInputs(b, deps.now);
    const run = forecast(records, profile, { id: "base", kind: "base", overrides: [] }, asOf, fxRates);
    const signals = records.signals.filter((s) => s.commitmentId === id);
    const msgSignal = signals.find((s) => s.sourceRef.excerpt?.text);
    const ev = msgSignal ? records.evidence.find((e) => e.id === msgSignal.sourceRef.record || e.sourceRef.record === msgSignal.sourceRef.record) : undefined;
    return {
      commitment: c,
      party: records.parties.find((p) => p.id === c.partyId) ?? null,
      events: run.events.filter((e) => e.commitmentId === id),
      signals,
      rules: records.rules.filter((r) => "partyId" in r.scope && r.scope.partyId === c.partyId),
      evidence: records.evidence.filter((e) => c.evidenceIds?.includes(e.id)),
      message: msgSignal
        ? { id: msgSignal.sourceRef.record, channel: msgSignal.channel, receivedAt: msgSignal.receivedAt, body: ev?.text ?? msgSignal.sourceRef.excerpt!.text!, excerpt: msgSignal.sourceRef.excerpt!.text! }
        : null,
    };
  });
};
