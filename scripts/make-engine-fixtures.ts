// Builds the engine fixtures: fixtures/{demo_runway,cascade_trade,pike_noodle}/{fixture.json,records.json,forecast_run.json}.
// Synthetic data only. Run: npx tsx scripts/make-engine-fixtures.ts
// forecast_run.json is the base-scenario run for lanes that start from a static forecast; engine/fixtures.test.ts
// fails if it drifts from the engine, so regenerate with this script after an intentional change.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BalanceSnapshot, CashEvent, Commitment, Evidence, Party, Records, Settlement, Signal, SourceRef } from "../schema/records";
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
// One Cascade Trade Co. across lanes (#50, #74): this generator is the single source of truth for both the engine
// fixture (records.json) and the intake fixture (intake/base_records.json, see cascadeIntakeBase below), so ingesting
// the intake files onto records.json links to what is already there instead of conflicting or counting twice.
// Party email domains, INV-1187, INV-104, bill SC-0042 and INV-1203 are the records the intake files
// (fixtures/cascade_trade/intake/, cases in fixtures/expected/intake/cases.json) describe.
function cascadeParties(): Party[] {
  const p = (id: string, name: string, kind: Party["kind"], tags: string[], notes: string[], domain?: string): Party =>
    ({ ...party(id, name, kind, tags, notes), ...(domain ? { contacts: { emailDomains: [domain] } } : {}) });
  return [
    p("party-evergreen-home", "Evergreen Home", "customer", ["slow_payer"], ["They always pay about two weeks late"], "evergreenhome.example"),
    p("party-puget-market", "Puget Market", "customer", ["reliable"], ["Usually pays a week early"], "pugetmarket.example"),
    p("party-harbor-hearth", "Harbor and Hearth", "customer", ["reliable"], ["On time, except holiday delays in December"], "harborandhearth.example"),
    p("party-shenzhen-ceramics", "Shenzhen Ceramics Co.", "supplier", ["preferred", "reliable"], ["Best quality; slow around Lunar New Year"], "szceramics.example"),
    p("party-jaipur-textiles", "Jaipur Textiles", "supplier", ["preferred"], ["Good partner; prices in rupees"]),
    p("party-ningbo-pack", "Ningbo Pack", "supplier", ["avoid"], ["Quality issues last year"], "ningbopack.example"),
    p("party-cascade-customs", "Cascade Customs Brokerage", "supplier", [], ["Bills duties and landing costs when a container clears"]),
  ];
}

// The records the intake files point at, as the books hold them. INV-104 is shown here as it stood when the owner
// wrote about it (Oct 25, still open); cascadeTrade() settles it on Nov 3, the date the owner was told.
function cascadeIntakeTargets() {
  const inv1187: Commitment = { ...invoice("INV-1187", "party-evergreen-home", $(28000), "2026-12-10", "2026-11-10"), evidenceIds: ["ev-zoho-INV-1187"] };
  const inv104: Commitment = { ...invoice("INV-104", "party-puget-market", $(12000), "2026-10-30", "2026-09-30"), evidenceIds: [] };
  // Shenzhen's bill for the 70% balance of PO-2291 (issued with the pro forma, due at shipment). PO-2291 links to it,
  // so the engine replaces the PO's ship leg with this bill: the $42K is counted once.
  const billSC0042: Commitment = {
    id: "bill-SC-0042", type: "bill", direction: "out", reference: "0042", partyId: "party-shenzhen-ceramics", amount: $(42000), currency: "USD",
    anchors: { invoice: "2026-11-14", due: "2026-12-14" }, status: "committed", outstanding: $(42000), settlement: "open", sourceRef: src("zoho_books", "0042"), evidenceIds: [],
  };
  const evidence: Evidence[] = [
    { id: "ev-zoho-INV-1187", channel: "zoho_books", format: "api", receivedAt: "2026-11-10T18:00:00Z", extraction: "ok", sourceRef: src("zoho_books", "INV-1187") },
  ];
  return { inv1187, inv104, billSC0042, evidence };
}

