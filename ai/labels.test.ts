import { describe, expect, it } from "vitest";
import { fmtDate, humanizeDates, humanizeId, ownerLabel } from "./labels";

describe("humanizeId", () => {
  it("strips the record prefix, splits dashes and camelCase, lowercases", () => {
    expect(humanizeId("rec-payroll")).toBe("payroll");
    expect(humanizeId("rec-est-tax")).toBe("est tax");
    expect(humanizeId("rec-salesTax")).toBe("sales tax");
    expect(humanizeId("revenueModel.dailySales")).toBe("daily sales");
    expect(humanizeId("bill_FP_4408")).toBe("bill fp 4408");
  });
  it("the browser copy gives the same words", async () => {
    const dir = "../app/ui/"; // a variable path: the browser module is plain JS with no types
    const { humanizeId: humanizeIdApp } = await import(/* @vite-ignore */ `${dir}format.js`);
    for (const id of ["rec-payroll", "rec-est-tax", "rec-salesTax", "revenueModel.dailySales", "daily-sales"]) expect(humanizeIdApp(id)).toBe(humanizeId(id));
  });
});

describe("ownerLabel", () => {
  const recurring = [{ id: "rec-rent", name: "Rent" }, { id: "rec-payroll", name: "Payroll", label: "Staff payroll" }];
  it("prefers the profile item's label, then name, lowercased", () => {
    expect(ownerLabel("rec-rent", { recurring })).toBe("rent");
    expect(ownerLabel("rec-payroll", { recurring })).toBe("staff payroll");
  });
  it("uses a record's own name, keeping its case, and the part before ~ for linked costs", () => {
    expect(ownerLabel("p1", { records: [{ id: "p1", name: "Evergreen Home" }] })).toBe("Evergreen Home");
    expect(ownerLabel("rec-rent~freight", { recurring })).toBe("rent");
  });
  it("humanizes an unknown id and never returns an empty label", () => {
    expect(ownerLabel("rec-unknown-thing", { recurring })).toBe("unknown thing");
    expect(ownerLabel(undefined)).toBe("an item");
  });
});

describe("dates", () => {
  it("fmtDate adds the year only when it differs from asOf", () => {
    expect(fmtDate("2026-12-25", "2026-11-16")).toBe("Dec 25");
    expect(fmtDate("2027-01-08", "2026-11-16")).toBe("Jan 8, 2027");
  });
  it("humanizeDates rewrites ISO dates in a sentence but not ids that contain one", () => {
    expect(humanizeDates("INV-1187 moves to 2027-01-08; due 2026-12-01.", "2026-11-16")).toBe("INV-1187 moves to Jan 8, 2027; due Dec 1.");
    expect(humanizeDates("Sales receipt s-2026-10-24 is in EUR", "2026-10-25")).toBe("Sales receipt s-2026-10-24 is in EUR");
  });
});
