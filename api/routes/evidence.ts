// GET /evidence/:id/original: download the original behind a piece of evidence (issue #155).
// Members of the business only. The storage key comes from the stored evidence record, never from the request,
// and the response can never run in the app's origin: always an attachment, nosniff, a locked-down CSP, and a
// content type from a short allow-list (everything else is application/octet-stream).

import type { FastifyInstance } from "fastify";
import type { Deps } from "../app";
import { safeFileName } from "../blobs";
import { DOWNLOAD_MIMES } from "../originals";
import { businessOf, HttpError, userOf } from "../http";

export const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;

export const evidenceRoutes = (deps: Deps) => async (app: FastifyInstance) => {
  app.get("/evidence/:id/original", async (req, reply) => {
    // Originals are never public: not even for the shared synthetic samples on the demo server.
    const user = userOf(req);
    if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to open the original.");
    const b = businessOf(req);
    const { id } = req.params as { id: string };
    const { records } = await deps.store.load(b.id);
    const ev = id.length <= 300 ? records.evidence.find((e) => e.id === id) : undefined;
    const notFound = new HttpError(404, "NOT_FOUND", "The original isn't available. It may not have been saved when this was imported.");
    if (!ev?.storageKey) throw notFound;
    // A shared sample is readable by every signed-in user, so an original in one must still need membership.
    if (b.isSynthetic && !(await deps.store.isMember(b.id, user.id))) throw notFound;
    const original = await deps.blobs.getOriginal(b.id, ev.storageKey).catch(() => { throw new HttpError(503, "STORAGE_UNAVAILABLE", "The original couldn't be opened right now. Try again in a minute.", { retryable: true }); });
    if (!original) throw notFound;
    if (original.bytes.length > MAX_DOWNLOAD_BYTES) throw new HttpError(413, "TOO_LARGE", "That original is too large to open here.");
    const declared = (ev.mime ?? original.mime ?? "").split(";")[0]!.trim().toLowerCase();
    const type = DOWNLOAD_MIMES.has(declared) ? declared : "application/octet-stream";
    return reply
      .header("content-type", type)
      .header("content-disposition", `attachment; filename="${safeFileName(ev.fileName)}"`)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, no-store")
      .send(Buffer.from(original.bytes));
  });
};
