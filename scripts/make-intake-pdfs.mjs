// Generates the synthetic intake PDFs in fixtures/cascade_trade/intake/.
// No dependencies: writes minimal PDF 1.4 files with Helvetica text.
// Usage: node scripts/make-intake-pdfs.mjs
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "..", "fixtures", "cascade_trade", "intake");

function pdf(pages) {
  // pages: array of { lines?: string[], drawOnly?: boolean }
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pagesId = objs.length + 1;
  objs.push(null); // placeholder for Pages
  const kids = [];
  for (const p of pages) {
    let stream;
    if (p.drawOnly) {
      // Image-like content with no text operators: simulates a scan.
      stream = "0.85 g 50 400 500 300 re f 0.2 g 70 650 200 20 re f 70 600 400 10 re f 70 580 380 10 re f";
    } else {
      const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
      stream = "BT /F1 11 Tf 14 TL 60 760 Td " + p.lines.map((l) => `(${esc(l)}) '`).join(" ") + " ET";
    }
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

const invoice = ({ number, total, currency = "USD", due = "December 10, 2026", extra = [] }) => [
  "CASCADE TRADE CO.",
  "1200 Valley Industrial Way, Kent, WA 98032",
  "",
  `INVOICE ${number}`,
  "Invoice date: November 10, 2026",
  `Due date: ${due}`,
  "Terms: Net 30",
  "",
  "Bill to: Evergreen Home LLC",
  "accounts@evergreenhome.example",
  "",
  "Description                         Qty     Unit       Amount",
  "Stoneware dinner set, 16 pc         400    40.00    16,000.00",
  "Glazed serving bowls                300    40.00    12,000.00",
  "",
  `Subtotal                                       ${total}`,
  `TOTAL DUE (${currency})                          ${total}`,
  "",
  "View or pay online:",
  "https://books.zoho.example/portal/cascadetrade/invoice/2-INV-1187",
  ...extra,
];

const files = {
  "inv1187.pdf": [{ lines: invoice({ number: "INV-1187", total: "28,000.00" }) }],
  "inv1187-cad.pdf": [{ lines: invoice({ number: "INV-1187", total: "28,000.00", currency: "CAD" }) }],
  "inv1187-revised-total.pdf": [{ lines: invoice({ number: "INV-1187", total: "29,500.00", extra: ["", "Revised: freight surcharge 1,500.00 added"] }) }],
  "ningbo-bill-0042.pdf": [{ lines: [
    "NINGBO PACK CO., LTD.",
    "No. 88 Harbor Road, Beilun, Ningbo, China",
    "",
    "COMMERCIAL INVOICE No. 0042",
    "Date: November 18, 2026",
    "Payment due: December 18, 2026 (100% before shipment)",
    "",
    "Buyer: Cascade Trade Co., Kent, WA, USA",
    "",
    "Corrugated shipping cartons, 5,000 pcs          USD 6,200.00",
    "",
    "TOTAL (USD)                                         6,200.00",
  ] }],
  "harbor-po-552.pdf": [{ lines: [
    "HARBOR AND HEARTH",
    "Purchasing Department, Seattle, WA",
    "",
    "PURCHASE ORDER HH-PO-552",
    "PO date: November 2, 2026",
    "Vendor: Cascade Trade Co.",
    "",
    "Hand-thrown mugs, 1,000 pcs @ 10.00             10,000.00",
    "",
    "PO TOTAL (USD)                                 10,000.00",
    "Payment terms: Net 30 from each invoice",
    "Delivery: partial shipments accepted",
    "Status: Accepted",
  ] }],
  "scanned-bill.pdf": [{ drawOnly: true }],
};

for (const [name, pages] of Object.entries(files)) {
  writeFileSync(join(OUT, name), pdf(pages));
  console.log("wrote", name);
}
