// Builds the engine fixtures: fixtures/{demo_runway,cascade_trade,pike_noodle}/{fixture.json,records.json,forecast_run.json}.
// Synthetic data only. Run: npx tsx scripts/make-engine-fixtures.ts
// forecast_run.json is the base-scenario run for lanes that start from a static forecast; engine/fixtures.test.ts
// fails if it drifts from the engine, so regenerate with this script after an intentional change.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BalanceSnapshot, CashEvent, Commitment, Party, Records, Settlement, Signal, SourceRef } from "../schema/records";
import type { Profile } from "../schema/profile";
import { forecast } from "../engine/forecast";
import { addDays, dowOf } from "../engine/dates";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const $ = (n: number) => Math.round(n * 100);
const write = (path: string, data: unknown) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), JSON.stringify(data, null, 2) + "\n");
};
const src = (system: string, record: string): SourceRef => ({ system, record });
const empty = (): Records => ({ parties: [], commitments: [], events: [], signals: [], rules: [], settlements: [], balances: [], evidence: [] });
const balance = (id: string, amount: number, asOf: string): BalanceSnapshot => ({ id, account: "operating", amount, currency: "USD", asOf, sourceRef: src("bank_csv", id) });

function party(id: string, name: string, kind: Party["kind"], tags: string[], notes: string[]): Party {
  return { id, name, kind, tags, notes };
}

// Paid receivables that teach the lag model: `lates[i]` days after due, one per month before `firstDue`.
function history(prefix: string, partyId: string, lates: number[], firstDue: string, amount: number): { commitments: Commitment[]; settlements: Settlement[] } {
  const commitments: Commitment[] = [];
  const settlements: Settlement[] = [];
  lates.forEach((late, i) => {
    const due = addDays(firstDue, i * 30);
    const id = `inv-${prefix}-${String(i + 1).padStart(2, "0")}`;
    commitments.push({ id, type: "invoice", direction: "in", reference: id.slice(4), partyId, amount, currency: "USD", anchors: { due }, status: "committed", settlement: "paid", outstanding: 0, sourceRef: src("zoho_books", id) });
    settlements.push({ id: `set-${id}`, commitmentId: id, partyId, amount, currency: "USD", date: addDays(due, late), sourceRef: src("bank_csv", `set-${id}`) });
  });
  return { commitments, settlements };
}

function invoice(ref: string, partyId: string, amount: number, due: string, invoiced: string): Commitment {
  return { id: `inv-${ref}`, type: "invoice", direction: "in", reference: ref, partyId, amount, currency: "USD", anchors: { invoice: invoiced, due }, status: "committed", outstanding: amount, settlement: "open", sourceRef: src("zoho_books", ref) };
}

// ---- demo_runway: the hand-calculated example from docs/HACKATHON_PLAN.md ----
function demoRunway(): { profile: Profile; records: Records } {
  const profile: Profile = {
    id: "demo_runway",
    displayName: "Demo runway (hand-calculated)",
    baseCurrency: "USD",
    horizonWeeks: 13,
    freeCashLookaheadWeeks: 6,
    defaultLagDays: 0,
    lagShrinkageK: 3,
    safetyLine: { kind: "fixed", amount: $(5000) },
    paymentPatterns: [],
    revenueModel: { kind: "deals" },
    recurring: [{ id: "rec-payroll", name: "Payroll", amount: $(18000), cadence: "monthly", anchor: "2026-11-01", endDate: "2026-11-01", category: "payroll", nonDeferrable: true }],
    thresholds: { signalAutoApplyConfidence: 0.85, rankFloor: 0.1, relationshipPenalty: {}, staleAfterHours: 72, stressDelayDays: 7 },
    actionLeadDays: { chase: 3, defer: 3 },
    signalSources: ["owner"],
    vocabulary: {},
  };
  const r = empty();
  r.parties = [party("party-supplier", "Demo Supplier", "supplier", [], []), party("party-customer", "Demo Customer", "customer", [], [])];
  r.balances = [balance("bal-demo", $(15000), "2026-10-25")];
  r.commitments = [
    { id: "bill-supplier", type: "bill", direction: "out", reference: "BILL-1", partyId: "party-supplier", amount: $(20000), currency: "USD", anchors: { due: "2026-10-29" }, status: "committed", outstanding: $(20000), settlement: "open", sourceRef: src("zoho_books", "BILL-1") },
    { id: "inv-INV-104", type: "invoice", direction: "in", reference: "INV-104", partyId: "party-customer", amount: $(12000), currency: "USD", anchors: { due: "2026-10-30" }, status: "committed", outstanding: $(12000), settlement: "open", sourceRef: src("zoho_books", "INV-104") },
    { id: "loan", type: "plan", direction: "in", category: "funding", funding: true, amount: $(40000), currency: "USD", anchors: { due: "2026-10-30" }, status: "likely", sourceRef: src("owner", "loan-note") },
  ];
  return { profile, records: r };
}

