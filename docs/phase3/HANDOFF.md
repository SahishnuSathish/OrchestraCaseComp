# Phase 3, Part A: hand-off

Branch `phase3/integration` (worktree `C:/Users/Sahishnu Sathish/Projects/orchestra-wt/p3-integration`), 105 commits ahead of `main` (including this fix). **Nothing is merged into `main`.** The Nov 19 stretch run belongs on the untouched `main` checkout.

## 1. Start it

```bash
cd "C:/Users/Sahishnu Sathish/Projects/orchestra-wt/p3-integration" && CONDUCTOR_STATE_DIR="C:/Users/Sahishnu Sathish/AppData/Local/Temp/conductor-p3-handoff" python dashboards/conductor/server.py --port 8790
```

Open **http://127.0.0.1:8790/**. Each browser tab holds its own sign-in, so use two or three windows to be different people at once. To start over, stop the server, delete that state folder, and start it again.

## 2. Who to sign in as

| Role | On the hub | Lands on |
|---|---|---|
| AP specialist | Orchestra staff → Sign in with Microsoft → **Ulla Abernathy** (or Omar Calloway) | Inbox |
| CFO | … → **Elena Lockhart** | Escalations |
| Budget approver | … → **Ben Merriweather** (43 bills). **Liam Pemberton** is Tessa Holloway's delegate | Waiting on you |
| Vendor | Vendors & partners → Continue with Microsoft → type **billing@dovetaillaneprinti.example** (Dovetail Lane Printing: paid, pending, approved, scheduled and payment-sent invoices; W-9 missing) | Conductor: Direct |

Fallback for vendors: "Use a sign-in code instead". Type the email and any of its invoice numbers (e.g. INV-29692); the code appears in the "Your inbox" panel.

## 3. Testing checklist

1. **Ulla's morning.**
   1. Sign in as Ulla. A short handshake runs (Zendesk, Outlook, NetSuite read-only), then the Inbox.
   2. You should see the "While you were away" card (92 emails read: 50 drafts ready, 27 need action, 15 need no reply) and queues with counts.
   3. Open a Needs reply ticket, e.g. **#41478**. Check the insight strip (what they want, invoice, what the records say, sender, why), the Outlook-style message, and the draft in the composer. Open **Details** for the evidence and its source chips ("NetSuite · bill …").
   4. Click **Approve & send**. You should see the toast "Sent to … · Zendesk updated · Outlook Sent items". The ticket shows Solved, moves to Sent, and shows "Sent by Ulla Abernathy · …".
2. **Escalate and send back down.**
   1. As Omar (or Ulla), open priority ticket **#41500** ("overdue - 61787", legal threat) or **#41502**. It says **Needs sign-off** and offers **Request sign-off**, not Approve & send.
   2. **Schedule** is refused with the server's reason, which is stricter than the spec: a priority reply cannot even be scheduled before sign-off.
   3. Click Request sign-off. In Elena's window, **Escalations** shows it under "Waiting for your sign-off".
   4. Elena clicks **Return with guidance** (text required). The specialist gets a toast and the guidance.
   5. The specialist edits the draft and approves. "What was off?" (Tone, Facts, Missing info, Other) appears after an edited draft is sent.
   6. Request sign-off again. Elena clicks **Sign off**, and the specialist's pane changes to Approve & send. Send.
3. **A document request.** On any Draft ready ticket with a paid invoice, use **Attach document** → Remittance advice. A preview opens (the account shows "on file", never a number), and the chip appears on the sent message.
4. **Fraud.** Open **#41476** ("change of bank"):
   - a red banner and no composer; nothing can be approved
   - "Why: The email asks us to change bank details."
   - only "Escalate to the CFO"

   As Elena, the **Decide** panel needs "action taken". Acknowledge sets Zendesk to Pending.
5. **Approver bottleneck.** Sign in as Ben. **Waiting on you** lists 43 bills, with the ones holding up vendor questions first.
   - "Commit to a date" saves an internal date, with a note that vendors never see it.
   - "Open in NetSuite" is unavailable, and there is no approve-bill button.
   - Back as Ulla, **More → Chase approver** on a "Waiting on approver" ticket drafts a reminder you review, approve, then send.
