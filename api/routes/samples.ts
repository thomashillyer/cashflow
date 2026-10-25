// POST /samples/load and POST /samples/clear: one click to try Neri with the fictional Cascade Trade business.
// Private businesses only (the auth hook already checks membership); never mixes with real data.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Deps } from "../app";
import { loadSample, shiftSample } from "../demo";
import { storeFor, businessOf, HttpError, userOf } from "../http";
import type { StoredProfile } from "../store";
import { refreshPending } from "./review";

export const sampleRoutes = (deps: Deps) => async (app: FastifyInstance) => {
  const guard = (req: FastifyRequest) => {
    if (!userOf(req)) throw new HttpError(401, "UNAUTHENTICATED", "Sign in first.");
    const b = businessOf(req);
    if (b.isSynthetic) throw new HttpError(403, "FORBIDDEN", "Sample data can only be loaded into your own business.");
    return b;
  };

  app.post("/samples/load", async (req) => {
    const b = guard(req);
    const store = storeFor(req);
    const { records: existing } = await store.load(b.id);
    if (existing.commitments.length || b.profile.account?.sampleLoaded) throw new HttpError(409, "CONFLICT", "Your business already has data.");
    const today = deps.now().toISOString().slice(0, 10);
    const sample = shiftSample(loadSample("cascade_trade")!, today);
    const aliases = [...new Set([...(b.profile.account?.aliases ?? []), ...(sample.profile.account?.aliases ?? []), sample.name])];
    const next: StoredProfile = structuredClone(b.profile);
    if (next.safetyLine.kind === "fixed" && next.safetyLine.amount === 0) next.safetyLine = structuredClone(sample.profile.safetyLine);
    if (!next.recurring?.length) next.recurring = structuredClone(sample.profile.recurring);
    next.account = { ...next.account, aliases, sampleLoaded: true };
    await store.saveProfile(b.id, next);
    const storeRevision = await store.upsertRecords(b.id, sample.records);
    const latest = await store.load(b.id);
    await refreshPending(store, b.id, latest.records, latest.storeRevision, deps.now().toISOString());
    return { loaded: true, commitments: sample.records.commitments.length, storeRevision };
  });

  app.post("/samples/clear", async (req) => {
    const b = guard(req);
    if (!b.profile.account?.sampleLoaded) throw new HttpError(409, "CONFLICT", "There is no sample data to clear.");
    const store = storeFor(req);
    const storeRevision = await store.clearRecords(b.id);
    const next: StoredProfile = structuredClone(b.profile);
    next.account = { ...next.account, sampleLoaded: false };
    await store.saveProfile(b.id, next);
    return { cleared: true, storeRevision };
  });
};
