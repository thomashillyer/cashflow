import { describe, expect, it } from "vitest";
import type { Evidence } from "../../schema/records";
import { dedupeEvidence } from "./dedupe";
import { describe as describeImport, summarize } from "./diagnostics";
import { sha256Hex } from "./hash";
import { childEvidenceId, fileEvidenceId, recordEvidenceId } from "./ids";

const ev = (record: string, receivedAt: string, fileHash?: string): Evidence => ({
  id: recordEvidenceId("upload", record),
  channel: "upload",
  format: "csv",
  receivedAt,
  fileHash,
  extraction: "ok",
  sourceRef: { system: "generic_file", record },
});

describe("hash and ids", () => {
  it("hashes identical bytes identically and different bytes differently", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex(new TextEncoder().encode("abc")));
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
    expect(sha256Hex("")).toHaveLength(64);
  });

  it("derives stable ids from the source", () => {
    expect(recordEvidenceId("zoho_books", "INV-1187")).toBe("ev-zoho_books-INV-1187");
    expect(recordEvidenceId("upload", " a b/c ")).toBe("ev-upload-a-b-c");
    expect(fileEvidenceId("upload", "deadbeefcafe")).toBe("ev-upload-deadbeef");
    expect(childEvidenceId("ev-upload-deadbeef", 2)).toBe("ev-upload-deadbeef-2");
    expect(() => recordEvidenceId("upload", "  ")).toThrow();
  });
});

describe("dedupeEvidence", () => {
  it("leaves an exact repeat unchanged", () => {
    const a = ev("r1", "2026-10-01T00:00:00Z", "h1");
    const r = dedupeEvidence([a], [ev("r1", "2026-10-01T00:00:00Z", "h1")]);
    expect(r.fresh).toEqual([]);
    expect(r.unchanged).toEqual([a]);
  });

  it("skips a byte-identical file arriving under a new name", () => {
    const a = ev("first.csv", "2026-10-01T00:00:00Z", "h1");
    const r = dedupeEvidence([a], [ev("copy.csv", "2026-10-02T00:00:00Z", "h1")]);
    expect(r.fresh).toEqual([]);
    expect(r.unchanged).toEqual([a]);
  });

  it("lets a newer version of the same provider record win", () => {
    const old = ev("r1", "2026-10-01T00:00:00Z", "h1");
    const next = ev("r1", "2026-10-05T00:00:00Z", "h2");
    const r = dedupeEvidence([old], [next]);
    expect(r.fresh).toEqual([next]);
    expect(r.superseded).toEqual([{ old, next }]);
  });

  it("does not let an older version replace a newer one", () => {
    const stored = ev("r1", "2026-10-05T00:00:00Z", "h2");
    const r = dedupeEvidence([stored], [ev("r1", "2026-10-01T00:00:00Z", "h1")]);
    expect(r.fresh).toEqual([]);
    expect(r.unchanged).toEqual([stored]);
  });

  it("dedupes repeats within one batch", () => {
    const r = dedupeEvidence([], [ev("r1", "2026-10-01T00:00:00Z", "h1"), ev("r1", "2026-10-01T00:00:00Z", "h1")]);
    expect(r.fresh).toHaveLength(1);
    expect(r.unchanged).toHaveLength(1);
  });
});

describe("import diagnostics", () => {
  const base = {
    evidenceId: "ev-upload-deadbeef",
    source: "generic_file",
    startedAt: "2026-10-25T10:00:00Z",
    warnings: [],
  };

  it("counts rejected rows once and reports completeness", () => {
    const d = summarize({
      ...base,
      rowsRead: 10,
      rowsImported: 7,
      rowsDuplicate: 1,
      errors: [
        { row: 4, code: "missing_amount", message: "No amount", nextStep: "Enter the amount", raw: "" },
        { row: 4, code: "missing_date", message: "No due date", nextStep: "Enter the date" },
        { row: 9, code: "invalid_amount", message: "Not a number", nextStep: "Fix the cell", raw: "28k?" },
      ],
    });
    expect(d.rowsRejected).toBe(2);
    expect(d.completeness).toBeCloseTo(7 / 9);
    expect(describeImport(d)).toBe("7 of 10 rows imported, 1 already known, 2 need your attention");
  });

  it("is complete when everything was already known", () => {
    const d = summarize({ ...base, rowsRead: 3, rowsImported: 0, rowsDuplicate: 3, errors: [] });
    expect(d.completeness).toBe(1);
  });
});
