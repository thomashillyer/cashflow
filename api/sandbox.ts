// Demo sandbox (#173, #153): on the public demo the synthetic samples are shared, so every visitor
// gets a private, in-memory copy-on-write copy of the sample they open. Reads and writes go to the
// copy; the real store is only ever read, once per (visitor, business), to seed it. Nothing is
// persisted: a restart or an eviction hands the visitor a fresh copy of the sample.

import type { Business, Store } from "./store";
import { MemoryStore } from "./store";

export const VISITOR_HEADER = "x-neri-visitor";
export const MAX_SANDBOXES = 500;
export const SANDBOX_TTL_MS = 2 * 60 * 60 * 1000;

// A random id from the app (crypto.randomUUID). Anything else is ignored, so the map can't be fed junk keys.
export const VISITOR_ID = /^[A-Za-z0-9_-]{16,64}$/;

type Entry = { store: MemoryStore; lastUsed: number };

export class SandboxStore {
  private readonly entries = new Map<string, Entry>();   // insertion order = least recently used first
  private readonly pending = new Map<string, Promise<MemoryStore>>();

  constructor(private readonly opts: { now?: () => number; max?: number; ttlMs?: number } = {}) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
  private key(visitorId: string, businessId: string): string {
    return `${visitorId}\u0000${businessId}`;
  }

  get size(): number {
    this.sweep();
    return this.entries.size;
  }

  private sweep(): void {
    const ttl = this.opts.ttlMs ?? SANDBOX_TTL_MS;
    const t = this.now();
    for (const [k, e] of this.entries) if (t - e.lastUsed > ttl) this.entries.delete(k);
  }

  // The visitor's copy of this business, created from the real store's current state on first use.
  async storeFor(visitorId: string, business: Business, real: Store): Promise<Store> {
    this.sweep();
    const k = this.key(visitorId, business.id);
    const hit = this.entries.get(k);
    if (hit) {
      hit.lastUsed = this.now();
      this.entries.delete(k);
      this.entries.set(k, hit);
      return hit.store;
    }
    let p = this.pending.get(k);
    if (!p) {
      p = copyFrom(real, business).finally(() => this.pending.delete(k));
      this.pending.set(k, p);
    }
    const store = await p;
    if (!this.entries.has(k)) {
      this.entries.set(k, { store, lastUsed: this.now() });
      const max = this.opts.max ?? MAX_SANDBOXES;
      while (this.entries.size > max) this.entries.delete(this.entries.keys().next().value as string);
    }
    return this.entries.get(k)?.store ?? store;
  }

  // Forget one visitor's copies (all businesses). Returns how many were dropped.
  reset(visitorId: string): number {
    let n = 0;
    for (const k of [...this.entries.keys()]) {
      if (k.startsWith(`${visitorId}\u0000`)) {
        this.entries.delete(k);
        n++;
      }
    }
    return n;
  }
}

async function copyFrom(real: Store, business: Business): Promise<MemoryStore> {
  const [{ records, storeRevision }, proposals, candidates, work, overrides] = await Promise.all([
    real.load(business.id), real.listProposals(business.id), real.listCandidates(business.id),
    real.loadWorkItems(business.id), real.loadOverrides(business.id),
  ]);
  const mem = new MemoryStore();
  await mem.seedBusiness({
    business, records, storeRevision, proposals, candidates, workItems: work.items,
    ...(work.inputsHash ? { inputsHash: work.inputsHash } : {}), overrides,
  });
  return mem;
}
