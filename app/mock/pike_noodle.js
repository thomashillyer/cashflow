// Preview fixture: Pike Street Noodle Bar (fictional Seattle restaurant).
// Daily card sales settle in 2 days with a weekday pattern; weekly payroll; no receivables at all.
// Same record shapes and the same preview engine as Cascade Trade — only the data and profile differ.

import { addDays, parseDate } from "../ui/format.js";

const usd = (dollars) => Math.round(dollars * 100);
const AS_OF = "2026-10-25";

export const profile = {
  id: "restaurant",
  displayName: "Restaurant and retail",
  baseCurrency: "USD",
  horizonWeeks: 13,
  freeCashLookaheadWeeks: 6,
  defaultLagDays: 0,
  lagShrinkageK: 3,
  safetyLine: { kind: "fixed", amount: usd(25000) },
  thresholds: {
    idleBalanceOver: { amount: usd(20000), minWeeks: 2 },
    signalAutoApplyConfidence: 1.01,
    rankFloor: usd(100),
    relationshipPenalty: { preferred: 0.5 },
  },
  signalSources: ["email", "owner"],
  vocabulary: { deal: "event booking", quote: "catering quote", purchase: "order" },
};

export const business = {
  id: "pike_noodle",
  name: "Pike Street Noodle Bar",
  owner: "Min",
  asOf: AS_OF,
  synthetic: true,
  timezone: "America/Los_Angeles",
  sources: [
    { id: "bank_csv", label: "Bank", state: "ok", syncedAt: "2026-10-25T05:00:00Z", detail: "Statement to Oct 24" },
    { id: "pos_csv", label: "Sales export", state: "ok", syncedAt: "2026-10-25T13:00:00Z", detail: "Card sales, last 12 months" },
    { id: "m365", label: "Microsoft 365", state: "ok", syncedAt: "2026-10-25T15:00:00Z", detail: "Nothing to review" },
  ],
};

export const parties = [
  { id: "card-processor", name: "Card sales (Square)", kind: "customer", tags: [], notes: [] },
  { id: "pacific-produce", name: "Pacific Produce", kind: "supplier", tags: [], notes: ["They'll hold an invoice a week if we ask"] },
  { id: "salish-seafood", name: "Salish Seafood", kind: "supplier", tags: ["preferred"], notes: ["Pay on time — hard to replace"] },
  { id: "payroll", name: "Payroll", kind: "employee", tags: [], notes: [] },
  { id: "landlord", name: "Pike Place Properties", kind: "other", tags: [], notes: [] },
  { id: "wa-dor", name: "WA sales tax", kind: "other", tags: [], notes: [] },
  { id: "equipment", name: "Walk-in cooler replacement", kind: "other", tags: [], notes: [] },
];

// Average daily card sales by weekday (Mon..Sun), from the POS export.
const weekday = [2600, 2800, 3100, 3600, 5600, 6400, 4700];

function seasonal(iso) {
  const d = parseDate(iso);
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  if (m === 11 && day >= 24 && day <= 26) return 0.35; // holidays
  if (m === 11) return 1.12; // December parties
  if (m === 0) return 0.72; // slow January
  return 1;
}

const commitments = [];
for (let d = AS_OF; d < addDays(AS_OF, 91); d = addDays(d, 1)) {
  const dow = (parseDate(d).getUTCDay() + 6) % 7;
  const dollars = Math.round(weekday[dow] * seasonal(d));
  const settle = addDays(d, 2);
  commitments.push({
    id: `sales-${d}`, type: "recurring", partyId: "card-processor", amount: usd(dollars), currency: "USD", anchors: { invoice: d }, status: "likely",
    sourceRef: { system: "generic_file", record: `POS weekday average, ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][dow]}` },
    legs: [{ legIndex: 0, date: settle, amount: usd(dollars), direction: "in", status: "likely", confidence: 0.78, basis: `expected card sales for ${d} (weekday average × season), settles in 2 days` }],
  });
}

