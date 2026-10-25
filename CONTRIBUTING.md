# Cashflow (Neri Cash)

An action-first cash-flow copilot for small businesses: **what needs attention, by when, and why?** It reads the books, bank, and outside signals (email, WhatsApp, owner notes), projects cash 13 weeks ahead with daily detail, and shows the owner "three things to do today," each with its dollar effect and a drafted action.

The live app is at [neri-cash.fly.dev](https://neri-cash.fly.dev). Create an account or sign in, open your private business, then use Sources to sync an available connection or upload/paste records. Imported documents wait in Review. Enter a real opening bank balance when requested; missing data stays visible. Production has no sample-business mode.

## Start here

1. Read [`CLAUDE.md`](CLAUDE.md) for the rules and conventions, then the [design](docs/design/01-overview-and-architecture.md) and [technical implementation plan](docs/TECHNICAL_PLAN.md).
2. Find your assigned role in the [task board](tasks/README.md); lane ownership is in [09-api-repo-lanes](docs/design/09-api-repo-lanes.md#five-people).
3. Freeze [`schema/records.ts`](docs/design/03-data-model.md) at 11:00 and commit fixture records so every lane builds against the same data.
4. Integrate at 1:00, freeze features at 3:00, submit by 5:30 ([timeline](docs/design/11-plan-demo-risks.md)).
5. Run the app and API: [`api/README.md`](api/README.md) (`npm run dev`, http://localhost:8787).
6. Wiring the AI modules into routes (api/app and integration lanes): [`ai/README.md`](ai/README.md), with a runnable example in [`ai/integration.example.test.ts`](ai/integration.example.test.ts).
7. Rehearse the [five-minute demo script](docs/DEMO_SCRIPT.md): new user onboarding, then a returning owner's review, forecast, and drafted-action workflow, with setup and reset instructions.

## Five roles

| Person | Lane | Task list |
|---|---|---|
| Niru (1) | Data ingestion and adapters: Zoho/CSV, bank, XLSX, email/WhatsApp paste, invoice links, evidence storage | [Tasks](tasks/01-data-and-source-adapters.md) |
| Thomas (2) | Engine: expand, payment lag, forecast, simulate, golden tests | [Tasks](tasks/02-cashflow-engine.md) |
| SilverBeck (3) | UI and UX: home screen, forecast chart, Review, onboarding/profile editor | [Tasks](tasks/03-product-ui-and-onboarding.md) |
| Andras (4) | AI ingestion and normalization: signal/document extraction, reconciliation proposals, brief text, Ask Neri, drafts | [Tasks](tasks/04-document-understanding-and-reconciliation.md) |
| Kiana (5) | Actions/recommendations, warnings and ranking, integration, deployment, demo, submission | [Tasks](tasks/05-actions-integration-and-demo.md) |

## Principles

- **Generic core, specific profile.** Business-specific terms, thresholds, and vocabulary live in `profiles/`, never in code.
- **Code computes, Claude judges.** All money math is deterministic TypeScript; Claude extracts, explains, and drafts, and every figure it states comes from a tool result.
- **Count one invoice once,** even when it arrives as an export row, a PDF, an email link, and a WhatsApp reminder.
- **Suggest, then wait.** The owner confirms every change. Nothing sends a message, pays a bill, or moves money.
- **Honest state.** Tentative funding, stale or incomplete data, and unresolved reviews stay visible; no all-clear without the data to back it.

## Setup for contributors

Run Claude Code on the hackathon API credits without touching your normal login: `bash scripts/setup-claude-hack.sh` (macOS/Linux) or `scripts/setup-claude-hack.ps1` (Windows), then `claude-hack` in this folder.

Public demos and committed fixtures must be synthetic. Real exports live in `data/private/` (gitignored); secrets go in `.env` only.

## Database (Supabase)

The schema lives in `supabase/migrations/` and mirrors `schema/records.ts`; `db/` has the typed client (`getSupabase`, `loadRecords`, `upsert*`). Copy `.env.example` to `.env`, paste the Supabase values the team lead shared, then run `npm run setup:supabase` to validate them and check connectivity (`-- --from-cli` fetches keys instead, if you are logged in to the Supabase org).

- **Local:** `npx supabase start` (needs Docker), then `npx supabase db reset` to apply migrations. `npx supabase status` prints the local URL and keys.
- **Shared hosted project:** `npx supabase link --project-ref <ref>`, then `npx supabase db push` to apply new migrations. Get the URL and anon key from Project Settings → API.
- **Schema changes:** add a new file with `npx supabase migration new <name>`; never edit an applied migration.
- **Review:** document imports create pending proposals and signals; confirm or dismiss them in Review. The API uses revision checks and atomic decisions before changing accepted financial records.
- **Reading** uses `loadRecords`, one `load_records` RPC snapshot returning `{ records, storeRevision }`. Server writes use a business-scoped service-role client.

Tenant RLS permits authenticated members to read only their private businesses. Anonymous access is limited to synthetic database rows; production API requests require sign-in and reject synthetic businesses. Connector credentials stay server-side and are bound to one private business with `NERI_CONNECTOR_BUSINESS_ID`. See [API configuration](api/README.md) for Outlook and optional Zoho Books. Public demos and fixtures remain synthetic.

The earlier [seven-hour plan](docs/HACKATHON_PLAN.md) is superseded by `docs/design/`, but keeps the duplicate-evidence demo story and its daily fixture arithmetic.