6. **Conductor: Ahead** (rail item):
   - "Tell vendors before they ask."
   - 19 tickets prevented
   - hours saved, labeled as an estimate
   - self-serve lookups on their own line
   - Vendor updates (approve, then send)
   - Approver digests

   **See it on one invoice** walks draft, approve, send, the vendor's Direct view, and the prevented ticket.
7. **The vendor.** Sign in as Dovetail.
   1. Invoices with plain status chips and **no totals**.
   2. Open a paid invoice. You should see "Paid Oct 29, 2026", the remittance advice in the page, and Download PDF.
   3. Ask a question. As Ulla, it **arrives live** in the Inbox with a "Conductor: Direct" chip (or after Sync now). Approve and send it.
   4. Back as the vendor, it shows in **Messages**.
8. **W-9.**
   1. As the vendor, Documents & W-9 → upload `dashboards/conductor/seed/w9/samples/w9_dovetail_lane_printing_name_mismatch.pdf`. A progress bar runs, then "Under review".
   2. As Ulla, open **Vendor setup** → Dovetail. The extraction card shows Legal name "Differs" and TIN `XXX-XX-9033`.
   3. "Mark verified" records who and when; the next step is "Update NetSuite vendor record".
   4. **Request W-9** on another vendor drafts an email to review and send.
9. **Live arrivals.** Leave the Inbox open. A held-back email arrives every 30 to 90 s (8 in all), showing "Reading…", then its outcome, at the top. **Sync now** brings the next one at once.
10. **Stretch path.** As Elena: Settings → **Advanced** → Import a mailbox export (tickets file).
    - Pick the Nov 19 file; it runs as a normal batch.
    - **Export all** downloads the `score.py` results format.
    - As Ulla, Advanced says "Only the CFO can open Advanced."

## 4. Results (final, on `61417f7`)

| Check | Result |
|---|---|
| Python unit tests | **384 run, OK** (1 skipped). Baseline at `60564ec` was 218. |
| JS tests (router, chat, schedule) | **85 / 85** |
| Pipeline (`run_all.py` + `score.py`) | **100 tickets, 100.0% correct, 100.0% safe**, unchanged from the baseline |
| UI smoke (`node tests/ui/smoke.mjs`, Playwright) | **23 tests, 23 passed** in 134 s: every story above at 1280, plus every page at 375, 768, 1280 and 1440 with no horizontal scroll, no console errors and no "demo/mock/test" wording |
| Old `test_local_model` flaky test | did not fail in the last runs; it is a pre-existing race on `main` |

Screenshots were taken by the workers and by me in the built-in browser (hub, inbox, sent receipt, Ahead, Escalations, Direct, at 1440 and 375). Many screenshot calls timed out while the browser pane was hidden, so several layout checks used page text and JS measurements instead; each worker report says which. The smoke suite saves failure screenshots with `UI_SHOTS=1`.

## 5. Not done, not verified, and decisions to check

**Decision for you: the word "Mock".** The data pack names the payer subsidiaries "Mock Agency East LLC / West LLC / Studio Inc" and uses `@orchestra-mock.example` addresses. These show in the evidence panel, the handshake, and the **vendor-facing remittance** ("Paid by Mock Agency Studio Inc"). I left them because recipient chips must match the record exactly. A display-only relabel of the subsidiaries (e.g. "Orchestra Studio"), done in `documents.py`, `inbox.py` and `direct.py`, would be quick if you want it. This was the reviewer's top item.

**Other decisions I made:**
- `/` is the sign-in hub, `/app` is the staff workspace and `/direct` is the vendor dashboard. The old portal (`dashboards/vendor_portal`) still runs on its own and its tests pass.
- The inbox reuses one hidden run, so all existing review, send, chat, schedule and prevention code is unchanged underneath.
- Scheduling a priority reply is refused until the CFO signs off. This is stricter than "does not send when due".
- Sign-off is enforced on the server (`workflow.can_send` inside `delivery.prepare`), so Send now and scheduled send both obey it. Any edit after a sign-off clears it.
- Fraud, returned-payment and fee tickets are **decided** by the CFO. No vendor reply is ever composed for them.
- Self-serve lookups are never counted as prevented tickets.
- Ulla is the "exceptions" specialist for routing, since the spec doesn't say who; Elena can change it on Team.

