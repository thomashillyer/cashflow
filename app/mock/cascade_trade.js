// Preview fixture: Cascade Trade Co. (fictional Kent, WA importer) — see docs/design/10-testing-and-fixtures.md.
// Shapes follow docs/design/03-data-model.md. Amounts in cents.
//
// Preview-only field: `legs` on each Commitment. In the real build the engine expands
// commitments into legs from the profile's payment patterns; here they are pre-expanded
// so the app can run before engine/ exists. Remove when the API is wired.

const usd = (dollars) => Math.round(dollars * 100);

export const profile = {
  id: "trading",
  displayName: "Trading and import",
  baseCurrency: "USD",
  horizonWeeks: 13,
  freeCashLookaheadWeeks: 6,
  defaultLagDays: 20,
  lagShrinkageK: 3,
  safetyLine: { kind: "fixed", amount: usd(35000) },
  thresholds: {
    idleBalanceOver: { amount: usd(50000), minWeeks: 2 },
    arConcentrationPct: 30,
    signalAutoApplyConfidence: 1.01,
    rankFloor: usd(250),
    relationshipPenalty: { preferred: 0.5, strategic: 0.6 },
  },
  signalSources: ["email", "whatsapp", "crm", "owner"],
  vocabulary: { deal: "order", quote: "RFQ", purchase: "PO" },
};

export const business = {
  id: "cascade_trade",
  name: "Cascade Trade Co.",
  owner: "Dana",
  asOf: "2026-10-25",
  synthetic: true,
  timezone: "America/Los_Angeles",
  sources: [
    { id: "zoho_books", label: "Zoho Books", state: "ok", syncedAt: "2026-10-25T14:40:00Z", detail: "26 invoices and bills" },
    { id: "bank_csv", label: "Bank", state: "ok", syncedAt: "2026-10-25T05:00:00Z", detail: "Statement to Oct 24" },
    { id: "m365", label: "Microsoft 365", state: "ok", syncedAt: "2026-10-25T15:05:00Z", detail: "1 message to review" },
    { id: "zoho_crm", label: "Zoho CRM", state: "ok", syncedAt: "2026-10-25T14:40:00Z", detail: "1 won order, 2 open RFQs" },
  ],
};

export const parties = [
  { id: "shenzhen-ceramics", name: "Shenzhen Ceramics Co.", kind: "supplier", tags: ["preferred", "reliable"], notes: ["Best quality; slow around Lunar New Year"] },
  { id: "jaipur-textiles", name: "Jaipur Textiles", kind: "supplier", tags: ["preferred"], notes: ["Good partner; prices in rupees", "They'll give us 15 more days if I ask"] },
  { id: "ningbo-pack", name: "Ningbo Pack", kind: "supplier", tags: ["avoid"], notes: ["Quality issues last year — backup only"] },
  { id: "pacific-freight", name: "Pacific Freight", kind: "supplier", tags: [], notes: [] },
  { id: "customs-broker", name: "Sound Customs Brokerage", kind: "agency", tags: [], notes: [] },
  { id: "evergreen-home", name: "Evergreen Home", kind: "customer", tags: ["slow_payer"], notes: ["They always pay about two weeks late"],
    contacts: { emailDomains: ["evergreenhome.example"] },
    lagStats: { n: 8, medianDaysLate: 14, iqrDays: 6, updatedAt: "2026-10-25" } },
  { id: "puget-market", name: "Puget Market", kind: "customer", tags: ["reliable"], notes: ["Usually pays a week early"],
    lagStats: { n: 11, medianDaysLate: -7, iqrDays: 3, updatedAt: "2026-10-25" } },
  { id: "harbor-hearth", name: "Harbor and Hearth", kind: "customer", tags: ["reliable"], notes: ["On time, except holiday delays in December"],
    lagStats: { n: 9, medianDaysLate: 0, iqrDays: 2, updatedAt: "2026-10-25" } },
  { id: "payroll", name: "Payroll", kind: "employee", tags: [], notes: [] },
  { id: "landlord", name: "Kent Commerce Park", kind: "other", tags: [], notes: [] },
  { id: "irs", name: "IRS estimated tax", kind: "other", tags: [], notes: [] },
];

