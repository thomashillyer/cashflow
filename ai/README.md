# Person 4 (AI) integration guide

For the API/app lane (person 3) and the integration lane (person 5): which `ai/` function each route calls, what goes in, what comes out, and what to persist. Design: [`docs/design/08-claude-layer.md`](../docs/design/08-claude-layer.md), [`docs/TECHNICAL_PLAN.md`](../docs/TECHNICAL_PLAN.md) sections 4, 5, 6, 8.

**Runnable version of everything below:** [`ai/integration.example.test.ts`](integration.example.test.ts). It runs the flow against the `cascade_trade` fixtures with an in-memory store, no network, no key (`npx vitest run ai/integration.example.test.ts`). The snippets here are copied from it (`store` is the test's in-memory stand-in for Supabase; `BUSINESS`, `MODE`, `NOW` are constants at the top of the file). Copy from the test, not from memory.

## Rules the routes must keep

- **Nothing in `ai/` writes to the store.** Every function is pure, or touches only the response cache. You persist what it returns.
- **`ingest` never applies anything.** Cash changes only when the owner confirms a proposal (`applyProposal`) or applies a signal (`state: "applied"`).
- **No send, no pay.** `draftMessage` returns text. There is no function that sends or moves money, and the routes must not add one.
- **Messages are data.** Never put message text into a prompt, a log, or an error. `ingest` routes it through the extraction schema only.
- **Same input, same ids.** Re-importing a file proposes the same ids. Do not let that reopen a proposal the owner already decided (see import). The ops themselves are idempotent, but `applyProposal` on a decided proposal throws `NOT_PROPOSED`.

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
  for (const p of result.proposals) {                              // upsertChangeProposals
    // Same input gives the same ids, so a re-import must not reopen a decided proposal.
    if (!store.proposals.has(p.id) || store.proposals.get(p.id)!.state === "proposed") store.proposals.set(p.id, p);
  }
  for (const s of result.signals) {                                // upsertSignals (state "proposed")
    if (!store.records.signals.some((x) => x.id === s.id)) store.records.signals.push(s);
  }
  store.notes.push(...result.notes);                               // keep notes for Review

  return result;   // { evidence, candidates, proposals, signals, notes } is everything Review renders
}
```

- **Input** (`IntakeInput`): `{kind:"pdf", bytes, fileName?}`, `{kind:"email"|"whatsapp", raw, attachments?}`, `{kind:"paste", text, receivedAt}`, `{kind:"sheet", sheets: SheetContent[], currency?, dayFirst?, columnMapping?}`. Every kind takes `source?: { evidenceId?, sourceRef?, receivedAt? }`.
- **Person 1 boundary:** adapters capture, store the original file (`Evidence.storageKey`), read XLSX/CSV into `SheetContent`, fetch URLs, and assign source ids. Pass those ids as `input.source` so Evidence and `sourceRef` point at your stored original. With no `source`, ids come from a content hash (stable, so fine for uploads and paste). Person 4 never captures or stores files.
- **`ctx`**: `records` and `storeRevision` from one `loadRecords` call (same snapshot; every proposal is pinned to that revision), `business` (`{name, aliases?}` from the profile), `mode`, `now` (ISO instant, pass the clock in), optional `timeZone` (relative dates like "next Friday"), `client`, `cacheDir`.
- **Output** (`IntakeResult`): `evidence[]` (parents, attachments, link children, deduped), `candidates[]`, `proposals[]` (one per candidate, all `proposed`), `signals[]` (all `proposed`), `notes[]` (`{scope, text}`, plain text; scope is a candidate, proposal, signal, or evidence id).
- **Persist** with the service role, using the individual helpers in `db/records.ts`: `upsertEvidence`, `upsertIntakeCandidates`, `upsertChangeProposals`, `upsertSignals`. **Do not use `upsertRecords` here:** it bumps the store revision and would make the proposals you just created stale. **Persist only proposals that are new or still `proposed`:** a plain upsert of a re-import would reset a confirmed or dismissed proposal to `proposed`. Keep `notes` too; Review needs them (for example, to see which signals have a vague date).
- **Bad input does not throw.** An unreadable, oversized, unsupported, or uncached file comes back as Evidence plus a `review` proposal and a note that says what to upload. Show the note; do not return a 5xx.
- **Live latency:** each model call has a 30 s timeout with one SDK retry, so up to about 60 s per call, and calls run one after another: one per document or attachment (up to 10) plus one per chat message that mentions payment, dates, or amounts. A single PDF fits a 60 s request budget; an email or WhatsApp bundle may not. For bundles, return an import id and let the UI poll. Extraction does not retry with feedback (only the brief, drafts, and `guardAnswer` do). Demo mode makes no calls.
- **Preview counts** for the import response: `candidates.length`, `proposals` grouped by `action`, `signals.length`.

## `GET /review`

Person 4 adds no code here. Return the pending queue from what import stored: `change_proposals` with `state = "proposed"` (join their candidates and Evidence), `signals` with `state = "proposed"`, and the notes. What the UI must render:

- **Fields.** `candidate.fields.*` are `Field<T>`: `found` (show the value and the quote from `evidence[].text`, with page/sheet/row when present), `missing` (show "not found" and the reason; never `0` or an empty string), `conflict` (show every `values[]` entry with its quote and make the owner pick).
- **Proposal.** `action` (`create` new commitment, `link` evidence only, `update` change fields, `conflict`, `review`), `reasons[]` (why this match, plain text), `targetCommitmentId` (the invoice it matched), `ops` (what confirming will do), `conflicts[]` (`{field, values[]}` with evidence for each side; the stored side is quoted as "system record: value").
- **Ambiguous matches.** `proposal.matchCandidates[]` and `signal.matchCandidates[]` are `{commitmentId, reasons[]}`: show each with its reasons and let the owner pick. `candidate.partyCandidates[]` (`{partyId?, name?, emails?, reason}`) are the unresolved counterparties: show them with `reason` and let the owner pick or confirm one. A `review`/`conflict` proposal has no `ops` and cannot be confirmed until the owner resolves it (see "Resolving a review item" below).
- **Notes** (`IntakeNote.text`, `candidate.notes`, `proposal.reasons`) are plain text. Render as text, never as HTML or markdown, and never interpret them. Message excerpts can be hostile.
- **Links are not payment.** `fields.paymentUrl` and `invoiceUrl` are links to open, labelled "Pay online" / "Invoice". Never show a link, a "paid" stamp (`fields.statedStatus`), or a promise as "paid". Only a `createSettlement` op from identified payment evidence records a payment.
- **One invoice, many channels.** A PDF, an email, a chat message, and a sheet row for the same invoice come back as `link` proposals on the same commitment. Show "already in your books, add as evidence", not a second invoice. Describe the effect from `ops`, not from `action`: a `linkEvidence` op changes no cash, but a `linkCommitments` op (an invoice fulfilling a PO) lowers the PO's outstanding amount and so changes the forecast.
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
  // Decided already (a double click, or a retry after a lost response): say so before the revision check,
  // because the first confirm moved the revision. With an Idempotency-Key, replay the stored result instead.
  if (proposal.state !== "proposed") throw new HttpError(409, "NOT_PROPOSED", `This item was already ${proposal.state}.`);
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
    refreshPending(store);   // the other pending proposals are now one revision behind
    return { storeRevision: store.storeRevision, affectedRecordIds: applied.affectedRecordIds, warnings: applied.warnings };
  } catch (err) {
    if (err instanceof ApplyError) throw new HttpError(APPLY_ERROR_STATUS[err.code], err.code, err.message);
    throw err;
  }
}
```

