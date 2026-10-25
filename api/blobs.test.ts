import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isOwnKey, MemoryBlobs, ORIGINALS_BUCKET, originalKey, safeFileName, SupabaseBlobs } from "./blobs";
import { sha256Hex } from "../adapters/core/hash";

const bytes = (s: string) => new TextEncoder().encode(s);
const H = sha256Hex(bytes("hello"));

describe("safeFileName", () => {
  it.each([
    ["ar-aging.csv", "ar-aging.csv"],
    ["../../etc/passwd", "passwd"],
    ["..\\..\\windows\\system32\\evil.exe", "evil.exe"],
    ["/abs/path/file.pdf", "file.pdf"],
    ["", "file"],
    [undefined, "file"],
    ["....", "file"],
    ["___", "file"],
    [".hidden", "hidden"],
    ["a b\tc\nd.csv", "a_b_c_d.csv"],
    ["请款单12.pdf", "12.pdf"],
    ["résumé final.xlsx", "resume_final.xlsx"],
    ["x\u0000y.csv", "x_y.csv"],
    ["a/../b.csv", "b.csv"],
    ["name..with..dots.csv", "name.with.dots.csv"],
  ] as const)("%j -> %j", (input, expected) => expect(safeFileName(input)).toBe(expected));

  it("bounds a very long name and keeps the extension", () => {
    const n = safeFileName(`${"a".repeat(500)}.xlsx`);
    expect(n.length).toBeLessThanOrEqual(80);
    expect(n.endsWith(".xlsx")).toBe(true);
  });

  it("never produces a path separator, a leading dot, or a name outside the allowed alphabet", () => {
    for (const evil of ["../x", "..", ".", "a/b", "a\\b", "%2e%2e/x", "x;rm -rf", "<script>.html", "con:", "~root"]) {
      expect(safeFileName(evil), evil).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
    }
  });
});

describe("originalKey / isOwnKey", () => {
  it("is business + hash + sanitized name, never the client's path", () => {
    const k = originalKey("biz_1", H, "../../etc/passwd.csv");
    expect(k).toBe(`biz_1/evidence/${H}-passwd.csv`);
    expect(isOwnKey("biz_1", k)).toBe(true);
  });

  it("rejects a bad business id or hash instead of building a path from them", () => {
    for (const biz of ["", "../x", "a/b", "a b", "x".repeat(65)]) expect(() => originalKey(biz, H, "f.csv"), biz).toThrow();
    for (const hash of ["", "abc", "Z".repeat(64), `${H}0`, "../".repeat(30)]) expect(() => originalKey("biz", hash, "f.csv"), hash).toThrow();
  });

  it("recognises only keys of exactly that shape under the caller's own business", () => {
    const k = originalKey("biz_a", H, "f.csv");
    expect(isOwnKey("biz_b", k)).toBe(false);
    for (const bad of [
      `biz_a/evidence/../biz_b/evidence/${H}-f.csv`, `biz_a/evidence/${H}-../f.csv`, `biz_a/evidence/${H}-f/g.csv`, `biz_a/evidence/${H}f.csv`,
      `biz_a/other/${H}-f.csv`, `/biz_a/evidence/${H}-f.csv`, `biz_a/evidence/${H.toUpperCase()}-f.csv`, "biz_a/evidence/", "", "biz_a",
    ]) expect(isOwnKey("biz_a", bad), bad).toBe(false);
  });
});

