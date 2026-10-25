# Neri Cash demo script

Presenter runbook, first draft. Allow **5 minutes**, plus optional follow-ups.
Audience: a small-business owner or a hackathon judge. Goal: show how an owner
gets started, then turns a payment update into a decision and a drafted action.

## Prepare and reset

Use only the fictional Cascade Trade Co. and Pike Street Noodle Bar data.
The main script uses the **browser-only preview**, which needs no database,
API key, email delivery, or external connection:

```sh
npm install
npm run app
```

Open <http://localhost:4300> in a fresh private browser window. Leave
`app/config.js` at its committed empty API/auth values and use a URL without
`?api=`. Keep the terminal running. See [app setup](../app/README.md) for details.

- Start at the welcome screen. To repeat onboarding, sign out in **Settings**
  or close all private windows and open a fresh private window.
- The preview account survives refresh in this browser; forecast changes,
  applied signals, and completed actions reset on a full reload. **Do not reload
  between the returning-user steps.** Reload before a fresh rehearsal.
- Demo time is fixed at **October 25, 2026**. Read cash amounts and dates from
  the screen; they are fixture forecasts, not today's bank data.
- Use a desktop-width window so **Review** is visible in the top navigation.
  Close unrelated tabs and disable notifications before recording.

Opening line: **“Neri turns your books, bank, and payment messages into the
few cash decisions you need to make today. Here is a new owner's first visit,
then their next morning.”**

## Act 1: New user onboarding (0:00–1:30)

| Time | Presenter action | Say | Check before continuing |
|---|---|---|---|
| 0:00–0:20 | On the welcome screen, enter `dana@cascade.example` in **Work email**, then **Continue**. | “Start with your business email. The production sign-in flow uses an email link or code. This preview simulates it locally.” | **Check your email**, **Code**, and **Business name** appear. No email is delivered with the committed preview configuration. |
| 0:20–0:35 | Enter `123456`; set **Business name** to `Cascade Trade Co.`; click **Create account**. | “No password to manage. These six digits work only in the preview.” | **Set up Cascade Trade Co.** opens. |
| 0:35–1:00 | Choose **Trading and import**. Point to the suggested apps, then enter `35,000` in **Keep at least**. Leave apps unselected. | “Choose a starting profile and the minimum cash you want to keep. Sources can come from files or pasted messages. We are using the bundled sample, so these connections are simulated.” | The safety reserve is $35,000. The button says **Skip for now**. |
| 1:00–1:15 | Click **Skip for now**. | “For this rehearsal, we can explore the product before connecting any accounts.” | **Home** loads, with the banner explaining that the preview shows a sample trading business. This is not a forecast built from the new email address. |
| 1:15–1:30 | Point to the short brief and today's actions. | “The starting point is a short list of actions: what to do, by when, and how much it could help cash.” | Each action has its reason, cash effect, and source links. |

**Onboarding success:** the owner reaches Home from a clean browser after
choosing a profile and reserve, and understands which data is simulated.

## Act 2: Existing user, next-morning workflow (1:30–4:45)

Continue in the same account. Narrate the time jump: **“Now imagine Dana coming
back the next morning. Her business is already set up.”** A returning preview
account can also open Home directly at <http://localhost:4300/#/today>.

| Time | Presenter action | Say | Check before continuing |
|---|---|---|---|
| 1:30–1:55 | Open **Details**. Point to **Cash today**, **Lowest point**, **Your line**, and the 13-week chart. | “Cash in the bank today is not the same as cash available through the next payroll and supplier bills.” | With untouched Cascade preview data: cash today **$104,000**; reserve **$35,000**; lowest point **−$6,800 on December 23, 2026**. If the fixture differs, use the displayed values. |
| 1:55–2:25 | Open **Review**. Find Evergreen Home's message about **INV-1187**. Read the highlighted excerpt and the proposed date change. Click **See invoice**, inspect its source and payment timing, then close the sheet. | “The books say when an invoice is due. This customer says they will pay around January 8. Neri proposes a change, shows the exact message behind it, and waits for Dana.” | The existing **$28,000** invoice moves from **December 24, 2026** to **January 8, 2027**. The card shows **86%** confidence and a before/after low point. Opening the invoice has not applied the change. |
| 2:25–2:45 | Click **Apply change** on that card; return to **Details**. | “Dana accepts the reading. The forecast changes the timing of this invoice; the message is not another invoice or proof of payment.” | The card leaves the pending list. The low point becomes **−$20,800 on December 24, 2026** in the untouched preview, and the cash chart updates. |
| 2:45–3:20 | Go to **Home**. Open **Draft email** on the Evergreen Home action; inspect the recipient, subject, and editable text. Click **Copy**, then close the sheet. | “Now Dana has a concrete next step and a draft she can edit. Copying a draft does not send it. Neri never sends a message, pays a bill, or moves money.” | A draft for the action opens. The forecast stays unchanged. Keep **Open in mail app** unused during the demo. |
| 3:20–3:40 | Click **Mark done** on that action. | “Done records Dana's follow-up. It does not mean the invoice was paid or that the customer agreed to a new date.” | The action shows **Done**. The low point does not improve just because an action was checked off. |
| 3:40–4:15 | In **Ask Neri**, type `Can I afford a $30K supplier deposit in December?` and submit. Read the answer, then click **Show in details**. | “Before committing to a purchase, Dana can see its effect on the cash gap. This is a what-if until she chooses to add it.” | A separate what-if appears. After the accepted delay, the preview proposes **December 15, 2026** and a low point of **−$50,800 on December 24**. Point out the interpreted date. Do not click **Add to forecast** for this example. |
| 4:15–4:45 | Click **Clear what-if**. Toggle **If customers pay a week late**, then return to **Expected**. | “Dana can compare a late-payment scenario, then return to the expected view. She can decide whom to call and which spending to reconsider before the tight week arrives.” | The what-if clears; the expected forecast remains at the accepted-message baseline. Stress changes the chart without rewriting the base forecast. |