**Say it plainly:** `confirm_change_proposal` (the RPC, wrapped by `confirmChangeProposal` in `db/records.ts`) validates and locks, and raises `NOT_IMPLEMENTED` (501) when the proposal has ops. So persons 3 and 5 **apply the ops server-side with `applyProposal` and upsert the result**, or extend the RPC to apply them (the SQL TODO lists the ops). Either way:

- Do the revision check, the writes, the proposal state change, and the revision bump in **one transaction** if you can. Separate calls can double-apply under two concurrent confirms, and one transaction is what makes the plan's "second confirm sees the first" hold.
- `applyProposal` does **not** check revisions or idempotency keys. Order the route's checks: replay a completed identical `Idempotency-Key` (return the stored result), then proposal not `proposed` (409 `NOT_PROPOSED`), then the owner's expected revision and `proposal.expectedStoreRevision` against the current revision (409 `STALE_REVIEW`). The state check goes before the revision check because the first confirm already moved the revision; a retry after a lost response should not look like "your books changed".
- **Refresh the other pending proposals after every write that moves the revision.** Every proposal from an import is pinned to the revision it was computed against, so confirming one makes all the others stale, and showing the same stale proposal again would never succeed. Rebuild each still-pending proposal from its stored candidate with `propose(candidate, records, { storeRevision, now })` (`ai/reconcile/match.ts`), as `refreshPending` does below. Apply the same step after a signal apply or an adapter import.

