# 11 — Plan, demo, risks, open questions

## Sunday timeline (Oct 25, 2026)

Event times from https://hack.claudeseattle.org/; internal checkpoints are ours.

| Time | What |
|---|---|
| 9:00–10:30 | Check-in, roles, agree on the data model and profile shape |
| 10:30 | Building starts (team formation closes) |
| 11:00 | `schema/records.ts` frozen; fixture records committed |
| 10:30–1:00 | Each lane builds against fixtures |
| 1:00–3:00 | Integrate end to end; switch to PilotCo's masked data |
| 3:00 | Feature freeze |
| 3:00–5:00 | Polish UI, rehearse, record the demo video |
| 5:00–5:30 | README and submit |
| 5:30 | Submission deadline |
| 5:30–6:30 | Prelim judging |
| 6:30–7:30 | Finals: 5-minute live demos plus Q&A |

## Demo

Follow the owner's nine-step script from the product brief (real owner, real cash crunch with names hidden, a decision in under three minutes). Then add one beat for the generic story:

- **Swap the profile** to the Pike Street Noodle Bar fixture and show the same home screen fill with different, sensible three things in seconds. That is our evidence for "any business owner."
- Show the three-step README.

Likely judge questions and answers:

- *What if Claude misreads a message?* Review screen, confidence on every signal, the source excerpt shown beside each change, and owner confirmation below the threshold.
- *Is this financial advice?* No. It shows options and the cash math; the owner decides. Partner cards are labeled samples.
- *Where does the data go?* Read-only access, processed for this business only; the public repo and video use fictional or masked data.
- *How accurate is it?* Show stated versus observed payment timing, and the forecast against what actually happened on the real books.
- *How is this different from Pilot or the accounting tool's forecast?* Signals from outside the books, deal-level cash before signing, and one engine that adapts to any business by profile.

## Risks

| Risk | Mitigation |
|---|---|
| Reusing the Neri prototype conflicts with event rules or the open-source requirement | Confirm with the hosts first thing; the repo layout works fresh if needed |
| Microsoft 365 access fails on the day | Paste or .eml upload uses the same Signal pipeline, so the demo beat survives |
| A forecast number on stage is wrong | Owner reviews every number before the demo; golden tests on the sandboxes |
| Claude states a figure that isn't in the data | Number check with regeneration and a plain-text fallback |
| "Generic" turns into building four profiles | Ship two working profiles; the other two are template files only |
| A sample partner card reads as a real offer | Labeled as a sample on the card, with how partners are paid |
| Slow Claude calls stall the live demo | Response cache keyed on the forecast run; demo mode never waits |

## Cut list

Protect the owner's core five: the 13-week forecast, real payment lag, one outside signal, warnings, and ways to close a gap.

If behind, cut in this order:

1. CRM deals
2. WhatsApp
3. The partner card
4. Live email (keep paste)
5. The idle-cash view

Keep the second profile; it is our proof of the rubric's generic requirement.

## Open questions before 10:30

- [ ] Do the event rules allow building on the existing Neri prototype, and is the owner fine open-sourcing that code?
- [ ] Does the Zoho export include payment dates per invoice? The lag model needs them.
- [ ] Which bank, and which statement format can we export?
- [ ] What is PilotCo's safety line?
- [ ] Live Microsoft 365 on Sunday, or paste first and live as a stretch?
- [ ] Who owns each lane?