const zb = (record) => ({ system: "zoho_books", record, url: `https://books.zoho.example/${record}` });

function leg(date, dollars, direction, status, confidence, basis, legIndex = 0) {
  return { legIndex, date, amount: usd(dollars), direction, status, confidence, basis };
}

export const commitments = [
  // Receivables (open invoices)
  { id: "inv-INV-1172", type: "invoice", partyId: "puget-market", amount: usd(24000), currency: "USD", anchors: { invoice: "2026-10-10", due: "2026-11-09" }, status: "committed", settlement: "open", sourceRef: zb("INV-1172"),
    legs: [leg("2026-11-02", 24000, "in", "committed", 0.86, "due Nov 9 − 7 days (Puget Market's median of last 11 payments)")] },
  { id: "inv-INV-1179", type: "invoice", partyId: "harbor-hearth", amount: usd(18500), currency: "USD", anchors: { invoice: "2026-10-21", due: "2026-11-20" }, status: "committed", settlement: "open", sourceRef: zb("INV-1179"),
    legs: [leg("2026-11-20", 18500, "in", "committed", 0.9, "due Nov 20; Harbor and Hearth pays on time (last 9 payments)")] },
  { id: "inv-INV-1181", type: "invoice", partyId: "evergreen-home", amount: usd(16200), currency: "USD", anchors: { invoice: "2026-10-14", due: "2026-11-13" }, status: "committed", settlement: "open", sourceRef: zb("INV-1181"),
    legs: [leg("2026-11-27", 16200, "in", "committed", 0.72, "due Nov 13 + 14 days (Evergreen Home's median of last 8 payments)")] },
  { id: "inv-INV-1187", type: "invoice", partyId: "evergreen-home", amount: usd(28000), currency: "USD", anchors: { invoice: "2026-11-10", due: "2026-12-10" }, status: "committed", settlement: "open", sourceRef: zb("INV-1187"),
    invoiceUrl: "https://books.zoho.example/INV-1187",
    legs: [leg("2026-12-24", 28000, "in", "committed", 0.72, "due Dec 10 + 14 days (Evergreen Home's median of last 8 payments)")] },
  { id: "inv-INV-1190", type: "invoice", partyId: "puget-market", amount: usd(31000), currency: "USD", anchors: { invoice: "2026-11-13", due: "2027-01-12" }, status: "committed", settlement: "open", sourceRef: zb("INV-1190"),
    legs: [leg("2027-01-05", 31000, "in", "committed", 0.86, "due Jan 12 − 7 days (Puget Market's median of last 11 payments)")] },
  { id: "inv-INV-1194", type: "invoice", partyId: "harbor-hearth", amount: usd(22000), currency: "USD", anchors: { invoice: "2026-11-18", due: "2026-12-18" }, status: "committed", settlement: "open", sourceRef: zb("INV-1194"),
    legs: [leg("2026-12-28", 22000, "in", "committed", 0.7, "due Dec 18 + 10 days (owner note: holiday delays in December)")] },
  { id: "inv-INV-1199", type: "invoice", partyId: "evergreen-home", amount: usd(34000), currency: "USD", anchors: { invoice: "2026-12-05", due: "2027-01-04" }, status: "committed", settlement: "open", sourceRef: zb("INV-1199"),
    legs: [leg("2027-01-18", 34000, "in", "committed", 0.72, "due Jan 4 + 14 days (Evergreen Home's median of last 8 payments)")] },
  { id: "inv-INV-1201", type: "invoice", partyId: "harbor-hearth", amount: usd(26000), currency: "USD", anchors: { invoice: "2026-12-16", due: "2027-01-15" }, status: "committed", settlement: "open", sourceRef: zb("INV-1201"),
    legs: [leg("2027-01-15", 26000, "in", "committed", 0.9, "due Jan 15; Harbor and Hearth pays on time")] },

  // Won order (likely): customer advance at order
  { id: "deal-SO-0088", type: "sales_deal", partyId: "puget-market", amount: usd(96000), currency: "USD", anchors: { order: "2027-01-11" }, status: "likely", sourceRef: { system: "crm", record: "Deal SO-0088 (won)" },
    legs: [leg("2027-01-11", 28800, "in", "likely", 0.8, "30% advance at order on a won $96,000 order; balance falls after this forecast")] },

  // Payables
  { id: "po-PO-2291-dep", type: "purchase_order", partyId: "shenzhen-ceramics", amount: usd(18000), currency: "USD", anchors: { order: "2026-11-20" }, status: "committed", sourceRef: zb("PO-2291"),
    legs: [leg("2026-11-20", 18000, "out", "committed", 0.98, "30% deposit at order on PO-2291 ($60,000)")] },
  { id: "po-PO-2291-bal", type: "purchase_order", partyId: "shenzhen-ceramics", amount: usd(42000), currency: "USD", anchors: { ship: "2026-12-22" }, status: "committed", sourceRef: zb("PO-2291"),
    legs: [leg("2026-12-22", 42000, "out", "committed", 0.95, "70% balance before ship on PO-2291 (ship Dec 22)")] },
  { id: "bill-DUT-2291", type: "bill", partyId: "customs-broker", amount: usd(9000), currency: "USD", anchors: { due: "2026-12-23" }, status: "likely", sourceRef: { system: "generic_file", record: "po-2291.pdf, landed cost estimate" },
    legs: [leg("2026-12-23", 9000, "out", "likely", 0.8, "duties and landing costs on PO-2291, estimated from the landed-cost sheet")] },
  { id: "po-PO-2302-bal", type: "purchase_order", partyId: "jaipur-textiles", amount: 100000000, currency: "INR", anchors: { ship: "2026-12-15" }, status: "committed", sourceRef: { system: "generic_file", record: "po-2302.xlsx" },
    legs: [leg("2026-12-15", 12000, "out", "committed", 0.95, "50% balance at ship on PO-2302 (₹10,00,000 at 83.3 per USD)")] },
  { id: "bill-B-551", type: "bill", partyId: "ningbo-pack", amount: usd(4800), currency: "USD", anchors: { due: "2026-11-06" }, status: "committed", settlement: "open", sourceRef: zb("BILL-551"),
    legs: [leg("2026-11-06", 4800, "out", "committed", 0.98, "packaging bill due Nov 6")] },
  { id: "bill-PF-7710", type: "bill", partyId: "pacific-freight", amount: usd(9500), currency: "USD", anchors: { due: "2026-11-23" }, status: "committed", settlement: "open", sourceRef: zb("BILL-PF-7710"),
    discount: { pct: 2, byDate: "2026-11-03" },
    legs: [leg("2026-11-23", 9500, "out", "committed", 0.98, "ocean freight due Nov 23 (2% off if paid by Nov 3)")] },
  { id: "bill-PF-7731", type: "bill", partyId: "pacific-freight", amount: usd(5200), currency: "USD", anchors: { due: "2026-11-24" }, status: "committed", settlement: "open", sourceRef: zb("BILL-PF-7731"),
    legs: [leg("2026-11-24", 5200, "out", "committed", 0.98, "forwarding and drayage due Nov 24")] },

  // Recurring
  ...["2026-10-30", "2026-11-13", "2026-11-27", "2026-12-11", "2026-12-24", "2027-01-08", "2027-01-22"].map((d) => ({
    id: `rec-payroll-${d}`, type: "recurring", partyId: "payroll", amount: usd(14000), currency: "USD", anchors: { due: d }, status: "committed", sourceRef: { system: "bank_csv", record: "recurring: payroll every other Friday" },
    legs: [leg(d, 14000, "out", "committed", 0.99, d === "2026-12-24" ? "biweekly payroll (moved from Fri Dec 25, holiday)" : "biweekly payroll, every other Friday")],
  })),
  ...["2026-11-01", "2026-12-01", "2027-01-01"].map((d) => ({
    id: `rec-rent-${d}`, type: "recurring", partyId: "landlord", amount: usd(6500), currency: "USD", anchors: { due: d }, status: "committed", sourceRef: { system: "bank_csv", record: "recurring: rent on the 1st" },
    legs: [leg(d, 6500, "out", "committed", 0.99, "rent on the 1st")],
  })),
  { id: "rec-tax-2027-01-15", type: "recurring", partyId: "irs", amount: usd(11000), currency: "USD", anchors: { due: "2027-01-15" }, status: "committed", sourceRef: { system: "bank_csv", record: "recurring: quarterly estimated tax" },
    legs: [leg("2027-01-15", 11000, "out", "committed", 0.97, "Q4 estimated tax, same as last quarter")] },

  // Pipeline (possible) — never in the main line
  { id: "rfq-RFQ-0412", type: "sales_deal", partyId: "harbor-hearth", amount: usd(58000), currency: "USD", anchors: { order: "2026-12-07" }, status: "possible", probability: 0.4, sourceRef: { system: "crm", record: "RFQ-0412 (quoted)" },
    legs: [leg("2026-12-07", 17400, "in", "possible", 0.4, "quoted RFQ, 30% advance if won (40% chance)")] },
  { id: "rfq-RFQ-0417", type: "sales_deal", partyId: "puget-market", amount: usd(41000), currency: "USD", anchors: { order: "2027-01-04" }, status: "possible", probability: 0.6, sourceRef: { system: "crm", record: "RFQ-0417 (quoted)" },
    legs: [leg("2027-01-04", 12300, "in", "possible", 0.6, "quoted RFQ, 30% advance if won (60% chance)")] },
];

