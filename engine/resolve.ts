// Event -> source record. Not every CashEvent.commitmentId names a row in records.commitments; the engine also emits
// synthetic ids, and this resolver is the one place that knows them:
//   - "<commitmentId>"            a stored commitment
//   - "sig-<signalId>"            a commitment created by an applied new_commitment/plan signal
//   - "<profile recurring id>"    a profile.recurring item (sourceRef system "profile")
//   - "daily-sales"               the profile's daily-sales revenue model (sourceRef system "profile"), built from actual sales
//   - "<parentId>~<patternId>"    a sales deal's virtual linked cost (profile payment pattern linkedCosts)
//   - any id, or absent           an actual bank line is its own source (checked first); a linked commitment rides along
// Pure. Docs: docs/design/05-forecast-engine.md.

import type { CashEvent, Commitment, Records } from "../schema/records";
import type { Profile } from "../schema/profile";
import { addDays } from "./dates";
import { DAILY_SALES_ID, SALES_HISTORY_DAYS } from "./expand";

export type RecurringItem = Profile["recurring"][number];

export type EventSource =
  | { kind: "commitment"; commitment: Commitment }
  | { kind: "profile_recurring"; item: RecurringItem }
  | { kind: "daily_sales"; historyEventIds: string[] }
  | { kind: "linked_cost"; parentCommitment: Commitment; patternId: string }
  | { kind: "actual"; event: CashEvent; commitment?: Commitment }
  | { kind: "unresolved" };

export { DAILY_SALES_ID };

function findCommitment(id: string, records: Records): Commitment | undefined {
  const stored = records.commitments.find((c) => c.id === id);
  if (stored) return stored;
  if (!id.startsWith("sig-")) return undefined;
  const s = records.signals.find((x) => `sig-${x.id}` === id && x.state === "applied");
  if (!s || (s.claim.kind !== "new_commitment" && s.claim.kind !== "plan")) return undefined;
  return { ...s.claim.draft, id, sourceRef: s.claim.draft.sourceRef ?? s.sourceRef };
}

// `asOf` is the run's as-of date; daily-sales history is the same window the engine averaged (SALES_HISTORY_DAYS before it).
export function resolveEventSource(event: CashEvent, records: Records, profile: Profile, asOf: string): EventSource {
  const id = event.commitmentId;
  // A bank line is the source of its own money, even when it settles an invoice (partial payment).
  const stored = event.status === "actual" ? records.events.find((e) => e.id === event.id) : undefined;
  if (stored) {
    const commitment = id === undefined ? undefined : findCommitment(id, records);
    return { kind: "actual", event: stored, ...(commitment ? { commitment } : {}) };
  }
  if (id === undefined) return { kind: "unresolved" };

  const c = findCommitment(id, records);
  if (c) return { kind: "commitment", commitment: c };

  const cut = id.lastIndexOf("~");
  if (cut > 0) {
    const parent = findCommitment(id.slice(0, cut), records);
    const patternId = id.slice(cut + 1);
    if (parent && profile.paymentPatterns.some((p) => p.id === patternId)) return { kind: "linked_cost", parentCommitment: parent, patternId };
  }

  if (event.sourceRef.system === "profile") {
    const item = profile.recurring.find((r) => r.id === id);
    if (item) return { kind: "profile_recurring", item };
    if (id === DAILY_SALES_ID && profile.revenueModel.kind === "dailySales") {
      const from = addDays(asOf, -SALES_HISTORY_DAYS);
      const historyEventIds = records.events
        .filter((e) => e.direction === "in" && e.category === "sales" && e.date >= from && e.date < asOf)
        .map((e) => e.id);
      return { kind: "daily_sales", historyEventIds };
    }
  }
  return { kind: "unresolved" };
}