// fixtures/cascade_trade/intake/base_records.json: the slice of the books the intake cases start from. It holds only
// what the intake files are matched against. INV-1203 is in records.json but not here: the po-partial-invoice case
// creates it from email-harbor-inv1203.eml after creating PO HH-PO-552 from harbor-po-552.pdf.
function cascadeIntakeBase() {
  const t = cascadeIntakeTargets();
  const ids = ["party-evergreen-home", "party-puget-market", "party-harbor-hearth", "party-shenzhen-ceramics", "party-ningbo-pack"];
  return {
    _comment: "Generated by scripts/make-engine-fixtures.ts from the same records as fixtures/cascade_trade/records.json (synthetic): the parties and commitments the intake cases are matched against, before intake. INV-104 is open here (as of the owner's Oct 25 message); records.json has it paid on Nov 3.",
    parties: cascadeParties().filter((p) => ids.includes(p.id)),
    commitments: [t.inv1187, t.inv104, t.billSC0042],
    evidence: t.evidence,
  };
}

function cascadeTrade(): Records {
  const r = empty();
  r.parties = cascadeParties();
  // Opening cash is a fixed literal, chosen once by hand so the base low point sits near the design target (about -$6K in
  // the week of Dec 21). It is never tuned against the engine, so fixtures/expected/engine/cascade_trade.json stays independent.
  r.balances = [balance("bal-cascade", $(145000), "2026-11-16")];
  const eg = history("EG", "party-evergreen-home", [13, 15, 14, 14, 16, 13, 14, 15], "2026-02-10", $(20000));
  const pm = history("PM", "party-puget-market", [-7, -8, -6, -7, -7, -9, -6, -7], "2026-02-15", $(15000));
  // Harbor pays one to three days after due: with only four payments the learned lag is shrunk toward the profile default
  // (+10 days), so INV-1203 (due Dec 16) is expected Dec 26, after the Dec 25 payroll.
  const hh = history("HH", "party-harbor-hearth", [1, 2, 3, 2], "2026-07-20", $(10000));
  r.commitments = [...eg.commitments, ...pm.commitments, ...hh.commitments];
  r.settlements = [...eg.settlements, ...pm.settlements, ...hh.settlements];
  const t = cascadeIntakeTargets();
  // INV-104: Puget paid on Nov 3, the date in the owner's Oct 25 message (intake/owner-message-inv104.txt).
  r.commitments.push({ ...t.inv104, settlement: "paid", outstanding: 0 });
  r.settlements.push({ id: "set-inv-INV-104", commitmentId: "inv-INV-104", partyId: "party-puget-market", amount: $(12000), currency: "USD", date: "2026-11-03", sourceRef: src("bank_csv", "set-inv-INV-104") });
  r.commitments.push(
    t.inv1187,
    // INV-1203 as intake reads it (email-harbor-inv1203.eml): the first partial shipment, $4,000 of Harbor's $10,000
    // PO HH-PO-552. The PO itself is not in the books: it arrives as harbor-po-552.pdf, and intake creates it and links
    // this invoice to it, so the engine then forecasts only the $6,000 not yet invoiced (cases.json po-partial-invoice).
    invoice("INV-1203", "party-harbor-hearth", $(4000), "2026-12-16", "2026-11-16"),
    // Puget's holiday order on Net 60, expected Jan 5 (Puget's learned lag rounds to 0 days). With INV-1203 it refills the account after
    // the Dec 25 low point. Neither lands between Dec 27 and rent on Jan 1, so when the Evergreen signal moves INV-1187
    // into January nothing covers rent and the dip deepens (about -$8K on Jan 1).
    invoice("INV-1196", "party-puget-market", $(8000), "2027-01-05", "2026-11-06"),
    invoice("INV-1215", "party-puget-market", $(115000), "2027-01-12", "2026-12-13"),
    {
      id: "po-PO-2291", type: "purchase_order", direction: "out", reference: "PO-2291", partyId: "party-shenzhen-ceramics", amount: $(60000), currency: "USD",
      anchors: { order: "2026-11-20", ship: "2026-12-14" }, patternId: "supplier_30_70", status: "committed", settlement: "open", linkedCommitmentIds: ["bill-SC-0042"], sourceRef: src("generic_file", "po-2291.pdf"),
    },
    t.billSC0042,
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
  r.evidence = t.evidence;
  // A proposed (not applied) signal: Evergreen says early January. It must not change the base forecast until applied.
  // It is exactly what the AI lane extracts from intake/whatsapp-evergreen.txt (ai/extract/signals.ts, cached run): same
  // id, channel, time, date, confidence (capped at 0.5: conditional promise, sender not a confirmed contact, so it stays
  // proposed under the trading auto-apply threshold), and an excerpt whose offsets slice that file.
  // Known gap: the chat is dated Nov 28, after this fixture's asOf (Nov 16). Neither date can move here without breaking
  // other lanes: asOf 2026-11-16 is pinned by ai/ask, ai/brief and api tests, and the chat's timestamps by
  // ai/extract/message.test.ts and the committed live extraction cache. The engine only orders signals by receivedAt.
  const sig: Signal = {
    id: "sig-ev-whatsapp-evergreen-2", channel: "whatsapp", receivedAt: "2026-11-28T17:31:47.000Z", partyId: "party-evergreen-home", commitmentId: "inv-INV-1187",
    claim: { kind: "date_change", newDate: "2027-01-05" }, confidence: 0.5, state: "proposed",
    sourceRef: { system: "whatsapp", record: "ev-whatsapp-evergreen", excerpt: { start: 213, end: 226, text: "early January" } },
  };
  r.signals = [sig];
  r.rules = [];
  return r;
}

// ---- pike_noodle: Pike Street Noodle Bar (restaurant, daily card sales, weekly payroll, no receivables) ----
// Story (docs/design/10-testing-and-fixtures.md): a busy December with holiday catering, then a slow January where the
// annual liquor license, the kitchen-line lease buyout and the quarterly estimated tax (profile recurring, Jan 15) land
// in the same week as payroll. The low point is Friday Jan 15, 2027.
//
// Seasonal sales are out of scope for the engine today: the daily-sales model averages the last 28 days of card receipts
// and shapes them by weekday only, so it cannot know January covers are softer. Rather than fake seasonality, the January
// dip comes from real January outflows a restaurant has (committed bills), and the December bump from owner-entered
// catering deposits (plans, likely). Neither needs an engine change.
function pikeNoodle(): Records {
  const r = empty();
  r.parties = [
    party("party-sound-produce", "Sound Produce", "supplier", [], []),
    party("party-noodle-wholesale", "Noodle Wholesale", "supplier", [], []),
    party("party-wslcb", "Washington State Liquor and Cannabis Board", "supplier", [], ["Liquor license renews every January"]),
    party("party-pacific-leasing", "Pacific Restaurant Leasing", "supplier", [], ["Kitchen line lease ends in January with a buyout payment"]),
    party("party-catering-guests", "Holiday catering guests", "customer", [], ["Office holiday parties pay a deposit when they book"]),
  ];
  // Start-of-day snapshot on asOf: bank lines dated before it are history only (already inside this balance).
  r.balances = [balance("bal-pike", $(22000), "2026-11-16")];
  const weights = [0.6, 0.7, 0.8, 1.0, 1.5, 1.8, 1.4];
  const mean = weights.reduce((a, b) => a + b, 0) / 7;
  // Card deposits land settleLagDays after the sale (profiles/restaurant.json), so each deposit is shaped by its
  // sale date's weekday: history stays in phase with the forecast.
  const restaurant = JSON.parse(readFileSync(join(root, "profiles/restaurant.json"), "utf8")) as Profile;
  const lag = restaurant.revenueModel.kind === "dailySales" ? (restaurant.revenueModel.settleLagDays ?? 0) : 0;
  const events: CashEvent[] = [];
  for (let i = 28; i >= 1; i--) {
    const date = addDays("2026-11-16", -i);
    const noise = ((i * 37) % 11) - 5; // deterministic wobble, +-$50
    const amount = $((2200 * weights[dowOf(addDays(date, -lag))]!) / mean + noise * 10);
    events.push({ id: `bank-sales-${date}`, legIndex: 0, date, amount, currency: "USD", amountBase: amount, direction: "in", status: "actual", confidence: 1, basis: "card settlement", category: "sales", sourceRef: src("bank_csv", `sales-${date}`) });
  }
  // Six Friday payroll runs before the snapshot: material for recurring detection (weekly, Friday, about $7,500, matching
  // the profile's rec-payroll). Dated before 2026-11-16, so they are history, never forecast or added to opening cash.
  const payroll = [7380, 7520, 7465, 7610, 7500, 7445];
  payroll.forEach((amt, i) => {
    const date = addDays("2026-10-09", i * 7);
    events.push({ id: `bank-payroll-${date}`, legIndex: 0, date, amount: $(amt), currency: "USD", amountBase: $(amt), direction: "out", status: "actual", confidence: 1, basis: "payroll run", category: "payroll", sourceRef: src("bank_csv", `payroll-${date}`) });
  });
  r.events = events;
  // Weekly produce bills on Thursdays through the horizon, plus noodles every other week, net-7 from the invoice date.
  const bills: [string, string, string, number, string?][] = [];
  for (let i = 0; i < 13; i++) {
    const due = addDays("2026-11-19", i * 7);
    bills.push([`FP-${4400 + i}`, "party-sound-produce", due, 3800 + (i % 4) * 100]);
    if (i % 2 === 0) bills.push([`NW-${4400 + i}`, "party-noodle-wholesale", due, 1500]);
  }
  // January: annual liquor license renewal and the kitchen-line lease buyout (final balloon payment).
  bills.push(["WSLCB-2027", "party-wslcb", "2027-01-11", 2500, "license"]);
  bills.push(["PRL-LEASE-88-BUYOUT", "party-pacific-leasing", "2027-01-14", 18000, "equipment lease"]);
  r.commitments = bills.map(([ref, partyId, due, amt, category]) => ({
    id: `bill-${ref}`, type: "bill", direction: "out", reference: ref, partyId, ...(category ? { category } : {}), amount: $(amt), currency: "USD", anchors: { invoice: addDays(due, -7), due }, status: "committed", outstanding: $(amt), settlement: "open", sourceRef: src("zoho_books", ref),
  }));
  // December: holiday-party catering deposits the owner expects (owner plans, likely; not invoices, so no lag).
  const catering: [string, number][] = [["2026-12-04", 2000], ["2026-12-11", 3500], ["2026-12-18", 2500]];
  for (const [due, amt] of catering) {
    r.commitments.push({ id: `plan-catering-${due}`, type: "plan", direction: "in", category: "catering", partyId: "party-catering-guests", amount: $(amt), currency: "USD", anchors: { due }, status: "likely", sourceRef: src("owner", `catering-${due}`) });
  }
  return r;
}

const fixtures: { name: string; profile: string; asOf: string; fxRates: Record<string, number>; records: Records }[] = [
  { name: "cascade_trade", profile: "profiles/trading.json", asOf: "2026-11-16", fxRates: { INR: 0.012 }, records: cascadeTrade() },
  { name: "pike_noodle", profile: "profiles/restaurant.json", asOf: "2026-11-16", fxRates: {}, records: pikeNoodle() },
];
write("fixtures/cascade_trade/intake/base_records.json", cascadeIntakeBase());
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
