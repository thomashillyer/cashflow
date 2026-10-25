// Payment-lag model. Docs: docs/design/05-forecast-engine.md "Payment-lag model".
// lag_p = (n * median + k * defaultLag) / (n + k); confidence = n/(n+k) * 1/(1 + iqr/14).

import type { Records, Rule } from "../schema/records";
import type { Profile } from "../schema/profile";
import { diffDays } from "./dates";

export type Lag = {
  days: number; // whole calendar days, rounded to nearest (half rounds up)
  confidence: number;
  n: number;
  basis: string; // human-readable suffix, e.g. "+ 22 days (median of last 8 payments)"
  ruleId?: string;
};

const MAX_SAMPLES = 12;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

// Days late (paid - due, signed) for the party's last fully paid receivables.
export function lagSamples(records: Records, partyId: string): number[] {
  const samples: { paid: string; late: number }[] = [];
  for (const c of records.commitments) {
    if (c.partyId !== partyId || c.settlement !== "paid") continue;
    if ((c.direction ?? (c.type === "bill" ? "out" : "in")) !== "in") continue;
    const due = c.anchors.due;
    if (!due) continue;
    const paidOn = records.settlements
      .filter((s) => s.commitmentId === c.id)
      .map((s) => s.date)
      .sort()
      .at(-1);
    if (!paidOn) continue;
    samples.push({ paid: paidOn, late: diffDays(paidOn, due) });
  }
  samples.sort((a, b) => (a.paid < b.paid ? -1 : a.paid > b.paid ? 1 : 0));
  return samples.slice(-MAX_SAMPLES).map((s) => s.late);
}

export function confirmedLagRule(rules: Rule[], partyId: string | undefined): Rule | undefined {
  return rules.find(
    (r) =>
      r.kind === "lag_offset" &&
      r.state === "confirmed" &&
      (("all" in r.scope && r.scope.all) || ("partyId" in r.scope && r.scope.partyId === partyId)) &&
      typeof r.params.offsetDays === "number",
  );
}

export function partyLag(records: Records, profile: Profile, partyId?: string): Lag {
  const rule = confirmedLagRule(records.rules, partyId);
  if (rule) {
    const days = Math.round(rule.params.offsetDays as number);
    return { days, confidence: 1, n: 0, basis: `+ ${days} days (owner rule: "${rule.fromNote}")`, ruleId: rule.id };
  }
  const k = profile.lagShrinkageK;
  const samples = partyId ? lagSamples(records, partyId) : [];
  const n = samples.length;
  if (n === 0) {
    const days = Math.round(profile.defaultLagDays);
    return { days, confidence: 0.1, n, basis: `+ ${days} days (profile default; no payment history)` };
  }
  const med = median(samples);
  const sorted = [...samples].sort((a, b) => a - b);
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  const lag = (n * med + k * profile.defaultLagDays) / (n + k);
  const days = Math.floor(lag + 0.5);
  const confidence = (n / (n + k)) * (1 / (1 + iqr / 14));
  return {
    days,
    confidence,
    n,
    basis: `${days >= 0 ? "+" : "-"} ${Math.abs(days)} days (median ${med} of last ${n} payment${n === 1 ? "" : "s"}, shrunk toward default ${profile.defaultLagDays} with k=${k}; rounded to nearest day)`,
  };
}
