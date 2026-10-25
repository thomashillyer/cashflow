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
- **No advice for sale, no specific investments.** System prompt states the partner and idle-cash rules from `07-warnings-and-ranking.md`.

## Demo safety and cost

- Response cache keyed on `hash(prompt template id, inputs, forecastRun.inputsHash)`. In demo mode, cache misses fall back to the plain code-built text instead of waiting.
- Prompt caching for the stable parts (system prompt, profile, schema).
- Brief text is generated once per forecast run, not per page load.

## Prompt files

Keep prompts in `ai/prompts/` as plain text with named slots: `extract_signal`, `map_columns`, `propose_profile`, `write_brief`, `ask_neri`, `draft_message`. Each lists its input fields, its output schema, and two examples.
