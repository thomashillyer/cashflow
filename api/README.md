# API server (`api/`)

One Fastify service (docs/TECHNICAL_PLAN.md §9) that answers the routes `app/api.js` calls, backed by `engine/`, `ai/` and `db/`. It also serves `app/` on the same origin, so `window.NERI_API_BASE = "same-origin"` in `app/config.js` just works. Nothing here sends a message, pays a bill or moves money: drafts are text, approve only ticks an item off.

## Run it

```
npm install
cp .env.example .env          # paste the Supabase values (see CLAUDE.md "Supabase setup")
npm run seed:demo             # once per Supabase project: the synthetic samples (cascade_trade, pike_noodle)
npm run dev                   # http://localhost:8787 (API + app), reloads on change
npm start                     # same, without watch (production)
```

No database? `NERI_STORE=memory DEMO_MODE=1 npm run dev` runs on the fixtures in memory (lost on restart), no sign-in needed. Good for a laptop demo.

Tests: `npx vitest run api` (Fastify `inject()`, in-memory store, no network, no key).

## Live demo hosting (Fly.io)

**https://neri-cash.fly.dev**: this API plus the app on one origin, in `DEMO_MODE` against the shared Supabase project. `Dockerfile` builds it and switches the image's `app/config.js` to `same-origin` (the committed file stays empty for the local preview). `fly.toml` sets the region (`sjc`), keeps one machine warm, and health-checks `/health`. `.github/workflows/fly-deploy.yml` deploys every push to `main` (repo secret `FLY_API_TOKEN`). Runtime secrets live in Fly: `fly secrets set -a neri-cash SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... [ANTHROPIC_API_KEY=...]`. Manual deploy: `fly deploy --remote-only`. Logs: `fly logs -a neri-cash`.

## Environment

| Variable | What it does |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Verify session tokens (`supabase.auth.getUser`). Without them every token is rejected. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server reads and writes, only after the auth and membership check. Never in the browser. |
| `ANTHROPIC_API_KEY` | Live Claude for imports, brief words and drafts. Without it (or with `NERI_AI_MODE=cache_only`) the server runs on the committed caches and code-built text. |
| `NERI_AI_MODE` | `live` or `cache_only`. Default: live when a key is set, except in `DEMO_MODE`, where it is `cache_only` unless set to `live`. |
| `DEMO_MODE=1` | Requests without a token may open the synthetic samples (public preview, judges); uploads (`/import`) still need sign-in, because the samples are shared. Private businesses still need a member's token. Also enables `POST /demo/reset`. |
| `NERI_DEFAULT_BUSINESS` | Sample opened when the caller has no business of their own (default `cascade_trade`). |
| `NERI_STORE=memory` | In-memory store seeded from the fixtures, instead of Supabase. |
| `NERI_ALLOW_RESET=1` | Enable `POST /demo/reset` outside demo mode. |
| `NERI_STATIC_DIR` | Directory served at `/` (default `app/`). |
| `PORT`, `HOST` | Default `8787`, `127.0.0.1`. Set `HOST=0.0.0.0` in a container. |

## Auth and tenant scope

- Every route except `GET /health` and `GET /ready` reads `Authorization: Bearer <supabase access token>` and verifies it with `supabase.auth.getUser` (anon-key client). A bad or expired token is `401` (the app then returns to sign-in). No token is `401` unless `DEMO_MODE=1`.
- **Which business:** the `X-Neri-Business` header (or `?business=`) if sent; else the caller's own business; else the default sample. The app does not send one yet, so a signed-in owner sees their own business and everyone else sees the sample.
- **Membership:** synthetic businesses are open to any verified caller (and to anonymous callers in demo mode). A private business needs membership: a row in `memberships` (tenant-access migration, branch `p3/tenant-access`) or, until that migration is applied, the owner recorded at `POST /setup` (`profile.account.ownerUserId`). Anything else is `404`, the same answer as an unknown id.
- Reads and writes then use the service-role client, scoped by that business id.
- Synthetic samples are shared: anyone who can open them can apply a signal or add a note. `POST /demo/reset` puts them back.

## Routes

Errors are `{ error: { code, message, fieldIssues, retryable }, revision? }`; `message` tells the owner the next step.