describe("MemoryBlobs", () => {
  it("storing the same bytes twice is one object with one key", async () => {
    const blobs = new MemoryBlobs();
    const a = await blobs.putOriginal("biz", { bytes: bytes("hello"), fileName: "a.csv", mime: "text/csv", hash: H });
    const b = await blobs.putOriginal("biz", { bytes: bytes("hello"), fileName: "a.csv", mime: "text/csv", hash: H });
    expect(a).toBe(b);
    expect(blobs.objects.size).toBe(1);
    expect(new TextDecoder().decode((await blobs.getOriginal("biz", a))!.bytes)).toBe("hello");
  });

  it("another business cannot read a key, and a hand-made path returns nothing", async () => {
    const blobs = new MemoryBlobs();
    const key = await blobs.putOriginal("biz_a", { bytes: bytes("secret"), fileName: "a.csv", hash: sha256Hex(bytes("secret")) });
    expect(await blobs.getOriginal("biz_b", key)).toBeNull();
    expect(await blobs.getOriginal("biz_a", key.replace("biz_a", "biz_a/../biz_b"))).toBeNull();
    expect(await blobs.getOriginal("biz_a", `biz_a/evidence/${H}-missing.csv`)).toBeNull();
  });

  it("does not let a later write change stored bytes (a copy is kept)", async () => {
    const blobs = new MemoryBlobs();
    const b = bytes("hello");
    const key = await blobs.putOriginal("biz", { bytes: b, hash: H });
    b[0] = 0;
    expect(new TextDecoder().decode((await blobs.getOriginal("biz", key))!.bytes)).toBe("hello");
  });
});

// A stand-in for supabase.storage: only what SupabaseBlobs calls.
function fakeSupabase(over: { uploadError?: { message: string; statusCode?: string }; downloadError?: { message: string; statusCode?: string }; data?: Blob | null } = {}) {
  const calls: { op: string; bucket: string; key: string; opts?: unknown }[] = [];
  const sb = {
    storage: {
      from: (bucket: string) => ({
        upload: async (key: string, _b: unknown, opts: unknown) => { calls.push({ op: "upload", bucket, key, opts }); return { data: null, error: over.uploadError ?? null }; },
        download: async (key: string) => { calls.push({ op: "download", bucket, key }); return { data: over.downloadError ? null : over.data ?? new Blob(["hello"], { type: "text/csv" }), error: over.downloadError ?? null }; },
      }),
    },
  } as unknown as SupabaseClient;
  return { sb, calls };
}

describe("SupabaseBlobs", () => {
  it("uploads to the private bucket without overwriting, under the sanitized key", async () => {
    const { sb, calls } = fakeSupabase();
    const key = await new SupabaseBlobs(sb).putOriginal("biz", { bytes: bytes("hello"), fileName: "../../x.csv", mime: "text/csv", hash: H });
    expect(key).toBe(`biz/evidence/${H}-x.csv`);
    expect(calls).toEqual([{ op: "upload", bucket: ORIGINALS_BUCKET, key, opts: { contentType: "text/csv", upsert: false } }]);
  });

  it("an object that already exists is the idempotent case, any other error is a failure", async () => {
    const dup = fakeSupabase({ uploadError: { message: "The resource already exists", statusCode: "409" } });
    await expect(new SupabaseBlobs(dup.sb).putOriginal("biz", { bytes: bytes("hello"), hash: H })).resolves.toContain(H);
    const bad = fakeSupabase({ uploadError: { message: "bucket not found", statusCode: "404" } });
    await expect(new SupabaseBlobs(bad.sb).putOriginal("biz", { bytes: bytes("hello"), hash: H })).rejects.toThrow(/could not store original/);
  });

  it("never asks Storage for a key that is not this business's own", async () => {
    const { sb, calls } = fakeSupabase();
    const blobs = new SupabaseBlobs(sb);
    expect(await blobs.getOriginal("biz_b", `biz_a/evidence/${H}-f.csv`)).toBeNull();
    expect(await blobs.getOriginal("biz_a", `biz_a/evidence/../../x`)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("reads bytes back; a missing object is null, an outage throws", async () => {
    const ok = fakeSupabase();
    const got = await new SupabaseBlobs(ok.sb).getOriginal("biz", `biz/evidence/${H}-f.csv`);
    expect(new TextDecoder().decode(got!.bytes)).toBe("hello");
    const missing = fakeSupabase({ downloadError: { message: "Object not found", statusCode: "404" } });
    expect(await new SupabaseBlobs(missing.sb).getOriginal("biz", `biz/evidence/${H}-f.csv`)).toBeNull();
    const down = fakeSupabase({ downloadError: { message: "upstream timeout", statusCode: "503" } });
    await expect(new SupabaseBlobs(down.sb).getOriginal("biz", `biz/evidence/${H}-f.csv`)).rejects.toThrow(/could not read original/);
  });
});
