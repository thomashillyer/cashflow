// POST /demo/reset (reseed the synthetic samples) and POST /ask (Ask Neri; lands with #102).

import type { FastifyInstance } from "fastify";
import type { Deps } from "../app";
import { loadSample, SAMPLES } from "../demo";
import { HttpError } from "../http";

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

  app.post("/ask", async () => {
    throw new HttpError(501, "NOT_IMPLEMENTED", "Ask Neri isn't connected on this server yet. Use Today's list and the what-if chart for now.");
  });
};