// ---- cascade_trade: Cascade Trade Co., importer (docs/design/10-testing-and-fixtures.md) ----
function cascadeTrade(): Records {
  const r = empty();
  r.parties = [
    party("party-evergreen-home", "Evergreen Home", "customer", ["slow_payer"], ["They always pay about two weeks late"]),
    party("party-puget-market", "Puget Market", "customer", ["reliable"], ["Usually pays a week early"]),
    party("party-harbor-hearth", "Harbor and Hearth", "customer", ["reliable"], ["On time, except holiday delays in December"]),
    party("party-shenzhen-ceramics", "Shenzhen Ceramics Co.", "supplier", ["preferred", "reliable"], ["Best quality; slow around Lunar New Year"]),
    party("party-jaipur-textiles", "Jaipur Textiles", "supplier", ["preferred"], ["Good partner; prices in rupees"]),
    party("party-ningbo-pack", "Ningbo Pack", "supplier", ["avoid"], ["Quality issues last year"]),
    party("party-cascade-customs", "Cascade Customs Brokerage", "supplier", [], ["Bills duties and landing costs when a container clears"]),
  ];
  // Opening cash is a fixed literal, chosen once by hand so the base low point sits near the design target (about -$6K in
  // the week of Dec 21). It is never tuned against the engine, so fixtures/expected/engine/cascade_trade.json stays independent.
  r.balances = [balance("bal-cascade", $(145000), "2026-11-16")];
  const eg = history("EG", "party-evergreen-home", [13, 15, 14, 14, 16, 13, 14, 15], "2026-02-10", $(20000));
  const pm = history("PM", "party-puget-market", [-7, -8, -6, -7, -7, -9, -6, -7], "2026-02-15", $(15000));
  const hh = history("HH", "party-harbor-hearth", [0, 1, 0, 0], "2026-07-20", $(10000));
  r.commitments = [...eg.commitments, ...pm.commitments, ...hh.commitments];
  r.settlements = [...eg.settlements, ...pm.settlements, ...hh.settlements];
  r.commitments.push(
    invoice("INV-1187", "party-evergreen-home", $(28000), "2026-12-10", "2026-11-10"),
    // Due on Christmas Eve, so it lands after New Year (holiday delay): applying the Evergreen signal then deepens the dip.
    invoice("INV-1203", "party-harbor-hearth", $(12000), "2026-12-24", "2026-11-24"),
    invoice("INV-1215", "party-puget-market", $(115000), "2027-01-12", "2026-12-13"),
    {
      id: "po-PO-2291", type: "purchase_order", direction: "out", reference: "PO-2291", partyId: "party-shenzhen-ceramics", amount: $(60000), currency: "USD",
      anchors: { order: "2026-11-20", ship: "2026-12-14" }, patternId: "supplier_30_70", status: "committed", settlement: "open", sourceRef: src("generic_file", "po-2291.pdf"),
    },
    {
      id: "po-PO-2302", type: "purchase_order", direction: "out", reference: "PO-2302", partyId: "party-jaipur-textiles", amount: 200_000_000, currency: "INR",
      anchors: { order: "2026-12-01", ship: "2026-12-15" }, patternId: "supplier_50_50", status: "committed", settlement: "open", sourceRef: src("generic_file", "po-2302.xlsx"),
    },
    {
      id: "bill-duties-2291", type: "bill", direction: "out", reference: "DUTIES-2291", partyId: "party-cascade-customs", category: "duties", amount: $(9000), currency: "USD",
      anchors: { due: "2026-12-18" }, status: "likely", settlement: "open", sourceRef: src("generic_file", "broker-inv-2291.pdf"),
    },
    {
      id: "rfq-harbor-spring", type: "sales_deal", direction: "in", reference: "RFQ-77", partyId: "party-harbor-hearth", amount: $(60000), currency: "USD",
      anchors: { order: "2026-12-05", delivery: "2027-02-01" }, status: "possible", probability: 0.4, sourceRef: src("email", "rfq-77"),
    },
  );
  // A proposed (not applied) signal: Evergreen says early January. It must not change the base forecast until applied.
  const sig: Signal = {
    id: "sig-evergreen-jan", channel: "email", receivedAt: "2026-11-16T09:00:00Z", partyId: "party-evergreen-home", commitmentId: "inv-INV-1187",
    claim: { kind: "date_change", newDate: "2027-01-08" }, confidence: 0.9, state: "proposed", sourceRef: { system: "email", record: "msg-evergreen-1", excerpt: { start: 0, end: 60, text: "We'll pay once our customer pays us, early January." } },
  };
  r.signals = [sig];
  r.rules = [];
  return r;
}

