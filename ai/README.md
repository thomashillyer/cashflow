# Person 4 (AI) integration guide

For the API/app lane (person 3) and the integration lane (person 5): which `ai/` function each route calls, what goes in, what comes out, and what to persist. Design: [`docs/design/08-claude-layer.md`](../docs/design/08-claude-layer.md), [`docs/TECHNICAL_PLAN.md`](../docs/TECHNICAL_PLAN.md) sections 4, 5, 6, 8.

**Runnable version of everything below:** [`ai/integration.example.test.ts`](integration.example.test.ts). It runs the flow against the `cascade_trade` fixtures with an in-memory store, no network, no key (`npx vitest run ai/integration.example.test.ts`). The snippets here are copied from it (`store` is the test's in-memory stand-in for Supabase; `BUSINESS`, `MODE`, `NOW` are constants at the top of the file). Copy from the test, not from memory.

## Rules the routes must keep

- **Nothing in `ai/` writes to the store.** Every function is pure, or touches only the response cache. You persist what it returns.
- **`ingest` never applies anything.** Cash changes only when the owner confirms a proposal (`applyProposal`) or applies a signal (`state: "applied"`).
- **No send, no pay.** `draftMessage` returns text. There is no function that sends or moves money, and the routes must not add one.
- **Messages are data.** Never put message text into a prompt, a log, or an error. `ingest` routes it through the extraction schema only.
- **Same input, same ids.** Re-importing a file proposes the same ids, and applying a proposal twice is a no-op, so retries are safe.

## Endpoint map

| Route | Person 4 function | Persist |
|---|---|---|
| `POST /import/:adapter` | `ingest(input, ctx)` | Evidence, candidates, proposals, signals (state `proposed`) |
| `GET /review` | none (read what import stored) | nothing |
| `POST /review/:id/confirm` | `applyProposal(records, proposal, { now })` | changed records, proposal `confirmed`, revision +1 |
| `POST /signals/:id/apply` / `dismiss` | none (state change) | signal `applied` / `dismissed`, revision +1 |
| `GET /brief` | `writeBrief(items, ctx)` | nothing (cached text on disk) |
| `POST /work-items/:id/draft` | `draftMessage(item, ctx)` | nothing (text only) |

## `POST /import/:adapter`

Flow: adapter captures and stores the original (person 1) -> `loadRecords` -> `ingest` -> persist -> return everything Review needs.

```ts
// The adapter (person 1) has already captured the file/paste and stored the original; the route passes
// its ids through input.source and Person 4 does the reading.
async function importRoute(store: Store, input: IntakeInput) {
  const { records, storeRevision } = store;                       // loadRecords(db, businessId)
  const result = await ingest(input, { records, storeRevision, business: BUSINESS, mode: MODE, now: NOW });

  // Persist for Review (service role). Use the individual upsertEvidence / upsertIntakeCandidates /
  // upsertChangeProposals / upsertSignals helpers. NOT upsertRecords: it bumps the store revision and
  // would make the proposals you just created stale.
  store.records = mergeEvidence(store.records, result.evidence);  // upsertEvidence
  for (const c of result.candidates) store.candidates.set(c.id, c); // upsertIntakeCandidates
  for (const p of result.proposals) store.proposals.set(p.id, p);   // upsertChangeProposals
  store.records.signals.push(...result.signals.filter((s) => !store.records.signals.some((x) => x.id === s.id))); // upsertSignals (state "proposed")

  return result;   // { evidence, candidates, proposals, signals, notes } is everything Review renders
}
```

- **Input** (`IntakeInput`): `{kind:"pdf", bytes, fileName?}`, `{kind:"email"|"whatsapp", raw, attachments?}`, `{kind:"paste", text, receivedAt}`, `{kind:"sheet", sheets: SheetContent[], currency?, dayFirst?, columnMapping?}`. Every kind takes `source?: { evidenceId?, sourceRef?, receivedAt? }`.
- **Person 1 boundary:** adapters capture, store the original file (`Evidence.storageKey`), read XLSX/CSV into `SheetContent`, fetch URLs, and assign source ids. Pass those ids as `input.source` so Evidence and `sourceRef` point at your stored original. With no `source`, ids come from a content hash (stable, so fine for uploads and paste). Person 4 never captures or stores files.
- **`ctx`**: `records` and `storeRevision` from one `loadRecords` call (same snapshot; every proposal is pinned to that revision), `business` (`{name, aliases?}` from the profile), `mode`, `now` (ISO instant, pass the clock in), optional `timeZone` (relative dates like "next Friday"), `client`, `cacheDir`.
- **Output** (`IntakeResult`): `evidence[]` (parents, attachments, link children, deduped), `candidates[]`, `proposals[]` (one per candidate, all `proposed`), `signals[]` (all `proposed`), `notes[]` (`{scope, text}`, plain text; scope is a candidate, proposal, signal, or evidence id).
- **Persist** with the service role, using the individual helpers in `db/records.ts`: `upsertEvidence`, `upsertIntakeCandidates`, `upsertChangeProposals`, `upsertSignals`. **Do not use `upsertRecords` here:** it bumps the store revision and would make the proposals you just created stale.
- **Bad input does not throw.** An unreadable, oversized, unsupported, or uncached file comes back as Evidence plus a `review` proposal and a note that says what to upload. Show the note; do not return a 5xx.
- **Live latency:** a live extraction can take up to about 30 s per document (one retry). Budget 60 s for the request, or return an import id and let the UI poll.
- **Preview counts** for the import response: `candidates.length`, `proposals` grouped by `action`, `signals.length`.

## `GET /review`

Person 4 adds no code here. Return the pending queue from what import stored: `change_proposals` with `state = "proposed"` (join their candidates and Evidence), `signals` with `state = "proposed"`, and the notes. What the UI must render:

- **Fields.** `candidate.fields.*` are `Field<T>`: `found` (show the value and the quote from `evidence[].text`, with page/sheet/row when present), `missing` (show "not found" and the reason; never `0` or an empty string), `conflict` (show every `values[]` entry with its quote and make the owner pick).
- **Proposal.** `action` (`create` new commitment, `link` evidence only, `update` change fields, `conflict`, `review`), `reasons[]` (why this match, plain text), `targetCommitmentId` (the invoice it matched), `ops` (what confirming will do), `conflicts[]` (`{field, values[]}` with evidence for each side; the stored side is quoted as "system record: value").
- **Ambiguous matches.** `proposal.matchCandidates[]` and `signal.matchCandidates[]` are `{commitmentId, reasons[]}`: show each with its reasons and let the owner pick. A `review`/`conflict` proposal with no `ops` cannot be confirmed until the owner resolves it (see `ownerEdits` below).
- **Notes** (`IntakeNote.text`, `candidate.notes`, `proposal.reasons`) are plain text. Render as text, never as HTML or markdown, and never interpret them. Message excerpts can be hostile.
- **Links are not payment.** `fields.paymentUrl` and `invoiceUrl` are links to open, labelled "Pay online" / "Invoice". Never show a link, a "paid" stamp (`fields.statedStatus`), or a promise as "paid". Only a `createSettlement` op from identified payment evidence records a payment.
- **One invoice, many channels.** A PDF, an email, a chat message, and a sheet row for the same invoice come back as `link` proposals on the same commitment. Show "already in your books, add as evidence", not a second invoice.
- **POs.** For a `linkCommitments` op, show `poRemaining(records, poId)` (`ai/reconcile/match.ts`; minor units; `undefined` when the id is not a PO) as "left to invoice on this PO".

## `POST /review/:id/confirm`

Flow: validate scope and idempotency key -> check revisions -> `applyProposal` -> persist -> return a fresh projection.

```ts
// Today the confirm_change_proposal RPC validates and locks but raises NOT_IMPLEMENTED when a proposal
// has ops. Until the RPC applies ops, the server applies them here with applyProposal and writes the
// result. Ideally this whole function runs in one transaction (extend the RPC or wrap it in one).
function confirmRoute(store: Store, proposalId: string, expectedRevision: number) {
  const proposal = store.proposals.get(proposalId);
  if (!proposal) throw new HttpError(404, "NOT_FOUND", "That item is no longer in Review.");
  // applyProposal does not check revisions; the route does (the RPC does the same check).
  if (expectedRevision !== store.storeRevision || proposal.expectedStoreRevision !== store.storeRevision) {
    throw new HttpError(409, "STALE_REVIEW", "Your books changed since you opened this. Review it again.");
  }
  try {
    const applied = applyProposal(store.records, proposal, { now: NOW });
    // Persist: upsertRecords(db, businessId, applied.records) (idempotent upserts, bumps the revision)
    // and upsert the proposal as { ...proposal, state: "confirmed", decidedAt: NOW }.
    store.records = applied.records;
    store.storeRevision += 1;
    store.proposals.set(proposal.id, { ...proposal, state: "confirmed", decidedAt: NOW });
    return { storeRevision: store.storeRevision, affectedRecordIds: applied.affectedRecordIds, warnings: applied.warnings };
  } catch (err) {
    if (err instanceof ApplyError) throw new HttpError(APPLY_ERROR_STATUS[err.code], err.code, err.message);
    throw err;
  }
}
```

**Say it plainly:** `confirm_change_proposal` (the RPC, wrapped by `confirmChangeProposal` in `db/records.ts`) validates and locks, and raises `NOT_IMPLEMENTED` (501) when the proposal has ops. So persons 3 and 5 **apply the ops server-side with `applyProposal` and upsert the result**, or extend the RPC to apply them (the SQL TODO lists the ops). Either way:

- Do the revision check, the writes, the proposal state change, and the revision bump in **one transaction** if you can. Separate calls can double-apply under two concurrent confirms, and one transaction is what makes the plan's "second confirm sees the first" hold.
- `applyProposal` does **not** check revisions or idempotency keys. Compare `proposal.expectedStoreRevision` and the owner's expected revision to the current store revision first (409 `STALE_REVIEW`), and replay a completed identical `Idempotency-Key` before anything else.
- **Pure.** It returns `{ records, affectedRecordIds, warnings }` and never mutates its input. Persist `records` with `upsertRecords` (idempotent on `(business_id, id)`, bumps the revision), and the proposal as `{ ...proposal, state: "confirmed", decidedAt }`. Show `warnings` (unresolved facts) to the owner.
- **Evidence** is stored at import. If you skipped that, `mergeEvidence(records, result.evidence)` adds it to the records first (existing ids win).
- **Owner edits.** To resolve a `conflict`/`review` item or fix a value, set `proposal.ownerEdits` (`CommitmentFieldChange[]`) from the request body before calling `applyProposal`. Edits win over extracted values and apply to `targetCommitmentId` (or the commitment the proposal creates). A conflict/review proposal with no ops and no edits is `NOTHING_TO_APPLY`.
- **Dismiss** is a state change (`state: "dismissed"`, `decidedAt`); nothing in `ai/` is involved.

`ApplyError` (`ai/reconcile/apply.ts`) has a `code`:

| `code` | Meaning | HTTP |
|---|---|---|
| `STALE_REVIEW` | A field changed since review (`updateCommitment.from` no longer matches) | 409 |
| `NOT_PROPOSED` | Already confirmed or dismissed | 409 |
| `OVER_ALLOCATED` | Linked invoices would exceed the PO amount | 409 |
| `NOTHING_TO_APPLY` | `conflict`/`review` with no ops and no owner edits | 422 |
| `UNKNOWN_TARGET` | The commitment the proposal points at is gone | 404 |

```ts
// ApplyError.code -> HTTP status for POST /review/:id/confirm. `Record<ApplyErrorCode, number>` makes
// tsc fail if a new code is added without a status.
export const APPLY_ERROR_STATUS: Record<ApplyErrorCode, number> = {
  STALE_REVIEW: 409,       // the books changed since the owner looked: refresh Review, do not resubmit
  NOT_PROPOSED: 409,       // already confirmed or dismissed (a double click or a retry)
  OVER_ALLOCATED: 409,     // linked invoices would exceed the PO; the owner picks how much to allocate
  NOTHING_TO_APPLY: 422,   // a conflict/review item with no ops and no ownerEdits: the owner must resolve it
  UNKNOWN_TARGET: 404,     // the commitment the proposal points at no longer exists
};
```

On any 409, refresh Review and show the item again; do not resubmit the stale decision. Return `{ error: { code, message, fieldIssues, retryable }, revision }` per the technical plan, and keep message text and amounts out of logs. The RPC's own errors keep the status on `StoreError.status`: `STALE_REVIEW`, `IDEMPOTENCY_CONFLICT`, `PROPOSAL_NOT_PENDING`, `PROPOSAL_UNRESOLVED` are 409, `NOT_FOUND` is 404, `NOT_IMPLEMENTED` is 501.

A confirmed `link` proposal adds evidence only: no new commitment, no new cash event. A confirmed `create` proposal adds the commitment (and party) with ids derived from the source, such as `inv-INV-1203`.

## `POST /signals/:id/apply` and `/dismiss`

Signals (a customer says it will pay later, an amount change, a cancellation) are not ChangeProposals. They are confirmed through their own `state`.

```ts
// The owner confirmed. Flipping state is the whole write; the engine applies "applied" signals as
// overrides on the next run, and the store revision moves so the forecast and brief are recomputed.
function applySignalRoute(store: Store, signalId: string): Signal {
  const signal = store.records.signals.find((s) => s.id === signalId);
  if (!signal) throw new HttpError(404, "NOT_FOUND", "That message is no longer in Review.");
  if (signal.state !== "proposed") throw new HttpError(409, "NOT_PROPOSED", `This message was already ${signal.state}.`);
  const applied: Signal = { ...signal, state: "applied" };   // dismiss is the same with state: "dismissed"
  store.records = { ...store.records, signals: store.records.signals.map((s) => (s.id === signalId ? applied : s)) };
  store.storeRevision += 1;
  return applied;
}
```

- Persist the signal with `upsertSignals` and bump the store revision (`bump_store_revision`). The engine treats `applied` signals as overrides (`engine/adjust.ts`: `date_change`, `cancel`; `engine/expand.ts`: `amount_change`, `new_commitment`, `plan`). `proposed` and `dismissed` signals change nothing.
- **Show the owner the words:** `signal.sourceRef.excerpt.text` is the quote, `claim` the proposed change, `confidence` a hint (never authorization). A signal can never apply itself.
- **Vague dates.** When the message says "end of the month" or "early next week", `claim.newDate` is only a suggestion. The signal has `confidence <= 0.5` and a note scoped to the signal id with the text `owner must confirm the date`. Show it as "around <date> (they wrote: <quote>)" with a date picker, and apply only after the owner picks or accepts a date; if they change it, apply `{ ...signal, claim: { ...signal.claim, newDate } }`. Never show a suggested date as fact.
- Other notes to show as plain text: sender not a confirmed party (confidence capped at 0.5), a conditional promise, an ambiguous match.

## `GET /brief`

Flow: engine (`runChecks` + `rank`, person 5) produces ranked `WorkItem[]` for one `ForecastRun` -> `writeBrief` writes only the words.

```ts
// `items` are the engine's ranked WorkItems (runChecks + rank, person 5) for the run you are returning;
// `run`, `records`, `profile` are that same run's inputs, so every number in the words matches the chart.
async function briefRoute(items: WorkItem[], ctx: BriefContext) {
  const { items: top, usedFallback } = await writeBrief(items, ctx);   // at most 3 items, order unchanged
  return { items: top, usedFallback };   // only title and why changed; cashEffect, score, neededBy, lever are the engine's
}

async function draftRoute(item: WorkItem, ctx: BriefContext) {
  return draftMessage(item, ctx);   // text only: { subject?, body, channel, links, usedFallback }. Nothing is sent.
}
```

- **Inputs:** `items` (best first) and a `BriefContext`: `run`, `records`, `profile` (the same run's inputs), `business: { name }`, `mode`, optional `client`, `cacheDir`, `model`.
- **Output:** `{ items, usedFallback }`. At most three items (never padded), same order, only `title` and `why` replaced. `cashEffect`, `score`, `neededBy`, `lever`, and `evidenceRefs` stay the engine's. `usedFallback` lists the item ids that got code-built text (the model's text failed `number_check`, or demo mode had no cache entry). That text is still valid; show it.
- Return the run's `inputsHash` and the store revision with the brief, so the chart and the brief cannot mix revisions.
- Every figure and date in `title` and `why` was checked against the engine's numbers (`ai/number_check.ts`). Claude never computes a figure.

## `POST /work-items/:id/draft`

Use the same `BriefContext` and the `WorkItem` loaded for `:id` from the same run (see `draftRoute` above).

- `draftMessage(item, ctx)` returns `Draft`: `{ subject?, body, channel: "email" | "message", links, usedFallback }`. `links` are copied from the commitment (`invoiceUrl`, plus `paymentUrl` for a chase), never produced by the model.
- **Text only. Never send.** Show it for the owner to copy or edit. "Approve" (`POST /work-items/:id/approve`) changes work-item state only; it is never "sent" or "paid".
- Show a payment link as "Pay online", never as proof of payment.

## Demo mode vs live mode

| | Demo (`mode: "cache_only"`) | Live (`mode: "live"`) |
|---|---|---|
| Needs | nothing (committed caches) | `ANTHROPIC_API_KEY` in `.env` (server only) |
| Reads | `LIVE_CACHE_DIR` if it exists, then the committed cache | the same caches first, then the model on a miss |
| Writes | nothing | `LIVE_CACHE_DIR` = `data/private/ai-cache` (gitignored; entries hold real names and amounts) |
| Import miss | a `review` proposal with a note; no signals | calls the model once, retries once with feedback, then a review item |
| Brief/draft miss | deterministic fallback text (`usedFallback`) | the model, then fallback text |

- **Committed demo caches** (`ai/cache.ts`): `DEFAULT_CACHE_DIR` = `fixtures/cascade_trade/intake/cache` (extractions and signals), `BRIEF_CACHE_DIR` = `fixtures/cascade_trade/brief/cache` (brief text and drafts). Pass `cacheDir` to use one directory alone (read and write); omit it for the layered default above.
- **Cache keys hash the exact input**: document text, business identity (`name` and `aliases`), prompt version, model, and for briefs the run's `inputsHash` and the facts. Demo mode hits only for the fixture inputs with the fixture business identity (`Cascade Trade Co.`, alias `Cascade Trade`, taken from the profile). Anything else is a miss, which in demo mode is a review item (import) or fallback text (brief), never an error. To demo a new input, run it once in live mode and commit the entry to the fixture cache directory (synthetic data only).
- **Mode is server config** (`docs/TECHNICAL_PLAN.md` section 9), not a request parameter. A public synthetic demo runs `cache_only`.
- **Model ids and prompt versions** live in `ai/config.ts` (`EXTRACTION_MODEL`, `BRIEF_MODEL`, `DRAFT_MODEL`, `*_PROMPT_VERSION`). Bumping a prompt version invalidates its cache entries. Do not hard-code model ids in routes.
- Pass `client` (an `Anthropic` instance) to reuse one; otherwise the default client reads `ANTHROPIC_API_KEY`.

## Where `number_check` fits

`writeBrief` and `draftMessage` already run it; routes do nothing. If you add free text from Claude elsewhere (`POST /ask`), wrap it in `guardAnswer(generate, allowed, fallback, { currency, asOf })` from `ai/number_check.ts`, with `allowed` from `allowedFromToolResults(toolResults)`.

## Checklist before wiring

1. `loadRecords` once per request; pass its `records` and `storeRevision` together.
2. Import persists with the individual upserts, not `upsertRecords`.
3. Confirm checks the revision, then `applyProposal`, then persists records, proposal state, and revision in one transaction; map `ApplyError.code` with the table above.
4. Signals change state only; the owner picks the date when the note says so.
5. Brief and draft use one run's `run`/`records`/`profile`; drafts are text only.
6. Review renders `Field<T>` states with quotes, conflicts, match candidates, and notes as plain text; links are never "paid".
