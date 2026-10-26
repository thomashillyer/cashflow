import { describe, expect, it } from "vitest";
import type { Records } from "../schema/records";
import { readThought } from "./thoughts";

const asOf = "2026-10-25"; // a Sunday
const empty: Records = { parties: [], commitments: [], events: [], signals: [], rules: [], settlements: [], balances: [], evidence: [] };

describe("owner note reading: amounts, direction and dates from the words", () => {
  it.each([
    ["I just won the lottery, I made 1 million dollars", "in", 100_000_000, "2026-10-25"],
    ["I just made 50,000", "in", 5_000_000, "2026-10-25"],
    ["I expect 50,000 loan to come in next week", "in", 5_000_000, "2026-10-26"],
    ["got paid fifty thousand today", "in", 5_000_000, "2026-10-25"],
    ["I earned 1.5m", "in", 150_000_000, "2026-10-25"],
    ["paying rent 6,500 on the 1st", "out", 650_000, "2026-11-01"],
    ["I'll repay the 20k loan in December", "out", 2_000_000, "2026-12-15"],
  ] as const)("%s", (text, direction, amount, date) => {
    expect(readThought(text, empty, asOf)).toMatchObject({ direction, amount, date, missing: [] });
  });

  it("marks money that already arrived as Received, but not an expectation", () => {
    expect(readThought("I just made 50,000", empty, asOf).received).toBe(true);
    expect(readThought("I expect 50,000 loan to come in next week", empty, asOf).received).toBeUndefined();
  });

  it.each(["whats the status of my cash", "Evergreen always pays late"])("leaves %s alone", (text) => {
    const r = readThought(text, empty, asOf);
    expect(r.amount).toBeNull();
    expect(r.date).toBeNull();
  });
});
