// Bounded zip reading. Declared sizes in a zip header are attacker-controlled, so sizes are enforced
// on the bytes actually inflated: a stream is read with a running cap and abandoned when it is exceeded.
// Used before anything inflates a whole archive (XLSX is a zip) or opens an entry (WhatsApp export).

import type { Readable } from "node:stream";
import JSZip from "jszip";

export class ZipTooLarge extends Error {
  constructor(message = "zip too large") { super(message); this.name = "ZipTooLarge"; }
}

export const MAX_ZIP_ENTRIES = 500;
export const MAX_ZIP_TOTAL_BYTES = 50_000_000;

type Read = { size: number; bytes?: Uint8Array };

// Inflate one entry, reading at most `cap` bytes. Returns undefined when the entry is larger.
function read(entry: JSZip.JSZipObject, cap: number, keep: boolean): Promise<Read | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const stream = entry.nodeStream("nodebuffer") as unknown as Readable;
    stream.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > cap) { done = true; stream.destroy(); resolve(undefined); return; }
      if (keep) chunks.push(c);
    });
    stream.on("end", () => { if (!done) { done = true; resolve({ size, ...(keep ? { bytes: new Uint8Array(Buffer.concat(chunks)) } : {}) }); } });
    stream.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
}

export async function readCapped(entry: JSZip.JSZipObject, cap: number): Promise<Uint8Array | undefined> {
  return (await read(entry, cap, true))?.bytes;
}

// Throws ZipTooLarge unless the archive really inflates to a safe size. Measured by streaming; nothing is kept.
export async function assertZipBudget(bytes: Uint8Array): Promise<void> {
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  if (entries.length > MAX_ZIP_ENTRIES) throw new ZipTooLarge("too many files");
  let remaining = MAX_ZIP_TOTAL_BYTES;
  for (const e of entries) {
    const r = await read(e, remaining, false);
    if (r === undefined) throw new ZipTooLarge();
    remaining -= r.size;
  }
}
