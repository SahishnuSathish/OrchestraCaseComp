# 60-second product tour: unseen ticket #41784 (Thistledown Staffing)

**The ticket:** #41784, "Following up on INV-93806", from Thistledown Staffing, with their **CEO copied**. It is one of the
30 unseen tickets (Nov 19). Conductor's result: a **priority draft reply** (holding reply) that needs **CFO sign-off**.

**Why this one:** it is the only unseen ticket whose vendor lights up every feature:
- **Escalation**: CEO copied, so the reply needs Elena's sign-off before anyone can send it.
- **Data trail**: INV-93806 is $20,413.71, approved, and in NetSuite as **scheduled for the Nov 25 payment run**.
- **Conductor: Direct**: Thistledown can sign in (`finance@thistledownstaffin.example`, Keiko Galloway) and sees
  INV-93806 "Scheduled for payment on Nov 25, 2026" without writing to us.
- **W-9 and TIN**: Thistledown's W-9 is flagged **TIN mismatch**. Vendor setup shows the TIN masked as `XXX-XX-4706`,
  the bills it holds up, and **Request W-9**.
- **Ahead**: Thistledown has a drafted **vendor update** listing where its invoices stand.

(Verified against this build on Nov 20 for everything except the ticket text itself, which lives in `data/unseen_tickets.json`.)

## Before you record (about 4 minutes, once)

1. Start the app with a **fresh state folder** (or Elena → Settings → Advanced → Reset the inbox with **Start completely
   fresh**). For the chat step, also have the local model running (Ollama with the model you used, e.g. `qwen3.5:9b`).
2. **Window A, Elena (CFO).** `http://127.0.0.1:8790/` → Orchestra staff → Sign in with Microsoft → **Elena Lockhart**.
   Settings → **Advanced** → Tickets file `<repo>\data\unseen_tickets.json` (e.g. `C:\Users\Sahishnu Sathish\Projects\Orchestra Case Comp\data\unseen_tickets.json`) → Only these ticket numbers `41784` →
   **Add to the inbox as new mail**. Then go to **Escalations** and leave it there.
3. **Window B, Vendor.** `http://127.0.0.1:8790/` → Vendors & partners → **Continue with Microsoft** →
   `finance@thistledownstaffin.example` → Next. Leave it on **Invoices**, with "INV-93806" typed in the search box.
4. **Window C, Ulla (AP specialist), the one you record.** Sign in as **Ulla Abernathy** → Inbox. Size it to 1440 × 900.
   Open Ahead once and come back, so its first build is warm.
5. Do step 2's "Add to the inbox" **last**, then start recording straight away. The email also arrives on its own
   within 30 to 90 seconds.

## 1. The order (what to show, in sequence)

| # | Feature | Where | Window |
|---|---|---|---|
| 1 | **Inbox UI** and a live arrival | Inbox → **Sync now** → #41784 lands on top, "Reading…", then its outcome | C (Ulla) |
| 2 | **The brief** | Open #41784 → "What Conductor found": what they want, INV-93806 matched, what the records say, sender, why it is priority | C |
| 3 | **Data trail** | **Details** tab → the NetSuite bill and the payment-run source chips → back to **Message** | C |
| 4 | **Chatbot** | "Ask about this ticket" → type `Why does this need sign-off?` → **Ask** | C |
| 5 | **Drafted email** | Scroll to the composer: the holding reply, records only, no promised date | C |
| 6 | **Escalation** | **Request sign-off** → window A, Escalations: Elena opens it → **Sign off** → window C: the pane flips to **Approve & send** → click it | C → A → C |
| 7 | **W-9 request and TIN** | Rail → **Vendor setup** → Thistledown Staffing: **TIN mismatch**, TIN `XXX-XX-4706`, bills held → **Request W-9** (a draft to review) | C |
| 8 | **Preventative (Ahead)** | Rail → **Ahead**: "Tell vendors before they ask.", tickets prevented → Vendor updates → Thistledown's notice | C |
| 9 | **Conductor: Direct** | Window B: INV-93806 "Scheduled for payment on Nov 25, 2026" | B |

## 2. The script (about 60 seconds)

| Time | Do | Say |
|---|---|---|
| 0:00–0:06 | Inbox on screen. Click **Sync now**; #41784 lands on top with "Reading…". | "This is Conductor, Orchestra's accounts-payable inbox. A new email just landed, and Conductor is reading it against NetSuite before anyone opens it." |
| 0:06–0:13 | Open #41784. Point at "What Conductor found" and the **Needs sign-off** chip. | "Thistledown wants to know where invoice 93806 stands, and their CEO is copied. Conductor matched the invoice, verified the sender, and flagged it as priority." |
| 0:13–0:19 | **Details** → point at the NetSuite and payment-run chips → **Message**. | "Every claim has a receipt: here's the bill in NetSuite, and here's the payment run it's on." |
| 0:19–0:26 | In "Ask about this ticket", type `Why does this need sign-off?` → **Ask**. | "Anyone on the team can ask Conductor about the ticket, in plain English, grounded in the same records." |
| 0:26–0:31 | Scroll to the composer. | "The reply is already drafted, from our records only. It never promises a date it can't back up." |
| 0:31–0:40 | **Request sign-off** → switch to Elena's window → open it → **Sign off** → back → **Approve & send**. | "Because the CEO is copied, it goes to our CFO first. One click to sign off, and only then can it be sent." |
| 0:40–0:47 | Rail → **Vendor setup** → Thistledown: point at **TIN mismatch** and `XXX-XX-4706` → **Request W-9**. | "Conductor also watches compliance. Thistledown's tax ID doesn't match our records, so it holds their bills and drafts a W-9 request. The TIN is never shown in full." |
| 0:47–0:54 | Rail → **Ahead** → point at tickets prevented → Thistledown's update. | "And it gets ahead of the next email: a status update for every vendor, approved by a person, so they don't have to ask." |
| 0:54–1:00 | Switch to the vendor window: INV-93806, "Scheduled for payment on Nov 25". | "Or vendors check themselves in Conductor: Direct. Fewer tickets, faster answers, and nothing goes out without a person." |

**If you are over time:** cut the chat step (0:19–0:26) and say its line over the Details step. **If the model is not
running**, skip the chat step entirely.

## If something looks different

- **#41784 does not appear after Sync now**: check Elena's toast said "1 email added". If it was added before, it is
  skipped; reset with Start completely fresh and add it again.
- **Request sign-off does not show up in Escalations**: it updates live; if not, click Escalations in the rail again.
- **Request W-9 is greyed out**: a request is already drafted and not yet sent (from a rehearsal). Point at the drafted
  request instead, or reset fresh.
- **The sign-in page** now opens on look B "Instrument" (the dark dial). It is the first thing a viewer sees if you
  record the sign-in; the handshake (the dial behind "Connecting Zendesk…") makes a good 3-second opener.
