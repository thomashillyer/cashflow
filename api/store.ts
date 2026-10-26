// The API's view of the store. Two implementations: SupabaseStore (api/supabase-store.ts, service role,
// used only after the route has checked the caller may see the business) and MemoryStore (tests, and
// `NERI_STORE=memory` for a no-database local run). Nothing here sends, pays or moves money.

import type { ChangeProposal, IntakeCandidate } from "../schema/intake";
import type { Profile } from "../schema/profile";
import type { Evidence, Override, Records, Signal, WorkItem } from "../schema/records";
import type { IntakeNote } from "../ai/intake";
import { validateOverrides } from "./overrides";

// Owner-facing details that have no column of their own. Kept in businesses.profile under `account`
// so no migration is needed; the engine ignores the extra key.
export type Thought = {
  id: string;
  text: string;
  via: string;
  createdAt: string;
  state: "new" | "added" | "kept";
  reading: ThoughtReading;
};

export type ThoughtReading = {
  kind: "investment" | "new_business" | "collection" | "spend" | "note";
  direction: "in" | "out" | null;
  status: "likely" | "possible" | null;
  probability?: number;
  amount: number | null;
  date: string | null;
  partyId?: string;
  invoiceId?: string;
  /** Money the owner says has already arrived ("just made", "won"); shown as Received. */
  received?: boolean;
  missing: string[];
};

export type Account = {
  owner?: string;
  email?: string;
  timezone?: string;
  kind?: string;                       // starter profile the owner picked
  aliases?: string[];                  // other names the business goes by (intake matching)
  connections?: { id: string; name: string; state: "ok" | "waiting" | "error"; message?: string; syncedAt?: string }[];
  ownerUserId?: string;                // Supabase auth user id of the owner (membership fallback)
  asOf?: string;                       // fixed "today" for synthetic samples; real businesses use the clock
  fxRates?: Record<string, number>;
  syncedAt?: string;
  createdAt?: string;
  thoughts?: Thought[];                // owner notes (parked thoughts)
  intakeNotes?: IntakeNote[];          // import notes Review needs (e.g. "owner must confirm the date")
  sampleLoaded?: boolean;              // the fictional Cascade Trade sample was loaded by POST /samples/load
  maskNames?: boolean;                // mask party names and contact details in every API response (api/mask.ts)
  maskAliases?: Record<string, string>; // real name -> stage name; the rest get Customer A, Supplier A, ...
};

export type StoredProfile = Profile & { account?: Account };

export type Business = { id: string; name: string; isSynthetic: boolean; profile: StoredProfile };

export type IntakeWrite = {
  evidence: Evidence[];
  candidates: IntakeCandidate[];
  proposals: ChangeProposal[];
  signals: Signal[];
};

// One owner decision (confirm, dismiss, apply) written as a single atomic step. See Store.commitDecision.
export type DecisionWrite = {
  expectedRevision: number;            // the storeRevision this request loaded (or the client's expectedRevision)
  idempotencyKey: string;
  requestHash: string;                 // sha256 of route + target id + normalized body
  records: Partial<Records>;           // upserts (records and/or signals)
  proposals: ChangeProposal[];         // proposal state changes
  response: Record<string, unknown>;   // what the route returns, minus storeRevision
};

export type DecisionResult =
  | { kind: "ok"; storeRevision: number; response: Record<string, unknown> }
  | { kind: "replay"; response: Record<string, unknown> }   // same key and same hash: the stored response
  | { kind: "conflict" }                                    // same key, different hash
  | { kind: "stale"; storeRevision: number };               // revision moved

export type DecisionLookup = { kind: "replay"; response: Record<string, unknown> } | { kind: "conflict" } | null;