| Route | Does | Returns |
|---|---|---|
| `GET /health` | Liveness, no auth. Always 200 while the process is up (Fly checks it), whatever the database says | `{ ok, demoMode, aiMode }` |
| `GET /ready` | Readiness, no auth. Compares the newest `supabase/migrations` file with `public.schema_version()`; cached ~30s. Memory store: always ready | `200 { ok: true, schema: { repo, db } }`, or `503 { ok: false, schema: { repo, db }, message }` when the database is behind (run `npx supabase db push`); `schema: null` on the memory store |
| `GET /context` | Business, owner, time zone, sources with last sync, parties, rules, profile | `{ business, profile, parties, rules, safetyLine, partyByCommitment, storeRevision }` |
| `GET /brief` | One engine run (`buildBrief`) + words (`writeBrief`) | `{ three, rest, watch, combined, shortfall, run, storeRevision, inputsHash, usedFallback }`; items carry `kind` (`act`/`watch`) and `partyId` |
| `GET /forecast?scenario=base\|stress` | Forecast run | `ForecastRun` |
| `POST /simulate` | `{ levers: Lever[] }` what-if | `{ run, lowPointDelta, freeCashDelta }` |
| `GET /records/:id` | A commitment and what's behind it. `id` may be a commitment id, an event id (`evt-inv-INV-1187-0`, `evt-rec-payroll-3`, `evt-daily-sales-2027-01-15`, a bank line), or a profile recurring id (`rec-payroll`) / `daily-sales`; resolved with `engine/resolve.ts`. Profile items and unmatched bank lines come back in the same commitment shape (`sourceRef.system` `profile` / the bank). 404 if nothing matches | `{ commitment, party, events, signals, rules, evidence, message, source, eventId }` (`source`: `commitment`, `actual`, `linked_cost`, `profile_recurring`, `daily_sales`; `eventId`: the event asked for or null; daily sales add `basedOn`, the sales receipts averaged) |
| `POST /setup` | Signed-in user creates their business: starter profile (`trading`, `restaurant`, `services`, `other`), reserve, connectors | the account `completeSetup` stores, plus `businessId` |
| `PATCH /profile` (and `PUT`) | Partial, read-modify-write: `{ safetyLine?, owner?, timezone? }` | `{ profile, storeRevision }` |
| `POST /import/:adapter` | `pdf` (`{ base64, fileName? }`), `email` / `whatsapp` (`{ text }` raw), `paste` (`{ text, receivedAt? }`), `sheet` (`{ base64, fileName }` CSV or XLSX, or `{ text }` as CSV; optional `columnMapping`, `headerRow`, `currency`, `dayFirst`), `whatsapp` also takes a `.txt`/`.zip` export as `{ base64, fileName }`, `upload` (by file extension: pdf, eml, csv, xlsx, zip, txt) -> `ingest` -> persist evidence, candidates, proposals, signals | `IntakeResult` + `storeRevision` + `preview` counts; file imports also return `diagnostics` (rows read/imported/rejected, row errors with `nextStep`, completeness), and a byte-identical file already imported returns `repeat: true` with no candidates |
| `GET /review` | Proposed signals the app renders | `[{ signal (with effect), message, commitment, party, from, to, before, after, needsDate, notes }]` |
| `GET /review/proposals` | Pending change proposals with candidate fields, evidence, target and notes; all proposed signals | `{ storeRevision, proposals, signals }` |
| `POST /review/:id/confirm` | `{ expectedRevision?, commitmentId?, ownerEdits? }` -> `applyProposal` -> upsert -> revision +1 -> rebuild other pending proposals | `{ storeRevision, affectedRecordIds, warnings }`; `ApplyError` -> 409/422/404 per `ai/README.md` |
| `POST /review/:id/dismiss` | Dismiss a proposal | `{ id, state }` |
| `POST /signals/:id/apply` / `dismiss` | `{ expectedRevision?, commitmentId?, newDate? }` | `{ signal, storeRevision, lowPoint, alert }` |
| `POST /rules/:id/confirm` / `dismiss` | The owner approves or dismisses a rule Ask Neri proposed (`proposed` -> `confirmed` / `dismissed`). One atomic `commitDecision` (Idempotency-Key honoured); `404` unknown rule, `409 NOT_PROPOSED` if already decided. Only a confirmed rule changes the forecast (lag offset in `engine/lag.ts`, flexibility in `engine/warnings.ts`) | `{ rule, storeRevision }` |
| `GET /notes`, `POST /notes` | Owner notes (`{ text, via }`) with Neri's reading and priced effect | `Thought[]` / `Thought` |
| `PATCH /notes/:id` | Correct the reading (`amount`, `date`, `direction`, `status`, `probability`, `partyId`, `kind`) | `Thought` |
| `POST /notes/:id/add\|keep\|remove` | `add` writes an owner Signal (date change on the named invoice, or a plan) | `{ id, state, ... }` |
| `POST /plans` | Owner confirmed an Ask Neri plan: `{ amount, date, note, direction?, status?, probability?, partyId? }` | `{ id, signal, storeRevision }` |
| `GET /overrides` | The owner's saved overrides (base scenario) | `{ overrides: Override[], storeRevision }` |
| `PUT /overrides/:id` | Create or update one saved override: `{ target: { commitmentId, legIndex? }, change: { date? \| shiftDays?, amount?, exclude? }, originId?, expectedRevision }`. `origin` is always `owner`. `expectedRevision` is required (`400` without it); the revision is compared-and-bumped first, so of two writes from the same revision one gets `409 STALE_REVIEW` (with the current `revision`) and must reload. Unknown keys, non-integer or negative amounts, bad dates and unknown commitments are `400`. Samples are shared and read-only: `403` | `{ override, created, storeRevision }` |
| `DELETE /overrides/:id` | Remove one; `?expectedRevision=` (or body) required, same `409`/`403` rules; unknown id `404` | `{ id, deleted, storeRevision }` |
| `POST /work-items/:id/draft` | `draftMessage`; `{ channel?: "email" \| "message" \| "whatsapp" }` | `{ to, subject, body, channel, links, usedFallback }` (text only) |
| `POST /work-items/:id/approve` | Marks the item done (never "sent" or "paid") | `{ id, state }` |
| `POST /demo/reset` | Reseed the synthetic samples (`{ business? }`) | `{ reset }` |
| `POST /ask` | Ask Neri (`handleAsk`, ai/ask): `{ question, via?: "text" \| "voice" }`; a stated plan or rule is stored as a proposed owner Signal or Rule | `{ text, headline, verdict, ..., scenario?: { label, run }, proposal?: { kind: "plan", amount, date, note } }` |

