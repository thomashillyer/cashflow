// HAND-AUTHORED stand-ins for model output, written to look like what the extraction prompt returns:
// raw strings as printed plus short verbatim quotes taken from the fixture text. They exist so the demo
// and tests run with no API key. `npx tsx scripts/refresh-extraction-cache.ts` replaces them with real
// model output (same cache keys, so no code changes).

import type { ExtractionOutput } from "../ai/extract/document";

const NONE = { value: null, quote: null } as const;
const f = (value: string, quote: string = value) => ({ value, quote });

const base = {
  fields: {
    sellerName: NONE, buyerName: NONE, reference: NONE, poReference: NONE, amount: NONE, outstanding: NONE,
    currency: NONE, issueDate: NONE, dueDate: NONE, terms: NONE, invoiceUrl: NONE, paymentUrl: NONE,
    statedStatus: NONE, paidAmount: NONE, paidDate: NONE,
  },
  coversReferences: [],
  containsInstructions: false,
  notes: [],
} satisfies Pick<ExtractionOutput, "fields" | "coversReferences" | "containsInstructions" | "notes">;

export const STANDINS: Record<string, ExtractionOutput> = {
  "inv1187.pdf": {
    ...base,
    kind: "invoice",
    businessRole: "seller",
    fields: {
      ...base.fields,
      sellerName: f("CASCADE TRADE CO."),
      buyerName: f("Evergreen Home LLC", "Bill to: Evergreen Home LLC"),
      reference: f("INV-1187", "INVOICE INV-1187"),
      amount: f("28,000.00", "TOTAL DUE (USD) 28,000.00"),
      currency: f("USD", "TOTAL DUE (USD)"),
      issueDate: f("November 10, 2026", "Invoice date: November 10, 2026"),
      dueDate: f("December 10, 2026", "Due date: December 10, 2026"),
      terms: f("Net 30", "Terms: Net 30"),
      invoiceUrl: f("https://books.zoho.example/portal/cascadetrade/invoice/2-INV-1187"),
    },
    confidence: 0.97,
  },
  "inv1187-cad.pdf": {
    ...base,
    kind: "invoice",
    businessRole: "seller",
    fields: {
      ...base.fields,
      sellerName: f("CASCADE TRADE CO."),
      buyerName: f("Evergreen Home LLC", "Bill to: Evergreen Home LLC"),
      reference: f("INV-1187", "INVOICE INV-1187"),
      amount: f("28,000.00", "TOTAL DUE (CAD) 28,000.00"),
      currency: f("CAD", "TOTAL DUE (CAD)"),
      issueDate: f("November 10, 2026", "Invoice date: November 10, 2026"),
      dueDate: f("December 10, 2026", "Due date: December 10, 2026"),
      terms: f("Net 30", "Terms: Net 30"),
      invoiceUrl: f("https://books.zoho.example/portal/cascadetrade/invoice/2-INV-1187"),
    },
    confidence: 0.97,
  },
  "inv1187-revised-total.pdf": {
    ...base,
    kind: "invoice",
    businessRole: "seller",
    fields: {
      ...base.fields,
      sellerName: f("CASCADE TRADE CO."),
      buyerName: f("Evergreen Home LLC", "Bill to: Evergreen Home LLC"),
      reference: f("INV-1187", "INVOICE INV-1187"),
      amount: f("29,500.00", "TOTAL DUE (USD) 29,500.00"),
      currency: f("USD", "TOTAL DUE (USD)"),
      issueDate: f("November 10, 2026", "Invoice date: November 10, 2026"),
      dueDate: f("December 10, 2026", "Due date: December 10, 2026"),
      terms: f("Net 30", "Terms: Net 30"),
      invoiceUrl: f("https://books.zoho.example/portal/cascadetrade/invoice/2-INV-1187"),
    },
    confidence: 0.9,
    notes: ["A freight surcharge is noted at the bottom of the page; the total differs from the sum of the two line items."],
  },
  "email-inv1187.eml": {
    ...base,
    kind: "conversational_update",
    businessRole: "seller",
    fields: {
      ...base.fields,
      buyerName: f("Evergreen Home LLC", "Accounts Payable, Evergreen Home LLC"),
      invoiceUrl: f(
        "https://books.zoho.example/portal/cascadetrade/invoice/2-INV-1187",
        "View invoice: https://books.zoho.example/portal/cascadetrade/invoice/2-INV-1187",
      ),
      paymentUrl: f(
        "https://checkout.stripe.example/c/pay/cs_live_inv1187_cascade",
        "Pay now: https://checkout.stripe.example/c/pay/cs_live_inv1187_cascade",
      ),
    },
    confidence: 0.8,
    notes: ["The customer re-sent the invoice and says they will process it in their next payment run; no payment date is given."],
  },
  "whatsapp-evergreen.txt": {
    ...base,
    kind: "conversational_update",
    businessRole: "seller",
    fields: {
      ...base.fields,
      reference: f("INV-1187", "INV-1187 for $28,000 is due Dec 10"),
      amount: f("$28,000", "INV-1187 for $28,000 is due Dec 10"),
      dueDate: f("Dec 10", "is due Dec 10"),
    },
    confidence: 0.85,
    notes: ["The customer says they will pay in early January, after their own customer pays them."],
  },
  "ningbo-bill-0042.pdf": {
    ...base,
    kind: "bill",
    businessRole: "buyer",
    fields: {
      ...base.fields,
      sellerName: f("NINGBO PACK CO., LTD."),
      buyerName: f("Cascade Trade Co.", "Buyer: Cascade Trade Co., Kent, WA, USA"),
      reference: f("0042", "COMMERCIAL INVOICE No. 0042"),
      amount: f("6,200.00", "TOTAL (USD) 6,200.00"),
      currency: f("USD", "TOTAL (USD)"),
      issueDate: f("November 18, 2026", "Date: November 18, 2026"),
      dueDate: f("December 18, 2026", "Payment due: December 18, 2026"),
      terms: f("100% before shipment", "(100% before shipment)"),
    },
    confidence: 0.95,
  },
  "harbor-po-552.pdf": {
    ...base,
    kind: "purchase_order",
    businessRole: "seller",
    fields: {
      ...base.fields,
      sellerName: f("Cascade Trade Co.", "Vendor: Cascade Trade Co."),
      buyerName: f("HARBOR AND HEARTH"),
      reference: f("HH-PO-552", "PURCHASE ORDER HH-PO-552"),
      amount: f("10,000.00", "PO TOTAL (USD) 10,000.00"),
      currency: f("USD", "PO TOTAL (USD)"),
      issueDate: f("November 2, 2026", "PO date: November 2, 2026"),
      terms: f("Net 30 from each invoice", "Payment terms: Net 30 from each invoice"),
      statedStatus: f("Accepted", "Status: Accepted"),
    },
    confidence: 0.95,
  },
  "email-harbor-inv1203.eml": {
    ...base,
    kind: "invoice",
    businessRole: "seller",
    fields: {
      ...base.fields,
      sellerName: f("Cascade Trade Co.", "Cascade Trade Co."),
      buyerName: f("Harbor and Hearth", "Hello Harbor and Hearth AP"),
      reference: f("INV-1203", "Invoice: INV-1203"),
      poReference: f("HH-PO-552", "against your PO HH-PO-552"),
      amount: f("USD 4,000.00", "Total due: USD 4,000.00"),
      currency: f("USD", "Total due: USD 4,000.00"),
      issueDate: f("November 16, 2026", "Invoice date: November 16, 2026"),
      dueDate: f("December 16, 2026", "Due: December 16, 2026 (Net 30)"),
      terms: f("Net 30", "(Net 30)"),
      invoiceUrl: f(
        "https://books.zoho.example/portal/cascadetrade/invoice/2-INV-1203",
        "View invoice: https://books.zoho.example/portal/cascadetrade/invoice/2-INV-1203",
      ),
    },
    confidence: 0.96,
  },
  "email-injection.eml": {
    ...base,
    kind: "none",
    businessRole: "unknown",
    containsInstructions: true,
    confidence: 0.2,
    notes: ["The message contains instructions addressed to an assistant; they were ignored. It states no invoice, bill, or payment."],
  },
};
