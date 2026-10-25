import type Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAskFixture } from "../../scripts/ask-fixture";
import type { CfoVoice, Decision } from "../../schema/ask";
import { ASK_CACHE_DIR, readCache } from "../cache";
import { checkVoice, fallbackVoice, voice, voiceCacheKey, voiceText, type VoiceContext } from "./voice";

const fx = loadAskFixture();
const byId = (id: string) => fx.entries.find((e) => e.id === id)!.decision;
const harbor = byId("afford-harbor-order");   // yes_if, 40% up front by Dec 1, fallback Jaipur +10 days
const december = byId("fix-gap-december");    // act_now, chase INV-1187 by Dec 18
const status = byId("status-this-month");     // on_track
const lookup = byId("lookup-evergreen-lag");  // info

const tmp = () => mkdtempSync(join(tmpdir(), "neri-voice-test-"));
const base = { profile: fx.profile, business: fx.business };
const cached = (over: Partial<VoiceContext> = {}): VoiceContext => ({ ...base, mode: "cache_only", cacheDir: ASK_CACHE_DIR, ...over });
const live = (client: Anthropic): VoiceContext => ({ ...base, mode: "live", client, cacheDir: tmp() });

// A stand-in for the Anthropic client: replies are consumed in order; requests are recorded.
function fakeClient(replies: (object | Error | string)[]) {
  const requests: any[] = [];
  const client = {
    messages: {
      create: async (req: unknown) => {
        requests.push(req);
        const r = replies[Math.min(requests.length - 1, replies.length - 1)]!;
        if (r instanceof Error) throw r;
        return { stop_reason: "end_turn", content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r) }] };
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

// What the model returns for `d`: the committed stand-in, with edits.
const goodOutput = (d: Decision, edit: Partial<Record<keyof CfoVoice, string | null>> = {}) => ({
  ...(readCache(ASK_CACHE_DIR, voiceCacheKey(d, base))!.output as object),
  ...edit,
});

describe("voice with the committed stand-in cache", () => {
  const modelVoiced = fx.entries.filter((e) => !["need_info", "decline", "proposed"].includes(e.decision.verdict));

  it("covers every model-voiced fixture Decision, marked as stand-ins", () => {
    expect(modelVoiced.length).toBeGreaterThanOrEqual(5);
    for (const e of modelVoiced) {
      const entry = readCache(ASK_CACHE_DIR, voiceCacheKey(e.decision, base));
      expect(entry?.source, e.id).toBe("stand-in");
    }
    expect(readdirSync(ASK_CACHE_DIR).filter((f) => f.endsWith(".json"))).toHaveLength(modelVoiced.length);
  });

  it("returns cached voices that pass every check, with the Decision's fields assembled by code", async () => {
    for (const e of modelVoiced) {
      const d = e.decision;
      const a = await voice(d, cached());
      expect(a.usedFallback, e.id).toBe(false);
      expect(checkVoice(a, d), e.id).toEqual([]);
      expect(a.verdict).toBe(d.verdict);
      expect(a.conviction).toBe(d.conviction);
      expect(a.citations).toEqual(d.citations);
      expect(a.scenarioId).toBe(d.scenarioId);
      expect(a.headline.length).toBeGreaterThan(0);
    }
  });

  it("makes the call in the headline, with at most one fallback and no menu", async () => {
    const a = await voice(harbor, cached());
    expect(a.headline).toBe("Yes, if Harbor and Hearth pays 40% up front by Dec 1.");
    expect(a.text.match(/if they refuse/gi)).toHaveLength(1);
    expect(a.text).not.toMatch(/options?|alternatively|you could/i);
    const w = await voice(byId("what-if-evergreen-january"), cached());
    expect(w.scenarioId).toBe("whatif-evergreen-2027-01-15");
  });

  it("text covers every voice field, in order", async () => {
    const a = await voice(harbor, cached());
    expect(a.nextStep).toBeDefined();
    expect(a.whatWouldChange).toBeDefined();
    const order = [a.headline, a.why, a.nextStep!, a.convictionNote, a.whatWouldChange!].map((p) => a.text.indexOf(p));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(a.text).toBe(voiceText(a));
    // Optional fields that are absent are not in the text.
    const s = await voice(status, cached());
    expect(s.nextStep).toBeUndefined();
    expect(s.text).toBe([s.headline, s.why, s.convictionNote, s.whatWouldChange].join("\n"));
  });

  it("skips a cache entry that no longer passes the checks, and falls back in cache_only mode", async () => {
    const dir = tmp();
    const { writeCache } = await import("../cache");
    const key = voiceCacheKey(harbor, base);
    writeCache(dir, { key, promptVersion: "x", model: "x", source: "stand-in", output: goodOutput(harbor, { headline: "Yes, if Harbor and Hearth pays 60% up front by Dec 1." }) });
    const a = await voice(harbor, cached({ cacheDir: dir }));
    expect(a.usedFallback).toBe(true);
  });

  it("falls back on a miss in cache_only mode and never calls the model", async () => {
    const { client, requests } = fakeClient([goodOutput(harbor)]);
    const a = await voice(harbor, { ...base, mode: "cache_only", cacheDir: tmp(), client });
    expect(a.usedFallback).toBe(true);
    expect(requests).toHaveLength(0);
  });
});

describe("voice in live mode: checks, one retry, then the code-built voice", () => {
  it("accepts a good model answer and caches it", async () => {
    const { client, requests } = fakeClient([goodOutput(harbor)]);
    const ctx = live(client);
    const a = await voice(harbor, ctx);
    expect(a.usedFallback).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0].output_config.format.type).toBe("json_schema");
    expect(requests[0].messages[0].content).toContain("<facts>");
    expect(readCache(ctx.cacheDir!, voiceCacheKey(harbor, base))?.source).toBe("live");
    // The second call is a cache hit.
    const again = await voice(harbor, { ...ctx, client: fakeClient([new Error("no calls expected")]).client });
    expect(again.usedFallback).toBe(false);
  });

  it("rejects a model output that lists options, retries with feedback, then falls back", async () => {
    const menu = goodOutput(harbor, {
      headline: "Yes, if Harbor and Hearth pays 40% up front by Dec 1.",
      why: "You have a few options:\n1. Ask Harbor and Hearth for 40% up front.\n2. Ask Jaipur Textiles for 10 more days.\n3. Alternatively, delay the order.",
    });
    const { client, requests } = fakeClient([menu]);
    const a = await voice(harbor, live(client));
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].messages)).toContain("menu language");
    expect(a.usedFallback).toBe(true);
    expect(a.headline).toBe(fallbackVoice(harbor).headline);
  });

  it("rejects a menu in phrasing alone, a second fallback, and a bulleted list", () => {
    const ok = goodOutput(harbor) as CfoVoice;
    const bad = (edit: Partial<CfoVoice>) => checkVoice({ ...ok, ...edit }, harbor).join(" | ");
    expect(bad({ why: "You could ask Harbor and Hearth for 40% up front, or you might ask Jaipur Textiles for 10 more days." })).toMatch(/menu/);
    expect(bad({ why: "Ask Harbor and Hearth for 40% up front, or consider a smaller order." })).toMatch(/menu/);
    expect(bad({ why: `${ok.why} If they say no, ask Jaipur Textiles for 10 more days.` })).toMatch(/at most one fallback/);
    expect(bad({ why: "- Ask Harbor and Hearth for 40% up front.\n- Ask Jaipur Textiles for 10 more days." })).toMatch(/lists/);
    // A fallback the Decision does not have is invented.
    expect(checkVoice({ ...goodOutput(status) as CfoVoice, why: "Your cash stays above the line. If they refuse, wait a week." }, status).join(" ")).toMatch(/no fallback/);
  });

  it("rejects an invented percent: 60% when the Decision allows 40%", async () => {
    const wrong = goodOutput(harbor, { headline: "Yes, if Harbor and Hearth pays 60% up front by Dec 1." });
    const problems = checkVoice(wrong as CfoVoice, harbor);
    expect(problems.join(" ")).toContain('number "60%" is not in the facts');
    // A retry that fixes it is accepted.
    const { client, requests } = fakeClient([wrong, goodOutput(harbor)]);
    const a = await voice(harbor, live(client));
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].messages)).toContain("60%");
    expect(a.usedFallback).toBe(false);
    expect(a.headline).toContain("40%");
  });

  it("rejects a day count or sample count the Decision does not allow", () => {
    const ok = goodOutput(harbor) as CfoVoice;
    expect(checkVoice({ ...ok, why: ok.why.replace("10 more days", "15 more days") }, harbor).join(" ")).toContain('"15 more days"');
    expect(checkVoice({ ...ok, convictionNote: "Medium confidence: Harbor and Hearth has 9 payments on record." }, harbor).join(" ")).toContain('"9 payments"');
  });

  it("rejects a wrong date and a wrong amount", () => {
    const ok = goodOutput(harbor) as CfoVoice;
    expect(checkVoice({ ...ok, headline: "Yes, if Harbor and Hearth pays 40% up front by Dec 8." }, harbor).join(" ")).toContain('date "Dec 8"');
    expect(checkVoice({ ...ok, why: ok.why.replace("$16,000", "$18,000") }, harbor).join(" ")).toContain('amount "$18,000"');
  });

  it("requires the verdict's stance and the recommendation's key fact in the headline", () => {
    const ok = goodOutput(harbor) as CfoVoice;
    expect(checkVoice({ ...ok, headline: "Harbor and Hearth should pay 40% up front by Dec 1." }, harbor).join(" ")).toMatch(/lead with the call/);
    expect(checkVoice({ ...ok, headline: "Yes, if Harbor and Hearth pays up front." }, harbor).join(" ")).toMatch(/key fact/);
    const d = goodOutput(december) as CfoVoice;
    expect(checkVoice({ ...d, headline: "Chase Evergreen Home on INV-1187 by Dec 18." }, december).join(" ")).toMatch(/lead with the call/);
    expect(checkVoice({ ...d, headline: "Act now: chase Evergreen Home on INV-1187." }, december).join(" ")).toMatch(/key fact/);
    expect(checkVoice({ ...goodOutput(status) as CfoVoice }, status)).toEqual([]);
  });

  it("rejects claims that something was sent or paid, loan advice, and the wrong confidence level", () => {
    const ok = goodOutput(harbor) as CfoVoice;
    const bad = (edit: Partial<CfoVoice>) => checkVoice({ ...ok, ...edit }, harbor).join(" | ");
    expect(bad({ nextStep: "I have sent Harbor and Hearth the request for 40% up front by Dec 1." })).toMatch(/sent, paid, or applied/);
    expect(bad({ nextStep: "I'll send the request to Harbor and Hearth by Dec 1." })).toMatch(/sent, paid, or applied/);
    expect(bad({ why: `${ok.why} A bank loan would cover the rest.` })).toMatch(/loan/);
    expect(bad({ convictionNote: "High confidence: Harbor and Hearth has only 4 payments on record." })).toMatch(/Medium confidence/);
    // Reporting what a customer did is not a claim by Neri.
    expect(checkVoice({ ...goodOutput(lookup) as CfoVoice }, lookup)).toEqual([]);
  });

  it("counts a named party's refusal as a fallback, allows loan words in facts, and keeps whatWouldChange to the facts", () => {
    const ok = goodOutput(harbor) as CfoVoice;
    expect(checkVoice({ ...ok, why: `${ok.why} If Evergreen Home refuses, wait a week.` }, harbor).join(" ")).toMatch(/at most one fallback/);
    expect(checkVoice({ ...ok, why: ok.why.replace("If they refuse", "If Jaipur Textiles refuses") }, harbor)).toEqual([]);
    const loan = { ...harbor, recommendation: { ...harbor.recommendation!, action: "Defer the bank loan payment for 40% up front" } };
    expect(checkVoice({ ...ok, why: "Deferring the bank loan payment lifts your lowest point by $16,000, to $37,500." }, loan)).toEqual([]);
    const l = goodOutput(lookup) as CfoVoice;
    expect(checkVoice({ ...l, whatWouldChange: "A late payment would change this." }, lookup).join(" ")).toMatch(/leave whatWouldChange null/);
  });

  it("accepts a headline whose percent the builder left out of allowed.numbers (share is always allowed)", () => {
    const d = { ...harbor, allowed: { ...harbor.allowed, numbers: harbor.allowed.numbers!.filter((n) => n.unit !== "pct") } };
    expect(checkVoice(goodOutput(harbor) as CfoVoice, d)).toEqual([]);
  });

  it("makes one call, not two, when the call itself fails", async () => {
    const { client, requests } = fakeClient([new Error("timeout")]);
    expect((await voice(harbor, live(client))).usedFallback).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("falls back after a refusal, a failed call, and bad JSON, never throwing", async () => {
    for (const reply of [new Error("network down"), "not json", { headline: 1 }]) {
      const { client } = fakeClient([reply]);
      const a = await voice(harbor, live(client));
      expect(a.usedFallback).toBe(true);
      expect(a.verdict).toBe("yes_if");
    }
  });
});

