// Every source an owner might connect. One adapter per source (CLAUDE.md principle 5); every one also
// has a no-setup fallback: export a file, upload it, or paste text.
//
// availability:
//   "live"    — working in the Neri prototype today (Zoho OAuth, Microsoft Graph, WhatsApp Cloud API)
//   "next"    — next to build (locked in the Neri roadmap)
//   "planned" — on the list; file import works now
// reads: what Neri takes from it, in the owner's words. Always read-only.

export const CATEGORIES = [
  { id: "accounting", label: "Accounting", why: "Invoices, bills, payments and who owes what. The base of the forecast." },
  { id: "bank", label: "Bank and cards", why: "Today's real balance and what actually cleared." },
  { id: "erp", label: "ERP and inventory", why: "Purchase orders, stock and production that will need cash before they bring it in." },
  { id: "crm", label: "CRM and sales", why: "Won deals and open quotes: money coming that the books don't know about yet." },
  { id: "commerce", label: "Payments, commerce and POS", why: "Daily sales and payouts, and when they settle." },
  { id: "payroll", label: "Payroll", why: "The biggest fixed outflow, on its real schedule." },
  { id: "spend", label: "Bills and spend", why: "Approved bills and card spend before they hit the bank." },
  { id: "comms", label: "Email, chat and calendar", why: "Promises and delays — the earliest sign a payment will move." },
  { id: "docs", label: "Documents", why: "Quotes, POs and contracts with the terms in them." },
  { id: "logistics", label: "Shipping and logistics", why: "Ship and delivery dates that trigger payments on both sides." },
];

export const CONNECTORS = [
  // Accounting
  { id: "zoho_books", name: "Zoho Books", category: "accounting", availability: "live", reads: "Invoices, bills, POs, payments, contacts" },
  { id: "quickbooks", name: "QuickBooks Online", mark: "QB", category: "accounting", availability: "next", reads: "Invoices, bills, payments, customers, vendors" },
  { id: "xero", name: "Xero", category: "accounting", availability: "next", reads: "Invoices, bills, payments, contacts" },
  { id: "sage_intacct", name: "Sage Intacct", mark: "SI", category: "accounting", availability: "planned", reads: "AR, AP, payments" },
  { id: "freshbooks", name: "FreshBooks", category: "accounting", availability: "planned", reads: "Invoices, expenses, payments" },
  { id: "tally", name: "Tally", category: "accounting", availability: "planned", reads: "Ledgers, outstanding receivables and payables" },

  // Bank and cards
  { id: "bank_feed", name: "Bank feeds", category: "bank", availability: "next", reads: "Balances and transactions from most US banks" },
  { id: "bank_csv", name: "Bank statement", category: "bank", availability: "live", reads: "Upload a CSV or PDF statement" },
  { id: "mercury", name: "Mercury", category: "bank", availability: "planned", reads: "Balances, transactions" },
  { id: "amex", name: "American Express", mark: "AX", category: "bank", availability: "planned", reads: "Card balance and statement date" },

  // ERP and inventory
  { id: "netsuite", name: "NetSuite", category: "erp", availability: "planned", reads: "POs, sales orders, AR, AP" },
  { id: "business_central", name: "Dynamics 365 Business Central", mark: "BC", category: "erp", availability: "planned", reads: "POs, sales orders, AR, AP" },
  { id: "sap_b1", name: "SAP Business One", mark: "SAP", category: "erp", availability: "planned", reads: "POs, sales orders, AR, AP" },
  { id: "odoo", name: "Odoo", category: "erp", availability: "planned", reads: "Purchases, sales, invoices" },
  { id: "acumatica", name: "Acumatica", category: "erp", availability: "planned", reads: "POs, sales orders, AR, AP" },
  { id: "katana", name: "Katana", category: "erp", availability: "planned", reads: "Manufacturing and purchase orders" },

  // CRM and sales
  { id: "zoho_crm", name: "Zoho CRM", category: "crm", availability: "live", reads: "Deals, RFQs, quotes, shipments, samples" },
  { id: "salesforce", name: "Salesforce", category: "crm", availability: "planned", reads: "Opportunities, stages, close dates" },
  { id: "hubspot", name: "HubSpot", category: "crm", availability: "planned", reads: "Deals, stages, close dates" },
  { id: "pipedrive", name: "Pipedrive", category: "crm", availability: "planned", reads: "Deals, stages, expected close" },

  // Payments, commerce, POS
  { id: "stripe", name: "Stripe", category: "commerce", availability: "planned", reads: "Charges, payouts, invoices" },
  { id: "square", name: "Square", category: "commerce", availability: "planned", reads: "Daily sales and payout timing" },
  { id: "shopify", name: "Shopify", category: "commerce", availability: "planned", reads: "Orders, payouts" },
  { id: "toast", name: "Toast", category: "commerce", availability: "planned", reads: "Daily sales, tips, payouts" },
  { id: "pos_csv", name: "Sales export", category: "commerce", availability: "live", reads: "Upload daily sales from any POS" },
  { id: "paypal", name: "PayPal", category: "commerce", availability: "planned", reads: "Payments received, balance" },

  // Payroll
  { id: "gusto", name: "Gusto", category: "payroll", availability: "planned", reads: "Pay schedule and run totals" },
  { id: "adp", name: "ADP", category: "payroll", availability: "planned", reads: "Pay schedule and run totals" },
  { id: "rippling", name: "Rippling", category: "payroll", availability: "planned", reads: "Pay schedule and run totals" },
  { id: "paychex", name: "Paychex", category: "payroll", availability: "planned", reads: "Pay schedule and run totals" },

  // Bills and spend
  { id: "bill_com", name: "BILL", mark: "B", category: "spend", availability: "planned", reads: "Approved bills and scheduled payments" },
  { id: "ramp", name: "Ramp", category: "spend", availability: "planned", reads: "Card spend, bills, statement dates" },

  // Comms
  { id: "m365", name: "Microsoft 365", mark: "MS", category: "comms", availability: "live", reads: "Outlook mail, Teams chats, calendar" },
  { id: "whatsapp", name: "WhatsApp Business", mark: "WA", category: "comms", availability: "live", reads: "Customer and supplier messages" },
  { id: "google", name: "Gmail and Google Calendar", mark: "G", category: "comms", availability: "next", reads: "Mail and calendar" },
  { id: "slack", name: "Slack", category: "comms", availability: "planned", reads: "Channel and DM messages you choose" },

  // Documents
  { id: "sharepoint", name: "OneDrive and SharePoint", mark: "OD", category: "docs", availability: "live", reads: "Quotes, POs, contracts" },
  { id: "gdrive", name: "Google Drive", category: "docs", availability: "next", reads: "Quotes, POs, contracts" },
  { id: "dropbox", name: "Dropbox", category: "docs", availability: "planned", reads: "Quotes, POs, contracts" },

  // Logistics
  { id: "flexport", name: "Flexport", category: "logistics", availability: "planned", reads: "Ship and arrival dates" },
  { id: "shipment_csv", name: "Shipment tracker export", category: "logistics", availability: "live", reads: "Upload ETAs from any forwarder" },
];

export const AVAILABILITY_LABEL = {
  live: "Ready",
  next: "Coming next",
  planned: "Planned",
};
