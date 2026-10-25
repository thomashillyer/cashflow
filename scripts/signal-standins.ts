// HAND-AUTHORED stand-ins for signal extraction model output (ai/extract/signals.ts), written to look like
// what ai/prompts/extract_signal.md returns: phrases as written plus verbatim quotes from the fixture text.
// They exist so the demo and tests run with no API key. A live run (extractSignals with mode "live") writes
// real answers under the same cache keys to the gitignored live cache, which is read first.
//
//   npx tsx scripts/signal-standins.ts            # print keys
//   npx tsx scripts/signal-standins.ts --write    # write fixtures/cascade_trade/intake/cache/<key>.json

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CACHE_DIR, writeCache } from "../ai/cache";
import { EXTRACTION_MODEL, SIGNAL_PROMPT_VERSION } from "../ai/config";
import { parseEmail, parsePaste, parseWhatsApp, type MessageBundle } from "../ai/extract/message";
import { messageUnits, signalCacheKey, type SignalExtraction } from "../ai/extract/signals";
import { INTAKE_DIR, evidenceIdFor } from "./cache-fixtures";

export const OWNER_INV104_RECEIVED_AT = "2026-10-25T16:00:00Z";

export type SignalFixture = "whatsapp-evergreen.txt" | "owner-message-inv104.txt" | "email-injection.eml";

const q = (value: string, quote: string = value) => ({ value, quote });
const none: SignalExtraction = {
  claim: "none", reference: null, partyName: null, amountMentioned: null, newDatePhrase: null, newAmount: null,
  dependsOn: null, containsInstructions: false, confidence: 0.9,
};

// Fixture bundles, built the way the intake pipeline builds them.
export function loadSignalBundle(name: SignalFixture): MessageBundle {
  const raw = readFileSync(join(INTAKE_DIR, name), "utf8");
  const evidenceId = evidenceIdFor(name);
  if (name.endsWith(".eml")) return parseEmail(raw, { evidenceId });
  if (name === "owner-message-inv104.txt") return parsePaste(raw.trim(), { evidenceId, receivedAt: OWNER_INV104_RECEIVED_AT });
  return parseWhatsApp(raw, { evidenceId });
}

// Outputs per fixture, in the order of the messages that pass triage.
export const SIGNAL_STANDINS: Record<SignalFixture, { channel: "email" | "whatsapp" | "owner"; outputs: SignalExtraction[] }> = {
  "whatsapp-evergreen.txt": {
    channel: "whatsapp",
    outputs: [
      // Cascade's own reminder: restates the due date, promises nothing.
      { ...none, reference: q("INV-1187", "INV-1187 for $28,000"), amountMentioned: q("$28,000", "$28,000") },
      {
        claim: "date_change",
        reference: q("INV-1187", "INV-1187 for $28,000"),
        partyName: null,
        amountMentioned: q("$28,000", "$28,000"),
        newDatePhrase: q("early January", "we'll pay once our customer pays us, early January"),
        newAmount: null,
        dependsOn: "once our customer pays us",
        containsInstructions: false,
        confidence: 0.6,
      },
      // "Same invoice link as before works for us."
      none,
    ],
  },
  "owner-message-inv104.txt": {
    channel: "owner",
    outputs: [{
      claim: "date_change",
      reference: q("INV-104", "invoice INV-104"),
      partyName: q("The customer", "The customer"),
      amountMentioned: null,
      newDatePhrase: q("November 3", "will be paid November 3 instead of October 30"),
      newAmount: null,
      dependsOn: null,
      containsInstructions: false,
      confidence: 0.92,
    }],
  },
  "email-injection.eml": {
    channel: "email",
    outputs: [{ ...none, containsInstructions: true, confidence: 0.1 }],
  },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes("--write");
  for (const [name, standin] of Object.entries(SIGNAL_STANDINS) as [SignalFixture, (typeof SIGNAL_STANDINS)[SignalFixture]][]) {
    const units = messageUnits(loadSignalBundle(name), standin.channel);
    if (units.length !== standin.outputs.length) throw new Error(`${name}: ${units.length} messages pass triage, ${standin.outputs.length} stand-ins`);
    units.forEach((u, i) => {
      const key = signalCacheKey(u.content);
      console.log(`${key}  ${name} ${u.label}`);
      if (write) {
        writeCache(DEFAULT_CACHE_DIR, {
          key, promptVersion: SIGNAL_PROMPT_VERSION, model: EXTRACTION_MODEL,
          source: `hand-authored stand-in for ${name} (${u.label}); replace with a live run`,
          output: standin.outputs[i],
        });
      }
    });
  }
}
