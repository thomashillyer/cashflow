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

// Columns the database fills in; never written, stripped on read. Per table: created_at is
// database bookkeeping everywhere except change_proposals, where it is ChangeProposal.createdAt.
const DB_ONLY_DEFAULT: ReadonlySet<string> = new Set(["business_id", "created_at", "source_system", "source_record"]);
const DB_ONLY: Record<string, ReadonlySet<string>> = {
  change_proposals: new Set(["business_id", "source_system", "source_record"]),
};

// Top-level timestamptz columns. PostgREST returns them as "2026-11-27T00:42:10.123456+00:00";
// the types promise ISO 8601 UTC, so normalize on read.
const TIMESTAMP_KEYS = new Set(["receivedAt", "createdAt", "decidedAt", "updatedAt", "fetchedAt"]);

function normalizeTimestamp(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? v : t.toISOString();
}

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
// Pass the table name so per-table DB-only columns are stripped correctly.
export function fromRow<T>(row: Row, table?: string): T {
  const dbOnly = (table && DB_ONLY[table]) || DB_ONLY_DEFAULT;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (dbOnly.has(k) || v === null) continue;
    const key = toCamel(k);
    out[key] = TIMESTAMP_KEYS.has(key) ? normalizeTimestamp(v) : v;
  }
  return out as T;
}
