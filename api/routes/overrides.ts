// The owner's saved overrides: GET /overrides, PUT /overrides/:id (create or update one), DELETE /overrides/:id.
// Stored in the base scenario apart from the imported records, so re-imports keep them; every base and stress
// forecast, simulate and brief applies them. Each write bumps the business revision, so cached work items and
// briefs recompute. An override changes a forecast line only: nothing here sends, pays or moves money.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Override } from "../../schema/records";
import type { Deps } from "../app";
import { businessOf, HttpError } from "../http";
import { checkOverride, MAX_OVERRIDES, OVERRIDE_ID } from "../overrides";
import { refreshPending } from "./review";

// Same optimistic check as the Review writes: an optional expectedRevision (body, or ?expectedRevision= on DELETE).
function expectedRevision(req: FastifyRequest): number | undefined {
  const body = (req.body ?? {}) as { expectedRevision?: unknown };
  if (typeof body.expectedRevision === "number") return body.expectedRevision;
  const q = (req.query ?? {}) as Record<string, unknown>;
  if (typeof q.expectedRevision === "string" && /^\d+$/.test(q.expectedRevision)) return Number(q.expectedRevision);
  return undefined;
}

function idParam(req: FastifyRequest): string {
  const { id } = req.params as { id: string };
  if (!OVERRIDE_ID.test(id)) throw new HttpError(400, "INVALID_ARGUMENT", "That change needs a short id (letters, numbers, - and _).", { fieldIssues: [{ field: "id", issue: "invalid" }] });
  return id;
}

export const overrideRoutes = (deps: Deps) => async (app: FastifyInstance) => {
  // Load the current revision and list, refusing a stale write.
  const begin = async (req: FastifyRequest, businessId: string) => {
    const [{ records, storeRevision }, overrides] = await Promise.all([deps.store.load(businessId), deps.store.loadOverrides(businessId)]);
    const expected = expectedRevision(req);
    if (expected !== undefined && expected !== storeRevision) {
      throw new HttpError(409, "STALE_REVIEW", "Your books changed since you opened this. Reload and try again.", { revision: storeRevision, retryable: true });
    }
    return { records, overrides };
  };

  const commit = async (businessId: string, overrides: Override[]) => {
    await deps.store.saveOverrides(businessId, overrides);
    const storeRevision = await deps.store.bumpRevision(businessId);
    // Pending Review proposals carry the revision they were built at; rebuild them so they stay confirmable.
    const { records } = await deps.store.load(businessId);
    await refreshPending(deps.store, businessId, records, storeRevision, deps.now().toISOString());
    return storeRevision;
  };

  app.get("/overrides", async (req) => {
    const b = businessOf(req);
    const [{ storeRevision }, overrides] = await Promise.all([deps.store.load(b.id), deps.store.loadOverrides(b.id)]);
    return { overrides, storeRevision };
  });

  // Body: { target: { commitmentId, legIndex? }, change: { date? | shiftDays?, amount?, exclude? }, originId?, expectedRevision? }.
  // origin is always "owner": this is the owner's own edit.
  app.put("/overrides/:id", async (req) => {
    const b = businessOf(req);
    const id = idParam(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { expectedRevision: _e, origin: _o, id: _i, ...rest } = body;
    const parsed = checkOverride({ ...rest, id, origin: "owner" });
    if (!parsed.ok) {
      throw new HttpError(400, "INVALID_ARGUMENT", "That change didn't look right. Amounts are whole cents, dates look like 2026-11-03.", { fieldIssues: parsed.issues });
    }
    const { records, overrides } = await begin(req, b.id);
    if (!records.commitments.some((c) => c.id === parsed.value.target.commitmentId)) {
      throw new HttpError(400, "INVALID_ARGUMENT", "That change points at a record we don't have.", { fieldIssues: [{ field: "target.commitmentId", issue: "unknown" }] });
    }
    const exists = overrides.some((o) => o.id === id);
    if (!exists && overrides.length >= MAX_OVERRIDES) {
      throw new HttpError(422, "TOO_MANY", `You have ${MAX_OVERRIDES} saved changes. Remove one first.`);
    }
    const next = exists ? overrides.map((o) => (o.id === id ? parsed.value : o)) : [...overrides, parsed.value];
    const storeRevision = await commit(b.id, next);
    return { override: parsed.value, created: !exists, storeRevision };
  });

  app.delete("/overrides/:id", async (req) => {
    const b = businessOf(req);
    const id = idParam(req);
    const { overrides } = await begin(req, b.id);
    if (!overrides.some((o) => o.id === id)) throw new HttpError(404, "NOT_FOUND", "That change isn't saved any more.");
    const storeRevision = await commit(b.id, overrides.filter((o) => o.id !== id));
    return { id, deleted: true, storeRevision };
  });
};
