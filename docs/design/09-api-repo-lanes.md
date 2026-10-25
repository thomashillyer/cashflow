# 09 — API, repo, and lane contracts

One TypeScript repo, to match the existing Neri prototype (Node, Supabase, HTML). If reusing the prototype isn't allowed under the event's rules, the same layout works fresh with SQLite. The schema lives in one file that every lane imports.

## Repo layout

```
neri-cash/
  CLAUDE.md
  README.md       three-step setup for a business owner
  schema/         records.ts — the six record types, single source of truth
  profiles/       trading.json, restaurant.json, agency.json, contractor.json
  adapters/       zoho_books/, bank_csv/, email/, owner/, generic_file/
  engine/         expand, lag, forecast, simulate, warnings, rank (+ tests)
  ai/             prompts/, tools.ts, number_check.ts, response_cache.ts
  api/            HTTP server
  app/            UI
  fixtures/       cascade_trade/, pike_noodle/, expected/
  docs/design/    this design
  data/private/   real exports (gitignored)
```

## API

| Endpoint | Does |
|---|---|
| `POST /import/:adapter` | Takes a file or pasted text; returns counts of records created and any proposals (mappings, recurring, profile edits) |
| `GET /forecast?scenario=` | Returns a `ForecastRun` |
| `POST /simulate` | Takes `Lever[]`; returns `{ scenarioId, lowPointDelta, run }` |
| `GET /brief` | Returns ranked `WorkItem[]` (top three first, then the rest) |
| `POST /ask` | Takes `{ question }`; returns an `Answer` (text, citations, optional scenarioId) |
| `POST /signals/:id/apply`, `POST /signals/:id/dismiss` | Owner decision on a proposed signal |
| `POST /rules/:id/confirm` | Owner confirms a rule proposed from a note |
| `POST /work-items/:id/draft` | Returns a drafted message for the item |
| `POST /work-items/:id/approve` | Marks it done (owner copies or opens in mail; never auto-sends) |
| `GET /profile`, `PUT /profile` | Read or edit the business profile |
| `GET /records/:id` | One record with its sourceRef, for "tap a number to see where it came from" |

## Screens (app)

1. **Home: three things to do today.** Each item: title, why, dollar effect, one-tap action (draft, mark done). Under it: cash today, the low point and its week, against the safety line.
2. **Forecast view.** 13-week chart with the safety line, low point marked, pipeline band for possible deals, idle-cash window. Tap any bar for the events and their sources.
3. **Ask Neri.** One box for questions, plans, and updates. What-ifs redraw the chart.
4. **Review.** Proposed signals, rules, mappings, and recurring items waiting for confirmation.
5. **Change alert.** "Customer B emailed: payment slips to Dec 20. Week 7 is now short $21K." Opens the home screen, re-ranked.

## Lane contracts

Each lane starts against fixtures, so nobody waits on anyone until integration at 1 pm.

| Lane | Consumes | Produces | Starts against |
|---|---|---|---|
| Data and adapters | Exports, messages, owner text | Records in the store | Real export files; writes `fixtures/*/records.json` first |
| Engine and warnings | Records plus profile | `ForecastRun`, `WorkItem[]` | `fixtures/*/records.json` |
| AI (Claude) | ForecastRun, WorkItems, tools | Brief text, answers, drafts, signals | `fixtures/*/forecast_run.json` |
| App | The API | Home screen, chart, Ask Neri, approve flow | Static JSON served from `fixtures/` |

### Five people

The engine-and-warnings lane is split so five people each own one area:

| Person | Lane | Owns |
|---|---|---|
| Niru (1) | Data and adapters | `adapters/`, Evidence storage, masking, `fixtures/*/records.json` |
| Thomas (2) | Engine | `engine/expand`, `lag`, `forecast`, `simulate` + golden tests |
| SilverBeck (3) | App | `app/`, `api/` routes, Review screen, onboarding/profile editor |
| Andras (4) | AI (Claude) | `ai/`: signal/document extraction, reconciliation proposals, brief text, Ask Neri, drafts |
| Kiana (5) | Warnings, integration, demo | `engine/warnings`, `rank`, end-to-end wiring, deploy, demo script, submission |

The task lists in `tasks/` came from the earlier plan; their checklists still apply where they match these lanes.

Hand-off order on build day:

1. By 11:00: `schema/records.ts` frozen; `fixtures/cascade_trade/records.json` committed (hand-written if needed).
2. By 12:00: engine produces `forecast_run.json` for the fixture; AI and App switch from hand-written to generated output.
3. 1:00: real adapters feed the store; everyone switches to PilotCo's masked data.
