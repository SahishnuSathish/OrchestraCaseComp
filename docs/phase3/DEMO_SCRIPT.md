# 60-second demo script: unseen ticket #41864

**The ticket:** #41864, "Open invoices - Ironbark Rentals". Nadia Ellsworth (Accounts Receivable, Ironbark Rentals) asks for the status of three invoices, 2026-66954, 2026-77278 and 2026-16763, and attaches a statement.

**Why this one:** in one email, Conductor shows everything it does:
- it recognises a verified vendor contact
- it finds three bills in NetSuite
- it checks the payment record before the bill status
- it reads three different states: **paid** with a reference, **scheduled** on the Nov 19 run, and **pending approval** with no date given
- it writes one plain reply with one line per invoice, and stops for a person to approve
- on approval it updates Zendesk and Outlook

That is the client's "15 minutes per ticket" done in about 15 seconds, with nothing sent until a person clicks.

**Backup ticket, for Q&A or a second clip:** #41741, "Quick question + new bank info". A friendly status question with new bank details tucked in. It shows the safety side (see the end of this file).

## Before you record (about 3 minutes, once)

1. Start the app with a fresh state folder, so the inbox is clean:
   ```bash
   cd "C:/Users/Sahishnu Sathish/Projects/Orchestra Case Comp" && CONDUCTOR_STATE_DIR="C:/Users/Sahishnu Sathish/AppData/Local/Temp/conductor-demo" python dashboards/conductor/server.py --port 8790
   ```
   If you have already used that folder, stop the server, delete the folder, then start again. Alternatively, Elena → Settings → Advanced → Reset the inbox, with **Start completely fresh** ticked.
2. **Window A, as Elena (CFO).** Open http://127.0.0.1:8790/ → Orchestra staff → Sign in with Microsoft → **Elena Lockhart**. Then:
   1. Go to Settings → **Advanced**.
   2. In **Tickets file or folder**, paste `C:\Users\Sahishnu Sathish\Downloads\unseen_tickets.json`.
   3. In **Only these ticket numbers**, type `41864`.
   4. Click **Add to the inbox as new mail**. The toast says 1 email added, first in line.
3. **Window B, as Ulla (AP specialist).** Open a second browser window (each window is its own sign-in) → http://127.0.0.1:8790/ → Sign in with Microsoft → **Ulla Abernathy** → Inbox. Close the "While you were away" card if you want a cleaner frame, or leave it, since it helps the story.
4. Size window B to about 1440 × 900 and start recording window B only.

## The recording (60 seconds)

| Time | Do | Say |
|---|---|---|
| 0:00 to 0:07 | Ulla's Inbox is on screen, with queues on the left and the message list in the middle. | "This is Conductor: Orchestra's AP inbox, with Zendesk and Outlook in one place. Conductor has already read the overnight email." |
| 0:07 to 0:14 | Click **Sync now** (top right). #41864 appears at the top with **Reading…**, then its outcome. | "A new email just came in from Ironbark Rentals. Conductor reads it as it lands, then checks every claim against NetSuite." |
| 0:14 to 0:27 | Click the row. Point at the **insight strip**: what they want, the three invoices matched in NetSuite, what the records say, sender: authorized contact. | "They're asking about three invoices. Conductor matched all three in NetSuite and verified the sender is on Ironbark's contact list. It ignores their attached statement and uses our records." |
| 0:27 to 0:38 | Click **Details** and scroll to the three bills with their source chips (NetSuite · bill …, Payment run RUN-2026-11-19). Click **Message** to go back. | "Here's the evidence: one paid by check with a reference, one on the November 19 payment run, and one still waiting on internal approval." |
| 0:38 to 0:48 | Scroll to the composer. Point at the three lines. | "The reply is already written, one line per invoice. The pending one gets no date. Conductor never promises a payment date the records don't support." |
| 0:48 to 0:57 | Click **Approve & send**. The toast reads "Sent to Nadia Ellsworth · Zendesk updated · Outlook Sent items", and the receipt appears. | "A person approves it. One click sends it, solves the Zendesk ticket and files it in Outlook." |
| 0:57 to 1:00 | Hold on the receipt "Sent by Ulla Abernathy · Zendesk updated (Solved)". | "About fifteen seconds instead of fifteen minutes, and nothing goes out without a person." |

**Shorter cut (45 s):** skip the Details step (0:27 to 0:38) and say the evidence line over the insight strip.

## If something looks different

- **The row doesn't appear after Sync now.** Check window A's toast said 1 email added. If you already brought it in once, it is skipped ("already in the inbox"). Reset with Start completely fresh, then add it again.
- **Another email arrives first.** The added ticket is always first in line. If a practice email arrived on its own before you clicked Sync now, that's fine: click #41864 in the list.
- **The page is slow on the very first load.** The first request after start-up builds the inbox (about 1 to 2 s). Open the inbox once before you start recording.

## Backup: #41741, safety (about 30 s)

1. Do the prep above, with `41741` in **Only these ticket numbers**.
2. **Sync now.** "Quick question + new bank info" arrives as **Action needed**, with a red **Fraud** flag.
3. Open it:
   - the red banner says nothing on this ticket can be approved or sent
   - "Why: The email asks us to change bank details."
   - the routing and account numbers in the email are withheld from the note
4. Say: "A friendly status question, with new bank details slipped in. Conductor stops it, hides the numbers, and sends it to the CFO. The next step is a callback to the number we already have on file, never the one in the email."
5. Optionally, switch to window A as Elena → **Escalations**, or **Inbox** → #41741 → **Decide** → Acknowledge, with the action taken "Called vendor on file; no bank change requested".

## Numbers you can quote (from `UNSEEN_RESULTS.md`)

- **All 30 unseen tickets** were read in about **1 second**: 12 draft replies, 11 internal notes for a person, 7 needing no reply.
- **Two misses** were found by reading every output against the rules, and **fixed the same day** with tests. The practice set stays at **100% correct, 100% safe**.
- **Model check:** the local model, as a second reader, agreed with the rules on all 30.
- **Every reply waits for a person.** Priority replies (a legal threat, collections, an executive copied) also need the CFO's sign-off.
