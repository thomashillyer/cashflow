# API server (`api/`)

One Fastify service (docs/TECHNICAL_PLAN.md §9) that answers the routes `app/api.js` calls, backed by `engine/`, `ai/` and `db/`. It also serves `app/` on the same origin, so `window.NERI_API_BASE = "same-origin"` in `app/config.js` just works. Nothing here sends a message, pays a bill or moves money: drafts are text, approve only ticks an item off.

## Run it

```
npm install
cp .env.example .env          # paste the Supabase values (see CLAUDE.md "Supabase setup")
npm run dev                   # http://localhost:8787 (API + app), reloads on change
npm start                     # same, without watch (production)
```

No database? `NODE_ENV=development NERI_STORE=memory DEMO_MODE=1 npm run dev` runs on the fixtures in memory (lost on restart), no sign-in needed. Good for a laptop demo.

Tests: `npx vitest run api` (Fastify `inject()`, in-memory store, no network, no key).

## Production hosting (Fly.io)

**https://neri-cash.fly.dev**: this API plus the app on one origin, with `DEMO_MODE=0`, `NERI_STORE=supabase`, and private signed-in businesses. Production rejects memory storage and demo mode at startup; missing Supabase configuration fails startup. `Dockerfile` builds it and switches the image's `app/config.js` to `same-origin` (the committed file stays empty for the local preview). `fly.toml` sets the region (`sjc`), keeps one machine warm, and health-checks `/health`. `.github/workflows/fly-deploy.yml` deploys every push to `main` (repo secret `FLY_API_TOKEN`). Runtime secrets live in Fly: `fly secrets set -a neri-cash SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... [ANTHROPIC_API_KEY=...]`. Manual deploy: `fly deploy --remote-only`. Logs: `fly logs -a neri-cash`.

## Environment

| Variable | What it does |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Verify session tokens (`supabase.auth.getUser`). Without them every token is rejected. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server reads and writes, only after the auth and membership check. Never in the browser. |
| `ANTHROPIC_API_KEY` | Live Claude for imports, brief words and drafts. Without it (or with `NERI_AI_MODE=cache_only`) the server runs on the committed caches and code-built text. |
| `NERI_ASK_MODE` | `live` turns on real Claude for Ask Neri only (needs `ANTHROPIC_API_KEY`); brief, drafts and intake keep following `NERI_AI_MODE`. Ask reads the committed caches first and calls Claude only on a miss, using Sonnet (`claude-sonnet-5-5`) unless `NERI_ASK_MODEL` names another model (`fly secrets set NERI_ASK_MODEL=...`, no deploy needed; cache lookups are unaffected) (12 s timeout; on error it answers with the code-built text). To turn it on: `fly secrets set ANTHROPIC_API_KEY=… NERI_ASK_MODE=live`. `/health` shows `askMode`. |
| `NERI_ASK_LIVE_MAX_PER_HOUR` | Cap on live Ask model calls per hour (default 200); over it, Ask answers from cache only. Questions are capped at 500 characters. |
| `ANTHROPIC_WORKSPACE_ID` | Only for a user-level key (`sk-ant-usr-...`), which isn't scoped to a workspace: the workspace id (`wrkspc_...`) sent as `anthropic-workspace-id` on every Claude call. Not needed for a workspace key (`sk-ant-api03-...`). |
| `NERI_AI_MODE` | `live` or `cache_only`. Default: live when a key is set, except in `DEMO_MODE`, where it is `cache_only` unless set to `live`. |
| `DEMO_MODE=1` | Requests without a token may open the synthetic samples (public preview, judges); uploads (`/import`) still need sign-in, because the samples are shared. Private businesses still need a member's token. Visitors get a private sandbox copy of each sample (see Demo sandbox). |
| `NERI_DEFAULT_BUSINESS` | Local demo sample only (default `cascade_trade`); ignored as a production fallback. |
| `NERI_STORE=memory` | Local in-memory store; fixtures are seeded only when `DEMO_MODE=1`. Rejected in production. |
| `NERI_ALLOW_RESET=1` | Let `POST /demo/reset` without a visitor id reseed the shared samples (admin use, tests). Off by default, also in demo mode. |
| `NERI_STATIC_DIR` | Directory served at `/` (default `app/`). |
| `PORT`, `HOST` | Default `8787`, `127.0.0.1`. Set `HOST=0.0.0.0` in a container. |

