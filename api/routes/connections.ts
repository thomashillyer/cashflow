import type { FastifyInstance } from "fastify";
import type { ConnectionService } from "../connections";
import { businessOf, HttpError, storeFor, userOf } from "../http";

export const connectionRoutes = (deps: { connections: ConnectionService; now: () => Date }) => async (app: FastifyInstance) => {
  app.get("/connections", async (req) => {
    if (!userOf(req)) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to see your connections.");
    return deps.connections.list(businessOf(req));
  });
  app.post("/connections/zoho_books/sync", async (req) => {
    if (!userOf(req)) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to sync your books.");
    if (Object.keys((req.query ?? {}) as object).length || (req.body != null && (typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length))) {
      throw new HttpError(400, "INVALID_ARGUMENT", "This connection is configured by your team. Sync does not accept account settings.");
    }
    return deps.connections.sync(businessOf(req), storeFor(req), deps.now);
  });
};
