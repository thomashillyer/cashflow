# 01 — Overview and architecture

## Summary

Neri Cash is one generic cash engine that adapts to each business through a **business profile** (configuration), not custom code. Every source becomes the same kind of record, plain code computes a 13-week forecast, named checks raise warnings, and Claude explains, ranks, and drafts the "three things to do today."

PilotCo (cross-border trading) is the first profile and our real test. A second, very different profile (a restaurant fixture) in the demo proves the design is generic.

The product story lives in the owner's brief ("Neri Cash: what we're building"). This set of docs covers how we build it.

## Design principles

The test for every component: could a restaurant, a contractor, or an agency use it by changing configuration only? If it needs `if business === "PilotCo"`, it belongs in the profile instead.

1. **Generic core, specific profile.** The engine knows about parties, commitments, and dated cash. Everything industry-specific (payment patterns, cycles, thresholds, vocabulary) is data in the business profile.
2. **Everything becomes a commitment, then cash events.** An invoice, a bill, a payroll run, a supplier deposit, a won deal, a quoted RFQ, and an owner's plan are all commitments. Each expands into dated cash events through a payment pattern.
3. **Code computes, Claude judges.** All numbers come from deterministic functions. Claude reads messy text, explains, ranks, and drafts; any figure it states must come from a tool result.
4. **Every number traces to a source.** Each cash event keeps a pointer to the invoice, bank line, message, or owner statement behind it.
5. **Certainty is explicit.** Every event carries a status (actual, committed, likely, possible) and a confidence. Maybe-money is never drawn as real money.
6. **Suggest, then wait.** Neri drafts; the owner approves. Neri never sends, pays, or moves money on its own.
7. **Adapters, not integrations.** A new source is one adapter that outputs the shared records. Every connector has a no-setup fallback (file export, forward, paste).

## Architecture

```
 ┌────────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────────┐
 │ Accounting │ │   Bank   │ │   Signals    │ │    Owner     │ <─┐
 │ Zoho/QB/   │ │ balance, │ │ email, chat, │ │ plans, quirks│   │
 │ Xero/export│ │ recurring│ │ CRM notes    │ │ via Ask Neri │   │
 └─────┬──────┘ └────┬─────┘ └──────┬───────┘ └──────┬───────┘   │
       └─────────────┴──────┬───────┴────────────────┘           │
┌──────────────┐     ┌──────▼──────────────────────────────┐     │
│   Business   │────>│ Adapters: one interface per source, │     │
│   profile    │     │ each with a file/paste fallback     │     │
│              │     └──────┬──────────────────────────────┘     │
│ payment      │     ┌──────▼──────────────────────────────┐     │
│ patterns     │     │ Shared records: parties, commitments,│    │
│ revenue model│     │ cash events, signals, rules          │    │
│ recurring    │     └──────┬───────────────────┬──────────┘     │
│ safety line  │     ┌──────▼─────────┐  ┌──────▼───────────┐    │
│ thresholds   │────>│ Forecast engine│─>│ Warnings and     │    │
│ vocabulary   │     │ (code)         │  │ ranking (code)   │    │
│              │     └──────┬─────────┘  └──────┬───────────┘    │
│ config,      │     ┌──────▼───────────────────▼──────────┐     │
│ not code     │     │ Claude layer: explains, answers,    │     │
└──────────────┘     │ drafts; cites records; no math      │     │
                     └──────┬──────────────────────────────┘     │
                     ┌──────▼──────────────────────────────┐     │
                     │ Owner surface: three things,        │─────┘
                     │ forecast, Ask Neri, approve drafts  │ owner loop
                     └─────────────────────────────────────┘
```

The owner loop: approved actions, confirmed signals, and plans typed into Ask Neri return as new records, so the next run already knows them.

## Two ingestion layers

Layer 1 captures source Evidence and extracts/maps it into structured intake candidates. Layer 2 validates and reconciles candidates into accepted shared records, then applies profile payment patterns, payment lag, and confirmed overrides to produce CashEvents. Unconfirmed extraction cannot directly change forecast cash. The [technical implementation plan](../TECHNICAL_PLAN.md) defines exact handoffs, persistence, API behavior, and the five-owner execution sequence.

## Where each part is specified

| Area | Doc |
|---|---|
| Business profile (how Neri adapts) | `02-business-profile.md` |
| Data model, the contract | `03-data-model.md` |
| Adapters | `04-adapters.md` |
| Forecast engine | `05-forecast-engine.md` |
| Signals pipeline | `06-signals.md` |
| Warnings and ranking | `07-warnings-and-ranking.md` |
| Claude layer | `08-claude-layer.md` |
| API, repo, lane contracts | `09-api-repo-lanes.md` |
| Test data and genericity check | `10-testing-and-fixtures.md` |
| Plan, demo, risks, open questions | `11-plan-demo-risks.md` |

## How we score against the rubric

Four equally weighted criteria, each scored 1 to 8 (https://hack.claudeseattle.org/).

| Criterion | What 7–8 means | Design choice that earns it |
|---|---|---|
| Does it work | Works end to end; a business could try it today | One loop rehearsed on real books: forecast, warning, explanation, fix, approved action. Deterministic engine, so the demo is repeatable. Claude responses cached for the demo dataset. |
| Ease for a small business | Plug-and-play; clear README; no code | A new business picks a starter profile and uploads an accounting export. Every live connector has a file or forward fallback. README in three steps. |
| Impact on operations | Changes how a core part of the business runs | "Three things to do today" turns cash management into a daily habit, with the email already drafted. |
| Creativity | Something judges hadn't thought of | Signals from outside the books move the forecast, with the message cited. Deals become probability-weighted cash before they're signed. One engine, swapped profiles. |
