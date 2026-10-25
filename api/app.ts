// Builds the Fastify instance (api/server.ts listens; tests use inject()). Every route except /health
// verifies the Supabase session token and resolves which business the caller may see before any
// service-role read or write. Nothing here sends a message, pays a bill or moves money.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { HttpError, sendError, type NeriRequest, type User } from "./http";
import type { AiMode } from "./engine";
import type { Store } from "./store";
import { readRoutes } from "./routes/read";
import { reviewRoutes } from "./routes/review";
import { ownerRoutes } from "./routes/owner";
import { workRoutes } from "./routes/work";
import { demoRoutes } from "./routes/demo";
import { overrideRoutes } from "./routes/overrides";
import { SandboxStore, VISITOR_HEADER, VISITOR_ID } from "./sandbox";
import { isBehind, type SchemaStatus, type SchemaStatusFn } from "./schema-status";

// Verifies a Supabase access token. Returns null for an invalid or expired token.
export type Verifier = (token: string) => Promise<User | null>;

export type AppOptions = {
  store: Store;
  verify: Verifier;
  demoMode?: boolean;              // DEMO_MODE=1: unauthenticated requests may use synthetic businesses
  defaultBusiness?: string;        // sample opened only in explicitly enabled demo mode
  aiMode?: AiMode;
  staticDir?: string;              // serve the app (same origin) when present
  // Public values for the served app/config.js (the anon key is public by design; never the service-role key).
  appConfig?: { supabaseUrl?: string; supabaseAnonKey?: string };
  now?: () => Date;
  allowReset?: boolean;            // POST /demo/reset (synthetic businesses only)
  logger?: boolean | { stream: NodeJS.WritableStream }; // tests pass a stream to capture log lines
  sandboxes?: SandboxStore;        // tests inject one to control the clock and limits
  schemaStatus?: SchemaStatusFn;   // GET /ready: repo vs database migration version (Supabase store only)
};

export type Deps = Required<Pick<AppOptions, "store" | "demoMode" | "defaultBusiness" | "aiMode" | "now" | "allowReset">> & {
  schemaStatus?: SchemaStatusFn;
  sandboxes: SandboxStore;         // per-visitor copies of the synthetic samples (demo mode)
};

const READY_CACHE_MS = 30_000;

