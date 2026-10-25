// camelCase records <-> snake_case rows. Only top-level keys are converted;
// nested jsonb (sourceRef, anchors, claim, ...) keeps the TypeScript shape.

import type { Records } from "../schema/records";

// Which table holds each Records collection.
export const TABLES = {
  parties: "parties",
  commitments: "commitments",
  events: "cash_events",
  signals: "signals",
  rules: "rules",
  settlements: "settlements",
  balances: "balance_snapshots",
  evidence: "evidence",
} as const satisfies Record<keyof Records, string>;

// Columns the database fills in; never written, stripped on read.
const DB_ONLY = new Set(["business_id", "created_at", "source_system", "source_record"]);

const toSnake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toCamel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

export type Row = Record<string, unknown>;

export function toRow<T extends object>(record: T, businessId: string): Row {
  const row: Row = { business_id: businessId };
  for (const [k, v] of Object.entries(record)) {
    if (v !== undefined) row[toSnake(k)] = v;
  }
  return row;
}

// Nulls become absent so optional fields read back as undefined, matching the types.
export function fromRow<T>(row: Row): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (DB_ONLY.has(k) || v === null) continue;
    out[toCamel(k)] = v;
  }
  return out as T;
}
