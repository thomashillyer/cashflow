// Owner notes ("parked thoughts"): the owner channel of the signals pipeline (docs/design/06-signals.md).
// A note gets a proposed reading (kind, direction, amount, date, party, invoice). Nothing reaches the
// forecast until the owner presses Add, which writes an owner Signal: a date_change on the invoice the
// note names, or a plan. Deterministic code reading; when Claude extraction for owner notes lands, swap
// readThought for it and keep the shapes.

import type { Profile } from "../schema/profile";
import type { CommitmentDraft, Override, Records, Signal } from "../schema/records";
import { forecast } from "../engine/forecast";
import type { Thought, ThoughtReading } from "./store";
import { readCashMovement } from "../ai/cash-direction";

const KINDS: { kind: ThoughtReading["kind"]; re: RegExp; direction: "in" | "out"; status: "likely" | "possible" }[] = [
  { kind: "investment", re: /\b(invest|investment|equipment|machine|cooler|truck|forklift|warehouse|expan\w*|capex|renovat\w*|upgrade)\b/, direction: "out", status: "likely" },
  { kind: "new_business", re: /\b(rfq|quote|quoted|lead|prospect|new customer|might order|could order|order from|deal|catering|booking|tender|bid)\b/, direction: "in", status: "possible" },
  { kind: "collection", re: /\b(collect|owes?|owe us|chase|will pay|can pay|pay by|pay us|payment from|receivable|overdue|paying late|pays late)\b/, direction: "in", status: "likely" },
  { kind: "spend", re: /\b(buy|spend|pay|paying|deposit|hire|hiring|purchase|rent|bonus|tax|container|fix|repair|order)\b/, direction: "out", status: "likely" },
];

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ONES: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15 };

// "fifty thousand", "two million", "twenty five thousand" -> a numeral string the digit parser reads.
function wordsToDigits(text: string): string {
  return text.replace(/\b(?:(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s-](one|two|three|four|five|six|seven|eight|nine))?|(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen)|a)\s+(thousand|million)\b/gi,
    (_m, t: string | undefined, o: string | undefined, n: string | undefined, unit: string) => {
      const v = t ? TENS[t.toLowerCase()]! + (o ? ONES[o.toLowerCase()]! : 0) : n ? ONES[n.toLowerCase()]! : 1;
      return `${v} ${unit}`;
    });
}

export function parseAmount(text: string): number | null {
  text = wordsToDigits(text);
  // Ignore identifiers like INV-1187 and four-digit years.
  const cleaned = text.replace(/\b[A-Za-z]+-\d+\b/g, " ").replace(/\b20\d\d\b/g, " ");
  const m = cleaned.match(/(\$)?\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m|thousand|million|grand)?\b/i);
  if (!m) return null;
  let v = Number(m[2]!.replace(/,/g, ""));
  const unit = (m[3] ?? "").toLowerCase();
  if (unit === "k" || unit === "thousand" || unit === "grand") v *= 1e3;
  if (unit === "m" || unit === "million") v *= 1e6;
  if (!m[1] && !unit && v < 1000) return null;
  return Math.round(v * 100);
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export function parseWhen(q: string, asOf: string): string | null {
  const [y, mo] = asOf.split("-").map(Number) as [number, number];
  let best: { index: number; month: number; day: number | null } | null = null;
  MONTHS.forEach((name, i) => {
    const m = q.match(new RegExp(`\\b(${name}|${name.slice(0, 3)})\\b\\.?\\s*(\\d{1,2})?(?:st|nd|rd|th)?\\b`));
    if (m && m.index !== undefined && (best === null || m.index < best.index)) best = { index: m.index, month: i, day: m[2] ? Number(m[2]) : null };
  });
  const b = best as { index: number; month: number; day: number | null } | null;
  if (b) {
    const year = b.month + 1 < mo ? y + 1 : y;
    const day = b.day ?? (/early/.test(q) ? 5 : /\b(end|late)\b/.test(q) ? 26 : 15);
    return `${year}-${String(b.month + 1).padStart(2, "0")}-${String(Math.min(day, 28)).padStart(2, "0")}`;
  }
  // "next week" is the start of next week (Monday), the same convention as the signals pipeline.
  if (/next week/.test(q)) return addDays(asOf, ((1 - new Date(`${asOf}T00:00:00Z`).getUTCDay() + 7) % 7) || 7);
  if (/next month/.test(q)) return addDays(asOf, 30);
  if (/\btomorrow\b/.test(q)) return addDays(asOf, 1);
  // "on the 1st": the next time that day of the month comes round.
  const dom = q.match(/\bthe (\d{1,2})(?:st|nd|rd|th)\b/);
  if (dom && Number(dom[1]) >= 1 && Number(dom[1]) <= 28) {
    const d = String(Number(dom[1])).padStart(2, "0");
    const thisMonth = `${y}-${String(mo).padStart(2, "0")}-${d}`;
    if (thisMonth >= asOf) return thisMonth;
    return mo === 12 ? `${y + 1}-01-${d}` : `${y}-${String(mo + 1).padStart(2, "0")}-${d}`;
  }
  return null;
}

