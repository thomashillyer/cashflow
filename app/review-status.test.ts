import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { forecast } from "../engine/forecast";
import type { ForecastRun } from "../schema/forecast";
import type { Profile } from "../schema/profile";
import type { Records } from "../schema/records";

const asOf = "2026-10-25";
const profile: Profile = {
  ...JSON.parse(readFileSync(new URL("../profiles/trading.json", import.meta.url), "utf8")),
  recurring: [], safetyLine: { kind: "fixed", amount: 0 },
};
const records: Records = {
  parties: [], commitments: [], events: [], signals: [], rules: [], settlements: [], evidence: [],
  balances: [{ id: "bank", account: "main", amount: 10000000, currency: "USD", asOf, sourceRef: { system: "owner", record: "bank" } }],
};
const base = { id: "base", kind: "base" as const, overrides: [] };
const makeRun = (r: Records = records) => forecast(r, profile, base, asOf, {});

// Execute the real screen and narration code with browser boot disabled. This catches contradictory
// all-clear text in any of the owner-facing paths without introducing a DOM dependency.
const main = readFileSync(new URL("./main.js", import.meta.url), "utf8");
const boot = main.lastIndexOf("\nstart().catch");
if (boot < 0) throw new Error("The app boot entrypoint changed; update this screen harness.");
const ui = main.slice(0, boot).replace(/^import .*;\n/gm, "");
function render(run: ForecastRun, mode = "live") {
  const drive = { innerHTML: "" };
  const supplied = {
    brief: { run, three: [], rest: [], watch: [], combined: null, shortfall: null },
    ctx: { parties: [], business: { asOf }, profile, partyOf: () => undefined },
    account: { owner: "Owner" },
  };
  const escape = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return runInNewContext(`${ui}
    Object.assign(app, supplied);
    renderDrive();
    ({ summary: summary(), html: viewToday(), spoken: spokenBrief(), panel: typeof forecastReviewPanel === "function" ? forecastReviewPanel() : "", drive: drive.innerHTML });`, {
    supplied, drive, api: { account: () => null, mode },
    document: { addEventListener() {}, querySelector: () => drive },
    window: { addEventListener() {}, NERI_LOCK_MINUTES: 0 },
    localStorage: { getItem: () => null }, addEventListener() {}, setInterval() {},
    money: String, dayDate: String, shortDate: String, esc: escape,
    addDays: (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10),
    speakable: String, greeting: () => "Hello", canSpeak: false, canListen: false,
    ASK_HINTS: [], CONNECTORS: [], CATEGORIES: [], logo: "", icon: {},
  }) as { summary: { headline: string; take: string; tone: string }; html: string; spoken: string[]; panel: string; drive: string };
}

describe("forecast checks in the owner brief", () => {
  it("shows the engine's no-data reason instead of an all-clear when the action list is empty", () => {
    const run = makeRun();
    expect(run.review?.needed).toBe(true);
    expect(run.firstBelowSafety).toBeUndefined();
    const output = render(run);
    expect(output.summary.tone).toBe("review");
    expect(output.html).toContain("No forecast yet");
    expect(output.html).toContain('href="#/sources"');
    expect(output.html).toContain("Add your first source");
    for (const text of [output.html, output.spoken.join(" "), output.drive]) {
      expect(text).not.toMatch(/good shape|Nothing needs you today|above your line for all/);
      expect(text).toContain("forecast");
    }
  });

  it("keeps the normal calm state only when the engine explicitly reports clean checks", () => {
    const run = makeRun({ ...records, commitments: [{ id: "invoice", type: "invoice", amount: 10000, currency: "USD", anchors: { due: "2026-11-02" }, status: "committed", sourceRef: { system: "owner", record: "invoice" } }] });
    expect(run.review).toEqual({ needed: false, reasons: [] });
    const output = render(run);
    expect(output.summary.tone).toBe("ok");
    expect(output.html).toContain("Nothing needs you today");
    expect(output.panel).toBe("");
  });

  it("treats older runs without check results as unverified", () => {
    const run = makeRun();
    delete run.review;
    const output = render(run);
    expect(output.summary.tone).toBe("review");
    expect(output.html).toContain("forecast checks aren't available yet");
    expect(output.html).not.toContain("good shape");
    expect(output.html).toContain("This server hasn't provided forecast checks");
    expect(output.html).not.toContain("Refresh your sources");
  });

  it("explains that the static preview cannot provide checks without an impossible refresh action", () => {
    const run = makeRun();
    delete run.review;
    const output = render(run, "preview");
    expect(output.summary.tone).toBe("review");
    expect(output.html).toContain("This preview doesn't include forecast checks");
    expect(output.html).toContain("Forecast checks require the live Neri server");
    expect(output.panel).not.toContain('href="#/sources"');
    expect(output.html).not.toContain("Refresh your sources");
    expect(output.spoken.join(" ")).not.toContain("Check the forecast items");
  });

  it("keeps cash-gap warnings visible and routes proposed messages to Review", () => {
    const run = makeRun();
    run.firstBelowSafety = asOf;
    run.lowPoint.amount = -100;
    run.review = { needed: true, reasons: [{ code: "unconfirmed_signal", message: "A payment date needs your OK.", refs: ["signal"] }] };
    const output = render(run);
    expect(output.summary.tone).toBe("short");
    expect(output.summary.headline).toContain("below your line");
    expect(output.html).toContain('href="#/review"');
    expect(output.spoken.join(" ")).toContain("A payment date needs your OK.");
    expect(output.summary.take).not.toContain("timing problem");
  });

  it("escapes source-derived reason text", () => {
    const run = makeRun();
    run.review!.reasons[0]!.message = '<script>alert("source")</script>';
    const output = render(run);
    expect(output.panel).not.toContain("<script>");
    expect(output.panel).toContain("&lt;script&gt;");
  });
});