```ts
// Every pending proposal is pinned to the revision it was computed against. A confirm or a signal apply
// bumps the revision, so without this step the owner's second confirm is STALE_REVIEW forever.
// Rebuild each still-pending proposal from its stored candidate against the new records. The id is the
// same ("cp-<candidate>-r<n>"), so it replaces the old one in place; decided proposals are never touched.
// (A note-only candidate loses its "attach this message to the invoice" link op here; the signal is
// unaffected. Re-run ingest from the stored original instead if you need that link back.)
function refreshPending(store: Store): void {
  for (const [id, p] of store.proposals) {
    const candidate = p.candidateId ? store.candidates.get(p.candidateId) : undefined;
    if (p.state !== "proposed" || !candidate) continue;
    store.proposals.set(id, propose(candidate, store.records, { storeRevision: store.storeRevision, now: NOW }));
  }
}
```

- **Pure.** It returns `{ records, affectedRecordIds, warnings }` and never mutates its input. Persist `records` with `upsertRecords` (idempotent on `(business_id, id)`, bumps the revision), and the proposal as `{ ...proposal, state: "confirmed", decidedAt }`. Show `warnings` (unresolved facts) to the owner.
- **Evidence** is stored at import. If you skipped that, `mergeEvidence(records, result.evidence)` adds it to the records first (existing ids win).
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
  STALE_REVIEW: 409,       // a field changed since the owner looked: rebuild the proposal, show it again
  NOT_PROPOSED: 409,       // already confirmed or dismissed (a double click or a retry)
  OVER_ALLOCATED: 409,     // linked invoices would exceed the PO; the owner picks how much to allocate
  NOTHING_TO_APPLY: 422,   // a conflict/review item with no ops and no ownerEdits: the owner must resolve it
  UNKNOWN_TARGET: 404,     // the commitment the proposal points at no longer exists
};
```

On a 409 `STALE_REVIEW`, refresh Review (the proposal is rebuilt) and show the item again; do not resubmit the stale decision. Return `{ error: { code, message, fieldIssues, retryable }, revision }` per the technical plan, and keep message text and amounts out of logs. The RPC's own errors keep the status on `StoreError.status`: `STALE_REVIEW`, `IDEMPOTENCY_CONFLICT`, `PROPOSAL_NOT_PENDING`, `PROPOSAL_UNRESOLVED` are 409, `NOT_FOUND` is 404, `NOT_IMPLEMENTED` is 501. The RPC returns 409 `PROPOSAL_UNRESOLVED` for the case `applyProposal` calls `NOTHING_TO_APPLY` (422); technical plan section 8 says unresolved facts are 422, so use 422 in both. It is not a refresh case: the owner has to resolve the item first.

### Resolving a review item

A `conflict` or `review` proposal comes back with `ops: []`. The owner decides, and your route turns the decision into ops or validated edits, then confirms as usual.

- **Pick one of `matchCandidates`:** append a `linkEvidence` op for the picked commitment and set `targetCommitmentId` (`resolveWithPick` below), save the proposal, then confirm. This only attaches the document as evidence; to change a field, add validated `ownerEdits`.
- **Pick a party (`partyCandidates`):** set `candidate.partyId` to the chosen party, save the candidate, and re-run `propose` for it. The new proposal is `create`, `link`, or `update` as usual.
- **Type a value (`ownerEdits`):** `applyProposal` applies `proposal.ownerEdits` after the ops, to `targetCommitmentId` (or the commitment the proposal creates), and **does no validation**: it writes `change.to` to `change.field` as given. So never copy a request body into `ownerEdits`. Validate it as `validOwnerEdits` does: an allowlisted field, integer minor units (not dollars, not strings), ISO dates, `from` read from the stored commitment. Settlement, type, ids, and source are never editable; a document or a message never marks anything paid. An `ownerEdits` proposal with no target is `UNKNOWN_TARGET`.
- `conflict` is resolved the same way: the owner chooses a value (an `ownerEdits` entry) or dismisses the item.

```ts
// A `review` proposal with matchCandidates has no ops until the owner picks one. Turn the pick into an op
// (link this evidence to that invoice), save the resolved proposal, then confirm it as usual.
function resolveWithPick(proposal: ChangeProposal, commitmentId: string): ChangeProposal {
  if (!proposal.matchCandidates?.some((m) => m.commitmentId === commitmentId)) {
    throw new HttpError(400, "INVALID_ARGUMENT", "Pick one of the invoices offered.");
  }
  return {
    ...proposal, action: "link", targetCommitmentId: commitmentId,
    ops: [...proposal.ops, { op: "linkEvidence", commitmentId, evidenceIds: proposal.evidenceIds }],
  };
}