export interface Store {
  getBusiness(id: string): Promise<Business | null>;
  // Membership: the caller is a member of a private business (memberships table when it exists,
  // else the owner recorded at setup).
  isMember(businessId: string, userId: string): Promise<boolean>;
  // The first business this user belongs to, if any.
  findUserBusiness(userId: string): Promise<string | null>;
  createBusiness(b: { name: string; profile: StoredProfile; isSynthetic: boolean; ownerUserId?: string; id?: string }): Promise<string>;
  saveProfile(id: string, profile: StoredProfile, name?: string): Promise<void>;
  load(id: string): Promise<{ records: Records; storeRevision: number }>;
  // Idempotent upserts of whole records, then a revision bump. Returns the new revision.
  upsertRecords(id: string, records: Partial<Records>): Promise<number>;
  // Remove cash events by id (a corrected re-import replaces the events of the earlier read of the same file). Bumps the revision.
  deleteEvents(id: string, eventIds: string[]): Promise<number>;
  // "Code computes, the DB commits": the route computes the change, then this writes the records, the
  // proposal states and the stored response in one atomic step, only while the revision is still
  // `expectedRevision`, and bumps the revision. The idempotency key is checked first, so a replay
  // succeeds even though the revision has since moved.
  commitDecision(id: string, d: DecisionWrite): Promise<DecisionResult>;
  // Read-only look at a stored decision: replay / conflict, or null when the key is unused.
  lookupDecision(id: string, key: string, requestHash: string): Promise<DecisionLookup>;
  bumpRevision(id: string): Promise<number>;
  // Compare-and-bump: +1 only when the revision is still `expected`. Returns the new revision, or null
  // when another write got there first.
  bumpRevisionIf(id: string, expected: number): Promise<number | null>;
  // Import results for Review. Does not bump the revision.
  saveIntake(id: string, write: IntakeWrite): Promise<void>;
  listProposals(id: string): Promise<ChangeProposal[]>;
  saveProposals(id: string, proposals: ChangeProposal[]): Promise<void>;
  listCandidates(id: string): Promise<IntakeCandidate[]>;
  loadWorkItems(id: string): Promise<{ items: WorkItem[]; inputsHash?: string }>;
  saveWorkItems(id: string, items: WorkItem[], inputsHash: string): Promise<void>;
  setWorkItemState(id: string, itemId: string, state: WorkItem["state"]): Promise<void>;
  // The owner's saved overrides: the base scenario (scenarios row id 'base'), kept apart from the
  // imported records so upsertRecords / re-imports never touch them. [] when none are saved.
  loadOverrides(id: string): Promise<Override[]>;
  // Replaces the whole list. Validates the shape (throws status 400 INVALID_ARGUMENT); ids are unique.
  // Does not bump the revision; the caller does.
  saveOverrides(id: string, overrides: Override[]): Promise<void>;
  // Demo reset: delete every record of a synthetic business, then write these.
  resetBusiness(b: { id: string; name: string; profile: StoredProfile }, records: Records): Promise<void>;
  // Private-business safe: delete every record, proposal, candidate, work item and override; keep the business
  // row, name, profile and membership. Bumps the revision.
  clearRecords(id: string): Promise<number>;
}

const empty = (): Records => ({
  parties: [], commitments: [], events: [], signals: [], rules: [], settlements: [], balances: [], evidence: [],
});

const KEYS = ["parties", "commitments", "events", "signals", "rules", "settlements", "balances", "evidence"] as const;

function upsertById<T extends { id: string }>(list: T[], next: T[]): T[] {
  const byId = new Map(list.map((x) => [x.id, x]));
  for (const n of next) byId.set(n.id, n);
  return [...byId.values()];
}

type MemBiz = Business & {
  records: Records; storeRevision: number; members: Set<string>;
  proposals: Map<string, ChangeProposal>; candidates: Map<string, IntakeCandidate>;
  workItems: Map<string, WorkItem>; workItemsHash?: string; overrides: Override[];
  decisions: Map<string, { hash: string; response: Record<string, unknown> }>;
};