export const rules = [
  { id: "rule-jaipur-flex", scope: { partyId: "jaipur-textiles" }, kind: "flexibility", params: { extraDays: 15 }, fromNote: "They'll give us 15 more days if I ask", state: "confirmed" },
  { id: "rule-evergreen-lag", scope: { partyId: "evergreen-home" }, kind: "lag_offset", params: { offsetDays: 14 }, fromNote: "They always pay about two weeks late", state: "confirmed" },
];

export const balances = [
  { id: "bal-2026-10-25", account: "Operating checking ••4410", amount: usd(104000), currency: "USD", asOf: "2026-10-25", sourceRef: { system: "bank_csv", record: "statement line 2026-10-24 closing balance" } },
];

// Messages waiting in Review. Text is data: it only ever feeds extraction.
export const messages = [
  {
    id: "msg-evg-1029",
    channel: "email",
    from: "ap@evergreenhome.example",
    partyId: "evergreen-home",
    receivedAt: "2026-10-25T14:52:00Z",
    subject: "RE: INV-1187",
    body:
      "Hi Dana,\n\nThanks for the reminder on INV-1187. Honestly we're stretched until our own customer pays us — we'll pay once their payment lands, which should be early January, around the 8th.\n\nSorry for the delay.\nMarcus, Evergreen Home AP",
    excerpt: "we'll pay once their payment lands, which should be early January, around the 8th",
  },
];

export const signals = [
  {
    id: "sig-evg-1187",
    channel: "email",
    receivedAt: "2026-10-25T14:52:00Z",
    partyId: "evergreen-home",
    commitmentRef: "inv-INV-1187",
    claim: { kind: "date_change", newDate: "2027-01-08" },
    confidence: 0.86,
    state: "proposed",
    sourceRef: { system: "email", record: "msg-evg-1029" },
  },
];

// Parked thoughts already in the owner's notebook (typed or spoken earlier).
export const thoughts = [
  { id: "th-seed-1", via: "voice", createdAt: "2026-10-24T23:12:00Z", text: "Thinking about a second Shenzhen container in January, around a $30K deposit" },
  { id: "th-seed-2", via: "typed", createdAt: "2026-10-24T02:40:00Z", text: "Puget hinted at a big spring order, maybe $80K, around March" },
  { id: "th-seed-3", via: "voice", createdAt: "2026-10-22T22:05:00Z", text: "Ask the bank about raising the credit line before the holidays" },
];
