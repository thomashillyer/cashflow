import type { FastifyInstance } from "fastify";
import type { ConnectionId, ConnectionService } from "../connections";
import { businessOf, HttpError, storeFor, userOf } from "../http";
import { ConnectorFailure } from "../../adapters/connector";

export const connectionRoutes = (deps: { connections: ConnectionService; now: () => Date }) => async (app: FastifyInstance) => {
  app.get("/connections", async (req) => {
    if (!userOf(req)) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to see your connections.");
    return deps.connections.list(businessOf(req));
  });
  // Open pipeline records (RFQs in play) that need a follow-up. Read-only; empty when no CRM is connected.
  app.get("/sales-actions", async (req) => {
    if (!userOf(req)) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to see your sales follow-ups.");
    if (!deps.connections.salesActions) return { actions: [], reason: "No CRM is set up on this server." };
    try {
      const actions = await deps.connections.salesActions(businessOf(req), deps.now);
      return { actions, ...(actions.length ? {} : { reason: "No open RFQs were found, or the CRM isn't connected for this business." }) };
    } catch (e) {
      // Our own plain-words connector messages only; never a provider payload.
      const reason = e instanceof ConnectorFailure ? `${e.error.message} ${e.error.nextStep}` : "Zoho CRM couldn't be read right now.";
      return { actions: [], unavailable: true, reason };
    }
  });
  app.post("/connections/:provider/sync", async (req) => {
    if (!userOf(req)) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to sync your books.");
    if (Object.keys((req.query ?? {}) as object).length || (req.body != null && (typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length))) {
      throw new HttpError(400, "INVALID_ARGUMENT", "This connection is configured by your team. Sync does not accept account settings.");
    }
    const provider = (req.params as { provider: string }).provider;
    if (provider !== "zoho_books" && provider !== "zoho_crm" && provider !== "outlook") throw new HttpError(404, "NOT_FOUND", "That connection isn't available.");
    return deps.connections.sync(businessOf(req), storeFor(req), deps.now, provider as ConnectionId);
  });
};