// ownerEdits come from the request body, and applyProposal writes them as given. Validate first:
// only these fields, integer minor units, ISO dates, `from` read from the stored commitment. Never settlement.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function validOwnerEdits(body: unknown, target: Commitment): CommitmentFieldChange[] {
  if (!Array.isArray(body)) throw new HttpError(400, "INVALID_ARGUMENT", "Edits must be a list.");
  return body.map((raw: { field?: unknown; to?: unknown }) => {
    const { field, to } = raw;
    const bad = () => new HttpError(400, "INVALID_ARGUMENT", `Cannot change ${String(field)} to that value.`);
    if (field === "amount" || field === "outstanding") {
      if (typeof to !== "number" || !Number.isSafeInteger(to) || to < 0) throw bad();
      return { field, from: target[field], to };
    }
    if (field === "currency") {
      if (typeof to !== "string" || !/^[A-Z]{3}$/.test(to)) throw bad();
      return { field, from: target.currency, to };
    }
    if (field === "anchors.invoice" || field === "anchors.due" || field === "anchors.order" || field === "anchors.ship" || field === "anchors.delivery") {
      if (typeof to !== "string" || !ISO_DATE.test(to)) throw bad();
      return { field, from: target.anchors[field.slice(8) as keyof Commitment["anchors"]], to };
    }
    throw bad();   // settlement, type, id, sourceRef, urls, party: not editable here
  });
}
```

A confirmed evidence-only `link` proposal adds no commitment and no cash event. A confirmed `create` proposal adds the commitment (and party) with ids derived from the source, such as `inv-INV-1203`. A `linkCommitments` op also changes the PO's outstanding amount. A `createSettlement` op records the payment and, when the target commitment has `outstanding` set (and the payment is already in opening cash), lowers it and sets `settlement` to `partial` or `paid`; when `outstanding` is unset the engine derives the remainder from the settlements. Show these warnings from `applyProposal` to the owner.

## `POST /signals/:id/apply` and `/dismiss`

Signals (a customer says it will pay later, an amount change, a cancellation) are not ChangeProposals. They are confirmed through their own `state`.

```ts
// The owner confirmed. Flipping state is the write; the engine applies "applied" signals as overrides on
// the next run, but it skips a signal with no commitmentId, so one must be set. The body carries what the
// owner picked: { commitmentId?, newDate? }.
function applySignalRoute(store: Store, signalId: string, expectedRevision: number, pick: { commitmentId?: string; newDate?: string } = {}): Signal {
  const signal = store.records.signals.find((s) => s.id === signalId);
  if (!signal) throw new HttpError(404, "NOT_FOUND", "That message is no longer in Review.");
  if (signal.state !== "proposed") throw new HttpError(409, "NOT_PROPOSED", `This message was already ${signal.state}.`);
  if (expectedRevision !== store.storeRevision) throw new HttpError(409, "STALE_REVIEW", "Your books changed. Review it again.");

  // Ambiguous match: no commitmentId until the owner picks one of signal.matchCandidates.
  const commitmentId = signal.commitmentId ?? pick.commitmentId;
  if (!commitmentId || !store.records.commitments.some((c) => c.id === commitmentId)) {
    throw new HttpError(422, "COMMITMENT_REQUIRED", "Pick which invoice this message is about.");
  }
  // Vague date ("end of the month"): claim.newDate is only a suggestion. The owner must pick or accept one.
  const vague = store.notes.some((n) => n.scope === signal.id && n.text === "owner must confirm the date");
  if (vague && !pick.newDate) throw new HttpError(422, "DATE_REQUIRED", "Pick the date they mean.");
  if (pick.newDate && !/^\d{4}-\d{2}-\d{2}$/.test(pick.newDate)) throw new HttpError(400, "INVALID_ARGUMENT", "Dates look like 2026-11-03.");

  const claim = signal.claim.kind === "date_change" && pick.newDate ? { ...signal.claim, newDate: pick.newDate } : signal.claim;
  const applied: Signal = { ...signal, commitmentId, claim, state: "applied" };   // dismiss: state "dismissed", nothing else
  store.records = { ...store.records, signals: store.records.signals.map((s) => (s.id === signalId ? applied : s)) };
  store.storeRevision += 1;   // db.rpc("bump_store_revision", ...) after upsertSignals
  refreshPending(store);
  return applied;
}
```

- **The request carries the owner's choices** (`{ commitmentId?, newDate? }`) plus the expected revision and an `Idempotency-Key`, like confirm. An ambiguous signal has `matchCandidates` and no `commitmentId`; the engine skips applied signals with no `commitmentId`, so the route must refuse (422) until the owner picks one.
- Persist the signal with `upsertSignals` and bump the store revision (there is no TypeScript helper for `bump_store_revision`; call `db.rpc("bump_store_revision", { p_business_id })` with the service role, as `upsertRecords` does), then refresh the pending proposals. The engine treats `applied` signals as overrides (`engine/adjust.ts`: `date_change`, `cancel`; `engine/expand.ts`: `amount_change`, `new_commitment`, `plan`). `proposed` and `dismissed` signals change nothing.
- **Show the owner the words:** `signal.sourceRef.excerpt.text` is the quote, `claim` the proposed change, `confidence` a hint (never authorization). A signal can never apply itself.
- **Vague dates.** When the message says "end of the month" or "early next week", `claim.newDate` is only a suggestion. The signal has `confidence <= 0.5` and a note scoped to the signal id with the text `owner must confirm the date`. Show it as "around <date> (they wrote: <quote>)" with a date picker. The route above requires `newDate` in the request when that note exists, and writes it into `claim.newDate`. Never show a suggested date as fact. This is why you must keep the import's `notes`.
- Other notes to show as plain text: sender not a confirmed party (confidence capped at 0.5), a conditional promise, an ambiguous match.

## `GET /brief`

Flow: `buildBrief({ records, profile, asOf, fxRates })` (`engine/brief.ts`, person 5) returns `{ run, brief }`; `brief.today` is the ranked `WorkItem[]` (at most three) for that one `ForecastRun` -> `writeBrief` writes only the words.

```ts
// `items` are the engine's ranked WorkItems for the run you are returning: `const { run, brief } = buildBrief({ records, profile, asOf, fxRates })` (engine/brief.ts), then `brief.today`;
// `run`, `records`, `profile` are that same run's inputs, so every number in the words matches the chart.
async function briefRoute(items: WorkItem[], ctx: BriefContext) {
  const { items: top, usedFallback } = await writeBrief(items, ctx);   // at most 3 items, order unchanged
  return { items: top, usedFallback };   // only title and why changed; cashEffect, score, neededBy, lever are the engine's
}

