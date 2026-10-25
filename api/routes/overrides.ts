// The owner's saved overrides: GET /overrides, PUT /overrides/:id (create or update one), DELETE /overrides/:id.
// Stored in the base scenario apart from the imported records, so re-imports keep them; every base and stress
// forecast, simulate and brief applies them. Each write bumps the business revision, so cached work items and
// briefs recompute. An override changes a forecast line only: nothing here sends, pays or moves money.

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Override } from "../../schema/records";
import type { Deps } from "../app";
import { storeFor, type NeriRequest, businessOf, HttpError } from "../http";
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
  if (b.isSynthetic && !(req as NeriRequest).sandboxed) throw new HttpError(403, "FORBIDDEN", "The sample is shared; set up your business to save changes.");
  return b;
}

// Overdue decisions are plain owner overrides with stable ids, so one item has at most one decision:
// "done" = exclude the leg (owner input, never a bank actual); "open" = stillOpen marker (keeps it in the
// forecast as expected now and out of the flags and the assumed-paid rule). "clear" removes either (Undo).
export const overdueIds = (commitmentId: string, legIndex?: number) => {
  const key = `${commitmentId}|${legIndex ?? "all"}`;
  const h = createHash("sha1").update(key).digest("hex").slice(0, 10);
  const safe = commitmentId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 70);
  return { done: `owner-done-${safe}-${legIndex ?? "all"}-${h}`, open: `owner-open-${safe}-${legIndex ?? "all"}-${h}` };
};

export const overrideRoutes = (deps: Deps) => async (app: FastifyInstance) => {
  // Compare-and-bump first, so of two writes from the same revision only one goes through (the other is a
  // 409 and reloads). Then read the list fresh, change it and save it. If the save fails the request is a
  // 500, the old list stays, and the bump costs one extra recompute.
  const write = async (req: FastifyRequest, businessId: string, expected: number, change: (list: Override[]) => Override[]) => {
    const storeRevision = await storeFor(req).bumpRevisionIf(businessId, expected);
    if (storeRevision === null) {
      const { storeRevision: now } = await storeFor(req).load(businessId);
      throw new HttpError(409, "STALE_REVIEW", "Your books changed since you opened this. Reload and try again.", { revision: now, retryable: true });
    }
    await storeFor(req).saveOverrides(businessId, change(await storeFor(req).loadOverrides(businessId)));
    // Pending Review proposals carry the revision they were built at; rebuild them so they stay confirmable.
    const { records } = await storeFor(req).load(businessId);
    await refreshPending(storeFor(req), businessId, records, storeRevision, deps.now().toISOString());
    return storeRevision;
  };

  app.get("/overrides", async (req) => {
    const b = businessOf(req);
    const [{ storeRevision }, overrides] = await Promise.all([storeFor(req).load(b.id), storeFor(req).loadOverrides(b.id)]);
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
    const [{ records }, current] = await Promise.all([storeFor(req).load(b.id), storeFor(req).loadOverrides(b.id)]);
    if (!records.commitments.some((c) => c.id === override.target.commitmentId)) {
      throw new HttpError(400, "INVALID_ARGUMENT", "That change points at a record we don't have.", { fieldIssues: [{ field: "target.commitmentId", issue: "unknown" }] });
    }
    if (!current.some((o) => o.id === id) && current.length >= MAX_OVERRIDES) {
      throw new HttpError(422, "TOO_MANY", `You have ${MAX_OVERRIDES} saved changes. Remove one first.`);
    }
    let created = false;
    const storeRevision = await write(req, b.id, expected, (list) => {
      created = !list.some((o) => o.id === id);
      return created ? [...list, override] : list.map((o) => (o.id === id ? override : o));
    });
    return { override, created, storeRevision };
  });

  // Body: { commitmentId, legIndex?, decision: "done" | "open" | "clear", expectedRevision }.
  app.post("/overdue-decision", async (req) => {
    const b = ownBusiness(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { commitmentId, legIndex, decision } = body;
    const issue = (field: string) => new HttpError(400, "INVALID_ARGUMENT", "That choice didn't look right. Reload and try again.", { fieldIssues: [{ field, issue: "invalid" }] });
    if (typeof commitmentId !== "string" || !commitmentId || commitmentId.length > 200) throw issue("commitmentId");
    if (legIndex !== undefined && !(Number.isSafeInteger(legIndex) && (legIndex as number) >= 0)) throw issue("legIndex");
    if (decision !== "done" && decision !== "open" && decision !== "clear") throw issue("decision");
    const expected = expectedRevision(req);
    const { records } = await storeFor(req).load(b.id);
    if (!records.commitments.some((c) => c.id === commitmentId)) {
      throw new HttpError(400, "INVALID_ARGUMENT", "That change points at a record we don't have.", { fieldIssues: [{ field: "commitmentId", issue: "unknown" }] });
    }
    const leg = legIndex as number | undefined;
    const ids = overdueIds(commitmentId, leg);
    const target = { commitmentId, ...(leg !== undefined ? { legIndex: leg } : {}) };
    const next: Override | null = decision === "done"
      ? { id: ids.done, target, change: { exclude: true }, origin: "owner", originId: "owner:paid-or-done" }
      : decision === "open" ? { id: ids.open, target, change: { stillOpen: true }, origin: "owner", originId: "owner:still-open" } : null;
    const storeRevision = await write(req, b.id, expected, (list) => {
      const rest = list.filter((o) => o.id !== ids.done && o.id !== ids.open);
      return next ? [...rest, next] : rest;
    });
    return { decision, override: next, storeRevision };
  });

  app.delete("/overrides/:id", async (req) => {
    const b = ownBusiness(req);
    const id = idParam(req);
    const expected = expectedRevision(req);
    if (!(await storeFor(req).loadOverrides(b.id)).some((o) => o.id === id)) throw new HttpError(404, "NOT_FOUND", "That change isn't saved any more.");
    const storeRevision = await write(req, b.id, expected, (list) => list.filter((o) => o.id !== id));
    return { id, deleted: true, storeRevision };
  });
};