// In-memory store with the same semantics as the Supabase one. Used by the tests and by
// `NERI_STORE=memory npm run dev` (seeded from the fixtures, lost on restart).
export class MemoryStore implements Store {
  private readonly biz = new Map<string, MemBiz>();
  private seq = 0;

  private need(id: string): MemBiz {
    const b = this.biz.get(id);
    if (!b) throw Object.assign(new Error("NOT_FOUND"), { status: 404, code: "NOT_FOUND" });
    return b;
  }

  addMember(businessId: string, userId: string): void {
    this.need(businessId).members.add(userId);
  }

  // Copies a whole business in (the demo sandbox seeds itself from the real store this way).
  async seedBusiness(s: {
    business: Business; records: Records; storeRevision: number; proposals: ChangeProposal[]; candidates: IntakeCandidate[];
    workItems: WorkItem[]; inputsHash?: string; overrides: Override[];
  }): Promise<void> {
    const c = structuredClone(s);
    this.biz.set(c.business.id, {
      ...c.business, records: c.records, storeRevision: c.storeRevision, members: new Set(),
      proposals: new Map(c.proposals.map((p) => [p.id, p])), candidates: new Map(c.candidates.map((x) => [x.id, x])),
      workItems: new Map(c.workItems.map((w) => [w.id, w])), ...(c.inputsHash ? { workItemsHash: c.inputsHash } : {}),
      overrides: c.overrides, decisions: new Map(),
    });
  }