describe("code-built voice", () => {
  const noCall = () => live(fakeClient([new Error("the model must not be called")]).client);
  const draft = { kind: "commitment" as const, draft: { type: "plan", direction: "out", amount: 4_000_000, currency: "USD", status: "likely", anchors: { due: "2026-12-15" } } as any };
  const decision = (over: Partial<Decision>): Decision => ({
    ...status, headlineFacts: [], numbers: [], context: {}, recommendation: undefined, fallback: undefined, assumptions: [],
    convictionReasons: [], whatWouldChange: undefined, allowed: { amounts: [], dates: [], numbers: [] }, citations: [], ...over,
  });

  it("need_info asks the one question, with no model call", async () => {
    const ctx = noCall();
    const d = decision({ intent: "afford", verdict: "need_info", question: "How much is the deposit?", missingData: "No amount to test.", citations: [] });
    const a = await voice(d, ctx);
    expect(a.headline).toBe("How much is the deposit?");
    expect(a.question).toBe("How much is the deposit?");
    expect(a.missingData).toBe("No amount to test.");
    expect(a.verdict).toBe("need_info");
    expect(a.usedFallback).toBe(true);
    expect(a.text).toContain("How much is the deposit?");
  });

  it("decline says why and gives the cash facts, with no model call", async () => {
    const d = decision({
      intent: "out_of_scope" as never, verdict: "decline", missingData: "I can't advise on investments or loans.",
      headlineFacts: [{ label: "Lowest cash point", amount: -550_000, date: "2026-12-25" }], citations: ["inv-INV-1187"],
      allowed: { amounts: [-550_000], dates: ["2026-12-25"], numbers: [] },
    });
    const a = await voice(d, noCall());
    expect(a.headline).toMatch(/can't answer/);
    expect(a.text).toContain("Lowest cash point: −$5,500 on Dec 25");
    expect(a.missingData).toBe("I can't advise on investments or loans.");
    expect(a.usedFallback).toBe(true);
  });

  it("proposed passes the proposal through with an id and applies nothing", async () => {
    const d = decision({ intent: "tell", verdict: "proposed", proposal: draft, citations: ["ask-draft-1"] });
    const a = await voice(d, { ...noCall(), proposalId: "sig-123" });
    expect(a.proposal).toEqual({ ...draft, id: "sig-123" });
    expect(a.headline).toMatch(/proposal for you to confirm/);
    expect(a.text).toMatch(/Nothing changes in your forecast until you confirm/);
    expect(a.text).not.toMatch(/\b(?:sent|paid|applied)\b/i);
    const auto = await voice(d, noCall());
    expect(auto.proposal?.id).toMatch(/^ask-proposal-[0-9a-f]{16}$/);
    expect(auto.proposal?.id).toBe((await voice(d, noCall())).proposal?.id);
  });
});

describe("fallbackVoice", () => {
  it("leads with the call and passes every check for every fixture Decision", () => {
    for (const e of fx.entries) {
      const v = fallbackVoice(e.decision);
      expect(checkVoice(v, e.decision), e.id).toEqual([]);
    }
  });

  it("opens with the verdict and the one recommendation", () => {
    expect(fallbackVoice(harbor).headline).toBe("Yes, if you ask Harbor and Hearth for 40% up front by Dec 1.");
    expect(fallbackVoice(december).headline).toBe("Act now: chase Evergreen Home on INV-1187 for payment by Dec 18.");
    expect(fallbackVoice(status).headline).toBe("You're on track.");
    expect(fallbackVoice({ ...harbor, verdict: "no", recommendation: undefined }).headline).toMatch(/^No,/);
    expect(fallbackVoice({ ...harbor, verdict: "yes", recommendation: undefined, fallback: undefined }).headline).toMatch(/^Yes, you can do this and stay above your \$35,000 safety line/);
  });

  it("states one fallback at most, the confidence in plain words, and the assumptions", () => {
    const v = fallbackVoice(harbor);
    expect(v.why.match(/If they refuse/g)).toHaveLength(1);
    expect(v.why).toContain("Assumptions: linked costs unknown.");
    expect(v.convictionNote).toBe("Medium confidence: Harbor and Hearth has only 4 payments on record.");
    expect(v.nextStep).toBe("Ask Harbor and Hearth for 40% up front by Dec 1.");
    expect(fallbackVoice(status).nextStep).toBeUndefined();
  });

  it("voice() returns it, assembled, when the model is unavailable", async () => {
    const a = await voice(december, { ...base, mode: "cache_only", cacheDir: tmp() });
    expect(a.usedFallback).toBe(true);
    expect(a.headline).toBe(fallbackVoice(december).headline);
    expect(a.text).toBe(voiceText(fallbackVoice(december)));
    expect(a.citations).toEqual(december.citations);
  });
});

describe("fixtures", () => {
  it("decisions.json parses and the cache files are stand-ins", () => {
    expect(fx.entries.map((e) => e.decision.verdict).sort()).toEqual(["act_now", "act_now", "info", "on_track", "yes_if"]);
    for (const f of readdirSync(ASK_CACHE_DIR)) {
      expect(JSON.parse(readFileSync(join(ASK_CACHE_DIR, f), "utf8")).source).toBe("stand-in");
    }
  });
});
