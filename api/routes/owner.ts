// What the owner tells Neri: POST /setup, PATCH|PUT /profile, owner notes (GET/POST /notes,
// PATCH /notes/:id, POST /notes/:id/add|keep|remove) and POST /plans. Notes and plans are the owner
// channel of the signals pipeline: they reach the forecast only as an owner Signal, after the owner's OK.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Profile } from "../../schema/profile";
import type { Deps } from "../app";
import { loadForRun, runInputs } from "../engine";
import { businessOf, HttpError, isIsoDate, minorUnits, userOf } from "../http";
import type { Business, StoredProfile, Thought, ThoughtReading } from "../store";
import { ownerSignal, priceThought, readThought } from "../thoughts";
import { refreshPending } from "./review";

// Starter profiles the setup screen offers -> files in profiles/.
const STARTER: Record<string, string> = {
  trading: "trading", restaurant: "restaurant", services: "agency", agency: "agency", contractor: "contractor", other: "trading",
};
const SAMPLE_FOR: Record<string, string> = { restaurant: "pike_noodle" };

const readProfile = (id: string): Profile =>
  JSON.parse(readFileSync(join(import.meta.dirname, "../../profiles", `${id}.json`), "utf8")) as Profile;

const ownerNameFrom = (email: string) => {
  const local = (email.split("@")[0] ?? "").split(/[._-]/)[0] ?? "";
  return local ? local[0]!.toUpperCase() + local.slice(1).toLowerCase() : "";
};

function safetyLineFrom(v: unknown): Profile["safetyLine"] {
  const s = v as { kind?: unknown; amount?: unknown; weeks?: unknown } | null;
  if (s && s.kind === "fixed") return { kind: "fixed", amount: minorUnits(s.amount, "safetyLine.amount") };
  if (s && s.kind === "weeksOfFixedCosts" && typeof s.weeks === "number" && s.weeks > 0 && s.weeks <= 52) return { kind: "weeksOfFixedCosts", weeks: s.weeks };
  throw new HttpError(400, "INVALID_ARGUMENT", "Set your safety line as an amount in cents or a number of weeks of fixed costs.", { fieldIssues: [{ field: "safetyLine", issue: "invalid" }] });
}

const READING_EDITABLE = new Set(["amount", "date", "direction", "status", "probability", "partyId", "kind"]);

