// Original files, messages and pasted text behind Evidence.storageKey (issue #155).
//
// The key is built here from the business id and the sha256 of the bytes, never from the client's file
// name: `<businessId>/evidence/<sha256>-<safe file name>`. Same business and same bytes is one object, so
// storing twice is a no-op. The file name part is sanitized (ASCII, no path characters, bounded) and exists
// only so a downloaded file keeps a recognisable name. Reads accept only a key of exactly that shape under
// the caller's own business prefix, so a key from another business or a hand-made path returns nothing.
//
// Supabase Storage is reached with the service-role key from server code only (see the bucket migration);
// MemoryBlobs backs tests and NERI_STORE=memory.

import type { SupabaseClient } from "@supabase/supabase-js";

export const ORIGINALS_BUCKET = "evidence-originals";
export const MAX_ORIGINAL_BYTES = 10 * 1024 * 1024;

export type OriginalInput = { bytes: Uint8Array; fileName?: string; mime?: string; hash: string };
export type StoredOriginal = { bytes: Uint8Array; mime?: string };

export interface Blobs {
  // Idempotent: same business and hash gives the same key and writes nothing the second time.
  putOriginal(businessId: string, original: OriginalInput): Promise<string>;
  // null when the key is not one of this business's originals, or the object is missing.
  getOriginal(businessId: string, storageKey: string): Promise<StoredOriginal | null>;
}

const BUSINESS_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,100}$/;

// A file name that is safe inside an object key and in a Content-Disposition header: the last path segment,
// ASCII letters, digits, dot, dash and underscore only, no leading dot, at most 80 characters, extension kept.
export function safeFileName(name: string | undefined): string {
  const last = (name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = last.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^[._-]+/, "").replace(/\.{2,}/g, ".");
  if (!cleaned || !/[A-Za-z0-9]/.test(cleaned)) return "file";
  if (cleaned.length <= 80) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 9 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, 80 - ext.length) + ext;
}

export function originalKey(businessId: string, hash: string, fileName?: string): string {
  if (!BUSINESS_ID.test(businessId)) throw new Error("invalid business id for storage");
  if (!HASH.test(hash)) throw new Error("invalid content hash for storage");
  return `${businessId}/evidence/${hash}-${safeFileName(fileName)}`;
}

// True only for a key this module could have produced for this business.
export function isOwnKey(businessId: string, key: string): boolean {
  if (!BUSINESS_ID.test(businessId)) return false;
  const prefix = `${businessId}/evidence/`;
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length);
  return HASH.test(rest.slice(0, 64)) && rest[64] === "-" && SAFE_NAME.test(rest.slice(65));
}

export class MemoryBlobs implements Blobs {
  readonly objects = new Map<string, StoredOriginal>();
  async putOriginal(businessId: string, o: OriginalInput): Promise<string> {
    const key = originalKey(businessId, o.hash, o.fileName);
    if (!this.objects.has(key)) this.objects.set(key, { bytes: new Uint8Array(o.bytes), ...(o.mime ? { mime: o.mime } : {}) });
    return key;
  }
  async getOriginal(businessId: string, key: string): Promise<StoredOriginal | null> {
    if (!isOwnKey(businessId, key)) return null;
    const o = this.objects.get(key);
    return o ? { bytes: new Uint8Array(o.bytes), ...(o.mime ? { mime: o.mime } : {}) } : null;
  }
}

export class SupabaseBlobs implements Blobs {
  constructor(private readonly sb: SupabaseClient) {}

  async putOriginal(businessId: string, o: OriginalInput): Promise<string> {
    const key = originalKey(businessId, o.hash, o.fileName);
    const { error } = await this.sb.storage.from(ORIGINALS_BUCKET).upload(key, o.bytes, {
      contentType: o.mime ?? "application/octet-stream", upsert: false,
    });
    // The same bytes were stored before: that is the idempotent case, not a failure.
    if (error && !/already exists|duplicate|409/i.test(`${error.message} ${(error as { statusCode?: string }).statusCode ?? ""}`)) {
      throw new Error(`could not store original: ${error.message}`);
    }
    return key;
  }

  async getOriginal(businessId: string, key: string): Promise<StoredOriginal | null> {
    if (!isOwnKey(businessId, key)) return null;
    const { data, error } = await this.sb.storage.from(ORIGINALS_BUCKET).download(key);
    if (error || !data) {
      if (!error || /not found|404|does not exist/i.test(`${error.message} ${(error as { statusCode?: string }).statusCode ?? ""}`)) return null;
      throw new Error(`could not read original: ${error.message}`);
    }
    return { bytes: new Uint8Array(await data.arrayBuffer()), ...(data.type ? { mime: data.type } : {}) };
  }
}