**Returning-user success:** Dana traces a cash risk to an invoice and message,
approves its timing change, gets a draft, records a follow-up, and explores a
purchase without silently committing that purchase or assuming payment arrived.

## Close (4:45–5:00)

**“That is the daily loop: see what needs attention, check the evidence,
confirm what changed, and take the next action. The owner keeps control.”**

For the hackathon, add: “Our team split the work across ingestion, the cash
engine, the owner interface, AI extraction and explanation, and integration.
Shared record contracts and review before pushing kept those lanes connected.”
See the [task board](../tasks/README.md) for the lane owners.

## Optional extensions (allow 30–60 seconds each)

- **Capture an owner's thought:** open **Notes**, type `Buy equipment for $5,000
  on November 20, 2026`, and click **Park it**. Inspect **Neri's reading**:
  money out, $5,000, November 20. Point to the priced effect before clicking
  **Add to forecast**. After adding, check the note says **Added to forecast**
  and the low point changes. Do this after the main script so its amounts stay
  reproducible. **Keep as a note** demonstrates the path that leaves cash alone.
- **A different business:** in Settings, sign out (or **Create your account**
  if using a sample account). On the welcome screen choose **Look around with a
  sample business first**. In **Settings**, use the sample-business selector
  to choose **Pike Street Noodle Bar**. Show its Home and Details views:
  the same interface now uses restaurant cash patterns and vocabulary.
- **Live import and reconciliation:** use the separate API setup below, sign in,
  and complete onboarding to create the owner's private business. Shared sample
  businesses reject uploads, even from signed-in users in demo mode. Import
  synthetic invoice evidence, inspect its proposed fields in Review, and confirm
  before showing the forecast. Re-import identical evidence and verify it is
  recognized as a repeat. Rehearse this route separately; the browser-only
  preview acknowledges uploads without importing them.

## Live API variant and fallback cues

The five-minute script above is a **product preview rehearsal**. For the real
engine/API, follow [API setup](../api/README.md). A local fixture-backed server
can run without a database:

```sh
NERI_STORE=memory DEMO_MODE=1 NERI_AI_MODE=cache_only npm run dev
```

Open <http://localhost:8787/?api=http://localhost:8787> and choose **Look around
with a sample business first**. The query opts the locally served UI into API
mode; opening the port alone leaves the committed config in preview mode.
Use the UI's returned values for this variant: the production engine and its
records can differ from `app/mock/`, so the preview amounts above are not its
acceptance criteria. Cache-only mode uses committed responses or deterministic
fallback text rather than a live model call.

Live onboarding requires configured Supabase Auth and a real sign-in email link or code;
`123456` is not a live credential. Live **imports** and **POST /setup** require
sign-in even in demo mode. For imports, first complete setup and use the resulting
private business; shared synthetic samples are read-only for imports.
See the API README before attempting those beats.
Never present simulated connections as completed OAuth or a live bank sync.

| If this happens | Presenter recovery |
|---|---|
| The browser opens an old account or no pending Evergreen card appears | Reset the preview with a full reload; use Settings to sign out if onboarding needs repeating. Start again before applying anything. |
| A real sign-in email is requested, or the API cannot be reached | Return to a fresh window at `http://localhost:4300` with empty committed API/auth config. Explain the switch to the bundled preview. |
| A connector is unavailable or email is slow | Continue with the sample. Mention file/paste alternatives; show a live upload only after separately rehearsing authenticated API mode. |
| Ask Neri returns its unsupported-question fallback | Use the exact question above. If still unsupported, skip the what-if and finish on the reviewed change and draft. |
| Copy is blocked by browser permissions | Highlight the editable draft to show it is ready for Dana; close it and continue. |
| Time is short | Keep onboarding, the Review → Apply change → Details loop, and the draft. Drop optional beats and the stress toggle. |

## Rehearsal checklist

- [ ] Fresh preview window reaches Home through email, preview code, profile, and reserve.
- [ ] The preview banner and simulated connections are explained out loud.
- [ ] Evergreen evidence, old/new dates, confidence, and before/after cash are visible.
- [ ] Applying the message updates the existing invoice's timing and the forecast.
- [ ] A draft opens; Copy and Mark done do not send anything or book a payment.
- [ ] The what-if can be cleared without adding the proposed purchase.
- [ ] The main path fits five minutes; a fresh reload makes it repeatable.