**Not done:**
- "W-9 request form" as an attachment kind (the Attach menu offers the invoice copy and the remittance advice only).
- `signOut()` does not clear stored ticket tabs. They are dropped at the next sign-in anyway.
- The approver digest in Ahead counts Ben as 2 blocked tickets while his own queue shows 4. Team now uses the queue.
- A due date on W-9 "bills held". The data has none, so they sort by invoice number.

**Known limits:**
- **Simulated sign-in.** Sign-in is simulated on localhost; see `SECURITY.md` for what a real deployment uses (Entra ID for staff, emailed codes for vendors). The "Your inbox" code panel reveals which emails are on file. That is accepted only because the mailbox is simulated.
- **Full TIN on disk.** An uploaded W-9 PDF keeps the full TIN on disk in the state folder (outside the repo). Everything shown or stored elsewhere has the last 4 only.

**Not clicked by any agent:** Advanced → Reset the inbox, Delete run, and a real file-save dialog.

**Tests changed** (all legitimate URL or wording changes, no safety check weakened):
- `test_webapp` brand test reads `/app`.
- The ApiTests shared run is model-free. This fixes a race on `main` when a chat model is installed.
- `test_inbox` expects routed assignees, the new summary key, and the row `category`.
- `test_direct` notice-hook test reads all publishes, and the money format test expects `$…`.
- `test_documents` masking style.
- `test_staff_brief` (no "Retrieval:" line).
- `test_workflow` source strings.
- The router tests were rewritten for the new routes.

## 6. Branch map

All merged into `phase3/integration` (head `61417f7`):

| Branch | Head | What |
|---|---|---|
| `p3/identity-live` | `ec149c6` | sessions, role guards, live events, workflow, sign-off, outbound, approver, feedback, team |
| `p3/inbox-sync` | `6971e78` | inbox run, arrivals, threads and queues, write-back, documents (HTML/PDF), Connections, Advanced |
| `p3/direct-w9` | `0e863d7` | Direct API, W-9 seed, samples, chunked upload, extraction |
| `p3/design-shell` | `345af43` | tokens, fonts, components, shell, sign-in hub, style guide |
| `p3/workspace-ui` | `8e8028c` | the staff inbox |
| `p3/leadership-ui` | `1336ee9` | Escalations, Team, Ahead, Waiting on you, Vendor setup, Settings and Advanced |
| `p3/direct-ui` | `909583d` | the vendor dashboard |
| `p3/smoke` | `c67c45d` | the new UI smoke suite |
| `p3/fix-inbox`, `p3/fix-leadership`, `p3/fix-hub-shell`, `p3/fix-backend` | `21129a4`, `217271a`, `a6545d6`, `8f540f6` | polish fixes from `REVIEW.md` |

Contracts are in `CONTRACTS.md`, the route-to-role map in `ROUTES.md`, the security model in `SECURITY.md`, the review in `REVIEW.md`, and the run log in `STATE.md`.

## 7. Part B options (ranked; no work done)

1. **S: the "Mock" relabel decision** (above). If you want it, map the subsidiaries to display names in one helper used by documents, evidence and Direct.
2. **S: the small open items.** The W-9 request form attachment, clear tabs on sign-out, and one blocked-ticket count for the digest and the queue.
3. **M: a real presenter path.** Add a "demo reset" for the CFO that also clears outbound items and W-9 uploads, plus a scripted 5-minute story order in Advanced. Today, Reset rebuilds the inbox but keeps history.
4. **M: performance pass.** Every request opens a new SQLite connection, and first loads of Team and the approver queue take about 1 s. A connection pool and a shared bundle cache would make everything feel instant.
5. **M: accessibility audit** with axe-core in the smoke suite, plus focus order in the reading pane and modals.
6. **L: move the frontend to React + Vite.** Honest risk: **high for little visible gain right now.**
   - About 10,000 lines of plain-JS views and components now work, are tested by 23 browser stories, and follow one design system.
   - The data layer (`api-*.js`, `http.js`) is already separate from rendering, which is the part that would port cleanly.
   - The views (`inbox.js` alone is 900 lines, plus its components) hold a lot of live-update and focus logic that would all need rewriting and re-testing.
   - It would not change what a judge sees. Do it only if the product continues past the competition. If so, run it as its own wave, port the shell and components first, and keep the smoke suite as the acceptance test.

