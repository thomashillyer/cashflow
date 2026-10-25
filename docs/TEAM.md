# Team: who did what

The Teamwork criterion rewards a distinct, visible role for every member and showing how we worked together. Code shows up in git history; record everything else here (pitch, research, user interviews, design, demo, decisions). Add a line when you finish something.

## Roles

| Person | Lane | Visible contribution |
|---|---|---|
| Niru (1) | Data and adapters | Source adapters (CSV/XLSX, Zoho, QuickBooks, Xero, Outlook, WhatsApp), imports, bank statements, masking |
| Thomas (2) | Engine; technical plan | Forecast engine, lag model, levers, scenarios; `docs/TECHNICAL_PLAN.md`; repo setup; Fly.io deployment; demo script |
| SilverBeck (3) | App | Owner app: sign-up and setup, Home with Ask Neri, today's cards, drive mode, logo; tenant access in the database |
| Andras (4) | AI (Claude): extraction, reconciliation, signals, answers | Shared schema, intake and extraction (PDF, XLSX, scanned, WhatsApp), reconciliation, Supabase, number check, brief and drafts, Ask Neri, API server, CI |
| Kiana (5) | Warnings, integration, demo | Warnings and ranking, end-to-end wiring, work items, adapter persistence, auth emails |

## How we worked together

- One lane per person (`docs/design/09-api-repo-lanes.md`), one shared contract (`schema/`), frozen at 11:00.
- Every task is a GitHub issue; every change is a PR that names its issue; a local subagent review runs before each push (`CLAUDE.md`).
- Shared synthetic fixtures (`fixtures/`) so every lane built in parallel without waiting on another.

## Log (non-code and notable decisions)

