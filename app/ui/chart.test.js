import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cashChart } from "./chart.js";

describe("possible-deals pipeline chart", () => {
  it("draws the pipeline supplied by the real engine fixture", () => {
    const run = JSON.parse(readFileSync(new URL("../../fixtures/cascade_trade/forecast_run.json", import.meta.url), "utf8"));
    expect(run.days.some((d) => d.pipeline !== d.closing)).toBe(true);
    expect(cashChart(run)).toContain('<path class="line ghost"');
    expect(cashChart(run, { pipeline: false })).not.toContain('<path class="line ghost"');
  });

  it("keeps a possible-deal cash dip inside the chart when costs land before receipts", () => {
    const run = {
      safetyLine: 10000,
      days: [
        { date: "2026-10-26", closing: 10000, pipeline: 10000 },
        { date: "2026-10-27", closing: 10000, pipeline: -90000 },
        { date: "2026-10-28", closing: 10000, pipeline: 20000 },
      ],
      weeks: [{ start: "2026-10-26" }],
      lowPoint: { date: "2026-10-26", amount: 10000 },
    };
    const path = cashChart(run).match(/<path class="line ghost" d="([^"]+)"/)[1];
    const ys = [...path.matchAll(/[ML][\d.]+,([\d.-]+)/g)].map((m) => Number(m[1]));
    expect(ys.length).toBeGreaterThan(0);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(28);
    expect(Math.max(...ys)).toBeLessThanOrEqual(232);
  });
});
