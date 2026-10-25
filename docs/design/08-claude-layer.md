# 08 — Claude layer

Claude never computes a forecast or a ranking. It reads, explains, answers, and drafts, always through tools that return engine results, so every figure it says traces to a record.

## Four jobs

| Job | Input | Output | Model tier |
|---|---|---|---|
| Extraction | Message text, unfamiliar spreadsheet headers, first data import | Signal records, column mappings, a proposed profile (structured outputs) | Small for triage, larger for extraction |
| Brief writing | Ranked work items with evidence | A title and a one-line "why" per item | Larger |
| Ask Neri | Owner's question | An answer with citations, plus a redrawn forecast when it's a what-if | Larger |
| Drafting | A work item and its party | A reminder email, an extension request, a reply | Larger |

Pick current model IDs from the Anthropic docs on the day; keep them in one config file.

## Ask Neri: a CFO, not a menu

The owner asked for a CFO that infers and recommends with conviction, not a list of options to choose from. Contracts: `schema/ask.ts`.

- **Lead with the call.** Every answer opens with a verdict and one recommendation: "Yes, if Harbor and Hearth pays 40% up front by Dec 1." Never "you could consider A, B, or C." At most one fallback: "If they refuse, ask Jaipur Textiles for 10 more days."
- **Code decides; Claude voices.** Claude reads the question into an `AskIntent` (quotes, not computed values; code resolves dates, amounts, and parties). Code runs the engine (`forecast`, `simulate`, `runChecks`/`rank`, `smallestUpfrontShare`) and builds a `Decision`: the best move by simulated effect and the profile's ranking, the act-by date, and the resulting low point. Claude turns the Decision into a `CfoAnswer` and cannot change a field.
- **Conviction is computed, not felt.** `high`/`medium`/`low` from data quality: payment-history sample size, unresolved reviews, stale sources, tentative or possible money in the path, vague dates. The answer says why in plain words and names the one fact that would change the call.
- **Ask back only when it matters.** If a missing fact changes the call (which supplier? what amount?), ask one short question; otherwise assume the profile default and say so.
- **Same guardrails.** Every figure passes `number_check` against `Decision.allowed`; citations required; code-built text on failure. Nothing is sent, paid, or applied: a stated plan or rule becomes a proposal with one-tap confirm. No investment or loan product advice (`out_of_scope` -> decline, with the cash facts).


**Who judges.** Ask Neri moves judgment into code (the pick, conviction, and what would change the call); Claude reads the question and voices the decision. That is a stricter reading of "Code computes, Claude judges", chosen so a confident tone never rests on an unchecked figure.

**Engine path per intent** (all in `engine/`; `Decision` amounts are in the profile base currency):

| Intent | Path | byDate |
|---|---|---|
| afford (inbound deal) | inject the draft as a synthetic commitment (`ask-draft-<hash>`), then `smallestUpfrontShare`; `cashEffect` = `runAtUpfrontShare(...).lowPoint.amount` minus the base low point; `not_deal_driven` -> verdict `act_now` with the fix_gap path | date of the upfront leg in the run |
| afford (outbound plan, e.g. a deposit) | inject the draft; `forecast` base vs with-draft; low point stays at or above the safety line -> `yes`; else `buildBrief` with the draft in `baseOverrides`, take the top lever, re-`simulate` to confirm it clears the line -> `yes_if`; nothing clears it -> `no` | the lever's `neededBy` |
| fix_gap | `buildBrief`; recommendation = `today[0]` (or `all[0]` if `today` is empty below the rank floor; none -> `on_track`); fallback = the next item on a different commitment or party | `WorkItem.neededBy` |
| what_if | express as overrides (a date move is a `chase`-style `assumeDate` on the commitment; a hire is a recurring draft); run `buildBrief` with them as `baseOverrides`; report the new low point and the top move; `scenario` carries the overrides for the chart | the move's `neededBy` |
| status | `forecast` over `intent.window` (default horizon); tightest day from daily minima; `on_track` when above the safety line, else `act_now` via fix_gap | n/a |
| lookup | `partyLag`/`lagStats`, open commitments, settlements; `info` | n/a |
| tell | plan -> a proposed owner Signal (`claim: "plan"`); rule -> a proposed Rule; verdict `proposed` | n/a |