Add entries under your own name to avoid merge conflicts. Each owner keeps their row in Roles current. Entries below are taken from git history (`.mailmap` joins Andras's two identities).

### Niru

- Built the source adapters: CSV/XLSX, links, Zoho, QuickBooks, Xero, Outlook and WhatsApp export (#88).
- Added imports through `/import` for CSV, XLSX and WhatsApp exports, with diagnostics and repeat detection, and kept the original file behind each import in a private bucket with member-only download (#156, #221).
- Added bank statement import: opening balance, bank lines and recurring proposals (#234).
- Read Zoho correctly on a live account: vendor payments, and CRM deals as `sales_deal` commitments with probability-driven certainty (#200, #212).
- Added books advances (unallocated payments), an expected-payment check, an Outlook mailbox and probe scripts (#193).
- Made Connect read the app for real: pull route, opening cash from Zoho, connection state on Sources (#227).
- Added consent helpers for Xero, QuickBooks and Zoho (Books, banking and CRM together), several operator emails, and documented the Connect env names (#235, #240).
- Masked contact details, account numbers and names at the edge so a real account can be shown (#224).

### Thomas

- Wrote the technical plan, the five lane task files and the repo setup: owner names in lanes, Supabase instead of SQLite, pre-push hook, Claude Code GitHub workflow (#25, #31, #33, #58).
- Built the forecast engine core: forecast, lag, scenarios, profiles, fixtures (#32); then lag precedence and signals, recurring anchors, per-leg lag, FX and coverage fixes (#55, #86, #94, #125, #151).
- Made payments count once and kept overdue bills in the balance; stress never beats base; opening cash per account; linked costs and settlement-derived outstanding (#95, #103, #108, #111, #160).
- Added the levers behind the warnings: one leg per lever, `nonDeferrable`, split as installments, smallest upfront share for deal affordability (#56, #93, #106).
- Added the needs-review flag and the weighted possible-deal pipeline on the chart, and qualified forecasts when source data needs review (#114, #202, #206).
- Built the fixtures and the Pike Street Noodle Bar story; wrote the onboarding and returning-user demo script (#80, #92, #104, #159, #205).
- Hosted the live demo (API and app) on Fly.io with auto-deploy from main, after trying Cloudflare Pages and Workers; kept the AI cache writable in the image (#141, #149, #172, #209, #232).
- Made owner overrides apply to every forecast and survive re-imports; fixed sign-in config, demo-mode Ask Neri and sign-up without email verification (#154, #177, #180, #217).

### SilverBeck

- Built the Neri Cash owner app: sign-up, setup, Home with Ask Neri, talk to Neri (#112).
- Added tenant access so each business is visible only to its members (#124).
- Published the app to GitHub Pages with `npm run app` for local integration, then moved hosting to Cloudflare Pages with per-PR previews (#130, #133).
- Put today's things on horizontal cards (#175).
- Added the Neri logo across the app with a design polish pass, and fixed the logo crop (#190, #198).
- Made the Ask Neri bar stand out with suggested questions on top, and added + in Ask for photos and files that go to Review (#194, #218).
- Matched the drive-mode play/stop and mic buttons (#215, #218).
- Added Reconnect on connected sources, with a status dot for Connected, Waiting and Needs attention (#233).
- Fixed the preview loading stale or stuck assets (#196, #204).

### Andras

- Adopted the Neri Cash design and merged it with the earlier plan; set up the PR/review workflow and the Supabase project; encoded the judging rubric in CLAUDE.md (#21, #53).
- Defined the shared schema and intake contracts, the intake fixtures and the person 4 integration guide (#19, #20, #90).
- Built intake: PDF text with page evidence, Claude document extraction, XLSX interpretation, message bundling and party resolution, signals for payment promises and date changes, and the `ingest()` pipeline (#23, #24, #28, #29, #54, #57, #83).
- Later intake work: scanned PDFs read with Claude vision, day-first WhatsApp dates (#171, #197).
- Built reconciliation: matcher, apply, PO partial invoices, and `Commitment.outstanding` kept consistent with settlements (#26, #85, #107).
- Built Supabase: schema migration, confirm RPC, typed client, fail-closed RLS, setup script, atomic `save_work_items` RPC, atomic confirm/dismiss/signal apply (#22, #30, #34, #109, #132, #201).
- Added `number_check` so no unsupported figure appears in Claude answers, the brief text and drafts, and live-Claude test caches (#36, #49, #59, #81, #84, #87, #89).
- Built Ask Neri: intent reading, CFO decision engine and voice, `askNeri()` with an eval set, live cache and Sonnet for live calls, rule proposals the owner can approve or dismiss (#100, #105, #116, #123, #131, #138, #150, #208, #222, #230, #236).
- Added the API server, CI, readiness checks, private demo copies per visitor, and the owner README (#126, #139, #153, #173, #187, #207, #213, #219, #239).

### Kiana

- Took the integration lane (person 5) and wrote the warning checks and ranking that turn a forecast into "three things to do today": cash gap (chase / defer), early-pay discount, idle cash, AR concentration, payment slip, each with a dollar effect from the engine's `simulate()` (#35).
- Wired the loop end to end in `engine/brief.ts` (forecast → warnings → rank) and added the `work_items` store helpers, so an owner's ticked-off items stay done across reruns (#70).
- Spotted that saved work items couldn't tell which forecast they came from, proposed an `inputs_hash` column, and agreed it with Andras before writing the migration; Andras followed up with the atomic save RPC (#91, #109).
- Aligned warnings with Thomas's engine changes: one lever per payment leg, and `deal_affordability` ("ask for 50% upfront and you stay above your safety line") for deal-level cash before signing (#98, #113).
- Ran a local subagent review before every push and fixed what it found; flagged cross-lane follow-ups in the PRs instead of patching other lanes' code (engine `ask_advance` semantics and overdue chase for Thomas, per-leg drafts for Andras).
- Made possible-deal affordability explain-only, with no dollar figure (#135).
- Persisted accounting adapter output idempotently on `sourceRef` (#148, #211).
- Kept done items on today's list without pushing open ones off, and made a defer's deadline its own due date, with the document named in the title (#199, #228, #243).
- Made sign-up and sign-in emails show the 6-digit code the app asks for (#192).