  async getBusiness(id: string): Promise<Business | null> {
    const b = this.biz.get(id);
    return b ? { id: b.id, name: b.name, isSynthetic: b.isSynthetic, profile: structuredClone(b.profile) } : null;
  }
  async isMember(businessId: string, userId: string): Promise<boolean> {
    const b = this.biz.get(businessId);
    return !!b && (b.members.has(userId) || b.profile.account?.ownerUserId === userId);
  }
  async findUserBusiness(userId: string): Promise<string | null> {
    for (const b of this.biz.values()) if (!b.isSynthetic && (b.members.has(userId) || b.profile.account?.ownerUserId === userId)) return b.id;
    return null;
  }
  async createBusiness(b: { name: string; profile: StoredProfile; isSynthetic: boolean; ownerUserId?: string; id?: string }): Promise<string> {
    const id = b.id ?? `biz-mem-${++this.seq}`;
    this.biz.set(id, {
      id, name: b.name, isSynthetic: b.isSynthetic, profile: structuredClone(b.profile), records: empty(), storeRevision: 0,
      members: new Set(b.ownerUserId ? [b.ownerUserId] : []), proposals: new Map(), candidates: new Map(), workItems: new Map(),
      overrides: [], decisions: new Map(),
    });
    return id;
  }
  async saveProfile(id: string, profile: StoredProfile, name?: string): Promise<void> {
    const b = this.need(id);
    b.profile = structuredClone(profile);
    if (name) b.name = name;
  }
  async load(id: string) {
    const b = this.need(id);
    return { records: structuredClone(b.records), storeRevision: b.storeRevision };
  }
  async upsertRecords(id: string, records: Partial<Records>): Promise<number> {
    const b = this.need(id);
    this.writeRecords(b, records);
    return ++b.storeRevision;
  }
  async deleteEvents(id: string, eventIds: string[]): Promise<number> {
    const b = this.need(id);
    const drop = new Set(eventIds);
    b.records.events = b.records.events.filter((e) => !drop.has(e.id));
    return ++b.storeRevision;
  }
  private writeRecords(b: MemBiz, records: Partial<Records>): void {
    for (const k of KEYS) {
      const next = records[k];
      if (next?.length) (b.records[k] as { id: string }[]) = upsertById(b.records[k] as { id: string }[], structuredClone(next));
    }
  }
  // No await between the checks and the writes, so on the event loop this is atomic: two concurrent
  // requests cannot both pass the revision check.
  async commitDecision(id: string, d: DecisionWrite): Promise<DecisionResult> {
    const b = this.need(id);
    const prior = b.decisions.get(d.idempotencyKey);
    if (prior) return prior.hash === d.requestHash ? { kind: "replay", response: structuredClone(prior.response) } : { kind: "conflict" };
    if (b.storeRevision !== d.expectedRevision) return { kind: "stale", storeRevision: b.storeRevision };
    this.writeRecords(b, d.records);
    for (const p of d.proposals) b.proposals.set(p.id, structuredClone(p));
    const storeRevision = ++b.storeRevision;
    const response = { ...structuredClone(d.response), storeRevision };
    b.decisions.set(d.idempotencyKey, { hash: d.requestHash, response: structuredClone(response) });
    return { kind: "ok", storeRevision, response };
  }
  async lookupDecision(id: string, key: string, requestHash: string): Promise<DecisionLookup> {
    const prior = this.need(id).decisions.get(key);
    if (!prior) return null;
    return prior.hash === requestHash ? { kind: "replay", response: structuredClone(prior.response) } : { kind: "conflict" };
  }
  async bumpRevision(id: string): Promise<number> {
    return ++this.need(id).storeRevision;
  }
  async bumpRevisionIf(id: string, expected: number): Promise<number | null> {
    const b = this.need(id);
    return b.storeRevision === expected ? ++b.storeRevision : null;
  }
  async saveIntake(id: string, w: IntakeWrite): Promise<void> {
    const b = this.need(id);
    b.records.evidence = upsertById(b.records.evidence, structuredClone(w.evidence));
    b.records.signals = upsertById(b.records.signals, structuredClone(w.signals));
    for (const c of w.candidates) b.candidates.set(c.id, structuredClone(c));
    for (const p of w.proposals) b.proposals.set(p.id, structuredClone(p));
  }
  async listProposals(id: string) {
    return structuredClone([...this.need(id).proposals.values()]);
  }
  async saveProposals(id: string, proposals: ChangeProposal[]) {
    const b = this.need(id);
    for (const p of proposals) b.proposals.set(p.id, structuredClone(p));
  }
  async listCandidates(id: string) {
    return structuredClone([...this.need(id).candidates.values()]);
  }
  async loadWorkItems(id: string) {
    const b = this.need(id);
    return { items: structuredClone([...b.workItems.values()]), ...(b.workItemsHash ? { inputsHash: b.workItemsHash } : {}) };
  }
  async saveWorkItems(id: string, items: WorkItem[], inputsHash: string) {
    const b = this.need(id);
    const next = new Map<string, WorkItem>();
    for (const [k, v] of b.workItems) if (v.state !== "open") next.set(k, v);
    for (const i of items) next.set(i.id, { ...structuredClone(i), state: b.workItems.get(i.id)?.state ?? "open" });
    b.workItems = next;
    b.workItemsHash = inputsHash;
  }
  async setWorkItemState(id: string, itemId: string, state: WorkItem["state"]) {
    const w = this.need(id).workItems.get(itemId);
    if (!w) throw Object.assign(new Error("NOT_FOUND"), { status: 404, code: "NOT_FOUND" });
    w.state = state;
  }
  async loadOverrides(id: string) {
    return structuredClone(this.need(id).overrides);
  }
  async saveOverrides(id: string, overrides: Override[]) {
    const b = this.need(id);
    b.overrides = structuredClone(validateOverrides(overrides));
  }
  async clearRecords(id: string) {
    const b = this.need(id);
    b.records = empty(); b.proposals = new Map(); b.candidates = new Map(); b.workItems = new Map(); b.workItemsHash = undefined;
    b.overrides = []; b.decisions = new Map();
    return ++b.storeRevision;
  }
  async resetBusiness(b: { id: string; name: string; profile: StoredProfile }, records: Records) {
    this.biz.delete(b.id);
    await this.createBusiness({ id: b.id, name: b.name, profile: b.profile, isSynthetic: true });
    await this.upsertRecords(b.id, records);
  }
}
