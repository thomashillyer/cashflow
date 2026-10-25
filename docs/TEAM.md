# Team: who did what

The Teamwork criterion rewards a distinct, visible role for every member and showing how we worked together. Code shows up in git history; record everything else here (pitch, research, user interviews, design, demo, decisions). Add a line when you finish something.

## Roles

| Person | Lane | Visible contribution |
|---|---|---|
| Niru (1) | Data and adapters | Source adapters, evidence capture, fixture records |
| Thomas (2) | Engine; technical plan | Forecast engine, lag model, scenarios; `docs/TECHNICAL_PLAN.md`; repo setup |
| SilverBeck (3) | App | Owner UI: home screen, chart, Review, onboarding |
| Andras (4) | AI (Claude): extraction, reconciliation, signals, answers | Shared schema, intake fixtures, document/message extraction, reconciliation, Supabase, number check, brief and drafts |
| Kiana (5) | Warnings, integration, demo | Warnings and ranking, end-to-end wiring, deploy, demo and pitch |

## How we worked together

- One lane per person (`docs/design/09-api-repo-lanes.md`), one shared contract (`schema/`), frozen at 11:00.
- Every task is a GitHub issue; every change is a PR that names its issue; a local subagent review runs before each push (`CLAUDE.md`).
- Shared synthetic fixtures (`fixtures/`) so every lane built in parallel without waiting on another.

## Log (non-code and notable decisions)

Add entries under your own name to avoid merge conflicts. Each owner keeps their row in Roles current.

### Niru

### Thomas

### SilverBeck

### Andras

- Adopted the Neri Cash design and merged it with the earlier plan; set up the PR/review workflow and the Supabase project; encoded the judging rubric in CLAUDE.md.

### Kiana

- Took the integration lane (person 5) and wrote the warning checks and ranking that turn a forecast into "three things to do today": cash gap (chase / defer), early-pay discount, idle cash, AR concentration, payment slip, each with a dollar effect from the engine's `simulate()` (#35).
- Wired the loop end to end in `engine/brief.ts` (forecast → warnings → rank) and added the `work_items` store helpers, so an owner's ticked-off items stay done across reruns (#70).
- Spotted that saved work items couldn't tell which forecast they came from, proposed an `inputs_hash` column, and agreed it with Andras before writing the migration; Andras followed up with the atomic save RPC (#91, #109).
- Aligned warnings with Thomas's engine changes: one lever per payment leg, and `deal_affordability` ("ask for 50% upfront and you stay above your safety line") for deal-level cash before signing (#98).
- Ran a local subagent review before every push and fixed what it found; flagged cross-lane follow-ups in the PRs instead of patching other lanes' code (engine `ask_advance` semantics and overdue chase for Thomas, per-leg drafts for Andras).