// ---- pike_noodle: Pike Street Noodle Bar (restaurant, daily card sales, no receivables) ----
function pikeNoodle(): Records {
  const r = empty();
  r.parties = [party("party-sound-produce", "Sound Produce", "supplier", [], []), party("party-noodle-wholesale", "Noodle Wholesale", "supplier", [], [])];
  r.balances = [balance("bal-pike", $(22000), "2026-11-16")];
  const weights = [0.6, 0.7, 0.8, 1.0, 1.5, 1.8, 1.4];
  const mean = weights.reduce((a, b) => a + b, 0) / 7;
  const events: CashEvent[] = [];
  for (let i = 28; i >= 1; i--) {
    const date = addDays("2026-11-16", -i);
    const noise = ((i * 37) % 11) - 5; // deterministic wobble, +-$50
    const amount = $((2200 * weights[dowOf(date)]!) / mean + noise * 10);
    events.push({ id: `bank-sales-${date}`, legIndex: 0, date, amount, currency: "USD", amountBase: amount, direction: "in", status: "actual", confidence: 1, basis: "card settlement", category: "sales", sourceRef: src("bank_csv", `sales-${date}`) });
  }
  r.events = events;
  // Weekly food and noodle bills on Thursdays through the horizon, net-7 from the invoice date.
  const bills: [string, string, string, number][] = [];
  for (let i = 0; i < 13; i++) {
    const due = addDays("2026-11-19", i * 7);
    const noodle = i % 3 === 1;
    bills.push([`${noodle ? "NW" : "FP"}-${4400 + i}`, noodle ? "party-noodle-wholesale" : "party-sound-produce", due, noodle ? 2600 : 3800 + (i % 4) * 100]);
  }
  r.commitments = bills.map(([ref, partyId, due, amt]) => ({
    id: `bill-${ref}`, type: "bill", direction: "out", reference: ref, partyId, amount: $(amt), currency: "USD", anchors: { invoice: addDays(due, -7), due }, status: "committed", outstanding: $(amt), settlement: "open", sourceRef: src("zoho_books", ref),
  }));
  return r;
}

const fixtures: { name: string; profile: string; asOf: string; fxRates: Record<string, number>; records: Records }[] = [
  { name: "cascade_trade", profile: "profiles/trading.json", asOf: "2026-11-16", fxRates: { INR: 0.012 }, records: cascadeTrade() },
  { name: "pike_noodle", profile: "profiles/restaurant.json", asOf: "2026-11-16", fxRates: {}, records: pikeNoodle() },
];
const demo = demoRunway();
write("fixtures/demo_runway/profile.json", demo.profile);
fixtures.unshift({ name: "demo_runway", profile: "fixtures/demo_runway/profile.json", asOf: "2026-10-25", fxRates: {}, records: demo.records });

for (const f of fixtures) {
  const profile = JSON.parse(readFileSync(join(root, f.profile), "utf8")) as Profile;
  const base = { id: "base", kind: "base" as const, overrides: [] };
  write(`fixtures/${f.name}/fixture.json`, { name: f.name, profile: f.profile, asOf: f.asOf, fxRates: f.fxRates });
  write(`fixtures/${f.name}/records.json`, f.records);
  const run = forecast(f.records, profile, base, f.asOf, f.fxRates);
  write(`fixtures/${f.name}/forecast_run.json`, run);
  console.log(f.name, "opening", run.openingBalance / 100, "low", run.lowPoint.date, run.lowPoint.amount / 100, "firstNeg", run.firstNegative, "warnings", run.warnings.length);
}
