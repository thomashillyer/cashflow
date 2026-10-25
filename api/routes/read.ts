// GET /context, GET /brief, GET /forecast, POST /simulate, GET /records/:id.

import type { FastifyInstance } from "fastify";
import type { CashEvent, Commitment, Lever, Records } from "../../schema/records";
import { forecast } from "../../engine/forecast";
import { simulate } from "../../engine/simulate";
import { findCommitment, resolveEventSource, type EventSource } from "../../engine/resolve";
import type { Deps } from "../app";
import { briefFor, loadForRun, runInputs, savedScenario } from "../engine";
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

// What GET /records/:id returns as `commitment`: a stored commitment, or one built from a profile entry or a bank
// line (no `type` when nothing fits, e.g. an unmatched bank line).
type RecordCommitment = Omit<Commitment, "type"> & { type?: Commitment["type"] };

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
    const { records, overrides } = await loadForRun(deps.store, b.id);
    const { profile, asOf, fxRates } = runInputs(b, deps.now);
    // Stress runs on the same saved overrides as base; forecast() adds the stress delays.
    return forecast(records, profile, savedScenario(overrides, scenario as "base" | "stress"), asOf, fxRates);
  });

  // What-if: body { levers: Lever[] }. Returns the run with the levers and the low-point change.
  app.post("/simulate", async (req) => {
    const b = businessOf(req);
    const levers = (req.body as { levers?: unknown } | undefined)?.levers;
    if (!Array.isArray(levers) || levers.length > 20) throw new HttpError(400, "INVALID_ARGUMENT", "Send up to 20 levers to try.");
    const { records, overrides } = await loadForRun(deps.store, b.id);
    for (const l of levers as Lever[]) {
      if (!l || typeof l !== "object" || !records.commitments.some((c) => c.id === l.commitmentId)) {
        throw new HttpError(400, "INVALID_ARGUMENT", "One of those changes points at a record we don't have.");
      }
    }
    const { profile, asOf, fxRates } = runInputs(b, deps.now);
    const sim = simulate(records, profile, overrides, levers as Lever[], asOf, fxRates);
    return { run: sim.run, lowPointDelta: sim.lowPointDelta, freeCashDelta: sim.freeCashDelta };
  });

  // A record and everything behind it: the commitment, its party, its dated events, signals, rules, and the message.
  // `id` may be a commitment id, an event id (a bank line, or a forecast event such as "evt-inv-INV-1187-0",
  // "evt-rec-payroll-3", "evt-daily-sales-2027-01-15"), or the id a forecast event points at (a profile recurring
  // item, "daily-sales", a linked cost). engine/resolve.ts decides what each event traces to; profile items and
  // unmatched bank lines come back in the same commitment shape, built from the profile entry or the bank line.
  // `source` names what was found and `eventId` the event that was asked for (null when a commitment was).
  app.get("/records/:id", async (req) => {
    const b = businessOf(req);
    const { id } = req.params as { id: string };
    const { records, overrides } = await loadForRun(deps.store, b.id);
    const { profile, asOf, fxRates } = runInputs(b, deps.now);
    const run = forecast(records, profile, savedScenario(overrides), asOf, fxRates);
    const notFound = () => new HttpError(404, "NOT_FOUND", "That record isn't in your books any more.");

    const view = (c: RecordCommitment, events: CashEvent[], source: EventSource["kind"], eventId: string | null) => {
      const signals = records.signals.filter((s) => s.commitmentId === c.id);
      const msgSignal = signals.find((s) => s.sourceRef.excerpt?.text);
      const ev = msgSignal ? records.evidence.find((e) => e.id === msgSignal.sourceRef.record || e.sourceRef.record === msgSignal.sourceRef.record) : undefined;
      return {
        commitment: c,
        party: records.parties.find((p) => p.id === c.partyId) ?? null,
        events,
        signals,
        rules: c.partyId ? records.rules.filter((r) => "partyId" in r.scope && r.scope.partyId === c.partyId) : [],
        evidence: records.evidence.filter((e) => c.evidenceIds?.includes(e.id)),
        message: msgSignal
          ? { id: msgSignal.sourceRef.record, channel: msgSignal.channel, receivedAt: msgSignal.receivedAt, body: ev?.text ?? msgSignal.sourceRef.excerpt!.text!, excerpt: msgSignal.sourceRef.excerpt!.text! }
          : null,
        source,
        eventId,
      };
    };
    const eventsOf = (cid: string) => run.events.filter((e) => e.commitmentId === cid);

    const direct = findCommitment(id, records);
    if (direct) return view(direct, eventsOf(direct.id), "commitment", null);

    // An event id, or else the first forecast event that points at this id (profile recurring, daily sales, linked cost).
    const asked = run.events.find((e) => e.id === id) ?? records.events.find((e) => e.id === id && e.status === "actual");
    const event = asked ?? run.events.find((e) => e.commitmentId === id);
    if (!event) throw notFound();
    const eventId = asked ? asked.id : null;
    const src = resolveEventSource(event, records, profile, asOf);
    switch (src.kind) {
      case "commitment":
        return view(src.commitment, eventsOf(src.commitment.id), src.kind, eventId);
      case "actual": {
        if (src.commitment) return view(src.commitment, eventsOf(src.commitment.id), src.kind, eventId);
        // An unmatched bank line (card sales, fees) is its own source.
        const line = run.events.find((e) => e.id === src.event.id) ?? src.event;
        return view({
          id: line.id, direction: line.direction, ...(line.category ? { category: line.category } : {}),
          amount: line.amount, currency: line.currency, anchors: {}, status: "actual", sourceRef: line.sourceRef,
        }, [line], src.kind, eventId);
      }
      case "linked_cost": {
        const parent = src.parentCommitment;
        return view(parent, [...eventsOf(parent.id), ...eventsOf(event.commitmentId!)].sort((x, y) => x.date.localeCompare(y.date)), src.kind, eventId);
      }
      case "profile_recurring": {
        const item = src.item;
        return view({
          id: item.id, type: "recurring", direction: item.direction ?? "out", category: item.category,
          amount: event.amount, currency: event.currency, anchors: {}, status: event.status,
          sourceRef: { system: "profile", record: item.name },
        }, eventsOf(item.id), src.kind, eventId);
      }
      case "daily_sales": {
        // The forecast has one event per sale day; show the one asked for, or the next week of them.
        const days = asked ? [event] : eventsOf(event.commitmentId!).slice(0, 7);
        return {
          ...view({
            id: event.commitmentId!, direction: "in", category: "sales",
            amount: event.amount, currency: event.currency, anchors: {}, status: event.status,
            sourceRef: { system: "profile", record: "Daily sales" },
          }, days, src.kind, eventId),
          basedOn: src.historyEventIds, // the actual sales receipts the average came from
        };
      }
      default:
        throw notFound();
    }
  });
};