// The fields of a per-request log line. Never bodies, headers or tokens.
export function requestLogLine(req: FastifyRequest, status: number, ms: number, errorCode?: string) {
  const businessId = (req as NeriRequest).business?.id;
  return {
    reqId: req.id,
    method: req.method,
    route: req.routeOptions?.url ?? "unmatched",
    status,
    ms: Math.round(ms * 10) / 10,
    ...(businessId ? { businessId } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

// Routes that need a signed-in user but no business yet.
const NO_BUSINESS = new Set(["/setup", "/demo/reset"]);

// Paths the API owns. Anything else falls through to the static app.
const API_PREFIXES = ["/context", "/brief", "/forecast", "/simulate", "/setup", "/profile", "/review", "/import", "/signals", "/rules",
  "/notes", "/plans", "/work-items", "/records", "/demo", "/ask", "/overrides", "/connections"];

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

// The visitor's random id (X-Neri-Visitor), or null when absent or malformed.
function visitorOf(req: FastifyRequest): string | null {
  const v = req.headers[VISITOR_HEADER];
  return typeof v === "string" && VISITOR_ID.test(v) ? v : null;
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
    sandboxes: opts.sandboxes ?? new SandboxStore(),
    ...(opts.schemaStatus ? { schemaStatus: opts.schemaStatus } : {}),
  };
  // disableRequestLogging: the onResponse hook below writes the one structured line per request.
  const app = Fastify({ logger: opts.logger ?? false, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 12 * 1024 * 1024 });

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

  const errorCodes = new WeakMap<FastifyRequest, string>();
  app.setErrorHandler((err, req, reply) => {
    errorCodes.set(req, err instanceof HttpError ? err.code : typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "INTERNAL");
    if (!(err instanceof HttpError) && ((err as { statusCode?: number }).statusCode ?? 500) >= 500) app.log.error({ code: (err as { code?: string }).code }, "request failed");
    return sendError(reply, err);
  });

  // One structured line per request: no bodies, headers or tokens.
  app.addHook("onResponse", async (req, reply) => {
    app.log.info(requestLogLine(req, reply.statusCode, reply.elapsedTime, errorCodes.get(req)), "request");
  });

  // Liveness only: Fly health-checks this. It must stay 200 while the process is up, whatever the database says.
  app.get("/health", async () => ({ ok: true, demoMode: deps.demoMode, aiMode: deps.aiMode }));

  // Readiness: is the database migrated to what this code expects? Cached ~30s.
  let cached: { at: number; status: SchemaStatus | null } | undefined;
  app.get("/ready", async (_req, reply) => {
    if (!deps.schemaStatus) return { ok: true, schema: null };
    const t = deps.now().getTime();
    if (!cached || t - cached.at >= READY_CACHE_MS) {
      cached = { at: t, status: await deps.schemaStatus().catch(() => null) };
    }
    const schema = cached.status ?? { repo: "unknown", db: null };
    if (cached.status && !isBehind(cached.status)) return { ok: true, schema };
    return reply.code(503).send({ ok: false, schema, message: "Database is behind the code: run npx supabase db push." });
  });

  app.addHook("preHandler", async (req) => {
    if (!isApiPath(req.url)) return;
    const r = req as NeriRequest;
    r.store = deps.store;
    const visitor = visitorOf(req);
    if (visitor) r.visitorId = visitor;
    const token = bearer(req);
    if (token !== null) {
      const user = token ? await opts.verify(token).catch(() => null) : null;
      if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Your session ended. Sign in again with your email and password.");
      r.user = user;
    } else if (!deps.demoMode) {
      throw new HttpError(401, "UNAUTHENTICATED", "Sign in to see your numbers.");
    } else if (req.url.startsWith("/import")) {
      // Demo samples are shared and public: anonymous uploads would publish the file to every visitor.
      throw new HttpError(401, "UNAUTHENTICATED", "Sign in to upload your own files. The sample already has its documents.");
    }

    const path = req.url.split("?")[0]!;
    if (path === "/demo/reset" && !deps.demoMode) throw new HttpError(403, "FORBIDDEN", "Sample resets are not available on this server.");
    if (NO_BUSINESS.has(path)) return;

    // Which business: an explicit X-Neri-Business header (or ?business=), else the caller's own
    // business. Only explicit demo mode can fall back to a synthetic sample.
    const q = (req.query ?? {}) as Record<string, unknown>;
    const asked = (req.headers["x-neri-business"] as string | undefined) ?? (typeof q.business === "string" ? q.business : undefined);
    if (asked !== undefined && !BUSINESS_ID.test(asked)) throw new HttpError(404, "NOT_FOUND", "We couldn't find that business.");
    const id = asked ?? (r.user ? await deps.store.findUserBusiness(r.user.id) : null) ?? (deps.demoMode ? deps.defaultBusiness : null);
    if (!id) throw new HttpError(404, "NO_BUSINESS", "Set up your business before adding sources or viewing your numbers.");
    const business = await deps.store.getBusiness(id);
    // Same answer for "doesn't exist" and "not yours", so ids can't be probed.
    const notFound = new HttpError(404, "NOT_FOUND", "We couldn't find that business. Sign in with the email you set it up with.");
    if (!business) throw notFound;
    if (business.isSynthetic && !deps.demoMode) throw notFound;
    if (!business.isSynthetic && !(r.user && await deps.store.isMember(business.id, r.user.id))) throw notFound;
    r.business = business;
    // Demo samples are shared, so a visitor works on a private copy; the real store is never written.
    if (deps.demoMode && business.isSynthetic) {
      if (visitor) {
        r.store = await deps.sandboxes.storeFor(visitor, business, deps.store);
        r.sandboxed = true;
        r.business = (await r.store.getBusiness(business.id)) ?? business;   // the visitor's profile and notes
      } else if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
        throw new HttpError(403, "FORBIDDEN", "The sample is shared. Reload the page to get your own copy.");
      }
    }
  });

  await app.register(readRoutes(deps));
  await app.register(reviewRoutes(deps));
  await app.register(ownerRoutes(deps));
  await app.register(workRoutes(deps));
  await app.register(demoRoutes(deps));
  await app.register(overrideRoutes(deps));

  if (opts.staticDir && existsSync(opts.staticDir)) {
    // The committed app/config.js stays empty (the static preview publishes it). When this server serves the app,
    // serve it live instead: same-origin API, plus the public Supabase values so sign-in works.
    const configPath = join(opts.staticDir, "config.js");
    if (existsSync(configPath)) {
      if (opts.appConfig?.supabaseAnonKey && isSecretKey(opts.appConfig.supabaseAnonKey))
        app.log.error("SUPABASE_ANON_KEY holds a secret/service-role key; sign-in stays off and the key is not served");
      const served = servedConfig(readFileSync(configPath, "utf8"), opts.appConfig ?? {}, deps.demoMode);
      app.get("/config.js", async (_req, reply) =>
        reply.type("application/javascript; charset=utf-8").header("cache-control", "no-cache").send(served));
    }
    await app.register(fastifyStatic, { root: opts.staticDir, prefix: "/", index: ["index.html"] });
  }
  return app;
}

// app/config.js with the live values set; every other line (comments, lock minutes) is kept.
export function servedConfig(committed: string, cfg: { supabaseUrl?: string; supabaseAnonKey?: string }, demoMode = false): string {
  const set = (src: string, name: string, value: string) =>
    src.replace(new RegExp(`^window\\.${name}\\s*=.*$`, "m"), `window.${name} = ${JSON.stringify(value)};`);
  let out = set(committed, "NERI_API_BASE", "same-origin");
  const demoFlag = `window.NERI_DEMO_MODE = ${JSON.stringify(demoMode)};`;
  out = /^window\.NERI_DEMO_MODE\s*=.*$/m.test(out)
    ? out.replace(/^window\.NERI_DEMO_MODE\s*=.*$/m, demoFlag)
    : `${out}\n${demoFlag}\n`;
  if (cfg.supabaseUrl && cfg.supabaseAnonKey && !isSecretKey(cfg.supabaseAnonKey)) {
    out = set(out, "NERI_SUPABASE_URL", cfg.supabaseUrl);
    out = set(out, "NERI_SUPABASE_ANON_KEY", cfg.supabaseAnonKey);
  }
  return out;
}

// A service-role or secret key must never reach the browser, even if it lands in SUPABASE_ANON_KEY by mistake.
export function isSecretKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  try {
    const payload = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8")) as { role?: string };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}
