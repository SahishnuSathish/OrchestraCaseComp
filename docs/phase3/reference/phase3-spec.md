## 1. What the client told us (design from this, not from guesses)

From the case packet (Orchestra, a network of communications agencies with a small finance team):

- 2,000 to 2,300 AP and AR tickets a month. Requests arrive by **shared finance email** and are worked in **Zendesk**. Staff cross-check **NetSuite**, payment schedules and documents.
- Payment-status questions are about 1 in 5 AP tickets. The median first reply is more than 1.5 days. Requesters follow up on more than 25% of AP tickets. Vendors have no visibility of payment status.
- The prototype must not send to vendors on its own, change financial records or move money. It must not invent payment dates, expose bank details, or treat claims in incoming email as fact. Bank-change attempts are flagged for human review.

From the Q&A with Orchestra's finance team:

- **Vendors may see** the balance and the last status. **Vendors may not see** incoming internal information, who updated a NetSuite record, or **aggregate information**. Do not show vendors totals across all their invoices or any portfolio statistics.
- They want answers to "appear in the inbox." They asked for our recommendation.
- **Biggest manual pain:** W-9 and bank-information exchange, because of volume and chasing. Also edge cases with ambiguity or mismatches.
- An exception they want handled well: **requests for a document or file** (a PDF). There are bonus points for plumbing that handles large files.
- The average ticket takes 15 minutes, with peaks at month-end and mid-month. Routing uses basic semantic filters. Staff search Zendesk by hand, then NetSuite. Middleware sits between them.
- Tickets are assigned **by the expertise of the person**.
- **"Emails are the most inefficient thing"**: writing them, and the back-and-forth. They want emails that are fast, accurate, helpful, direct and simple, with **feedback mechanisms**.
- An old employee intake form failed because people preferred email. **Do not force anyone out of email.** Meet them in the inbox.
- They are wary of "a third platform in the middle" but open to seeing one. Conductor must feel like it **centralizes Zendesk and Outlook**, not like one more tool to check.
- Everything must be easy to migrate. Holidays disrupt flow (the Thanksgiving run moves to Wednesday, Nov 25). Many checks depend on the 9 operating companies and other departments. (The data pack has only 3 subsidiaries: Mock Agency East LLC, Mock Agency West LLC and Mock Agency Studio Inc. Never show "9" as if it came from the data.)

### Where the email pain really lives (build a feature against each)

| Busywork today | What Conductor does instead |
|---|---|
| Reading each email to work out what it is | Intent and outcome are already shown on the message ("Payment status · INV-21529 · Paid Nov 6") |
| Working out who sent it and whether they may ask | Sender is resolved against the vendor's authorized contacts or active employees, with a visible "Verified contact" or "Not on file" badge |
| Searching Zendesk, then NetSuite, then payment runs | An evidence panel shows the bill, payment, run and linked tickets in one place, each with a "source" chip |
| Writing a careful reply | The draft is already in the compose box, written from records only. One click to approve and send |
| Back-and-forth and follow-ups (more than 25%) | Duplicate and follow-up threads are grouped with the original. Conductor: Ahead tells vendors before they ask. Conductor: Direct lets them check without emailing |
| "Can you send me the invoice / remittance / W-9?" | One-click **Attach document**: a remittance advice or invoice copy rendered from records, attached to the draft |
| Chasing approvers in other departments | "Chase approver" drafts a nudge to the `nextApprover` (or their delegate) and tracks it |
| Misrouted mail (HR, payroll, AR) | Forwarded in one click to Quinn Ellsworth (HR Generalist, from the dataset) or the AR queue, with a note |
| W-9 and bank-detail exchange | A vendor-setup queue: W-9 read and checked automatically. Bank-change requests always go to the fraud review path |

## 2. Decisions already made (do not reopen)