// Money that has already arrived ("just made", "won") as opposed to expected.
const HAPPENED = /\b(?:(?:i|we)(?:'ve| have)?\s+(?:just\s+|already\s+)?(?:made|earned|won|received|collected|sold|got paid|banked)|just\s+(?:made|earned|won|received|got|collected|sold)|got paid|came in)\b/;
const FUTURE = /\b(expect\w*|will|going to|gonna|next|coming|come in|planning|plan to|should|might|maybe|i'll|we'll)\b/;
const IN_WORDS = /\b(made|earned?|earning|won|receiv\w*|got paid|collect\w*|come[s]? in|coming in|came in|incoming|inbound|payout|sold|refund\w*|income|revenue)\b/;
const OUT_WORDS = /\b(pay|paying|paid out|spend|spending|spent|buy|buying|bought|owe|owing|rent|payroll|invest(?:ing)? in|repay\w*|loan repayment|pay(?:ing)? back)\b/;

// Deterministic direction from the owner's words. Repaying a loan is money out; a loan coming in is money in.
export function textDirection(q: string): "in" | "out" | null {
  if (/\b(invoice|bill|statement|quote|order)\b/.test(q) || /\b(?:not|never|no longer|don't|won't)\b/.test(q)) return null;
  if (/\b(repay\w*|loan repayment|pay(?:ing)? back)\b/.test(q) && !/\brepayment\w* (?:from|to (?:us|me))\b/.test(q)) return "out";
  const loan = /\b(loan|financing|funding|borrow\w*|line of credit|credit line)\b/.test(q);
  if (loan && /\b(come[s]? in|coming in|came in|incoming|inbound|receiv\w*|get(?:ting)?|expect\w*|borrow\w*)\b/.test(q)) return "in";
  const i = IN_WORDS.test(q);
  const o = OUT_WORDS.test(q);
  if (i && !o) return "in";
  if (o && !i) return "out";
  return null;
}

export function readThought(text: string, records: Records, asOf: string): ThoughtReading {
  const q = text.toLowerCase();
  const ref = (c: Records["commitments"][number]) => (c.reference ?? c.sourceRef.record).toLowerCase();
  const named = records.commitments.find((c) => ref(c).length > 3 && q.includes(ref(c)));
  const openInvoice = named?.type === "invoice" && (named.settlement ?? "open") === "open" ? named : undefined;
  const movement = readCashMovement(text);
  const loan = /\b(loan|financing|funding|borrow\w*|credit line|line of credit|capital injection)\b/.test(q);
  const known = KINDS.find((k) => k.re.test(q));
  let match: { kind: ThoughtReading["kind"]; direction: "in" | "out" | null; status: "likely" | "possible" } | undefined = loan
    ? { kind: "investment" as const, direction: movement?.direction ?? textDirection(q), status: "likely" as const }
    : openInvoice ? KINDS.find((k) => k.kind === "collection")!
      : known?.kind === "new_business" ? known
        : movement?.direction === "in" ? { kind: "collection" as const, direction: "in" as const, status: "likely" as const }
        : known
          ?? (movement?.direction === "out" ? { kind: "spend" as const, direction: "out" as const, status: "likely" as const } : undefined);
  const amount = parseAmount(text);
  const happened = HAPPENED.test(q) && !FUTURE.test(q);
  let date = parseWhen(q, asOf);
  // "just", "today", "now" with no other date, or something that already happened: today.
  if (date == null && (happened || /\b(just|today|right now)\b/.test(q))) date = asOf;
  const party = named?.partyId
    ? records.parties.find((p) => p.id === named.partyId)
    : records.parties.find((p) => {
        const first = p.name.toLowerCase().split(" ")[0] ?? "";
        return first.length >= 4 && new RegExp(`\\b${first.replace(/[^a-z0-9]/g, "")}\\b`).test(q);
      });
  const fallbackDir = movement?.direction ?? textDirection(q);
  if (!match && amount != null && fallbackDir) {
    match = fallbackDir === "in"
      ? { kind: "collection", direction: "in", status: "likely" }
      : { kind: "spend", direction: "out", status: "likely" };
  }
  if (!match) return { kind: "note", direction: null, status: null, amount, date, ...(party ? { partyId: party.id } : {}), missing: [] };
  let invoiceId: string | undefined;
  let ambiguousInvoice = false;
  if (match.kind === "collection" && party) {
    const invoices = records.commitments.filter((c) => c.partyId === party.id && c.type === "invoice"
      && (c.settlement ?? "open") === "open" && (amount == null || (c.outstanding ?? c.amount) === amount));
    invoiceId = openInvoice?.id ?? (invoices.length === 1 ? invoices[0]!.id : undefined);
    ambiguousInvoice = !openInvoice && invoices.length > 1;
  }
  const invoice = records.commitments.find((c) => c.id === invoiceId);
  const probability = match.status === "possible"
    ? (/\b(likely|probably|confirmed|verbal)\b/.test(q) ? 0.6 : /\b(maybe|might|hinted|long shot)\b/.test(q) ? 0.3 : 0.4)
    : undefined;
  const missing: string[] = [];
  if (match.direction == null) missing.push("direction");
  if (ambiguousInvoice) missing.push("invoice reference");
  if (!invoice && amount == null) missing.push("amount");
  if (date == null) missing.push("date");
  return {
    kind: match.kind, direction: match.direction, status: match.status,
    ...(probability !== undefined ? { probability } : {}),
    amount: invoice && amount == null ? invoice.amount : amount,
    date,
    ...(party ? { partyId: party.id } : {}),
    ...(invoiceId ? { invoiceId } : {}),
    ...(happened && match.direction === "in" ? { received: true as const } : {}),
    missing,
  };
}

// The owner Signal a confirmed note (or an Ask Neri plan) becomes.
export function ownerSignal(
  id: string, t: { text: string; createdAt: string; via?: string }, r: Pick<ThoughtReading, "invoiceId" | "date" | "amount" | "direction" | "status" | "probability" | "partyId">,
  profile: Profile, state: Signal["state"],
): Signal | null {
  if (!r.date) return null;
  const sourceRef = { system: "owner", record: id, excerpt: { start: 0, end: t.text.length, text: t.text } };
  if (r.invoiceId) {
    return {
      id, channel: "owner", receivedAt: t.createdAt, ...(r.partyId ? { partyId: r.partyId } : {}), commitmentId: r.invoiceId,
      claim: { kind: "date_change", newDate: r.date }, confidence: 0.9, state, sourceRef,
    };
  }
  if (r.amount == null || !r.direction) return null;
  const status = r.status ?? "likely";
  const draft: CommitmentDraft = {
    type: status === "possible" ? "sales_deal" : "plan",
    direction: r.direction,
    ...(r.direction === "in" && readCashMovement(t.text)?.funding ? { funding: true as const } : {}),
    ...(r.partyId ? { partyId: r.partyId } : {}),
    amount: r.amount,
    currency: profile.baseCurrency,
    anchors: { order: r.date, due: r.date },
    status,
    ...(status === "possible" ? { probability: r.probability ?? 0.4 } : {}),
    category: "owner plan",
    sourceRef,
  };
  return {
    id, channel: "owner", receivedAt: t.createdAt, ...(r.partyId ? { partyId: r.partyId } : {}),
    claim: { kind: "plan", draft }, confidence: 0.9, state, sourceRef,
  };
}

// What adding the note would do to the low point: base run vs the run with a trial applied signal.
export function priceThought(t: Thought, records: Records, profile: Profile, asOf: string, fxRates: Record<string, number>, overrides: Override[] = []) {
  const r = t.reading;
  if (r.kind === "note" || !r.date || (r.amount == null && !r.invoiceId)) return null;
  const scenario = { id: "base", kind: "base" as const, overrides };
  const base = forecast(records, profile, scenario, asOf, fxRates);
  if (r.date > (base.days[base.days.length - 1]?.date ?? r.date)) return { outside: true };
  if (r.status === "possible" && r.amount != null) return { pipeline: Math.round(r.amount * (r.probability ?? 0.4)) };
  const trial = ownerSignal(`trial-${t.id}`, t, r, profile, "applied");
  if (!trial) return null;
  const after = forecast({ ...records, signals: [...records.signals, trial] }, profile, scenario, asOf, fxRates);
  return { lowPointDelta: after.lowPoint.amount - base.lowPoint.amount, lowPoint: after.lowPoint };
}
