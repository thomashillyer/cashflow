// Collects run warnings plus structured needs-review reasons (ForecastRun.review), so "unresolved data cannot
// produce an unqualified green briefing" never depends on parsing warning strings.
// push(): informational note only. review(): data is missing or unresolved; records both the warning and a reason.

import type { ForecastRun, ReviewReason } from "../schema/forecast";

export class Notes {
  private readonly warnings: string[] = [];
  private readonly reasons: ReviewReason[] = [];

  push(...messages: string[]): void {
    this.warnings.push(...messages);
  }

  review(code: string, message: string, refs: (string | undefined)[] = []): void {
    this.warnings.push(message);
    this.reasons.push({ code, message, refs: [...new Set(refs.filter((r): r is string => !!r))] });
  }

  merge(other: { warnings: string[]; reasons: ReviewReason[] }): void {
    this.warnings.push(...other.warnings);
    this.reasons.push(...other.reasons);
  }

  get list(): string[] {
    return [...new Set(this.warnings)];
  }

  get reviewReasons(): ReviewReason[] {
    const seen = new Set<string>();
    return this.reasons.filter((r) => {
      const k = `${r.code}\u0000${r.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  get summary(): NonNullable<ForecastRun["review"]> {
    const reasons = this.reviewReasons;
    return { needed: reasons.length > 0, reasons };
  }
}