async function draftRoute(item: WorkItem, ctx: BriefContext) {
  return draftMessage(item, ctx);   // text only: { subject?, body, channel, links, usedFallback }. Nothing is sent.
}
```

- **Inputs:** `items` (`brief.today`, best first) and a `BriefContext`: `run`, `records`, `profile` (the same run's inputs), `business: { name }`, `mode`, optional `client`, `cacheDir`, `model`.
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
| Import miss | a `review` proposal with a note; no signals | calls the model (30 s timeout, one SDK retry), then a review item with a note if it fails |
| Brief/draft miss | deterministic fallback text (`usedFallback`) | the model, then fallback text |

- **Committed demo caches** (`ai/cache.ts`): `DEFAULT_CACHE_DIR` = `fixtures/cascade_trade/intake/cache` (extractions and signals), `BRIEF_CACHE_DIR` = `fixtures/cascade_trade/brief/cache` (brief text and drafts). Pass `cacheDir` to use one directory alone (read and write); omit it for the layered default above.
- **Cache keys hash the exact input**: document text, business identity (`name` and `aliases`), prompt version, model, and for briefs the run's `inputsHash` and the facts. Demo mode hits only for the fixture inputs with the fixture business identity (`Cascade Trade Co.`, alias `Cascade Trade`, taken from the profile). Anything else is a miss, which in demo mode is a review item (import) or fallback text (brief), never an error. To demo a new input, run it once in live mode and commit the entry to the fixture cache directory (synthetic data only).
- **The brief cache is keyed on `run.inputsHash`, which covers the records and every signal in any state.** In demo mode, importing a message that yields a proposed signal, confirming a proposal, or applying a signal changes the hash, so the next `GET /brief` has no cached text and returns the code-built fallback (`usedFallback`). That text is valid but plainer. For a scripted demo, run the exact demo path once in live mode against the demo business (import, confirm, apply, then the brief and drafts) and commit the new entries to `fixtures/cascade_trade/brief/cache` (and the intake cache for the inputs).
- **Mode is server config** (`docs/TECHNICAL_PLAN.md` section 9), not a request parameter. A public synthetic demo runs `cache_only`.
- **Model ids and prompt versions** live in `ai/config.ts` (`EXTRACTION_MODEL`, `BRIEF_MODEL`, `DRAFT_MODEL`, `*_PROMPT_VERSION`). Bumping a prompt version invalidates its cache entries. Do not hard-code model ids in routes.
- Pass `client` (an `Anthropic` instance) to reuse one; otherwise the default client reads `ANTHROPIC_API_KEY`.

## Where `number_check` fits

`writeBrief` and `draftMessage` already run it; routes do nothing. If you add free text from Claude elsewhere (`POST /ask`), wrap it in `guardAnswer(generate, allowed, fallback, { currency, asOf })` from `ai/number_check.ts`, with `allowed` from `allowedFromToolResults(toolResults)`.

## Checklist before wiring

1. `loadRecords` once per request; pass its `records` and `storeRevision` together.
2. Import persists with the individual upserts, not `upsertRecords`.
3. Confirm checks proposal state, then revision, then `applyProposal`, then persists records, proposal state, and revision in one transaction, then refreshes the other pending proposals; map `ApplyError.code` with the table above. Validate `ownerEdits`.
4. Signals change state only; the owner picks the commitment (if ambiguous) and the date (if vague).
5. Brief and draft use one run's `run`/`records`/`profile`; drafts are text only.
6. Review renders `Field<T>` states with quotes, conflicts, match candidates, and notes as plain text; links are never "paid".

## Ask Neri: `voice(decision, ctx)` (P4.21)

`voice` in [`ai/ask/voice.ts`](ask/voice.ts) turns a code-built `Decision` (`schema/ask.ts`) into the owner-facing `CfoAnswer`. Claude writes only the `CfoVoice` (headline, why, nextStep, convictionNote, whatWouldChange); code fills in verdict, conviction, question, proposal, citations, scenarioId, and missingData from the Decision, and `text` is the voice fields joined, so `number_check` covers every word.

- **Input:** `ctx = { profile, business: { name }, mode, client?, cacheDir?, proposalId? }`. For verdict `proposed`, persist the proposal first and pass its id as `proposalId`.
- **Never throws, never sends.** Checks: amounts, dates, percentages, day counts, and sample counts against `decision.allowed`; no menus (options, "you could", lists, a second fallback); the headline leads with the verdict and the recommendation's key fact; no sent/paid claims. One retry with feedback, then a code-built voice (`usedFallback: true`).
- **`need_info`, `decline`, `proposed`** always use the code-built voice (no model call).
- **Cache:** committed stand-ins in `fixtures/cascade_trade/ask/cache` (from `scripts/make-voice-standins.ts`); `scripts/refresh-voice-cache.ts` replaces them with live output. Hand-built Decisions: `fixtures/cascade_trade/ask/decisions.json`.
