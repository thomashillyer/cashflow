// Owner-stated cash movement shared by Notes and Ask Neri. A loan is not inherently an expense.
// Explicit receipts/payments beat a model's generic "plan" label; ambiguous loans need clarification.
import type { Direction } from "../schema/records";

export function readCashMovement(text: string): { direction: Direction | null; funding: boolean } | undefined {
  // "a loan to buy equipment" describes incoming financing, not the later use of the cash.
  const q = text.toLowerCase().replace(/’/g, "'").split(/\b(?:to|for)\s+(?:buy\w*|purchas\w*|pay\w*|spend\w*|repay\w*)\b/)[0]!;
  const financing = /\b(loan|financing|funding|borrow\w*|credit line|line of credit|capital injection)\b/.test(q);
  const negated = /\b(?:not|never|no longer|don't|won't)\s+(?:(?:be|been|going to|expect to)\s+)?(?:get\w*|receiv\w*|expect\w*|borrow\w*)\b/.test(q);
  if (negated) return { direction: null, funding: false };
  const repaymentReceipt = /\brepayment\w*\b/.test(q);
  const fromOwner = /\bfrom (?:us|me)(?=\s*(?:next\b|this\b|tomorrow\b|today\b|on\b|in\b|by\b|[?.!,]|$))/.test(q);
  const toOwner = /\bto (?:us|me)(?=\s*(?:next\b|this\b|tomorrow\b|today\b|on\b|in\b|by\b|[?.!,]|$))/.test(q);
  if (fromOwner && financing) return { direction: "out", funding: false };
  if (toOwner && financing && !/\b(invoice|bill|statement|quote|order)\b/.test(q)) return { direction: "in", funding: !repaymentReceipt };
  const receiptVerb = /\b(receiv(?:e|ed|ing)|get(?:ting)?|expect(?:ing)?|borrow\w*)\b/.test(q);
  const document = /\b(invoice|bill|statement|quote|order)\b/.test(q);
  const cashObject = /\b(money|cash|funds|payment|refund|grant|proceeds|deposit)\b/.test(q);
  const explicitReceipt = /\b(receiv(?:e|ed|ing)|inbound|incoming|refund|pay us|payment from|repayment from)\b/.test(q);
  const expectedExpense = !explicitReceipt && /\b(tax|rent|expense\w*|payroll|repayment\w*)\b/.test(q);
  const bareCash = /\b(?:get(?:ting)?|expect(?:ing)?|receiv(?:e|ed|ing))\s+(?:a\s+)?\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|thousand|million|grand)?(?=\s*(?:next\b|this\b|tomorrow\b|today\b|on\b|in\b|by\b|from\b|[?.!]|$))/.test(q);
  const incoming = !expectedExpense && (/\b(inbound|incoming|loan proceeds|money in|cash in|pay us|payment from)\b/.test(q)
    || (receiptVerb && !document && (financing || cashObject || bareCash))
    || (financing && /\bin for\s+\$?\s*\d/.test(q)));
  const repayment = /\b(repay(?:ing)?|pay(?:ing)? back|lend\w*|loan(?:ing)? to)\b/.test(q)
    || (!incoming && /\brepayment\w*\b/.test(q));
  const expense = !incoming && /\b(spend\w*|buy\w*|purchas\w*|expense\w*|equipment|machine|cooler|truck|forklift|rent|tax|repair\w*)\b/.test(q);
  const outgoing = repayment || expense || /\b(outbound|outgoing|money out|cash out|payment to)\b/.test(q)
    || /\b(?:i|we)(?:'ll|\s+(?:will|am|are))?\s+pay(?:ing)?\b/.test(q);
  if (incoming && outgoing) return { direction: null, funding: false };
  if (incoming) return { direction: "in", funding: financing && !repaymentReceipt };
  if (outgoing) return { direction: "out", funding: false };
  return financing ? { direction: null, funding: false } : undefined;
}
