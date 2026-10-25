// The owner's saved overrides (schema/records.ts `Override`): the base scenario's overrides, stored per
// business in `scenarios` (id 'base', kind 'base') apart from the imported records, so a re-import never
// erases them. Applied to every base and stress forecast, simulate and brief. Shape checks only; all
// money math stays in engine/. An override changes a forecast line; it never sends, pays or moves money.

import { z } from "zod";
import type { Override } from "../schema/records";

export const OVERRIDE_ID = /^[A-Za-z0-9_.:~-]{1,128}$/;
export const MAX_OVERRIDES = 500;

const isoDate = z.string().refine((v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;   // rejects 2026-02-30
}, "a real date as YYYY-MM-DD");

const change = z.object({
  date: isoDate.optional(),
  shiftDays: z.number().int().min(-3660).max(3660).refine((n) => n !== 0, "not zero").optional(),
  amount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),   // integer minor units
  exclude: z.literal(true).optional(),
}).strict().refine((c) => Object.keys(c).length > 0, "say what changes: date, shiftDays, amount or exclude")
  .refine((c) => !(c.date !== undefined && c.shiftDays !== undefined), "either a date or a shift, not both");

export const overrideSchema = z.object({
  id: z.string().regex(OVERRIDE_ID),
  target: z.object({
    commitmentId: z.string().min(1).max(200),
    legIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }).strict(),
  change,
  origin: z.enum(["rule", "signal", "lever", "owner"]),
  originId: z.string().min(1).max(200).optional(),
}).strict();

export type FieldIssue = { field: string; issue: string };

const issuesOf = (err: z.ZodError, prefix = ""): FieldIssue[] =>
  err.issues.map((i) => ({ field: `${prefix}${i.path.join(".")}` || "override", issue: i.message }));

// Checks one override. Returns the parsed value (unknown keys rejected, never stripped) or the issues.
export function checkOverride(raw: unknown): { ok: true; value: Override } | { ok: false; issues: FieldIssue[] } {
  const r = overrideSchema.safeParse(raw);
  return r.success ? { ok: true, value: r.data as Override } : { ok: false, issues: issuesOf(r.error) };
}

// What the stores call before writing: every override valid, ids unique, list bounded.
export function validateOverrides(list: unknown): Override[] {
  const fail = (issues: FieldIssue[]) =>
    Object.assign(new Error(`invalid overrides: ${issues.map((i) => `${i.field} ${i.issue}`).join("; ")}`), {
      status: 400, code: "INVALID_ARGUMENT", fieldIssues: issues,
    });
  if (!Array.isArray(list)) throw fail([{ field: "overrides", issue: "must be a list" }]);
  if (list.length > MAX_OVERRIDES) throw fail([{ field: "overrides", issue: `at most ${MAX_OVERRIDES}` }]);
  const out: Override[] = [];
  const seen = new Set<string>();
  list.forEach((raw, i) => {
    const r = checkOverride(raw);
    if (!r.ok) throw fail(r.issues.map((x) => ({ ...x, field: `overrides.${i}.${x.field}` })));
    if (seen.has(r.value.id)) throw fail([{ field: `overrides.${i}.id`, issue: "duplicate id" }]);
    seen.add(r.value.id);
    out.push(r.value);
  });
  return out;
}
