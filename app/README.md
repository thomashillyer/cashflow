# Neri Cash app

The owner-facing web app: Today (three things), Forecast, Notes, Review, Sources, Ask Neri, and drive mode.
Plain HTML, CSS and JavaScript modules. No build step, no dependencies. Works on phone, tablet and desktop.

## Run it

```bash
cd app
python3 -m http.server 4300     # or: npx serve -l 4300
```

Open http://localhost:4300. It starts in **preview mode** with two fictional businesses (switch in Settings):
Cascade Trade Co. (trading, from `docs/design/10-testing-and-fixtures.md`) and Pike Street Noodle Bar (restaurant).

## Hosting

The app is served together with the API from one Node service on Fly.io at **https://neri-cash.fly.dev**
(see `api/README.md`, "Live demo hosting"). There is no separate static host.

## Point it at the team API

Set `window.NERI_API_BASE` in `app/config.js`, or open `http://localhost:4300/?api=http://localhost:8787`.
Every call goes through `app/api.js`; the `live` object there lists the routes the app expects. They follow
`docs/design/09-api-repo-lanes.md`, plus the app routes below that are not in the older lane table:

| Route | Why the app needs it |
|---|---|
| `GET /context` | Business name, owner, timezone, sources with last sync, parties, rules, profile |
| `GET /review` | Proposed signals with the message excerpt and the priced effect (before/after low point) |
| `GET/POST /notes`, `PATCH /notes/:id`, `POST /notes/:id/(add\|keep\|remove)` | Parked thoughts (owner channel of the signals pipeline) |
| `POST /plans` | Owner confirms a plan proposed in Ask Neri |
| `GET /connections`, `POST /connections/:id/sync` | Tenant-bound source availability and an actual read-only sync |
| `GET /review/proposals`, `POST /review/:id/confirm\|dismiss` | Imported document fields, evidence and revision-checked owner decisions |
| `PUT /balance` | Owner-entered bank balance snapshot; existing accounts come from `context.balanceAccounts` |

`GET /brief` should return `{ three, rest, watch, combined, shortfall, run }`: the ranked `WorkItem`s split into
today's three, the rest, and watch items, plus the `ForecastRun` they came from, so the list and the chart always
show the same revision.

## What's here

| Path | What it is |
|---|---|
| `index.html`, `styles.css`, `main.js` | Shell, design tokens (Neri brand), all screens |
| `ui/chart.js` | 13-week cash chart (daily closings, your line, low point, pipeline, what-if) |
| `ui/speech.js` | Play brief (speech synthesis) and voice capture for notes, both built into the browser |
| `catalog/connectors.js` | Every source the Sources screen lists, with honest availability |
| `mock/` | **Preview only.** Browser-only engine and fictional fixtures selected when no API is configured; production never selects them. |

## Product rules the UI keeps

- Today leads with one sentence and at most three actions, each with its dollar effect and an act-by date. Never padded to three.
- Play brief reads the same sentence and items out loud (about 35 seconds). Drive mode is large type, two buttons, screen kept awake.
- Home, Details, Play brief and drive mode surface the engine's forecast review status and reasons, even with no ranked actions. An all-clear requires `run.review.needed === false`; missing checks remain unverified, and the static preview explains that checks require the live server.
- Notes: anything typed or spoken is read as money in or out, amount, date, party and certainty. It reaches the forecast only after **Add to forecast**.
- Every number has a source chip that opens its record: the invoice, its payment history, the message behind a moved date.
- Nothing sends, pays or writes back. Drafts are copied or opened in the owner's own mail app.
- Partner cards appear only in explicit demo mode, labeled as samples with their referral disclosure.
- Hide names (Settings) masks customers and suppliers for demos and screen sharing.

## Security

- **Sign-in:** real accounts use email and password with Supabase Auth (`app/ui/auth.js`). New passwords need at least eight characters. Disable **Confirm email** in the hosted project's Authentication settings (`mailer_autoconfirm: true` through the Management API); local `auth.email.enable_confirmations` is already false. Sign-up returns a session immediately and the owner continues to business setup. Returning owners choose **Sign in**, which restores their business through `/context` without rerunning `/setup`. Passwords go straight to Supabase and are never saved in Neri's account data or local storage. The service-role key never goes in the browser.
- **Email verification:** sign-up and password sign-in send no email and need no SMTP provider. Email addresses are unverified in this hackathon flow; access to private businesses depends on the authenticated user ID and membership, never on a claimed email address. Password reset delivery still needs a mail provider. Previously issued PKCE email links remain supported and their callback credentials are removed from the URL; legacy passwordless users do not automatically gain a password by re-registering.
- **API calls** carry the user's session token (`Authorization: Bearer …`). A 401 sends the owner back to sign-in.
- **Tenant isolation** (separate PR, `supabase/migrations/*_tenant_access.sql`): with a user's token, the database returns only businesses that user is a member of. The API exposes synthetic sample businesses only in explicit demo mode. Reads the server makes with the service-role key bypass this, so the API must check the token (or pass it through) before real data goes in. Invites are a follow-up.
- **Screen lock:** numbers blur after `NERI_LOCK_MINUTES` (default 15) without activity or in the background; with real sign-in, unlocking checks the session is still valid.
- **Sign out everywhere** (Settings) revokes every refresh token; other devices are signed out once their current access token expires (about an hour by default).

## Real owner data and source imports

A live API defaults to production behavior: `window.NERI_DEMO_MODE` must explicitly be `true` to expose sample businesses. Production hides sample entry points and switching, drops cached preview accounts, and never sends sample routing headers. A saved owner session restores its private business; a new owner continues setup. Home and Details show an import-first state until the forecast has opening cash and source records. No placeholder cash chart or suggested actions are shown before then.

Source choices during setup are preferences, not connections. Planned and coming-next providers are greyed out and cannot be selected. `GET /connections` reports the sources available to this particular business. Only an `available: true` response shows **Sync now**; `POST /connections/:id/sync` performs the real server-side read. Providers without that capability are greyed out on Sources; dedicated file-import cards remain available, and the upload and paste controls provide a fallback for every provider. Outlook email uses the `outlook` provider ID. Gmail is listed separately from calendar access; an unconfigured Gmail connection stays disabled.

File uploads call `POST /import/upload`; pasted source text calls `POST /import/paste`. Review loads `GET /review/proposals` alongside matched signals, shows extracted fields and reasons, and confirms resolved proposals through revision-checked `POST /review/:id/confirm` with an idempotency key. Unresolved items remain visible and cannot be applied until their missing information is resolved; they can be dismissed. Failed syncs and imports report an error instead of showing a success state.

Missing opening cash can be supplied through **Add your current bank balance** on Home or Sources. The owner types the actual signed amount and balance date; `PUT /balance` stores it as an owner-entered balance snapshot in the profile currency. Blank, malformed or over-precision amounts are rejected before any request. The balance is not turned into a note or a forecast commitment.

Existing bank balances can be corrected by selecting an existing account from `context.balanceAccounts`; the UI does not invent an additional account. Foreign-currency balances are updated by statement import because manual entry uses the business base currency.
