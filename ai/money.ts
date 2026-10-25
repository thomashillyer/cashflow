// The one money convention for owner-facing text (briefs, drafts, code-built fallbacks).
// Minor units in, text out, by integer math on the digits. A currency shows as its symbol when Intl has one
// that number_check can read back ("$", "€", "£", "¥", "₹"); otherwise as its ISO code ("CHF 1,000").
// A foreign-currency figure with its base-currency equivalent reads "₹1,000,000 (about $12,000 at today's rate)".

import { minorUnitDigits } from "./normalize";

// Symbols number_check understands, and the currency each one means.
const SYMBOL_CODE: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR" };

export function currencyMarker(currency: string): { text: string; symbol: boolean } {
  try {
    const part = new Intl.NumberFormat("en", { style: "currency", currency })
      .formatToParts(0).find((p) => p.type === "currency")?.value;
    if (part && SYMBOL_CODE[part] === currency) return { text: part, symbol: true };
  } catch { /* unknown code: fall through to the ISO code */ }
  return { text: currency, symbol: false };
}

// "$28,000", "−$5,500" (U+2212 minus), "₹1,000,000", "CHF 1,000".
export function fmtMoney(minor: number, currency: string): string {
  const digits = minorUnitDigits(currency);
  const abs = BigInt(Math.abs(minor));
  const scale = 10n ** BigInt(digits);
  const whole = (abs / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % scale).toString().padStart(digits, "0");
  const num = digits > 0 && frac !== "0".repeat(digits) ? `${whole}.${frac}` : whole;
  const m = currencyMarker(currency);
  const text = m.symbol ? `${m.text}${num}` : `${m.text} ${num}`;
  return minor < 0 ? `−${text}` : text;
}

// A commitment-currency figure; when it is not the base currency and a converted figure is known:
// "₹1,000,000 (about $12,000 at today's rate)". Both figures come from code.
export function fmtWithBase(minor: number, currency: string, base: string, baseMinor?: number): string {
  const own = fmtMoney(minor, currency);
  return currency === base || baseMinor === undefined ? own : `${own} (about ${fmtMoney(baseMinor, base)} at today's rate)`;
}