1. **One app.** Fold the vendor portal into the Conductor FastAPI server on `127.0.0.1:8790`: one origin, one sign-in hub, role-scoped routes and API. Keep `dashboards/vendor_portal/` and its tests working, and reuse `PortalLogic` for the vendor email-code fallback, but the product entry point is the single app.
2. **Plain JavaScript stays** for Phase A: no React and no bundler. Build a real shared component layer in CSS and JS modules. A React and Vite move may be considered in Part B, so keep components cleanly separated, and keep the data access in `api*.js` modules apart from the rendering code.
3. **No fictional people.** Every person in the product comes from `employees.csv`, the ticket `users` list or `vendors.csv`. Escalation follows the dataset and Orchestra's real structure (section 3.4).
4. **Staff sign in with a simulated "Sign in with Microsoft."** The chosen account decides the role, the inbox and what the person sees.
5. **Vendors sign in with simulated SSO** ("Continue with Microsoft" or "Continue with Google"). An account picker lists that vendor's authorized contacts. The existing email + invoice → 6-digit code flow is the fallback, and the code arrives in a simulated mailbox panel.
6. **Send rights:** AP Specialists approve and send routine replies. These need the **CFO's sign-off** before anything goes out:
   - priority tickets (a legal threat or a copied executive)
   - fraud or bank-change requests
   - returned payments
   - early-payment and late-fee requests

   **What sign-off means for each.** Only priority tickets have a vendor reply: the pipeline drafts a holding `draft_reply`, and the CFO signs off on its exact text. The other three categories produce an `internal_action_note`, so there is no reply to sign off. For those, the CFO **decides the note**: acknowledges it, records the action taken, and closes or returns it. Fraud tickets stay blocked from approval (`reply_checks.BLOCK_APPROVE_FLAGS`). **Conductor never writes a vendor reply on a note ticket**, and there is no free-text compose path that skips the records-only draft. A person who wants to reply on one of those tickets does so outside Conductor, and Conductor records that it was handled.
   **Enforced on the server.** `workflow.can_approve()` and `workflow.can_send()` run inside `_apply_review`, `api_send`, `delivery.deliver_reply` and `scheduler._send_one`. A scheduled send of a ticket that needs sign-off fails closed. Hiding a button is not enough.
7. **No visible "demo mode."** Nothing on screen should say demo, prototype, mock or test. Sign-in and connections are instant and believable. Reset and the import of the stretch file live in Settings → Connections → Advanced, visible to the CFO only.
8. **Branding.** Orchestra's identity, with Conductor as the product family (section 3.1).
9. **Pipeline edits are allowed, carefully.** `src/` may be changed if a feature truly needs it. The gate (section 5) must stay at 100% correct and 100% safe after every merge. The Nov 19 stretch run must still work from the command line (`python src/run_all.py`, `TICKETS_FILE` with `mock_api.py`) and from the app's import path.
10. **Workers:** Opus 5.5 for design-heavy work (design system, shell, sign-in, every UI surface). Sonnet 5.5 for backend work. See section 6.

## 3. Product specification

### 3.1 Brand and design language

Orchestra's live site (orchestraco.com), from computed styles:

- **Type:** Degular / Degular Display. This is an Adobe-licensed font, so do not bundle it. Use **Bricolage Grotesque** (OFL, already loaded on Orchestra's own site) for display and headings, **Geist** for interface text, and **Geist Mono** for IDs, amounts in tables and references. Self-host the woff2 files in the repo-root `assets/fonts/` with their OFL license files. Download them from `@fontsource/bricolage-grotesque` on cdn.jsdelivr.net or from Google Fonts. **Remove Instrument Serif** from the product CSS, but **keep its woff2 and license files on disk**: the old vendor portal's `dashboards/vendor_portal/page.py` lists them in `FONT_NAMES`, and `tests/test_portal_page.py` serves them.

**Two `assets/` folders.** The repo root has `assets/css/{tokens,fonts}.css` and `assets/fonts/`. Both Conductor (mounted at `/shared` and `/static/fonts`) and the old vendor portal (`page.py` inlines `tokens.css` and `fonts.css`) use them. Conductor's own files are in `dashboards/conductor/assets/` (`index.html`, `js/`, `css/base.css`, `css/components.css`, `css/views/`). From section 3.1 on, this prompt writes `assets/…` for the repo-root folder and `conductor/assets/…` for `dashboards/conductor/assets/…`. Any change to the root `tokens.css` must keep the old vendor portal rendering and `tests/test_portal_page.py` passing.
- **Color:**
  - ink `#222222`
  - Orchestra green `#223307`
  - paper `#EFEFEF`
  - white `#FFFFFF`
  - mint `#E7FFD9`
  - sky `#B5E6EC`
  - peach `#FCC4AB`
  - navy `#1F4C76`
  - slate `#27455C`
  - crimson `#A53548`
  - greys `#333333`, `#555555`, `#D8D8D8`
- **Shape:** square. Orchestra's site uses a 0px radius on almost everything. Use radius 0 for surfaces and panels, and at most 2px for inputs, buttons and badges. Use hairline 1px borders over drop shadows. Use shadow only for floating layers (menus, toasts, modals).

**Product family.** Keep the baton mark from the current `index.html`, refined to sit next to Orchestra's wordmark:

- **Conductor**: the staff workspace. Green chrome (`#223307` top bar, mint highlights).
- **Conductor: Direct**: the vendor dashboard. Navy-led (`#1F4C76`), so it reads as outward-facing.
- **Conductor: Ahead**: proactive vendor notices and approver digests. A mint and green accent, with its own glyph.
- A lockup like "Orchestra | Conductor". Write a one-line tagline per product. It must be plain, not hype.

**Feel.** "Sharp, not basic":

- Dense but calm, in the style of a Zendesk agent workspace.
- Clear type hierarchy, generous row height, tabular figures for money, and strong focus states.
- Real empty and loading states.
- Restrained motion: 120 to 200 ms; no bounces.
- No pastel washes or blobby cards. No emoji. Color carries status meaning only (green settled, navy scheduled, peach waiting, crimson risk).
- WCAG AA contrast.
- Layouts work at 1440, 1280, 768 and 375 px with no horizontal page scroll.

Use generic icons. Do not copy Zendesk, Microsoft or Outlook logos or other proprietary assets. Say "Zendesk" and "Outlook" in text where a connection is named. Patterns may be familiar, but assets must be our own.

**Tokens.** Use three layers (primitive → semantic → component) in the repo-root `assets/css/tokens.css`. Components never use raw hex. Build a hidden style-guide route (`#/styleguide`, CFO only) that renders every component. Workers and you use it for visual QA.

### 3.2 The sign-in hub: one entry point for every dashboard

`GET /` serves the **sign-in hub**. This is not a marketing site. It is the page Orchestra people and vendors would bookmark.

- **Layout.** Split screen:
  - **Left:** the Orchestra | Conductor lockup, one line of value proposition, and three quiet proof points drawn from real numbers in the data (for example, tickets read automatically and the median time to a draft). Never show vendor data before sign-in.
  - **Right:** a sign-in card with two clear choices: **"Orchestra staff"** and **"Vendors & partners."**
- **Staff path.** "Sign in with Microsoft" opens a Microsoft-style account picker: a modal list of real accounts with initials avatars, names, emails and titles from `employees.csv`. Show only roles that have a dashboard (section 3.4). Picking one runs a short, real-feeling handshake screen:
  - Signing in as Ulla Abernathy…
  - Connecting Zendesk (orchestra-mock.zendesk.com) ✓
  - Connecting Outlook (ap@orchestra-mock.example) ✓
  - NetSuite, read-only ✓
  - Preparing your inbox…

  Then land on that person's home. The handshake takes about 1 to 2 seconds in total. Make it skippable, and skip it on reload.
  The picker shows each person's title and department prominently, because several first names repeat. For example, Elena Lockhart is the CFO and Elena Fairbanks is an approver. Vendor contacts such as `ulla@quillfernstudio.example` and `ben@bramblewickprintco.example` share first names with staff.
- **Vendor path.** "Continue with Microsoft" or "Continue with Google" opens an **email-first** step, as the real providers do. The vendor types their work email, and the picker then shows only that one account (name, company, email). **Never list vendor companies or contacts before an email is entered.** A full list of every vendor's contacts on the public hub would be vendor data before sign-in. It would also break enumeration safety. For a smooth demo, the email field may offer the **last account used in this browser** (from `localStorage`), never a directory.
  - An unknown email gets the same next screen as a known one ("Check your account") and then a neutral "We couldn't sign you in with that account" that does not say whether the address is on file.
  - "Use a sign-in code instead" opens the email + invoice → 6-digit code fallback. The code lands in a small "Your inbox" panel that looks like an email notification, so the flow is fully self-contained. **Session model:** the code proves the person controls the email, and the session that follows covers that contact's vendor (all its invoices). This is wider than today's `PortalLogic`, where a code is tied to one (email, invoice) pair and allows one lookup. Reuse `PortalLogic`'s rate limits, code TTL and constant-time compare, and add the session step in `direct.py`. Because the panel shows the code only for an authorized email, it reveals which addresses are on file. That is accepted for a simulated mailbox and recorded in `SECURITY.md`, with what a real deployment does instead: send the code by email and show the same "check your inbox" screen to everyone.
- **Sessions are per tab** (`sessionStorage`, sent as a header), so two windows can be two different people at once. Example: Ulla in one window, Elena in another, a vendor in a third. Everything stays live across them (section 3.5).
- **Loading states everywhere:** skeleton rows for lists, shimmer-free placeholders, a slim top progress bar for navigation, and inline "Conductor is reading…" while a draft or brief is built. No layout jumps.
- Sign-out returns to the hub. A role switcher is not needed. Signing out and picking another account is the realistic flow.

**Security.** Keep the per-launch token (`x-ap-token`), the Host and Origin checks, CSP, `no-store` and the other existing headers. Add a session header, and a server-side session table with a role and subject (an employee email or a vendor contact). Every API route declares the roles it allows. Vendor sessions can call **only** `/api/direct/*`. Staff routes return 403 to vendor sessions. Direct answers stay enumeration-safe: the same response for "no match", "another vendor's invoice" and "not authorized". Record in `docs/phase3/SECURITY.md` that SSO is simulated on localhost and what a real deployment would swap in: Entra ID for staff, and a magic link or OIDC for vendors.

**Requests that cannot carry headers.** Plan these in `CONTRACTS.md`; do not leave them to the workers:
- **`/api/live` (SSE).** `EventSource` cannot send headers. Today's run events pass `?token=` in the URL. For `/api/live`, the page first calls `POST /api/live/ticket` with its headers. That returns a single-use stream ticket valid for 60 seconds, bound to the session, which goes in the query string. Never put the raw session ID in a URL.
- **Documents.** "Download PDF" and the document preview cannot send headers either. The client fetches the file with its headers and opens it as a `blob:` URL. The alternative is a one-time document URL, built the same way as the stream ticket. Today's CSP sends `frame-ancestors 'none'` on every response, which blocks the app from showing its own rendered invoice in an iframe. Send `frame-ancestors 'self'` on the document routes only, and add `blob:` to `img-src`/`frame-src` only if the preview needs it.

### 3.3 Conductor workspace: one place for email and Zendesk

This is the heart of the product. It must feel like **using Zendesk and Outlook with the busywork removed**. It is not a third tool.

**Shell (Zendesk-familiar):**

- Top bar: product lockup, global search across tickets, vendors and invoices, a live connection indicator (Zendesk · Outlook · NetSuite), notifications, and the user menu.
- A narrow left rail of section icons: Inbox, Ahead, Vendor setup, Insights or Team (by role), Settings.
- Ticket tabs along the top of the workspace for open tickets, as in Zendesk.

**Inbox (three panes, Outlook-familiar):**

1. **Queues** (left): Needs reply · Needs action · Escalated · Returned to me · Waiting on approver · Waiting on vendor · Scheduled · Sent · Closed. Each shows a count, and the counts update live.
2. **Message list** (middle): one row per thread. Each row shows the sender name and company, the subject, a snippet, the time, and badges:
   - Zendesk ticket `#41249` and the source "Outlook"
   - the outcome chip: Draft ready / Action needed / No reply needed
   - risk flags (Fraud, Legal, Exec cc'd)
   - "Verified contact" or "Not on file"

   Group same-invoice and follow-up threads (`src/batch_groups.py`).
3. **Reading pane** (right), styled like an Outlook message:
   - full header (From, To, Cc, Date) and the thread history
   - attachments as chips
   - an **insight strip** pinned above the message: what they want, the invoice matched, the verified status from records, and why
   - the **inline reply composer** below the thread, already holding the draft: a simple formatting toolbar, recipient chips (from records, read-only), and an attachments row with an **Attach document** menu (invoice copy, remittance advice, W-9 request form) rendered from records
   - primary actions: **Approve & send**, **Schedule** (existing scheduled send), **Escalate**, and **More** (assign to the other specialist, chase approver, forward to HR or AR, mark no reply needed)

**Evidence panel.** A collapsible fourth column, or a tab in the reading pane on narrower screens, like Zendesk's context panel:

- requester and vendor card (subsidiary, terms, authorized contacts with the requester highlighted)
- the invoice record, the payment (bank details always masked to the last 4), the payment run, and linked tickets
- each fact carries a source chip: NetSuite · bill 50000, Payment run RUN-2026-11-19, Zendesk #… (run IDs in `payment_runs.csv` look like `RUN-2026-10-15`)
- the existing **ticket chat** with the local model, as an "Ask about this ticket" tab
- the brief, and the rule trail ("why this outcome"), in plain language

**Write-back (simulated, but believable).** Sending does all of the following, with toasts:

- marks the Zendesk ticket Solved, or Pending for action notes, with an internal note
- puts the message in Outlook's Sent items
- writes the `.eml` to the outbox as today

The thread shows "Sent by Ulla Abernathy · Zendesk updated · 10:42."

**Feedback mechanism** (requested by the client). When a person edits a draft before approving, ask in one click "What was off?" (Tone · Facts · Missing info · Other). Store it. The CFO sees the trends.

**Inbox sync (replaces "runs" as the primary flow):**

- On first staff sign-in, "Zendesk" and "Outlook" are connected. Under the hood, `data/tickets.json` is the Zendesk source and the thread history is the mailbox.
- **The inbox sits on one hidden run.** Today every review, send, chat, schedule and prevention route lives under `/api/runs/{run_id}/…`, and `db.py` keys everything by `(run_id, ticket_id)`. The inbox does not build a second review store. It creates one persistent run, the "inbox run", at first connect. A thread ID maps to `(inbox_run_id, ticket_id)`, and the existing review, send, chat, schedule and prevention code works on it unchanged. `CONTRACTS.md` names the run, says how its ID is found (a `settings` row), and states that Reset rebuilds it.
- The app clock is the **snapshot date, Friday Nov 13, 2026**. Use **one clock for everything**: a new `dashboards/conductor/appclock.py` (seam commit) with `now()`, set to Nov 13, 2026 with the real time of day. Live arrivals, "Sent · 10:42", toasts, aging, the Nov 17 holding date and scheduled send all read it. `scheduler.set_clock(appclock.now)` is called at start-up. Today the scheduler uses `time.time()`, so without this, "tomorrow at 9:00" would mean Nov 19 in the real world.
- **New tickets need a requester.** `build_view` looks up `requester_id` in the backend's `users`, and `data/` is read-only. `inbox.ingest()` therefore keeps an in-memory user overlay (persisted in the state DB) for held-back arrivals and Direct questions. It feeds the overlay to the pipeline's `Store` without writing to `data/`.
- On connect, Conductor has already processed the backlog. Show a **"While you were away, Conductor read N emails: X drafts ready, Y need action, Z need no reply"** summary card.
- Hold back the last several tickets, by `created_at`. They **arrive live** on a believable cadence: one every 30 to 90 seconds, configurable, plus "Sync now". Each runs through `pipeline.process_ticket` as it lands. The row appears with a brief "Reading…" state, then its outcome.
- Vendor questions asked in Conductor: Direct (section 3.7) arrive in this inbox as new tickets through the same ingest path.
- **Runs leave the main navigation.** Batch runs, `score.py` export and **"Import a mailbox export (tickets file)"** for the Nov 19 stretch run move to Settings → Connections → Advanced, for the CFO only. `run_all.py` and the export format must still work.
- Settings → Connections lists Zendesk, Outlook, NetSuite (read-only) and the local AI model, each with a status, last sync, scopes in plain words ("Read tickets, add internal notes, set status"; "Read and send from ap@…"; "Read vendors, bills, payments; no write access"), and a sync log. The existing model settings move here, restyled.

### 3.4 Roles and escalation: a live, company-wide platform

Orchestra's public leadership page lists no Controller or AP manager. The dataset's Zendesk agents are exactly **Elena Lockhart (CFO)**, **Ulla Abernathy** and **Omar Calloway** (AP Specialists). Build exactly these sign-ins:

| Role | People (from data) | Home | Can do |
|---|---|---|---|
| **AP Specialist** | Ulla Abernathy, Omar Calloway | Inbox | Work tickets; approve and send routine replies; assign or ask for a second review from the other specialist; escalate to the CFO with a reason; chase an approver; forward misrouted mail; manage vendor setup |
| **CFO** | Elena Lockhart | Escalations + Team overview | Everything a specialist can do, plus: decide escalations; **return to a specialist with guidance** ("send it back down"); **sign off** priority sends; see the team-wide live overview; Advanced settings; style guide |
| **Budget approver** | Client Services staff who are a `nextApprover` on any open bill (e.g. Ben Merriweather, Rosa Dunmore, Quinn Winslow, Ana Underhill…), and **Liam Pemberton** as delegate for the inactive Tessa Holloway. Wendy Quimby and Nadia Winslow are also inactive with Liam as delegate, but no bill names them, so Liam's queue holds only Tessa's 2 pending bills | "Waiting on you" | See bills pending their approval, the vendor tickets each one is blocking, and Conductor: Ahead digests. **Acknowledge** or **commit to an approval date** (internal only, never shown to vendors as a payment date). "Open in NetSuite" is a disabled or simulated link. **They cannot approve bills in Conductor**, because the case forbids changing financial records |
| **Vendor contact** | Every address in `authorizedContacts` | Conductor: Direct | Section 3.7 |

Others appear only as **people the workflow names**, not as sign-ins:

- Quinn Ellsworth (HR Generalist) is the forward target for payroll and HR mail.
- Farid Abernathy (CEO) is the copied executive that triggers priority.
- AR is a forward queue.

**Escalation lifecycle.** Write it as a state machine in one backend module, with an audit row for every transition.

- `open` → `escalated` (to the CFO, with a reason category and a note) → `returned` (to the specialist, with guidance) **or** `signed_off` (CFO approves the exact text; its hash is stored) → `sent`.
- **Mandatory sign-off categories** (decision 6): **Approve & send** on those tickets is replaced by **Request sign-off**.
- Assignment: unassigned tickets are routed **by expertise**, the way the client described:
  - fraud, bank change, returns and conflicts → the specialist marked for exceptions
  - status and documents → round-robin
  - priority → CFO visibility

  Seed the expertise from the dataset. In `tickets.json`, Omar authored 10 agent replies and Ulla 5. Ulla also authored all 6 replies in `linked_tickets.json`, the earlier tickets, so she has 11 in all. Count both files, and make the expertise editable by the CFO.
- "Chase approver" creates an approver nudge, reusing `approver_digest`. It is reviewed like any outbound item and tracked on the ticket ("Chased Ben Merriweather · Nov 13 · no response yet").

**Live.** Add one server-sent event stream (`/api/live`) scoped by role. Every state change publishes an event: arrival, outcome, assignment, escalation, return, sign-off, send, schedule, Ahead send, W-9 received, vendor question. Open dashboards update counts, rows and the open ticket in place. Show toasts for events addressed to the viewer ("Elena returned #41262 to you with guidance"). A notifications tray keeps the last 50. The CFO overview has an activity feed.

**CFO overview (Team):**

- live queue health by queue and by specialist
- aging buckets
- **first-reply time** now vs. the case baseline (more than 1.5 days)
- follow-up rate
- a bottleneck board of approvers ranked by blocked tickets
- Conductor: Ahead impact (tickets prevented)
- feedback trends
- the audit log

Label every metric with its source ("practice data, snapshot Nov 13"). Follow the `dataviz` skill for charts and stat tiles.

### 3.5 Conductor: Ahead (rebrand and promote the Prevent page)

This is a **headline selling point**, not an afterthought. It answers the client's strategic question: reply faster, **or prevent the request**.

- A top-level rail item for staff and the CFO, with a short explanation at the top: "Tell vendors before they ask."
- Three sections:
  - **Vendor updates**: notices, drafted from records, approve → send.
  - **Approver digests**: approvers blocking payments, with chase status.
  - **Impact**: tickets prevented, with the named tickets each notice would have prevented (`notices.coverage`), and estimated hours saved at 15 minutes per ticket (the client's figure), labeled as an estimate.
- Keep the existing one-invoice end-to-end demo as **"See it on one invoice"**, restyled: draft → approve → send → the vendor's Direct view shows the same status and balance → the prevented ticket.
- A "prevented this week" counter appears on every staff home.
- On the vendor side, Ahead notices show in Conductor: Direct under **Updates**, with notification preferences.
- All existing protections stay: `egress_guard.check_outbound`, and the stale-record 409.

### 3.6 W-9 and vendor setup (focused, well integrated)

The client named W-9 and bank-information exchange as their biggest manual pain. The data pack has no W-9 records. Create **fictional sample W-9 data for existing vendors only**, in `dashboards/conductor/seed/w9/` (not in `data/`):

- a JSON status per vendor: on file / missing / expired / name mismatch / TIN mismatch
- a few sample filled W-9 PDFs generated by a script with fictional TINs

Never show more than the last 4 digits of a TIN anywhere, including model prompts and logs.

- **Vendor setup** (a staff rail item): a queue of vendors whose W-9 is missing, expired or mismatched, with the bills each one is holding up.
  - Actions: **Request W-9** (a drafted, reviewable email with a secure upload link to Direct); **Review upload**.
- **Upload and read.** A vendor uploads a W-9 PDF in Direct. Large-file plumbing (the client's bonus point):
  - chunked upload with progress
  - streaming SHA-256
  - a size cap of 50 MB and a type check
  - files stored under the state directory, never in the repo
- **Extraction.** Read the fields with `pypdf` (AcroForm fields first, text fallback). Optionally use the local model only to normalize names.
- **Check.** Compare against the vendor record: legal name vs. `companyName`, entity type, address, TIN last 4 vs. the record on file.
- **Result.** An extraction card with each field and a match or mismatch mark. "Mark verified" records who verified it and when. It does not change NetSuite. Show "Update NetSuite vendor record" as the next human step.
- **Bank details are never accepted through this flow.** Any bank-change request, in email or as an upload, goes to the existing fraud path and needs CFO review.
- The W-9 status shows on the vendor card in the evidence panel and on the vendor's Direct home.

### 3.7 Conductor: Direct, the vendor dashboard (a full page, not a bubble)

A clean, modern vendor portal that a vendor would actually use instead of emailing.

- **Header:** the Conductor: Direct lockup, the vendor company name, the signed-in contact, and sign out. There is no staff navigation, no internal names and no ticket IDs.
- **Home:** a list of **their invoices** with invoice number, date, amount, **balance**, and **last status** as a plain-language chip:
  - Received
  - Awaiting internal approval (no date)
  - Approved, typically paid within 5 to 10 business days
  - Scheduled for payment on <run date>
  - Payment sent <date>
  - Paid <date>
  - Under review: our team will follow up (no date). This covers every state where `status_service` returns `NEEDS_REVIEW`: returned payments, record conflicts and "not received" disputes. Never say why it is under review.

  `status_service.lookup_status` answers one invoice at a time. The list needs a new read-only function in `direct.py` that lists the signed-in vendor's bills and runs each through the same `rules.classify_bill` → snippet → `egress_guard` path. It never builds its own wording.

  Plus search and filter. **No totals or aggregate figures** (the client's rule).
- **Invoice detail:**
  - a status timeline with only the public steps
  - **the document the answer came from**: a rendered invoice copy from the bill record, and, when paid, a **remittance advice** (payment date, method, reference; bank account masked; no reference for returned payments)
  - a "Download PDF" button
  - "Source: Orchestra accounts payable records, updated Nov 13, 2026"
- **Ask a question.** A short form scoped to an invoice. It creates a ticket in the staff inbox through the normal ingest path. The answer, once a person approves it, appears in **Messages** and is emailed. The case rule holds: nothing reaches a vendor without a person.
- **Documents and W-9:** W-9 status and upload (section 3.6), and downloadable documents.
- **Updates:** Conductor: Ahead notices and notification preferences.
- All data comes from `status_service` and the records. Reuse its rules for what can be said (`balance_line`, the standard window, pending with no date). Never repeat claims from vendor emails.
- When a vendor opens an invoice in Direct, record a **self-serve lookup**. Show it in Ahead's impact as its own line ("self-serve lookups"), apart from `notices.coverage`. A sign-in or a lookup is not a prevented ticket. Never add lookups to "tickets prevented" or to hours saved.

### 3.8 Keep everything that works

Map each existing feature into the new structure. Do not drop any of them:

- ticket chat → the evidence panel
- scheduled send → the composer's Schedule
- briefs, rewrite and the rule trail → the evidence panel
- the prevent demo → Ahead
- model settings, the test console and the mail mode → Settings → Connections
- the export → Advanced
- the bulk review → multi-select in the message list

The tests in `tests/` must keep passing. Update them where URLs or flows legitimately changed, and say so. `tests/ui/smoke.mjs` must be rewritten for the new sign-in and workspace flows. It runs at 375, 768, 1280 and 1440 px.

## 4. Rules for you and every worker

- **Local only.** Bind to 127.0.0.1. The model is Ollama through `local_model.py`. There is no cloud API, no CDN at runtime and no external network calls from the app. Self-host all assets.
- **Nothing leaves without a person.** Every outbound item (reply, notice, digest, chase, W-9 request) has a review state, and needs an explicit approve, then send. Sign-off categories need the CFO. Recipient, subject and body always come from server records, never from the request.
- **Masking.** Bank account numbers, routing numbers and TINs show the last 4 digits at most, everywhere: UI, logs, prompts, emails, PDFs and test fixtures.
- **Data files** in `data/` are read-only. New seed data goes under `dashboards/conductor/seed/`.
- **State.** Every server or test run sets `CONDUCTOR_STATE_DIR` to an absolute folder **outside the repo**, unique per worktree (for example `C:/Users/Sahishnu Sathish/AppData/Local/Temp/conductor-p3-<branch>`). Tracked `.eml` files in `dashboards/conductor/state/outbox/` must never change.
- **Ports.** The integration app uses 8790. Each worker uses its own port: 8801 to 8809, assigned in its brief.
- **Keep identifiers:** header `x-ap-token`, localStorage key `ap.run` (it can become unused, but do not reuse it for something else), env vars `CONDUCTOR_STATE_DIR` and `AP_DESK_STATE_DIR`.
- **Copy:** short sentences, plain words, no filler, no exclamation marks. Write like a finance team writes to a vendor.
- **Accessibility:** keyboard reachable, visible focus, labels on every control, `aria-live` for toasts and arrivals.
- **Git:**
  - Stage explicit paths only. Never `git add -A` or `git add .`.
  - Never force-push, rebase a shared branch, run `git reset --hard`, or push to `origin`.
  - Commit early and often, with clear messages.
  - End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` or `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`, matching the worker's model.
- **Owned files.** A worker edits only the files it owns. If it needs a change elsewhere, it stops and reports the need to you. It does not make the change.
- **Stay in your worktree.** The Agent tool has no working-directory option. A worker starts in the orchestrator's folder, which is the user's checkout on `main`. So every brief says, and every worker obeys:
  - Use **absolute paths** under your own worktree for every Read, Edit and Write. Never use a relative path.
  - Run git as `git -C "<your worktree>" …`, and commands as `cd "<your worktree>" && …` within the same command.
  - Before every commit, run `git -C "<your worktree>" rev-parse --show-toplevel` and `git -C "<your worktree>" branch --show-current`, and check both. If either is wrong, stop and report.
  - The user's checkout `C:/Users/Sahishnu Sathish/Projects/Orchestra Case Comp` is read-only to workers. They may read its untracked `docs/` and nothing else there.
- **Verification before claiming done:** run the commands and report their real output. A worker building UI must open its page in the built-in browser (`mcp__Claude_Browser__*`), screenshot it at 1440 and 375 px, and check the console for errors. Workers share **one** browser pane, so each opens **its own tab** with `tabs_create`, passes that `tabId` to every browser call, sets the size with `resize_window` on that tab only, and closes the tab when done. Never drive another worker's tab.