export const ownerRoutes = (deps: Deps) => async (app: FastifyInstance) => {
  const nowIso = () => deps.now().toISOString();

  // Body: { email, businessName, kind, reserve (cents), connect: string[] }. Returns the account completeSetup stores.
  app.post("/setup", async (req) => {
    const user = userOf(req);
    if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in with your work email first.");
    const body = (req.body ?? {}) as { email?: unknown; businessName?: unknown; kind?: unknown; reserve?: unknown; connect?: unknown };
    const name = typeof body.businessName === "string" ? body.businessName.trim() : "";
    if (!name || name.length > 120) throw new HttpError(400, "INVALID_ARGUMENT", "Enter your business name (up to 120 characters).", { fieldIssues: [{ field: "businessName", issue: "required" }] });
    const kind = typeof body.kind === "string" && STARTER[body.kind] ? body.kind : "other";
    const reserve = body.reserve === undefined || body.reserve === null ? undefined : minorUnits(body.reserve, "reserve");
    const connect = Array.isArray(body.connect) ? body.connect.filter((c): c is string => typeof c === "string" && /^[a-z0-9_-]{1,40}$/.test(c)).slice(0, 30) : [];
    const email = user.email ?? (typeof body.email === "string" ? body.email : "");
    const createdAt = nowIso();
    const connections = connect.map((id) => ({ id, name: id, state: "waiting" as const }));
    const starter = readProfile(STARTER[kind]!);
    // The starter's sample recurring costs (payroll, rent) are not this owner's: start empty, so nothing
    // on screen is a number the owner didn't give us.
    const profile: StoredProfile = {
      ...starter,
      recurring: [],
      ...(reserve !== undefined ? { safetyLine: { kind: "fixed", amount: reserve } } : {}),
      account: { owner: ownerNameFrom(email), email, kind, connections, ownerUserId: user.id, createdAt },
    };
    // One business per owner for now: setting up again updates it (notes and import notes are kept).
    const existing = await deps.store.findUserBusiness(user.id);
    let businessId: string;
    if (existing) {
      const b = await deps.store.getBusiness(existing);
      await deps.store.saveProfile(existing, { ...profile, account: { ...b?.profile.account, ...profile.account } }, name);
      businessId = existing;
    } else {
      businessId = await deps.store.createBusiness({ name, profile, isSynthetic: false, ownerUserId: user.id });
    }
    return {
      businessId, email, owner: profile.account!.owner, businessName: name, kind, sandbox: SAMPLE_FOR[kind] ?? "cascade_trade",
      reserve: reserve ?? null, connections, createdAt,
    };
  });

  // Partial update, read-modify-write. Today: safetyLine, plus owner name and time zone.
  const updateProfile = async (req: FastifyRequest) => {
    const b = businessOf(req);
    const body = (req.body ?? {}) as { safetyLine?: unknown; owner?: unknown; timezone?: unknown };
    const next: StoredProfile = structuredClone(b.profile);
    if (body.safetyLine !== undefined) next.safetyLine = safetyLineFrom(body.safetyLine);
    if (typeof body.owner === "string") next.account = { ...next.account, owner: body.owner.slice(0, 80) };
    if (typeof body.timezone === "string" && /^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/.test(body.timezone)) next.account = { ...next.account, timezone: body.timezone };
    await deps.store.saveProfile(b.id, next);
    const storeRevision = await deps.store.bumpRevision(b.id);
    const { account: _a, ...profile } = next;
    return { profile, storeRevision };
  };
  app.patch("/profile", updateProfile);
  app.put("/profile", updateProfile);

  // ---- owner notes -----------------------------------------------------------------------
  const view = async (b: Business, thoughts: Thought[]) => {
    const { records, overrides } = await loadForRun(deps.store, b.id);
    const { profile, asOf, fxRates } = runInputs(b, deps.now);
    return thoughts.map((t) => ({ ...t, effect: t.state === "new" ? priceThought(t, records, profile, asOf, fxRates, overrides) : null }));
  };
  const saveThoughts = (b: Business, thoughts: Thought[]) =>
    deps.store.saveProfile(b.id, { ...b.profile, account: { ...b.profile.account, thoughts: thoughts.slice(0, 200) } });
  const findThought = (b: Business, id: string) => {
    const t = (b.profile.account?.thoughts ?? []).find((x) => x.id === id);
    if (!t) throw new HttpError(404, "NOT_FOUND", "That note isn't here any more.");
    return t;
  };

  app.get("/notes", async (req) => {
    const b = businessOf(req);
    return view(b, b.profile.account?.thoughts ?? []);
  });

  app.post("/notes", async (req) => {
    const b = businessOf(req);
    const body = (req.body ?? {}) as { text?: unknown; via?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 2000) throw new HttpError(400, "INVALID_ARGUMENT", "Type or say the note first (up to 2000 characters).", { fieldIssues: [{ field: "text", issue: "required" }] });
    const { records } = await deps.store.load(b.id);
    const { asOf } = runInputs(b, deps.now);
    const t: Thought = {
      id: `th-${randomUUID().slice(0, 8)}`, text, via: body.via === "voice" ? "voice" : "typed", createdAt: nowIso(), state: "new",
      reading: readThought(text, records, asOf),
    };
    await saveThoughts(b, [t, ...(b.profile.account?.thoughts ?? [])]);
    return (await view(b, [t]))[0];
  });

  // Owner corrects the reading: { amount?, date?, direction?, status?, probability?, partyId?, kind? }.
  app.patch("/notes/:id", async (req) => {
    const b = businessOf(req);
    const t = findThought(b, (req.params as { id: string }).id);
    const edits = (req.body ?? {}) as Record<string, unknown>;
    const r: ThoughtReading = { ...t.reading };
    for (const [k, v] of Object.entries(edits)) {
      if (!READING_EDITABLE.has(k)) throw new HttpError(400, "INVALID_ARGUMENT", `You can't change ${k} here.`, { fieldIssues: [{ field: k, issue: "not editable" }] });
      if (k === "amount") r.amount = v === null ? null : minorUnits(v, "amount");
      if (k === "date") { if (v !== null && !isIsoDate(v)) throw new HttpError(400, "INVALID_ARGUMENT", "Dates look like 2026-11-03."); r.date = v as string | null; }
      if (k === "direction") { if (v !== "in" && v !== "out") throw new HttpError(400, "INVALID_ARGUMENT", "Money in or out?"); r.direction = v; }
      if (k === "status") { if (v !== "likely" && v !== "possible") throw new HttpError(400, "INVALID_ARGUMENT", "Likely or possible?"); r.status = v; }
      if (k === "probability") { if (typeof v !== "number" || v < 0 || v > 1) throw new HttpError(400, "INVALID_ARGUMENT", "Chance is between 0 and 1."); r.probability = v; }
      if (k === "partyId") { if (typeof v !== "string") throw new HttpError(400, "INVALID_ARGUMENT", "Pick a customer or supplier."); r.partyId = v; }
      if (k === "kind") { if (!["investment", "new_business", "collection", "spend", "note"].includes(String(v))) throw new HttpError(400, "INVALID_ARGUMENT", "Pick a kind."); r.kind = v as ThoughtReading["kind"]; }
    }
    r.missing = r.missing.filter((m) => (m === "amount" ? r.amount == null : m === "date" ? r.date == null : true));
    const next = { ...t, reading: r };
    await saveThoughts(b, (b.profile.account?.thoughts ?? []).map((x) => (x.id === t.id ? next : x)));
    return (await view(b, [next]))[0];
  });

  app.post("/notes/:id/:decision", async (req) => {
    const b = businessOf(req);
    const { id, decision } = req.params as { id: string; decision: string };
    const t = findThought(b, id);
    const thoughts = b.profile.account?.thoughts ?? [];
    if (decision === "remove") {
      await saveThoughts(b, thoughts.filter((x) => x.id !== id));
      return { id, state: "removed" };
    }
    if (decision === "keep") {
      await saveThoughts(b, thoughts.map((x) => (x.id === id ? { ...x, state: "kept" as const } : x)));
      return { id, state: "kept" };
    }
    if (decision !== "add") throw new HttpError(404, "NOT_FOUND", "Add, keep or remove.");
    if (t.state === "added") throw new HttpError(409, "NOT_PROPOSED", "That note is already in your forecast.");
    if (t.reading.missing.length) throw new HttpError(422, "MISSING_FIELDS", `Add the ${t.reading.missing.join(" and ")} first.`, { fieldIssues: t.reading.missing.map((f) => ({ field: f, issue: "required" })) });
    const { profile } = runInputs(b, deps.now);
    // The owner's own words, confirmed by the owner: the signal is applied, not waiting in Review.
    const signal = ownerSignal(`sig-${t.id}`, t, t.reading, profile, "applied");
    if (!signal) throw new HttpError(422, "MISSING_FIELDS", "Add the amount and date first.");
    const revision = await deps.store.upsertRecords(b.id, { signals: [signal] });
    await saveThoughts(b, thoughts.map((x) => (x.id === id ? { ...x, state: "added" as const } : x)));
    const { records } = await deps.store.load(b.id);
    await refreshPending(deps.store, b.id, records, revision, nowIso());
    return { id, state: "added", signalId: signal.id, storeRevision: revision };
  });

  // Owner confirms a plan from Ask Neri ("Add to forecast"): { amount, date, note, direction?, status?, probability?, partyId?, via? }.
  app.post("/plans", async (req) => {
    const b = businessOf(req);
    const p = (req.body ?? {}) as Record<string, unknown>;
    const amount = minorUnits(p.amount, "amount");
    if (!isIsoDate(p.date)) throw new HttpError(400, "INVALID_ARGUMENT", "Dates look like 2026-11-03.", { fieldIssues: [{ field: "date", issue: "YYYY-MM-DD" }] });
    const note = typeof p.note === "string" ? p.note.slice(0, 2000) : "Owner plan";
    const direction = p.direction === "in" ? "in" : "out";
    const status = p.status === "possible" ? "possible" : "likely";
    const probability = typeof p.probability === "number" && p.probability >= 0 && p.probability <= 1 ? p.probability : undefined;
    const { records } = await deps.store.load(b.id);
    const partyId = typeof p.partyId === "string" && records.parties.some((x) => x.id === p.partyId) ? p.partyId : undefined;
    const id = `plan-${randomUUID().slice(0, 8)}`;
    const { profile } = runInputs(b, deps.now);
    const signal = ownerSignal(id, { text: note, createdAt: nowIso() }, {
      date: p.date, amount, direction, status, ...(probability !== undefined ? { probability } : {}), ...(partyId ? { partyId } : {}),
    }, profile, "applied")!;
    const revision = await deps.store.upsertRecords(b.id, { signals: [signal] });
    await refreshPending(deps.store, b.id, { ...records, signals: [...records.signals, signal] }, revision, nowIso());
    return { id: signal.id, signal, storeRevision: revision };
  });
};
