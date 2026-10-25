// Builds the Fastify instance (api/server.ts listens; tests use inject()). Every route except /health
// verifies the Supabase session token and resolves which business the caller may see before any
// service-role read or write. Nothing here sends a message, pays a bill or moves money.

import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { HttpError, sendError, type NeriRequest, type User } from "./http";
import type { AiMode } from "./engine";
import type { Store } from "./store";
import { readRoutes } from "./routes/read";
import { reviewRoutes } from "./routes/review";
import { ownerRoutes } from "./routes/owner";
import { workRoutes } from "./routes/work";
import { demoRoutes } from "./routes/demo";

// Verifies a Supabase access token. Returns null for an invalid or expired token.
export type Verifier = (token: string) => Promise<User | null>;

export type AppOptions = {
  store: Store;
  verify: Verifier;
  demoMode?: boolean;              // DEMO_MODE=1: unauthenticated requests may use synthetic businesses
  defaultBusiness?: string;        // sample opened when the caller has no business of their own
  aiMode?: AiMode;
  staticDir?: string;              // serve the app (same origin) when present
  now?: () => Date;
  allowReset?: boolean;            // POST /demo/reset (synthetic businesses only)
  logger?: boolean;
};

export type Deps = Required<Pick<AppOptions, "store" | "demoMode" | "defaultBusiness" | "aiMode" | "now" | "allowReset">>;

// Routes that need a signed-in user but no business yet.
const NO_BUSINESS = new Set(["/setup", "/demo/reset"]);

// Paths the API owns. Anything else falls through to the static app.
const API_PREFIXES = ["/context", "/brief", "/forecast", "/simulate", "/setup", "/profile", "/review", "/import", "/signals",
  "/notes", "/plans", "/work-items", "/records", "/demo", "/ask"];

const isApiPath = (url: string) => {
  const path = url.split("?")[0]!;
  return API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
};

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : "";
}

const BUSINESS_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const deps: Deps = {
    store: opts.store,
    demoMode: opts.demoMode ?? false,
    defaultBusiness: opts.defaultBusiness ?? "cascade_trade",
    aiMode: opts.aiMode ?? "cache_only",
    now: opts.now ?? (() => new Date()),
    allowReset: opts.allowReset ?? false,
  };
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 12 * 1024 * 1024 });

  // The app sends Content-Type: application/json on every call, including body-less POSTs.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "") return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new HttpError(400, "INVALID_JSON", "That request wasn't valid JSON. Reload and try again."), undefined);
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (!(err instanceof HttpError) && ((err as { statusCode?: number }).statusCode ?? 500) >= 500) app.log.error({ code: (err as { code?: string }).code }, "request failed");
    return sendError(reply, err);
  });

  app.get("/health", async () => ({ ok: true, demoMode: deps.demoMode, aiMode: deps.aiMode }));

  app.addHook("preHandler", async (req) => {
    if (!isApiPath(req.url)) return;
    const r = req as NeriRequest;
    const token = bearer(req);
    if (token !== null) {
      const user = token ? await opts.verify(token).catch(() => null) : null;
      if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Your session ended. Sign in again with a new code.");
      r.user = user;
    } else if (!deps.demoMode) {
      throw new HttpError(401, "UNAUTHENTICATED", "Sign in to see your numbers.");
    } else if (req.url.startsWith("/import")) {
      // Demo samples are shared and public: anonymous uploads would publish the file to every visitor.
      throw new HttpError(401, "UNAUTHENTICATED", "Sign in to upload your own files. The sample already has its documents.");
    }

    const path = req.url.split("?")[0]!;
    if (NO_BUSINESS.has(path)) return;

    // Which business: an explicit X-Neri-Business header (or ?business=), else the caller's own
    // business, else the default sample.
    const q = (req.query ?? {}) as Record<string, unknown>;
    const asked = (req.headers["x-neri-business"] as string | undefined) ?? (typeof q.business === "string" ? q.business : undefined);
    if (asked !== undefined && !BUSINESS_ID.test(asked)) throw new HttpError(404, "NOT_FOUND", "We couldn't find that business.");
    const id = asked ?? (r.user ? await deps.store.findUserBusiness(r.user.id) : null) ?? deps.defaultBusiness;
    const business = await deps.store.getBusiness(id);
    // Same answer for "doesn't exist" and "not yours", so ids can't be probed.
    const notFound = new HttpError(404, "NOT_FOUND", "We couldn't find that business. Sign in with the email you set it up with.");
    if (!business) throw notFound;
    if (!business.isSynthetic && !(r.user && await deps.store.isMember(business.id, r.user.id))) throw notFound;
    r.business = business;
  });

  await app.register(readRoutes(deps));
  await app.register(reviewRoutes(deps));
  await app.register(ownerRoutes(deps));
  await app.register(workRoutes(deps));
  await app.register(demoRoutes(deps));

  if (opts.staticDir && existsSync(opts.staticDir)) {
    await app.register(fastifyStatic, { root: opts.staticDir, prefix: "/", index: ["index.html"] });
  }
  return app;
}