// Weekly payroll (Fridays), produce and seafood bills (net-7), rent, monthly sales tax.
for (let d = "2026-10-30"; d < addDays(AS_OF, 91); d = addDays(d, 7)) {
  commitments.push({ id: `rec-payroll-${d}`, type: "recurring", partyId: "payroll", amount: usd(13600), currency: "USD", anchors: { due: d }, status: "committed",
    sourceRef: { system: "bank_csv", record: "recurring: weekly payroll" },
    legs: [{ legIndex: 0, date: d, amount: usd(13600), direction: "out", status: "committed", confidence: 0.99, basis: "weekly payroll, every Friday" }] });
  const prod = addDays(d, -2);
  commitments.push({ id: `bill-produce-${prod}`, type: "bill", partyId: "pacific-produce", amount: usd(5400), currency: "USD", anchors: { due: prod }, status: "committed", settlement: "open",
    sourceRef: { system: "email", record: `Pacific Produce statement, week of ${prod}` },
    legs: [{ legIndex: 0, date: prod, amount: usd(5400), direction: "out", status: "committed", confidence: 0.95, basis: "weekly produce invoice, net-7" }] });
  const sea = addDays(d, -1);
  commitments.push({ id: `bill-seafood-${sea}`, type: "bill", partyId: "salish-seafood", amount: usd(4300), currency: "USD", anchors: { due: sea }, status: "committed", settlement: "open",
    sourceRef: { system: "email", record: `Salish Seafood invoice, week of ${sea}` },
    legs: [{ legIndex: 0, date: sea, amount: usd(4300), direction: "out", status: "committed", confidence: 0.95, basis: "weekly seafood invoice, net-7" }] });
}
for (const d of ["2026-11-01", "2026-12-01", "2027-01-01"]) {
  commitments.push({ id: `rec-rent-${d}`, type: "recurring", partyId: "landlord", amount: usd(9800), currency: "USD", anchors: { due: d }, status: "committed",
    sourceRef: { system: "bank_csv", record: "recurring: rent on the 1st" },
    legs: [{ legIndex: 0, date: d, amount: usd(9800), direction: "out", status: "committed", confidence: 0.99, basis: "rent on the 1st" }] });
}
for (const [d, amt] of [["2026-11-25", 6900], ["2026-12-26", 7100], ["2027-01-25", 8400]]) {
  commitments.push({ id: `rec-salestax-${d}`, type: "recurring", partyId: "wa-dor", amount: usd(amt), currency: "USD", anchors: { due: d }, status: "committed",
    sourceRef: { system: "bank_csv", record: "recurring: monthly sales tax on the 25th" },
    legs: [{ legIndex: 0, date: d, amount: usd(amt), direction: "out", status: "committed", confidence: 0.92, basis: "monthly sales tax, based on last month's sales" }] });
}
commitments.push({ id: "plan-cooler", type: "plan", partyId: "equipment", amount: usd(18500), currency: "USD", anchors: { order: "2027-01-12" }, status: "likely",
  sourceRef: { system: "owner", record: "Owner note: replace the walk-in cooler in mid-January" },
  legs: [{ legIndex: 0, date: "2027-01-12", amount: usd(18500), direction: "out", status: "likely", confidence: 0.9, basis: "owner plan: walk-in cooler replacement, mid-January" }] });
commitments.push({ id: "booking-holiday-party", type: "sales_deal", partyId: "card-processor", amount: usd(6400), currency: "USD", anchors: { order: "2026-12-12" }, status: "possible", probability: 0.5,
  sourceRef: { system: "email", record: "Catering quote: Amazon team holiday party" },
  legs: [{ legIndex: 0, date: "2026-12-12", amount: usd(6400), direction: "in", status: "possible", confidence: 0.5, basis: "catering quote, 50% chance" }] });

export { commitments };

export const rules = [
  { id: "rule-produce-flex", scope: { partyId: "pacific-produce" }, kind: "flexibility", params: { extraDays: 7 }, fromNote: "They'll hold an invoice a week if we ask", state: "confirmed" },
];

export const balances = [
  { id: "bal-2026-10-25", account: "Business checking ••2207", amount: usd(41000), currency: "USD", asOf: AS_OF, sourceRef: { system: "bank_csv", record: "statement line 2026-10-24 closing balance" } },
];

export const messages = [];
export const signals = [];

export const thoughts = [
  { id: "th-seed-1", via: "voice", createdAt: "2026-10-25T05:30:00Z", text: "Fremont brewery wants a catering quote for December, maybe $9K" },
  { id: "th-seed-2", via: "typed", createdAt: "2026-10-24T06:10:00Z", text: "Need to fix the hood vent before inspection, about $4,500, early December" },
];