**Conviction inputs** (thresholds from `profile.thresholds.conviction`, defaults: high needs >= 6 lag samples and 0 pending reviews; medium needs >= 3): lag samples (`partyLag().n`; a confirmed lag rule counts as high, not "no history"), pending intake reviews (passed in by the caller, `pendingReviewCount`), stale balances (`BalanceSnapshot.asOf` vs `thresholds.staleAfterHours`), tentative or possible money on the path (`run.events` status/confidence), and vague dates (`intent.dateVague`). `whatWouldChange` names the lowest-confidence event on the path.

**number_check for answers.** `CfoAnswer.text` joins the voice fields, so the existing check covers them; percentages and day/count numbers are checked against `Decision.allowed.numbers`, an extension of `ai/number_check.ts` that the voice task adds.

| Question | Intent | Decision |
|---|---|---|
| "Can I afford a $40K deposit in December?" | afford | yes / no / yes_if with the cheapest change that keeps cash above the safety line |
| "What should I do about December?" | fix_gap | act_now with the top-ranked lever and act-by date |
| "What if Evergreen pays in January?" | what_if | the new low point and the one move that covers it; scenarioId for the chart |
| "Am I OK this month?" | status | on_track / act_now with the tightest day |
| "When does Evergreen usually pay?" | lookup | info, from lag stats and history |
| "Evergreen always pays 20 days late" | tell | proposed rule for one-tap confirm |

## Tools exposed to Claude

```ts
get_forecast(scenarioId?)                 // weekly balances, low point, free cash
simulate(levers: Lever[])                 // change in low point for a what-if; returns a scenarioId
get_records(ids | filter)                 // invoices, bills, events, signals, with sourceRefs
get_party(id)                             // tags, notes, payment history, lag stats
propose_commitment(c) / propose_rule(r)   // saved as proposed; owner confirms in the UI
```

There is no tool that sends a message, pays a bill, or moves money. Drafts are returned as text for the owner to copy or open in their mail client.

## Output contract

Every user-facing response uses:

```ts
type Answer = {
  text: string;               // plain English, profile vocabulary
  citations: string[];        // record ids; UI renders as tappable links
  scenarioId?: string;        // when a what-if was simulated, UI redraws the chart
  missingData?: string;       // set instead of guessing
};
```

## Guardrails

- **Number check.** After each response, code extracts every amount and date from `text` and compares them with values present in that turn's tool results (amounts within rounding; dates exact). A figure with no match triggers one regeneration; a second failure falls back to the plain warning text built by code.
- **Citations required.** An answer with amounts and no citations fails the check.
- **Say "I don't know."** If the tools return nothing relevant, set `missingData` and say what is missing instead of estimating.
- **Messages are data.** Email and WhatsApp text goes only to the extraction prompt, wrapped as data. The brief, Ask Neri, and drafting prompts never see raw message text, only extracted Signal fields and short excerpts.
- **Explain why, specifically.** "Cash dips below your line in week 6 because Customer A pays 22 days late on average and the tax payment lands that week," not "risk detected."
- **Wording is computed, not guessed (brief and drafts).** The facts carry `asOf`, `commitment.dueStatus` ("not yet due" / "due today" / "overdue by N days"), `neededByStatus`, each expected date's `againstLowPoint`, and a `display` string per amount from one formatter (`ai/money.ts`: symbol when number_check can read it back, else ISO code; a converted figure reads "₹1,000,000 (about $12,000 at today's rate)"). Rules: tense follows `dueStatus` ("is due Dec 10", never "was due", for a not-yet-due invoice); "after your lowest point"; `neededBy` is "ask by"/"act by", never "settled by"; chase drafts get a code-computed `payBy` (the due date or earlier) and no later date.
- **No advice for sale, no specific investments.** System prompt states the partner and idle-cash rules from `07-warnings-and-ranking.md`.

## Demo safety and cost

- Response cache keyed on `hash(prompt template id, inputs, forecastRun.inputsHash)`. In demo mode, cache misses fall back to the plain code-built text instead of waiting.
- Prompt caching for the stable parts (system prompt, profile, schema).
- Brief text is generated once per forecast run, not per page load.

## Prompt files

Keep prompts in `ai/prompts/` as plain text with named slots: `extract_signal`, `map_columns`, `propose_profile`, `write_brief`, `ask_neri`, `draft_message`. Each lists its input fields, its output schema, and two examples.
