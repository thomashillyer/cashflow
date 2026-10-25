import { createHash } from "node:crypto";

// Byte-identical files dedupe on this. Text is hashed as UTF-8.
export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}
