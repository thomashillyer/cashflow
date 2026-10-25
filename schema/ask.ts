// Ask Neri contracts. Source: docs/design/08-claude-layer.md ("Ask Neri: a CFO, not a menu").
//
// Flow: the owner's question -> AskIntent (Claude reads the words; code resolves dates,
// amounts, parties) -> Decision (code runs the engine and picks ONE recommendation with a
// computed conviction) -> CfoAnswer (Claude voices the decision; every figure checked by
// number_check; code-built text on failure). Nothing is sent, paid, or applied: plans and
// rules the owner states become proposals the owner confirms.

import type { CommitmentDraft, Lever, Rule } from "./records";
import type { Answer } from "./forecast";

export type AskIntentKind =
  | "afford"        // "Can I afford a $40K deposit in December?" / "Can I take the Harbor order?"
  | "fix_gap"       // "What should I do about December?" / "How do I get through payroll?"
  | "what_if"       // "What if Evergreen pays in January?" / "What if I hire someone in March?"
  | "status"        // "Am I OK this month?" / "When is my tightest week?"
  | "lookup"        // "When does Evergreen usually pay?" / "What do I owe Jaipur?"
  | "tell"          // owner states a plan or a rule: "Planning a $40K deposit in Dec", "Evergreen always pays 20 days late"
  | "out_of_scope"; // investment/loan product advice, anything unrelated to this business's cash

// Claude's reading of the question, after code has resolved phrases into values.
export type AskIntent = {
  kind: AskIntentKind;
  question: string;                  // verbatim
  partyId?: string;                  // resolved in code from the named party
  commitmentId?: string;             // resolved in code from a reference ("INV-1187", "the Harbor order")
  amount?: number;                   // minor units, parsed in code from the quoted phrase
  currency?: string;
  date?: string;                     // YYYY-MM-DD, resolved in code from the quoted phrase
  dateVague?: string;                // "early January": kept so the answer can say it assumed a date
  draft?: CommitmentDraft;           // afford / what_if / tell(plan): the hypothetical or planned commitment
  rule?: Omit<Rule, "id" | "state">; // tell(rule)
  unresolved: string[];              // what couldn't be resolved ("which supplier?"); non-empty -> ask back
};

export type Conviction = "high" | "medium" | "low";

// What code decided. Claude may only phrase this; it never changes a field.
export type Decision = {
  intent: AskIntentKind;
  verdict: "yes" | "no" | "yes_if" | "act_now" | "on_track" | "info" | "need_info" | "proposed" | "decline";
  headlineFacts: { label: string; amount?: number; date?: string }[];  // the 1-3 numbers the answer leads with
  recommendation?: {
    action: string;                  // code-built imperative: "Ask Harbor and Hearth for a 40% deposit"
    lever?: Lever;
    byDate?: string;                 // act-by date
    cashEffect?: number;             // from simulate(), minor units, base currency
    resultingLowPoint?: { date: string; amount: number };
  };
  fallback?: { action: string; lever?: Lever; cashEffect?: number };  // at most one "if that fails"
  conviction: Conviction;
  convictionReasons: string[];       // computed: "based on 8 of Evergreen's payments", "2 unresolved reviews"
  whatWouldChange?: string;          // one line: the fact that would flip the call
  proposal?: { kind: "commitment"; draft: CommitmentDraft } | { kind: "rule"; rule: Omit<Rule, "id" | "state"> };
  scenarioId?: string;               // the what-if run the chart should show
  citations: string[];               // record ids behind every headline fact
  allowed: { amounts: number[]; dates: string[] };  // every figure the answer may state (for number_check)
  missingData?: string;              // need_info / decline: what's missing or why we won't answer
};

// What the owner sees. Extends Answer additively so existing consumers keep working.
export type CfoAnswer = Answer & {
  verdict: Decision["verdict"];
  headline: string;                  // one sentence, leads with the call: "Yes, if Harbor pays 40% up front by Dec 1."
  why: string;                       // two or three sentences, specific, figures from Decision only
  nextStep?: string;                 // the one thing to do, with the date
  conviction: Conviction;
  convictionNote: string;            // plain words: "High confidence: based on 8 payments and current books."
  whatWouldChange?: string;
  proposal?: Decision["proposal"];   // UI shows a one-tap confirm
  usedFallback: boolean;
};
