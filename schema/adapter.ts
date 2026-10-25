// Adapter interface. Source: docs/design/04-adapters.md.

import type { Profile } from "./profile";
import type { Records } from "./records";

export type PullInput =
  | { mode: "live"; since?: string }
  | { mode: "file"; path: string; mime: string }
  | { mode: "text"; text: string };

export type RawItem = { id: string; payload: unknown };

export type NormalizeContext = { businessId: string; receivedAt: string };

// What an adapter emits: any subset of the shared records. Future cash events are
// never emitted; `events` holds actuals only (bank lines, past payments).
export type Normalized = Partial<Records>;

export interface Adapter {
  id: string;                         // "zoho_books", "bank_csv", "email_m365"
  kind: "books" | "bank" | "signals" | "owner";
  pull(input: PullInput): Promise<RawItem[]>;
  normalize(raw: RawItem[], profile: Profile, ctx: NormalizeContext): Normalized;
}
