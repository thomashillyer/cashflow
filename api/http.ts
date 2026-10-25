// Errors in the shape of docs/TECHNICAL_PLAN.md section 8:
// { error: { code, message, fieldIssues, retryable }, revision? }. Messages tell the owner the next step.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Business } from "./store";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: { fieldIssues?: { field: string; issue: string }[]; retryable?: boolean; revision?: number } = {},
  ) {
    super(message);
  }
}

export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof HttpError) {
    return reply.code(err.status).send({
      error: { code: err.code, message: err.message, fieldIssues: err.extra.fieldIssues ?? [], retryable: err.extra.retryable ?? false },
      ...(err.extra.revision !== undefined ? { revision: err.extra.revision } : {}),
    });
  }
  const e = err as { status?: number; statusCode?: number; code?: string; message?: string };
  const status = e.status ?? e.statusCode ?? 500;
  if (status === 404) return sendError(reply, new HttpError(404, "NOT_FOUND", "That item doesn't exist any more. Reload and try again."));
  if (status >= 400 && status < 500) {
    return sendError(reply, new HttpError(status, typeof e.code === "string" ? e.code : "BAD_REQUEST", "That request didn't look right. Reload and try again."));
  }
  return sendError(reply, new HttpError(500, "INTERNAL", "Something went wrong on our side. Try again in a minute.", { retryable: true }));
}

export type User = { id: string; email?: string };

// Set by the auth hook on every route except /health.
export type NeriRequest = FastifyRequest & { user?: User; business?: Business };

export function businessOf(req: FastifyRequest): Business {
  const b = (req as NeriRequest).business;
  if (!b) throw new HttpError(404, "NOT_FOUND", "No business selected. Sign in again, or open a sample.");
  return b;
}

export const userOf = (req: FastifyRequest): User | undefined => (req as NeriRequest).user;

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

export function minorUnits(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new HttpError(400, "INVALID_ARGUMENT", `${field} must be a whole number of cents, zero or more.`, { fieldIssues: [{ field, issue: "not integer minor units" }] });
  }
  return v;
}
