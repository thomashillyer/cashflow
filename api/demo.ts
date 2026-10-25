// The synthetic sample businesses: fixture records plus the profile they run on. Used by
// scripts/seed-demo.ts and POST /demo/reset. Synthetic data only.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Records } from "../schema/records";
import type { StoredProfile } from "./store";

const ROOT = join(import.meta.dirname, "..");

// Display details of the samples; everything else comes from fixtures/<id>/.
export const SAMPLES = [
  { id: "cascade_trade", name: "Cascade Trade Co.", aliases: ["Cascade Trade"], owner: "Dana", timezone: "America/Los_Angeles" },
  { id: "pike_noodle", name: "Pike Street Noodle Bar", aliases: ["Pike Noodle"], owner: "Mai", timezone: "America/Los_Angeles" },
] as const;

export type Sample = { id: string; name: string; profile: StoredProfile; records: Records };

const read = <T>(path: string): T => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as T;

export function loadSample(id: string): Sample | null {
  const meta = SAMPLES.find((s) => s.id === id);
  if (!meta) return null;
  const fx = read<{ profile: string; asOf: string; fxRates?: Record<string, number> }>(`fixtures/${id}/fixture.json`);
  const raw = read<Partial<Records>>(`fixtures/${id}/records.json`);
  const records: Records = {
    parties: raw.parties ?? [], commitments: raw.commitments ?? [], events: raw.events ?? [], signals: raw.signals ?? [],
    rules: raw.rules ?? [], settlements: raw.settlements ?? [], balances: raw.balances ?? [], evidence: raw.evidence ?? [],
  };
  const profile: StoredProfile = {
    ...read<StoredProfile>(fx.profile),
    account: {
      owner: meta.owner, timezone: meta.timezone, aliases: [...meta.aliases], asOf: fx.asOf, fxRates: fx.fxRates ?? {},
      syncedAt: `${fx.asOf}T14:00:00Z`, thoughts: [], intakeNotes: [],
    },
  };
  return { id, name: meta.name, profile, records };
}

const DAY = 86_400_000;
const dayNum = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY;

// Shift every ISO date and timestamp in the sample by whole days, so a private business sees the sample
// around its own today. Order and gaps between dates are unchanged.
export function shiftSample(sample: Sample, today: string): Sample {
  const days = Math.round(dayNum(today) - dayNum(sample.profile.account!.asOf!));
  if (!days) return structuredClone(sample);
  const shift = (d: string) => new Date((dayNum(d) + days) * DAY).toISOString().slice(0, 10);
  const re = /\b(\d{4}-\d{2}-\d{2})(?=$|[T"\s,.)])/g;
  const records = JSON.parse(JSON.stringify(sample.records).replace(re, (m, d: string) => (Number.isNaN(Date.parse(d)) ? m : shift(d)))) as Records;
  return { ...sample, records };
}

export const loadSamples =(): Sample[] => SAMPLES.map((s) => loadSample(s.id)!);