## Auth and tenant scope

The hosted app creates accounts and signs in with email and password directly through Supabase. Email confirmations are disabled for the hackathon, so neither action sends mail. Passwords never pass through this API. Private-business access still checks the verified session's user ID and membership, not its unverified email address.

- **Email-link callback:** set the hosted Supabase Authentication Site URL to `https://neri-cash.fly.dev` (for local development, use the app's local origin). The frontend uses that default destination without a redirect override or wildcard allowlist. The default email template works unchanged: open the link in the browser/device where sign-in started so the stored PKCE verifier is available. Existing businesses are restored through `GET /context`; signing in does not call `POST /setup` again. Six-digit OTP templates remain supported.
- **Email delivery:** without custom SMTP, the built-in sender is limited to team addresses and currently two emails/hour. A configured provider such as SendGrid supports its own recipient and rate-limit policy; the frontend also accepts its six-digit-code templates. Email delivery is not required for the current password sign-in. No sender credentials or auth-confirmation settings are changed by this frontend flow. Configure hosted Auth separately from app deployment; do not push the local `supabase/config.toml` wholesale. [Supabase SMTP limits](https://supabase.com/docs/guides/auth/auth-smtp).
- Every route except `GET /health` and `GET /ready` reads `Authorization: Bearer <supabase access token>` and verifies it with `supabase.auth.getUser` (anon-key client). A bad or expired token is `401` (the app then returns to sign-in). No token is `401` unless `DEMO_MODE=1`.
- **Which business:** the `X-Neri-Business` header (or `?business=`) if sent; else the caller's own business. A signed-in user without a business receives `404 NO_BUSINESS` and goes to setup. The default sample is used only with explicit local `DEMO_MODE=1`.
- **Membership:** synthetic businesses are rejected in production, including explicit IDs; they are accessible only in demo mode. A private business needs membership: a row in `memberships` (tenant-access migration, branch `p3/tenant-access`) or, until that migration is applied, the owner recorded at `POST /setup` (`profile.account.ownerUserId`). Anything else is `404`, the same answer as an unknown id.
- Reads and writes then use the service-role client, scoped by that business id.
- Synthetic samples are shared and read-only for anonymous visitors in demo mode; see Demo sandbox below.

The legacy `/sources/:source/pull` route is not configured by the production entry point; use the tenant-bound `/connections` service below.

## Real source connections

Production Sources discovers capabilities through `GET /connections`; selecting a provider in setup does not connect it. Configure `NERI_CONNECTOR_BUSINESS_ID` with exactly one private business ID plus the provider credentials as server secrets. Other businesses cannot discover or use that server-managed account.

- Outlook: `MICROSOFT_TENANT_ID` (tenant UUID), `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_MAILBOX_UPN`. `POST /connections/outlook/sync` scans up to fifty recent messages from the last thirty days and processes at most ten financial messages with the existing application's mailbox permissions. Each sync scans one page without following pagination. It saves evidence and pending proposals/signals; it never sends mail or applies proposed changes. Live extraction requires `NERI_AI_MODE=live` and `ANTHROPIC_API_KEY`. Partial failures remain visible and retryable.
- Zoho Books: `ZOHO_API_DOMAIN`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, optional `ZOHO_ORGANIZATION_ID`. `POST /connections/zoho_books/sync` imports normalized accounting records from the bound company. Tokens must be valid; unavailable providers offer upload/paste instead.
- `PUT /balance` takes `{ amount, asOf, account? }`: signed integer cents, a nonfuture `YYYY-MM-DD`, and optional account name. Currency is the business base currency. Re-entering the same account/date corrects its snapshot. Enter only an actual bank balance; email imports do not invent one.

New businesses start with no recurring commitments, no opening bank balance, and a zero reserve until the owner sets one. Missing cash/books stay visible; no sample totals are presented as actual data.

## Demo sandbox

In `DEMO_MODE=1`, a request on a synthetic business gets a per-visitor, copy-on-write sandbox (`api/sandbox.ts`), so one visitor's edits never reach the shared sample or another visitor.

- The app creates a random id once (`crypto.randomUUID`, kept in localStorage) and sends it as `X-Neri-Visitor` on every call.
- The preHandler resolves a per-request store (`req.store`, read in routes with `storeFor(req)`). With a visitor id it is an in-memory `MemoryStore` copy of that business, seeded lazily from the real store (records, proposals, candidates, profile and notes, overrides, work items) on first access and keyed by (visitor, business). The real store is only read, never written.
- Notes, plans, profile, Review confirm/apply/dismiss, signals, rules, overrides and Ask Neri all write to the copy.
- At most 500 sandboxes (least recently used evicted), expiring after 2 hours idle. A restart or eviction gives the visitor a fresh copy of the sample.
- `POST /demo/reset` with a visitor id drops only that visitor's copy. Without one it is `403` unless the server runs with `NERI_ALLOW_RESET=1`, which reseeds the shared samples (`npm run seed:demo` talks to the database directly and is unaffected).
- A write (POST/PUT/PATCH/DELETE) on a sample with no visitor id is `403` "The sample is shared. Reload the page to get your own copy."; reads still work. `/import` on samples is unchanged (sign-in required).
- Signed-in members of real businesses are unaffected.

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
| `POST /import/bank` | A bank statement, chosen by the owner (never auto-detected from `upload`): `{ base64, fileName }` CSV or XLSX, or `{ text }` as CSV; optional `columnMapping` (`date`, `description`, `amount` or `debit`/`credit`, `balance`, `currency`; 0-based), `headerRow`, `currency`, `dayFirst`, `account` -> actual cash events (no `commitmentId`: bank lines are never matched to an invoice by guess), the newest running balance as a `BalanceSnapshot` dated the day after the newest line (only when unambiguous), evidence last | `{ repeat, written, storeRevision, diagnostics, mapping, balance, recurring, unallocated, preview }`. `recurring` are proposals only (payee, cadence, typical amount, next expected, evidence rows): nothing is applied. A byte-identical statement returns `repeat: true` and writes nothing; a corrected mapping always re-reads; a file with nothing readable writes nothing and returns the mapping preview |
| `POST /sources/:source/pull` | `zoho_books`, `zoho_crm`, `outlook` (the app's id `m365` is accepted for Outlook); body `{ sinceDays? }` for Outlook. Reads the connected app read-only. Books and CRM records are persisted idempotently (`persistImport`: a repeat pull writes nothing, an edited record updates one row); Zoho Books also reads the active bank and cash account balances as the forecast's opening cash (written only when changed; without Zoho's Banking permission the books still import with a plain warning). Outlook messages go through the same intake as an upload and become Review items; messages already read are skipped and the rest are reached on later pulls (15 per pull). The connection's state (connected, or the plain reason it is not) is stored for the Sources screen. Signed-in members of their own business only: samples and anonymous callers are refused. | `{ source, kind, summary, diagnostics }` (not the `/import` shape). Not connected: 422 `SOURCE_NOT_SET_UP`; token problem 424; rate limited 429; provider down 502; a pull already running 409. Each error says the next step (reconnect, or upload/paste instead). |
| `GET /evidence/:id/original` | Download the original behind a piece of evidence (the uploaded file, the pasted text as `.txt`, or an attachment from an email/zip). Signed-in members of the business only (`401` without a token, `404` for another business, unknown evidence, or no saved original, `503` retryable if storage is down). The key comes from the stored evidence, never from the request. Always an attachment with `x-content-type-options: nosniff` and a locked-down CSP; the content type is one of pdf, csv, xlsx, plain text, eml, else `application/octet-stream`, so an uploaded html/svg can never run in the app's origin. Originals live in the private `evidence-originals` bucket (service role only; no client policy). Import stores them and sets `Evidence.storageKey`; if storing fails the import still succeeds with a note | the file bytes |
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
| `POST /overdue-decision` | Owner decision on an overdue item: `{ commitmentId, legIndex?, decision: "done" \| "open" \| "clear", expectedRevision }`. `done` saves an owner `exclude` override (never a bank actual), `open` saves a `stillOpen` marker (kept in the forecast as expected now, unflagged, exempt from the assumed-paid rule), `clear` undoes either. Same revision (`409`) and sample (`403`) rules as overrides. Items due before the Monday `profile.assumeSettledBeforeWeeks` weeks before asOf (default 1) are left out as assumed paid (`run.assumedPaid`) unless marked still open | `{ decision, override, storeRevision }` |
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