Saved overrides live in the `scenarios` row `(business_id, 'base')`, apart from the imported records: `upsertRecords` and re-imports never touch them (a demo reset deletes them with the sample). Every base and stress `GET /forecast`, `POST /simulate`, `GET /brief`, `GET /records/:id`, Review pricing, note pricing and `POST /ask` run on them; stress is the same overrides with the stress delays added. An override only changes a forecast line; it never sends, pays or moves money. If saving the list fails after the revision bump, the route returns `500` and the old list stays (the bump only causes one extra recompute).

Owner notes and plans go in as **applied** owner Signals: the owner's own words, confirmed by the owner's click. Messages from anyone else stay `proposed` until the owner applies them in Review.

Forecast runs include `days[].pipeline` for the chart's separate probability-weighted possible-deals line; each week's `pipelineClosing` matches its last day's pipeline value. Possible deals never change the main cash balance.

Confirm, dismiss and signal apply/dismiss are one atomic `Store.commitDecision` (records + proposals + revision + stored response; compare-and-set on the revision the request loaded; SQL: `commit_review_decision`). Send an `Idempotency-Key` header to make a retry replay the first response (same key, different body: 409 `IDEMPOTENCY_CONFLICT`). Without the header the request is still atomic and race-safe but cannot be replayed.

## Not served yet

- Owner notes, the account details and import notes live in `businesses.profile.account` (no migration needed).

## Request logs and startup check

Each request writes one structured log line (`msg: "request"`): `reqId`, `method`, `route` (the route pattern, not the URL), `status`, `ms`, `businessId` when one was resolved, and `errorCode` on errors. Bodies, headers and tokens are never logged. Tests run with the logger off. At startup (Supabase store only) the server compares the newest migration file with `schema_version()` and logs one warning naming both versions if the database is behind or the function is missing; it never crashes. FX rates in the business account are checked in `runInputs`: only positive finite numbers keyed by a three-letter ISO 4217 code are used, others are dropped with a warning. The rates used are already in the run (`ForecastRun.fxRates`).
