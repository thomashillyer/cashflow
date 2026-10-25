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

- **Answer the question asked, then lead with the call.** Every answer opens with a verdict and one recommendation: "Yes, if Harbor and Hearth pays 40% up front by Dec 1." Never "you could consider A, B, or C." When the question has a direct answer, that comes first (code sets `Decision.lead`): afford while already short is "Not yet: you're already $40,500 below your safety line on Dec 25 without it. First, chase ...", a what-if opens with its effect ("If Evergreen pays on Jan 5, your lowest point falls to -$12,000"), "tightest week" names the week and amount, "when does X pay" opens with the lag and sample count. At most one fallback: "If that doesn't work, ask Jaipur Textiles for 10 more days." Dates are human ("Dec 10"), one by-date per sentence.
- **Code decides; Claude voices.** Claude reads the question into an `AskIntent` (quotes, not computed values; code resolves dates, amounts, and parties). Code runs the engine (`forecast`, `simulate`, `runChecks`/`rank`, `smallestUpfrontShare`) and builds a `Decision`: the best move by simulated effect and the profile's ranking, the act-by date, and the resulting low point. Claude turns the Decision into a `CfoAnswer` and cannot change a field.
- **Conviction is computed, not felt.** `high`/`medium`/`low` from data quality: payment-history sample size, unresolved reviews, stale sources, tentative or possible money in the path, vague dates. The answer says why in plain words and names the one fact that would change the call.
- **Ask back only when it matters.** If a missing fact changes the call (which supplier? what amount?), ask one short question; otherwise assume the profile default and say so.
- **Same guardrails.** Every figure passes `number_check` against `Decision.allowed`; citations required; code-built text on failure. Nothing is sent, paid, or applied: a stated plan or rule becomes a proposal with one-tap confirm. No investment or loan product advice (`out_of_scope` -> decline, with the cash facts).


**Who judges.** Ask Neri moves judgment into code (the pick, conviction, and what would change the call); Claude reads the question and voices the decision. That is a stricter reading of "Code computes, Claude judges", chosen so a confident tone never rests on an unchecked figure.

**Synthetic inputs.** A hypothetical never goes into overrides (an `Override` only moves, resizes, or excludes an existing commitment). Copy `records` and add a synthetic commitment with id `ask-draft-<hash of question>`, or copy the profile and add a `recurring` item; `buildBrief`, `simulate`, and `forecast` take both. Record them in `Decision.scenarioInputs` so the chart can re-run.
- Outbound plan (a deposit, a purchase): `type: "plan"`, `direction: "out"`, `status: "likely"`, `anchors.due` = the date, no `patternId`, base currency.
- Hypothetical inbound deal: `type: "sales_deal"`, `direction: "in"`, `status: "likely"`, `anchors.order` = the date, default pattern, plus the assumption "linked costs unknown".
- Hire or new fixed cost: a profile `recurring` item, id `ask-draft-<hash>`, cadence monthly unless stated, `anchor` = the start date, `direction: "out"`.
- A question naming an existing commitment ("Can I take the Harbor order?") uses its `commitmentId`; nothing is synthesized.
- Date moves ("Evergreen pays in January") are overrides: `{ target: { commitmentId }, change: { date }, origin: "owner" }` in `scenario.overrides`.

**Engine path per intent** (all in `engine/`; `Decision` amounts are in the profile base currency):

