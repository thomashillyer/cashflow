// POST /work-items/:id/draft and /approve. A draft is text for the owner to copy or open in their own
// mail or chat app; approve changes the work item's state only. Nothing is sent or paid.

import type { FastifyInstance } from "fastify";
import type { Party } from "../../schema/records";
import { draftMessage } from "../../ai/brief";
import type { Deps } from "../app";
import { compute } from "../engine";
import { businessOf, HttpError } from "../http";

// Where the owner would send it, from the party's contacts. Customers' payables desk for a chase,
// suppliers' receivables desk for a deferral; empty when we have no contact.
function recipient(party: Party | undefined, channel: "email" | "message"): string {
  if (!party?.contacts) return "";
  if (channel === "message") return party.contacts.phones?.[0] ?? "";
  const domain = party.contacts.emailDomains?.[0];
  if (!domain) return "";
  return `${party.kind === "customer" ? "ap" : "accounts"}@${domain}`;
}

// Shown as the To placeholder when we know the company's domain but not an address.
function recipientHint(party: Party | undefined, channel: "email" | "message"): string | undefined {
  const domain = party?.contacts?.emailDomains?.[0];
  return channel === "email" && domain ? `someone@${domain}` : undefined;
}

export const workRoutes = (deps: Deps) => async (app: FastifyInstance) => {
  // Body (optional): { channel: "email" | "message" | "whatsapp" }.
  app.post("/work-items/:id/draft", async (req) => {
    const b = businessOf(req);
    const { id } = req.params as { id: string };
    const asked = (req.body as { channel?: unknown } | undefined)?.channel;
    const c = await compute(deps.store, b, deps.aiMode, deps.now);
    const item = c.brief.all.find((i) => i.id === id);
    if (!item) throw new HttpError(404, "NOT_FOUND", "That item isn't on your list any more. Reload Today.");
    const want = asked === "message" || asked === "whatsapp" ? "message" : asked === "email" ? "email" : undefined;
    const withChannel = want
      ? { ...item, actions: [{ kind: want === "message" ? "draft_message" as const : "draft_email" as const }, ...item.actions.filter((a) => a.kind === "mark_done")] }
      : item;
    const draft = await draftMessage(withChannel, c.ctx);
    const commitmentId = item.lever?.commitmentId ?? item.evidenceRefs[0];
    const partyId = c.records.commitments.find((x) => x.id === commitmentId)?.partyId;
    const party = c.records.parties.find((p) => p.id === partyId);
    return { ...draft, to: recipient(party, draft.channel), toHint: recipientHint(party, draft.channel), subject: draft.subject ?? "", itemId: id };
  });

  app.post("/work-items/:id/approve", async (req) => {
    const b = businessOf(req);
    const { id } = req.params as { id: string };
    const c = await compute(deps.store, b, deps.aiMode, deps.now);   // makes sure the ranking is saved
    if (!c.brief.all.some((i) => i.id === id)) throw new HttpError(404, "NOT_FOUND", "That item isn't on your list any more. Reload Today.");
    await deps.store.setWorkItemState(b.id, id, "done");
    return { id, state: "done" };
  });
};
