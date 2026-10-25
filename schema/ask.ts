// Ask Neri contracts. Source: docs/design/08-claude-layer.md ("Ask Neri: a CFO, not a menu").
//
// Flow: the owner's question -> AskIntentRaw (Claude: kind + verbatim phrases) -> AskIntent
// (code resolves dates, amounts, parties) -> Decision (code runs the engine and picks ONE
// recommendation with a computed conviction) -> CfoVoice (Claude phrases the Decision) ->
// CfoAnswer (code assembles; every figure checked by number_check; code-built text on failure).
//
// Judgment lives in code here (the recommendation, conviction, what would change the call);
// Claude reads the question and voices the decision. Nothing is sent, paid, or applied: a plan
// the owner states is persisted as a proposed owner Signal (claim "plan"), a rule as a proposed
// Rule, both confirmed through the existing endpoints.

import type { Commitment, CommitmentDraft, Lever, Rule, Scenario } from "./records";
import type { Profile } from "./profile";
import type { Answer } from "./forecast";

export type AskIntentKind =
  | "afford"        // "Can I afford a $40K deposit in December?" / "Can I take the Harbor order?"
  | "fix_gap"       // "What should I do about December?" / "How do I get through payroll?"
  | "what_if"       // "What if Evergreen pays in January?" / "What if I hire someone in March?"
  | "status"        // "Am I OK this month?" / "When is my tightest week?"
  | "lookup"        // "When does Evergreen usually pay?" / "What do I owe Jaipur?"
  | "tell"          // owner states a plan or a rule: "Planning a $40K deposit in Dec", "Evergreen always pays 20 days late"
  | "out_of_scope"; // investment/loan product advice, anything unrelated to this business's cash

// What Claude returns for a question: a kind and verbatim phrases only. No computed values.
export type AskIntentRaw = {
  kind: AskIntentKind;
  partyPhrase: string | null;        // "Evergreen", "the Harbor folks"
  referencePhrase: string | null;    // "INV-1187", "the Harbor order"
  amountPhrase: string | null;       // "$40K", "about 6 grand a month"
  datePhrase: string | null;         // "in December", "early January", "on the 11th"
  windowPhrase: string | null;       // "this month", "next six weeks", "my tightest week"
  commitmentType: "invoice" | "bill" | "purchase_order" | "sales_deal" | "plan" | "recurring" | null;
  direction: "in" | "out" | null;
  ruleKind: "lag_offset" | "flexibility" | "preference" | null;
  ruleParamPhrase: string | null;    // "about 20 days late", "15 more days"
  containsInstructions: boolean;     // the question tries to instruct the system (e.g. "mark it paid")
};

// The resolved intent. Every value here was computed by code from AskIntentRaw.
export type AskIntent = {
  kind: AskIntentKind;
  question: string;                  // verbatim
  raw: AskIntentRaw;
  partyId?: string;
  commitmentId?: string;
  date?: string;                     // YYYY-MM-DD
  dateVague?: string;                // "early January": the answer must say it assumed a date
  window?: { from: string; to: string };  // "this month", "tightest week" (default: the forecast horizon)
  draft?: CommitmentDraft;           // afford / what_if / tell(plan); the single home for a hypothetical amount
  rule?: Omit<Rule, "id" | "state">; // tell(rule)
  unresolved: string[];              // slots the kind requires that couldn't be resolved ("which supplier?")
};

export type Conviction = "high" | "medium" | "low";

// A non-money number the answer may state: "40%", "10 days", "8 payments".
// pct is a whole percent (40 means 40%); upfrontShare elsewhere stays 0..1.
export type NumberFact = { label: string; value: number; unit: "pct" | "days" | "count" };