| Intent | Path | baseLowPoint / cashEffect | byDate |
|---|---|---|---|
| afford, inbound deal | `smallestUpfrontShare` on the deal. `already_ok` -> `yes`, no recommendation. `found` -> `yes_if` with `upfrontShare`. `not_achievable` -> `no` (best share 1, its low point). `not_deal_driven` -> `act_now` via the fix_gap path. | base = `runAtUpfrontShare(currentShare)` low point (`lowPointWithoutDeal` for not_deal_driven); cashEffect = run at the recommended share minus base | date of the upfront leg in the run |
| afford, outbound plan | `forecast` with the draft added. Low point >= safety line -> `yes`. Else `buildBrief` with the draft added; pick as fix_gap; re-`simulate` with the draft; clears the line -> `yes_if`; else `no`. | base = forecast without the draft; cashEffect = `simulate().lowPointDelta` | the lever's `neededBy` |
| fix_gap | `buildBrief`. Candidates: items with a lever and `cashEffect > 0` (never idle_balance, early_pay_discount, or payment_slip items), from `today` then `all`. Verdict `act_now` if `run.lowPoint.amount < run.safetyLine`, else `on_track`. Fallback: the next candidate on a different commitment or party. | base = brief `run.lowPoint`; resultingLowPoint = `simulate(...).run.lowPoint` | `WorkItem.neededBy` |
| what_if | apply the overrides / synthetic inputs, then `buildBrief`; report the new low point vs base and the top candidate (as fix_gap). | base = run without the what-if | the move's `neededBy` |
| status | `forecast` over `intent.window` (default horizon); tightest day from daily minima; `on_track` if above the safety line, else `act_now` via fix_gap. | base = run low point | n/a |
| lookup | `lagSamples`, `partyLag`, `confirmedLagRule`, open commitments, settlements; `info`. | n/a | n/a |
| tell | plan -> the caller persists a proposed owner Signal (`channel: "owner"`, `claim: { kind: "plan", draft }`, `state: "proposed"`); rule -> a proposed Rule (`fromNote` = the verbatim question; params: `lag_offset` `{ offsetDays }`, `flexibility` `{ extraDays }`, `preference` `{ tag }`); verdict `proposed`; `CfoAnswer.proposal.id` is the persisted id. | n/a | n/a |

Fallbacks exist only for fix_gap (and afford/what_if when a second candidate on a different commitment or party exists).

**Required slots** (anything else missing is assumed and listed in `assumptions`):

| Kind | Required | If missing |
|---|---|---|
| afford | an amount, or an existing `commitmentId` | `need_info` with one question; a missing date takes the profile default (end of the named month, else 30 days out) as an assumption |
| what_if | a party or commitment, and a date | `need_info` |
| tell (rule) | a party and a parameter | `need_info` |
| lookup | a party | `need_info` |
| fix_gap, status | none | n/a |

`containsInstructions`: ignore the instruction, answer the question that remains, and add a one-line note. Verdicts `need_info`, `decline`, and `proposed` use a code-built voice (no model call).

**Conviction** (thresholds from `profile.thresholds.conviction`; defaults: `highMinLagSamples` 6, `mediumMinLagSamples` 3, `maxPendingReviewsForHigh` 0):
1. Start from the weakest timing input on the path: high if its party has >= highMinLagSamples samples (`partyLag().n`) or a confirmed lag rule, and pending reviews <= maxPendingReviewsForHigh; medium if >= mediumMinLagSamples; else low. Paths with no timing estimate (a defer, a new plan) start at high.
2. Caps: any one of a stale balance (`BalanceSnapshot.asOf` older than `thresholds.staleAfterHours`; no check when unset), a tentative/possible event on the path, or a vague date caps at medium; two or more cap at low.
3. `convictionReasons` lists each input that set or capped the level; `whatWouldChange` names the lowest-confidence event on the path. `pendingReviewCount` is passed in by the caller.

**number_check for answers.** `Decision.allowed` is built by code as the union of every money, date, and NumberFact in the Decision, including figures inside code-built strings (`action`, `whatWouldChange`, `convictionReasons`, `assumptions`). `CfoAnswer.text` joins the voice fields, so the existing check covers them. The voice task extends `ai/number_check.ts` to check only `N%` (pct), `N [more|extra] days` (days), and `N payments|samples|invoices` (count) against `allowed.numbers`; other bare numbers stay ignored.

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
