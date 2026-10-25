// The owner's saved overrides: GET /overrides, PUT /overrides/:id (create or update one), DELETE /overrides/:id.
// Stored in the base scenario apart from the imported records, so re-imports keep them; every base and stress
// forecast, simulate and brief applies them. Each write bumps the business revision, so cached work items and
// briefs recompute. An override changes a forecast line only: nothing here sends, pays or moves money.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Override } from "../../schema/records";
import type { Deps } from "../app";
import { businessOf, HttpError } from "../http";
import type { Business } from "../store";
import { checkOverride, MAX_OVERRIDES, OVERRIDE_ID } from "../overrides";
import { refreshPending } from "./review";

// Required on every write: the revision the owner's screen was built from (body, or ?expectedRevision= on DELETE).
function expectedRevision(req: FastifyRequest): number {
  const body = (req.body ?? {}) as { expectedRevision?: unknown };
  if (typeof body.expectedRevision === "number" && Number.isSafeInteger(body.expectedRevision)) return body.expectedRevision;
  const q = (req.query ?? {}) as Record<string, unknown>;
  if (typeof q.expectedRevision === "string" && /^\d{1,15}$/.test(q.expectedRevision)) return Number(q.expectedRevision);
  throw new HttpError(400, "INVALID_ARGUMENT", "Reload and try again (this change needs the revision you were looking at).", { fieldIssues: [{ field: "expectedRevision", issue: "required" }] });
}

function idParam(req: FastifyRequest): string {
  const { id } = req.params as { id: string };
  if (!OVERRIDE_ID.test(id)) throw new HttpError(400, "INVALID_ARGUMENT", "That change needs a short id (letters, numbers, - and _).", { fieldIssues: [{ field: "id", issue: "invalid" }] });
  return id;
}

// Samples are shared by every visitor: a saved change would move everyone's forecast.
function ownBusiness(req: FastifyRequest): Business {
  const b = businessOf(req);
  if (b.isSynthetic) throw new HttpError(403, "FORBIDDEN", "The sample is shared; set up your business to save changes.");
  return b;
}

export const overrideRoutes = (deps: Deps) => async (app: FastifyInstance) => {
  // Compare-and-bump first, so of two writes from the same revision only one goes through (the other is a
  // 409 and reloads). Then read the list fresh, change it and save it. If the save fails the request is a
  // 500, the old list stays, and the bump costs one extra recompute.
  const write = async (businessId: string, expected: number, change: (list: Override[]) => Override[]) => {
    const storeRevision = await deps.store.bumpRevisionIf(businessId, expected);
    if (storeRevision === null) {
      const { storeRevision: now } = await deps.store.load(businessId);
      throw new HttpError(409, "STALE_REVIEW", "Your books changed since you opened this. Reload and try again.", { revision: now, retryable: true });
    }
    await deps.store.saveOverrides(businessId, change(await deps.store.loadOverrides(businessId)));
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

  // Body: { target: { commitmentId, legIndex? }, change: { date? | shiftDays?, amount?, exclude? }, originId?, expectedRevision }.
  // origin is always "owner": this is the owner's own edit.
  app.put("/overrides/:id", async (req) => {
    const b = ownBusiness(req);
    const id = idParam(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { expectedRevision: _e, origin: _o, id: _i, ...rest } = body;
    const parsed = checkOverride({ ...rest, id, origin: "owner" });
    if (!parsed.ok) {
      throw new HttpError(400, "INVALID_ARGUMENT", "That change didn't look right. Amounts are whole cents, dates look like 2026-11-03.", { fieldIssues: parsed.issues });
    }
    const expected = expectedRevision(req);
    const override = parsed.value;
    const [{ records }, current] = await Promise.all([deps.store.load(b.id), deps.store.loadOverrides(b.id)]);
    if (!records.commitments.some((c) => c.id === override.target.commitmentId)) {
      throw new HttpError(400, "INVALID_ARGUMENT", "That change points at a record we don't have.", { fieldIssues: [{ field: "target.commitmentId", issue: "unknown" }] });
    }
    if (!current.some((o) => o.id === id) && current.length >= MAX_OVERRIDES) {
      throw new HttpError(422, "TOO_MANY", `You have ${MAX_OVERRIDES} saved changes. Remove one first.`);
    }
    let created = false;
    const storeRevision = await write(b.id, expected, (list) => {
      created = !list.some((o) => o.id === id);
      return created ? [...list, override] : list.map((o) => (o.id === id ? override : o));
    });
    return { override, created, storeRevision };
  });

  app.delete("/overrides/:id", async (req) => {
    const b = ownBusiness(req);
    const id = idParam(req);
    const expected = expectedRevision(req);
    if (!(await deps.store.loadOverrides(b.id)).some((o) => o.id === id)) throw new HttpError(404, "NOT_FOUND", "That change isn't saved any more.");
    const storeRevision = await write(b.id, expected, (list) => list.filter((o) => o.id !== id));
    return { id, deleted: true, storeRevision };
  });
};