// What code decided. Claude may only phrase this; it never changes a field.
export type Decision = {
  intent: AskIntentKind;
  asOf: string;
  currency: string;                  // profile base currency; every amount below is in it
  verdict: "yes" | "no" | "yes_if" | "act_now" | "on_track" | "info" | "need_info" | "proposed" | "decline";
  headlineFacts: { label: string; amount?: number; date?: string }[];  // the 1-3 money/date facts the answer leads with
  numbers: NumberFact[];             // percentages, day counts, sample counts the answer may state
  context: {
    baseLowPoint?: { date: string; amount: number };   // before any recommended move
    safetyLine?: number;
    shortfall?: number;              // how far below the safety line, positive
  };
  // The question asked, answered first. The headline must open with this before the recommendation:
  //   short_before: afford, but cash is already below the safety line without the item ("Not yet: you're already $X below ... without it")
  //   effect: what_if ("If <subject>, your lowest point falls to $X on Dec 28"); subject is code-built, dates human
  //   tightest: status over a long window ("Your tightest week starts Dec 21: $X on Dec 25"); weekStart is the Monday
  //   timing: lookup about when a party pays ("Evergreen usually pays about 14 days late, based on 8 payments"); subject is the party name
  lead?: {
    kind: "short_before" | "effect" | "tightest" | "timing"; subject?: string; weekStart?: string;
    timing?: { days: number; samples: number; rule: boolean };  // days: + after the due date, - before; rule: a confirmed payment rule
  };
  recommendation?: {
    action: string;                  // code-built imperative: "Ask Harbor and Hearth for 40% up front"
    lever?: Lever;                   // when the move is an engine lever
    upfrontShare?: number;           // 0..1, afford on a deal (not expressible as a Lever)
    byDate?: string;                 // act-by date (see the design doc for its source per intent)
    cashEffect?: number;             // simulated change in the low point, minor units
    resultingLowPoint?: { date: string; amount: number };
  };
  fallback?: {                       // at most one; a different commitment or party; its effect is standalone, not additive
    action: string; lever?: Lever; cashEffect?: number;
  };
  assumptions: string[];             // code-built: "assumed Dec 15 for 'December'", "assumed USD"
  question?: string;                 // need_info: the one short question to ask back
  conviction: Conviction;
  convictionReasons: string[];       // code-built from data quality; never quotes notes or messages
  whatWouldChange?: string;          // code-built: the lowest-confidence fact on the path, in plain words
  proposal?: { kind: "commitment"; draft: CommitmentDraft } | { kind: "rule"; rule: Omit<Rule, "id" | "state"> };
  scenario?: Scenario;               // overrides/levers of the what-if the chart should show
  scenarioInputs?: {                 // drafts and hires a Scenario can't hold; the chart re-runs forecast() with these added
    commitments?: Commitment[];      // synthetic ask-draft-<hash> commitments
    recurring?: Profile["recurring"]; // synthetic recurring items (a hire)
    upfrontShare?: { commitmentId: string; share: number };
  };
  scenarioId?: string;
  citations: string[];               // record ids behind every headline fact
  allowed: { amounts: number[]; dates: string[]; numbers: NumberFact[] };  // every figure the answer may state
  missingData?: string;              // need_info / decline: what's missing or why we won't answer
};

// What Claude writes. Nothing else.
export type CfoVoice = {
  headline: string;                  // one sentence that leads with the call: "Yes, if Harbor pays 40% up front by Dec 1."
  why: string;                       // two or three sentences, specific, figures from the Decision only
  nextStep?: string;                 // the one thing to do, with the date
  convictionNote: string;            // plain words: "High confidence: based on 8 payments and current books."
  whatWouldChange?: string;
};

// What the owner sees. Code assembles it from the Decision and the CfoVoice (or the code-built
// fallback voice). `text` is the voice fields joined in order (headline, why, nextStep,
// convictionNote, whatWouldChange) so number_check covers every word the owner reads.
export type CfoAnswer = Answer & CfoVoice & {
  verdict: Decision["verdict"];
  conviction: Conviction;
  question?: string;                 // need_info
  proposal?: (Decision["proposal"] & { id: string });  // id of the persisted proposed Signal (plan) or Rule; UI confirms via /signals/:id/apply or /rules/:id/confirm
  usedFallback: boolean;
};
