// 13-week cash chart from a ForecastRun's daily closings. Pure SVG, sized to its container.
// The low point is drawn as the sun from the Neri mark; amber fill only where cash is under the line.

import { moneyShort, shortDate, parseDate } from "./format.js";

export function cashChart(run, { width = 640, height = 260, mini = false, ghost = null, whatIf = null, pipeline = true, selectedWeek = null } = {}) {
  const days = run.days;
  const pad = mini ? { t: 14, r: 8, b: 18, l: 8 } : { t: 28, r: 64, b: 28, l: 52 };
  const W = width;
  const H = height;
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  const series = [run, ghost, whatIf].filter(Boolean);
  let lo = Math.min(0, run.safetyLine, ...series.flatMap((r) => r.days.map((d) => d.closing)));
  let hi = Math.max(run.safetyLine, ...series.flatMap((r) => r.days.map((d) => (pipeline && typeof d.pipeline === "number" ? Math.max(d.closing, d.pipeline) : d.closing))));
  const span = hi - lo || 1;
  lo -= span * 0.08;
  hi += span * 0.1;

  const x = (i) => pad.l + (i / (days.length - 1)) * iw;
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ih;
  const pathOf = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  // step line: balance holds until the next event
  const stepPts = (r, key = "closing") => {
    const pts = [];
    r.days.forEach((d, i) => {
      if (i > 0) pts.push([x(i), y(r.days[i - 1][key])]);
      pts.push([x(i), y(d[key])]);
    });
    return pts;
  };

  const main = stepPts(run);
  const safetyY = y(run.safetyLine);
  const zeroY = y(0);
  const bottom = pad.t + ih;
  const id = `c${Math.random().toString(36).slice(2, 8)}`;

  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Cash forecast. Lowest point ${moneyShort(run.lowPoint.amount)} on ${shortDate(run.lowPoint.date)}.">`;
  svg += `<defs><clipPath id="${id}"><rect x="0" y="${safetyY}" width="${W}" height="${Math.max(0, H - safetyY)}"/></clipPath></defs>`;

  // gridlines + y labels
  if (!mini) {
    const ticks = niceTicks(lo, hi, 4);
    for (const t of ticks) {
      svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`;
      svg += `<text class="axis" x="${pad.l - 10}" y="${y(t) + 4}" text-anchor="end">${moneyShort(t)}</text>`;
    }
    // month labels at week starts
    let lastMonth = -1;
    run.weeks.forEach((w) => {
      const i = days.findIndex((d) => d.date === w.start);
      const m = parseDate(w.start).getUTCMonth();
      if (i >= 0 && m !== lastMonth) {
        svg += `<text class="axis" x="${x(i)}" y="${H - 6}">${shortDate(w.start)}</text>`;
        lastMonth = m;
      }
    });
  }

  // selected week band
  if (selectedWeek) {
    const i0 = days.findIndex((d) => d.date === selectedWeek);
    if (i0 >= 0) svg += `<rect class="sel" x="${x(i0)}" y="${pad.t}" width="${x(Math.min(i0 + 7, days.length - 1)) - x(i0)}" height="${ih}"/>`;
  }

  // area + under-the-line fill
  svg += `<path class="area" d="${pathOf(main)}L${x(days.length - 1)},${bottom}L${x(0)},${bottom}Z"/>`;
  svg += `<path class="belowfill" clip-path="url(#${id})" d="${pathOf(main)}L${x(days.length - 1)},${safetyY}L${x(0)},${safetyY}Z"/>`;

  // reference lines
  if (lo < 0) svg += `<line class="zero" x1="${pad.l}" x2="${W - pad.r}" y1="${zeroY}" y2="${zeroY}"/>`;
  svg += `<line class="safety" x1="${pad.l}" x2="${W - pad.r}" y1="${safetyY}" y2="${safetyY}"/>`;
  if (!mini) svg += `<text class="label" x="${W - pad.r + 8}" y="${safetyY + 4}">Your line</text>`;

  // pipeline (possible deals), ghost (before a change), what-if
  if (pipeline && !mini && run.days.every((d) => typeof d.pipeline === "number") && run.days.some((d) => d.pipeline !== d.closing)) {
    svg += `<path class="line ghost" d="${pathOf(stepPts(run, "pipeline"))}"/>`;
  }
  if (ghost) svg += `<path class="line ghost" d="${pathOf(stepPts(ghost))}"/>`;
  svg += `<path class="line" d="${pathOf(main)}"/>`;
  if (whatIf) svg += `<path class="line whatif" d="${pathOf(stepPts(whatIf))}"/>`;

  // low point sun
  const target = whatIf ?? run;
  const li = target.days.findIndex((d) => d.date === target.lowPoint.date);
  if (li >= 0) {
    const cx = x(li);
    const cy = y(target.lowPoint.amount);
    svg += `<circle class="sun-halo" cx="${cx}" cy="${cy}" r="${mini ? 9 : 14}"/>`;
    svg += `<circle class="sun" cx="${cx}" cy="${cy}" r="${mini ? 4.5 : 6}"/>`;
    if (!mini) {
      const anchor = cx > W - 140 ? "end" : "start";
      const dx = anchor === "end" ? -14 : 14;
      svg += `<text class="low-label" x="${cx + dx}" y="${cy + 18}" text-anchor="${anchor}">${moneyShort(target.lowPoint.amount)} on ${shortDate(target.lowPoint.date)}</text>`;
    }
  }

  // week hit areas
  if (!mini) {
    run.weeks.forEach((w) => {
      const i0 = days.findIndex((d) => d.date === w.start);
      if (i0 < 0) return;
      const i1 = Math.min(i0 + 7, days.length - 1);
      svg += `<rect class="hit" data-action="week" data-week="${w.start}" x="${x(i0)}" y="${pad.t}" width="${x(i1) - x(i0)}" height="${ih}"><title>Week of ${shortDate(w.start)}</title></rect>`;
    });
  }

  return svg + "</svg>";
}

function niceTicks(lo, hi, n) {
  const step0 = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}