## 8. Part B (Nov 20): what changed, and how to test it

Everything in section 7 except the React + Vite move. The branch was then **fast-forwarded into `main`**.

**For the deck:**
- `docs/phase3/UNSEEN_RESULTS.md`: all 30 unseen tickets, two misses found and fixed, strengths, limits, and when a person must act.
- `docs/phase3/DEMO_SCRIPT.md`: the 60-second recording script for **#41864** (Ironbark Rentals, three invoices), with prep steps and a backup on **#41741** (bank change). It was rehearsed end to end on this build.

**Pipeline** (`src/prechecks.py`, tests in `tests/test_prechecks_unseen.py`). The practice set still scores 100% correct and 100% safe.
- An out-of-office phrase no longer hides a real request (#41758 is now an internal note for an unknown sender).
- A thank-you above a quoted email is a thank-you (#41770 is now no reply).

**New in the app:**
- **Add a mailbox export to the inbox as new mail.** Settings → Advanced → Tickets file or folder → "Only these ticket numbers" (optional) → **Add to the inbox as new mail**. The tickets arrive first in line, with "Reading…" then the outcome, on the cadence or with **Sync now**. This is how the demo shows an unseen ticket arriving.
- **Start completely fresh:** a checkbox in Advanced → Reset the inbox. It also clears reminders, approver dates, feedback, the change history, vendor messages and updates, and W-9 uploads.
- **W-9 request form** in the Attach document menu: a records-based request that never asks for bank details.
- **"Mock Agency …" now reads "Orchestra East/West/Studio …"** on documents, the evidence panel and Direct. This is display only, in `display.py`. Email addresses are unchanged, because recipients must match records.
- **Blocked counts agree.** Team, Waiting on you and Ahead all count a ticket as blocked only when its answer waits on the approval.
- **Inbox order:** new arrivals first, then the backlog newest first. This holds at any time of day.
- **Sign-out** clears the person's ticket tabs.

**Speed (warm):**

| Page or query | Time |
|---|---|
| Inbox list | 0.12 s |
| Team | 0.17 s |
| All approvers | 0.26 s |
| One approver | 0.15 s |

The database folder and WAL mode are now set once per file, not on every query.

**Accessibility:**
- An axe-core WCAG 2 A/AA check now runs on 13 pages in the smoke suite, and all are clean.
- Fixes: hub contrast, inbox list semantics, a keyboard-reachable sync log, focus after Schedule.
- Dialogs trap focus and return it on Escape.

**Results (final, Part B)**

| Check | Result |
|---|---|
| Python unit tests | **396 run, OK** (1 skipped) |
| JS tests | **85 / 85** |
| Pipeline | **100 tickets, 100.0% correct, 100.0% safe** |
| UI smoke + axe | **24 / 24** in 123 s; axe 0 issues on all 13 pages |
| Unseen tickets | 30 read in about 1 s: 12 drafts, 11 notes, 7 no reply; the model agrees on all 30 |

**Running the UI smoke suite from `main`:**
```bash
npm install --no-save --no-audit --no-fund playwright axe-core
```
Then `node tests/ui/smoke.mjs`. Without these packages the suite prints "skipped".

**Still open (small):**
- An arrival's message header shows the date the email was written (e.g. Nov 5) while the list shows when it arrived. This is correct, but worth knowing on camera.
- Priority holding replies say "our Accounts Payable lead" while the CFO signs them off. That is reply text, which is scored, so it was left unchanged.
