# Neri Cash app

The owner-facing web app: Today (three things), Forecast, Notes, Review, Sources, Ask Neri, and drive mode.
Plain HTML, CSS and JavaScript modules. No build step, no dependencies. Works on phone, tablet and desktop.

## Run it

```bash
cd app
python3 -m http.server 4300     # or: npx serve -l 4300
```

Open http://localhost:4300. It starts in **preview mode** with two fictional businesses (switch in the header):
Cascade Trade Co. (trading, from `docs/design/10-testing-and-fixtures.md`) and Pike Street Noodle Bar (restaurant).

## Point it at the team API

Set `window.NERI_API_BASE` in `app/config.js`, or open `http://localhost:4300/?api=http://localhost:8787`.
Every call goes through `app/api.js`; the `live` object there lists the routes the app expects. They follow
`docs/design/09-api-repo-lanes.md`, plus four the app needs that aren't in that table yet:

| Route | Why the app needs it |
|---|---|
| `GET /context` | Business name, owner, timezone, sources with last sync, parties, rules, profile |
| `GET /review` | Proposed signals with the message excerpt and the priced effect (before/after low point) |
| `GET/POST /notes`, `PATCH /notes/:id`, `POST /notes/:id/(add\|keep\|remove)` | Parked thoughts (owner channel of the signals pipeline) |
| `POST /plans` | Owner confirms a plan proposed in Ask Neri |

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
| `mock/` | **Preview only.** A small generic engine plus two fixtures so the app runs before `engine/`, `ai/` and `api/` exist. Delete when the API is wired. |

## Product rules the UI keeps

- Today leads with one sentence and at most three actions, each with its dollar effect and an act-by date. Never padded to three.
- Play brief reads the same sentence and items out loud (about 35 seconds). Drive mode is large type, two buttons, screen kept awake.
- Notes: anything typed or spoken is read as money in or out, amount, date, party and certainty. It reaches the forecast only after **Add to forecast**.
- Every number has a source chip that opens its record: the invoice, its payment history, the message behind a moved date.
- Nothing sends, pays or writes back. Drafts are copied or opened in the owner's own mail app.
- Partner cards are labeled as samples, with the referral disclosure on the card.
- Hide names (Settings) masks customers and suppliers for demos and screen sharing.

## Security

- **Sign-in:** one-time code to the business email through Supabase Auth (`app/ui/auth.js`). Set `NERI_SUPABASE_URL` and `NERI_SUPABASE_ANON_KEY` in `app/config.js`; without them the app runs the preview sign-up, which never leaves the browser. No passwords are stored. The service-role key never goes in the browser.
- **API calls** carry the user's session token (`Authorization: Bearer …`). A 401 sends the owner back to sign-in.
- **Tenant isolation** (separate PR, `supabase/migrations/*_tenant_access.sql`): with a user's token, the database returns only businesses that user is a member of, plus the synthetic sample businesses. Reads the server makes with the service-role key bypass this, so the API must check the token (or pass it through) before real data goes in. Invites are a follow-up.
- **Screen lock:** numbers blur after `NERI_LOCK_MINUTES` (default 15) without activity or in the background; with real sign-in, unlocking checks the session is still valid.
- **Sign out everywhere** (Settings) revokes every refresh token; other devices are signed out once their current access token expires (about an hour by default).
