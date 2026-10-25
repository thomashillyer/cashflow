// Live Claude for Ask Neri only (NERI_ASK_MODE=live). The ask path in ai/ask is already cache-first: it reads the
// committed caches before it ever calls the model, so a suggested question stays instant and free. This module
// wraps the client the ask path receives to (a) cap each call at a timeout, (b) count calls against an hourly
// spend guard, and (c) log one line per request (latency, calls, tokens). It never logs the key or the question.

import Anthropic from "@anthropic-ai/sdk";
import type { AiMode } from "./engine";

export const ASK_LIVE_TIMEOUT_MS = 12_000;
export const ASK_LIVE_MAX_PER_HOUR = 200;
const HOUR_MS = 3_600_000;

export type AskLiveOptions = {
  maxPerHour?: number;
  timeoutMs?: number;
  now?: () => number;
  log?: (line: string) => void;
};

export type AskLiveSession = { mode: AiMode; client?: Anthropic; finish: (status: number) => void };

type Usage = { usage?: { input_tokens?: number; output_tokens?: number } };

export class AskLiveGuard {
  private calls: number[] = []; // timestamps of model calls in the last hour
  readonly maxPerHour: number;
  readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(opts: AskLiveOptions = {}) {
    this.maxPerHour = opts.maxPerHour ?? ASK_LIVE_MAX_PER_HOUR;
    this.timeoutMs = opts.timeoutMs ?? ASK_LIVE_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((l) => console.log(l));
  }

  private used(): number {
    const cutoff = this.now() - HOUR_MS;
    this.calls = this.calls.filter((t) => t > cutoff);
    return this.calls.length;
  }

  // Start one Ask request. Live mode over the hourly limit degrades to cache_only (the honest "demo mode" reason).
  begin(askMode: AiMode, base?: Anthropic): AskLiveSession {
    if (askMode !== "live") return { mode: askMode, finish: () => {} };
    if (this.used() >= this.maxPerHour) {
      this.log(`[ask] live limit reached (${this.maxPerHour}/hour): answering from cache only`);
      return { mode: "cache_only", finish: () => {} };
    }
    const started = this.now();
    let calls = 0, inTok = 0, outTok = 0, failed = 0;
    const real = base ?? new Anthropic({ maxRetries: 0 }); // key from ANTHROPIC_API_KEY
    const timeoutMs = this.timeoutMs;
    const create = async (body: unknown, options?: object) => {
      calls++;
      this.calls.push(this.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const call = (real.messages.create as unknown as (b: unknown, o?: object) => Promise<Usage>)
          .call(real.messages, body, { ...options, timeout: timeoutMs, maxRetries: 0 });
        const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs); });
        const res = await Promise.race([call, deadline]);
        inTok += res?.usage?.input_tokens ?? 0;
        outTok += res?.usage?.output_tokens ?? 0;
        return res;
      } catch (err) {
        failed++;
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const client = { messages: { create } } as unknown as Anthropic;
    return {
      mode: "live",
      client,
      finish: (status) => {
        const ms = this.now() - started;
        this.log(`[ask] live status=${status} cache=${calls === 0 ? "hit" : "miss"} model_calls=${calls} failed=${failed} ms=${ms} tokens_in=${inTok} tokens_out=${outTok}`);
      },
    };
  }
}
