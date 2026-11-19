# Phase 3 contracts

Every worker codes against this file. If you need something that is not here, stop and report it to the orchestrator. Do not invent a different shape. The product spec is `docs/phase3/reference/phase3-spec.md`. Today's app is described in `docs/phase3/reference/conductor.md` and `docs/phase3/reference/features/`.

**Paths.** `assets/…` is the repo-root shared folder (tokens, font CSS, font files). `conductor/…` is `dashboards/conductor/…`. A bare `.py` module is in `dashboards/conductor/`. A bare `.js` file is in `dashboards/conductor/assets/js/`.

---

## 1. Roles and permissions

| Role id | Who | Home after sign-in |
|---|---|---|
| `ap_specialist` | Ulla Abernathy, Omar Calloway | `/app#/inbox` |
| `cfo` | Elena Lockhart | `/app#/escalations` |
| `approver` | Active employees who are `nextApprover` on a `Pending Approval` or `Pending PO` bill, plus active delegates (`delegateEmail`) of inactive approvers with such bills (Liam Pemberton for Tessa Holloway) | `/app#/approver` |
| `vendor` | Any address in a vendor's `authorizedContacts`, vendor not inactive | `/direct` |

`STAFF = {ap_specialist, cfo}`. Farid Abernathy, Quinn Ellsworth and everyone else in `employees.csv` cannot sign in.

| API prefix | ap_specialist | cfo | approver | vendor | no session |
|---|---|---|---|---|---|
| `/api/health`, `/api/session/*` | yes | yes | yes | yes | yes |
| `/api/live/*` | yes | yes | yes | yes (own events) | no |
| `/api/direct/*` | no | no | no | **yes** | no |
| `/api/approver/*` | no | yes (read) | yes | no | no |
| `/api/admin/*`, `/api/runs` list/create/import/delete, `/api/settings/*` writes, `/api/fs/*`, `/api/dataset/*` | no | **yes** | no | no | no |
| `/api/workflow/*/signoff`, `/return`, `/decide`, `PUT /api/workflow/expertise`, `/api/feedback/trends`, `/api/workflow/audit` | no | **yes** | no | no | no |
| every other `/api/*` (inbox, runs/{id}/…, workflow, w9, documents, outbound, feedback, chat, schedule, prevention, model, mail) | yes | yes | no | no | no |

A vendor session on any non-Direct route gets **403**. No session gets **401**. All `/api/*` routes still need `x-ap-token`, as today.

## 2. Sessions (`identity.py`, owner `p3/identity-live`)

- Header: **`x-conductor-session`**. The browser keeps it in `sessionStorage` key **`conductor.session`** (one per tab). Never in a URL.
- Table `sessions(id TEXT PK, role TEXT, subject TEXT, name TEXT, vendor_id TEXT NULL, created_at REAL, last_seen REAL)`. `id` = `secrets.token_urlsafe(24)`.
- `identity.current(request) -> Session | None`. `Session` has `id, role, subject (email), name, vendor_id, title`.
- `identity.require_role(*roles)` is a FastAPI dependency. It returns the `Session`, raises 401 with no session and 403 for a wrong role.
- `identity.staff_directory() -> list[dict]`: `{email, name, title, department, role}` for the staff and approver sign-ins only, from `employees.csv`.
- `identity.vendor_for_contact(email) -> dict | None`: the vendor row when exactly one active vendor lists the address.

Endpoints (JSON):

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/session/directory` | | `{accounts: [{email, name, title, department, role}]}`. Staff only. **There is no vendor directory.** |
| `POST /api/session/sso` | `{kind: "staff", email}` | `{session, role, name, email, title, home}`. 401 `{"detail": "We couldn't sign you in with that account."}` for anyone not in the directory |
| `POST /api/session/sso` | `{kind: "vendor", provider: "microsoft" \| "google", email}` | Same answer, plus `vendor: {id, name}`. The same neutral 401 for unknown, inactive or ambiguous addresses |
| `POST /api/session/code/request` | `{email, invoice}` | `{ok: true, message, inbox: {to, subject, code} \| null}`. Uses `PortalLogic.request_code` (rate limits, TTL). `inbox` is the simulated mailbox panel: it is non-null only when a code was issued |
| `POST /api/session/code/verify` | `{email, invoice, code}` | The vendor session answer, or 401 `{"detail": "That code is not valid or has expired."}`. The session covers the contact's vendor (all of its invoices) |
| `GET /api/session` | | The current session answer, or 401 |
| `DELETE /api/session` | | `{ok: true}` |

The code flow lives in `identity.py`; it may import `direct.py` helpers.

## 3. Live events (`live.py`, owner `p3/identity-live`)

- `live.publish(type: str, payload: dict, *, roles: set[str] | None = None, subjects: set[str] | None = None, vendor_id: str | None = None) -> None`. `roles=None` means `STAFF`. Thread-safe. Callable from any thread.
- `POST /api/live/ticket` → `{ticket, expires_in: 60}`. Single-use, bound to the calling session.
- `GET /api/live?ticket=…` → `text/event-stream`. Each event is `event: <type>` and `data: <json>`. The data always has `{id, at (appclock ISO), type, summary, ticket_id?, actor?: {name, email}, to?: [emails]}` plus the payload. A keep-alive comment `: ping` is sent every 15 s.
- Delivery: an event reaches a stream when the stream's role is in `roles`, or its subject is in `subjects`, or (vendor streams) `vendor_id` matches. Vendor streams receive **only** events with their `vendor_id`.
- Existing `GET /api/runs/{id}/events` (run progress) also accepts `?ticket=` from the same endpoint, in place of `?token=`.

Event types:

| type | publisher | extra payload |
|---|---|---|
| `ticket.arrived` | inbox | `{ticket_id, queue, from_name, subject}` |
| `ticket.outcome` | inbox | `{ticket_id, outcome: draft_ready \| action_needed \| no_reply, queue}` |
| `queue.counts` | inbox | `{counts: {queue_id: n}}` |
| `ticket.assigned` | workflow | `{ticket_id, assignee}` (`subjects` = assignee) |
| `ticket.escalated`, `signoff.requested` | workflow | `{ticket_id, reason, note}` (`roles={"cfo"}` plus the specialist) |
| `ticket.returned` | workflow | `{ticket_id, guidance}` (`subjects` = specialist) |
| `ticket.signed_off`, `ticket.decided` | workflow | `{ticket_id, decision?}` |
| `ticket.sent` | workflow (on_sent) | `{ticket_id, by}` |
| `ticket.scheduled` | inbox, on a schedule change | `{ticket_id, send_at}` |
| `outbound.created`, `outbound.sent` | workflow | `{outbound_id, kind}` |
| `ahead.sent` | prevention routes, through inbox | `{kind, key}` |
| `approver.committed` | workflow | `{bill_id, approver, date}` |
| `w9.received` | w9 | `{vendor_id, upload_id}` |
| `direct.question` | direct | `{ticket_id, vendor_id}` |
| `direct.message` | direct (on_sent) | `{vendor_id}` (vendor audience) |
| `direct.update` | direct | `{vendor_id}` (vendor audience) |
| `sync.status` | inbox | `{state, held_back, next_at}` |

## 4. The app clock (`appclock.py`, seam commit, owner: orchestrator)

- `appclock.now() -> float`: epoch seconds. The date is fixed to **Friday, Nov 13, 2026** (local time). The time of day is real.
- `appclock.today() -> datetime.date` (always 2026-11-13). `appclock.iso(ts=None) -> str` gives local ISO 8601 with an offset.
- `server.py` calls `scheduler.set_clock(appclock.now)` at import. Tests may still call `scheduler.set_clock(...)`.
- Every new module uses `appclock`, never `time.time()`, for anything a person sees.

## 5. Inbox (`inbox.py`, `connectors.py`, owner `p3/inbox-sync`)

**The inbox run.** One persistent run in the existing `runs` table, `source='inbox'`, label "Inbox". Its id is in `settings` key `inbox.run_id`. `inbox.inbox_run_id() -> str` creates it on first call: it processes every ticket in `data/tickets.json` **except the held-back ones** through the pipeline with no model (the same path as a run, through `runner.py`'s adapter), then marks it done. Reset (`POST /api/admin/reset`) deletes and rebuilds it.

**Threads.** A thread id is the Zendesk ticket id (`int`). It means `(inbox_run_id(), ticket_id)`. The existing review, draft, send, brief, chat and schedule routes are used with that run id: `/api/runs/{inbox_run_id}/…`.

**Held back and arrivals.** Hold back the last 8 tickets by `created_at`. After connect, one arrives every 30 to 90 s (random, settings key `inbox.cadence` = `[30, 90]`), or now with Sync now. Arrival = `inbox.ingest(ticket, user, source="zendesk")`.

- `inbox.ingest(ticket: dict, user: dict | None, source: "zendesk" | "direct") -> int`: stores the user in the overlay, runs `pipeline.process_ticket` on the inbox run, stores the bundle and brief like a run does, publishes `ticket.arrived` then `ticket.outcome` and `queue.counts`. Returns the ticket id. `ticket` has the `tickets.json` shape. `user` has the `users` shape (`{id, name, email, role: "end-user"}`).
- `inbox.new_ticket_id() -> int`: the next free id above every id in `tickets.json`, the overlay and `linked_tickets.json`.
- User overlay: table `inbox_users(id INTEGER PK, name, email, role)`. Merged into the pipeline `Store` so `build_view` finds requesters. `data/` is never written.

Endpoints (`ap_specialist`, `cfo`):

| Method and path | Answer |
|---|---|
| `GET /api/inbox/summary` | `{run_id, read, drafts_ready, action_needed, no_reply, held_back, prevented_this_week, connected_at}` (the "While you were away" card) |
| `GET /api/inbox/queues` | `{queues: [{id, label, count}]}`. Ids: `needs_reply, needs_action, escalated, returned, waiting_approver, waiting_vendor, scheduled, sent, closed` |
| `GET /api/inbox/threads?queue=&q=&assignee=` | `{rows: [ThreadRow]}` |
| `GET /api/inbox/threads/{ticket_id}` | `Thread` |
| `POST /api/inbox/sync` | `{arrived: [ticket_id]}` (Sync now: brings the next held-back ticket in) |
| `POST /api/inbox/threads/{ticket_id}/attachments` | body `{kind: "invoice" \| "remittance", bill_id}` → `{attachments: [Attachment]}` |
| `DELETE /api/inbox/threads/{ticket_id}/attachments/{attachment_id}` | `{attachments: [...]}` |
| `GET /api/connections` | `{connections: [{id: zendesk \| outlook \| netsuite \| model, name, status, last_sync, scopes: [str], detail}], log: [{at, text}]}` |

`ThreadRow` = `{ticket_id, from_name, from_email, company, subject, snippet, received_at, source: "Outlook" | "Conductor: Direct", zendesk_status, outcome, intent, invoice_refs, flags: [fraud | legal | exec_cc | injection], sender_verified: bool, assignee, workflow_state, category (sign-off category or null), review_state, group_id, group_size, reading: bool}`\| legal \| exec_cc \| injection], sender_verified: bool, assignee, workflow_state, review_state, group_id, group_size, reading: bool}`.

`Thread` = `ThreadRow` plus `{headers: {from, to, cc, date, subject}, messages: [{author, email, at, body, public, attachments: [name]}], insight: {wants, invoice, status_line, why}, result: <bundle.result>, decision: <bundle.decision>, review: <same as today's detail>, workflow: <§6 state>, evidence: Evidence, attachments: [Attachment], schedule: <today's schedule payload or null>, run_id}`.

`Evidence` = `{requester: {name, email, kind, authorized}, vendor: {id, name, subsidiary, terms, contacts: [{email, is_requester}], w9_status} | null, items: [{ref, bill: {...}, payment: {... account masked to last 4} | null, run: {run_id, run_date, run_status} | null, sources: [{label, ref}]}], linked: [{id, status, subject}], brief, rule_trail: [{name, summary}]}`. `sources` labels are "NetSuite · bill 50000", "Payment run RUN-2026-11-19", "Zendesk #41249".

**Write-back.** `inbox` registers a `delivery.ON_SENT` hook (§7). It marks the Zendesk ticket `solved` (or `pending` for decided notes), adds an internal note, files the message in "Sent items", writes a sync-log line, and publishes `ticket.sent`.

**Advanced** (`cfo` only), also in `inbox.py`: `POST /api/admin/reset`; `POST /api/admin/import {path}` (a tickets file → a normal batch run through `runner.Manager.start_run`); `GET /api/admin/export?run_id=&scope=` (same format as today's export). The existing `/api/runs*` routes stay and are CFO-only.

Tables (owner inbox): `inbox_users`, `inbox_state(ticket_id PK, zendesk_status, sent_folder INTEGER, arrived_at REAL, source)`, `sync_log(id PK, at, text)`. The assignee and workflow state live in `workflow` only. The inbox reads them with `workflow.get_state(ticket_id) -> {state, category, assignee, chased}`.

**Queue rules** (computed by inbox from the bundle, review state and `workflow.get_state`):
- `needs_reply`: a draft reply, workflow `open` or `returned`, review not sent
- `needs_action`: an internal note, not decided
- `escalated`: `escalated` or `signoff_requested`
- `returned`: `returned`, assigned to the viewer
- `waiting_approver`: the note names a `nextApprover` (pending approval or PO)
- `waiting_vendor`: we asked the vendor for something (a PDF copy or W-9) and it was sent
- `scheduled`: has an active scheduled send
- `sent`: review `sent`
- `closed`: `no_draft`, `decided` or `closed`

## 6. Workflow (`workflow.py`, `feedback.py`, owner `p3/identity-live`)

All workflow ids are inbox ticket ids. States: `open → escalated → returned | signoff_requested | signed_off | decided → sent | closed`.

- `workflow.signoff_category(bundle) -> None | "priority" | "fraud" | "returned" | "early_or_late_fee"`, from `bundle["result"]["priority"]`, `flags` and `bundle["decision"]["rule"]`.
- `workflow.can_approve(session, run_id, ticket_id) -> str | None`: a reason string blocks approval. Rules: a sign-off category blocks a specialist's `approved` (they must request sign-off). Fraud blocks everyone (as today).
- `workflow.can_send(run_id, ticket_id, reply_hash) -> str | None`: a `priority` ticket sends only when its state is `signed_off` and the stored hash equals `reply_hash` (`delivery.reply_hash(to, subject, body)`). Used by `delivery.prepare`, so **scheduled send is covered too**.
- **Sign-off meaning** (decision 6): `priority` → the CFO signs off the exact reply text (the hash is stored). `fraud`, `returned`, `early_or_late_fee` are internal notes: the CFO **decides** (`acknowledged` with an action taken, `closed`, or `returned` with guidance). No vendor reply is ever composed on a note ticket.

Endpoints:

| Method and path | Who | Body |
|---|---|---|
| `GET /api/workflow/{ticket_id}` | staff | → `{state, category, assignee, history: [Audit], chases: [...], signoff: {hash, by, at} \| null}` |
| `POST /api/workflow/{ticket_id}/escalate` | staff | `{reason:`ThreadRow` = `{ticket_id, from_name, from_email, company, subject, snippet, received_at, source: "Outlook" | "Conductor: Direct", zendesk_status, outcome, intent, invoice_refs, flags: [fraud | legal | exec_cc | injection], sender_verified: bool, assignee, workflow_state, category (sign-off category or null), review_state, group_id, group_size, reading: bool}`\| exec \| fraud \| bank_change \| returned \| early_payment \| late_fee \| conflict \| other, note}` |
| `POST /api/workflow/{ticket_id}/request-signoff` | staff | `{note}` |
| `POST /api/workflow/{ticket_id}/return` | cfo | `{guidance}` (required) |
| `POST /api/workflow/{ticket_id}/signoff` | cfo | `{reply_hash}` (must match the current reply) |
| `POST /api/workflow/{ticket_id}/decide` | cfo | `{decision: acknowledged \| closed, action_taken, note}` |
| `POST /api/workflow/{ticket_id}/assign` | staff | `{to: email}` |
| `POST /api/workflow/{ticket_id}/chase` | staff | `{}` → creates an `approver_nudge` outbound item for the bill's `nextApprover` (or delegate), using `approver_digest` |
| `POST /api/workflow/{ticket_id}/forward` | staff | `{to: "hr" \| "ar", note}` (HR = Quinn Ellsworth) |
| `POST /api/workflow/{ticket_id}/no-reply` | staff | `{note}` |
| `GET /api/workflow/escalations` | cfo | → `{rows: [...]}` |
| `GET /api/workflow/audit?limit=` | cfo | → `{rows: [Audit]}` |
| `GET /api/workflow/expertise`, `PUT /api/workflow/expertise` | staff / cfo | `{people: [{email, name, replies, exceptions: bool, categories: [...]}]}` |
| `GET /api/team/overview` | cfo | queue health by queue and specialist, aging, first-reply time, follow-up rate, bottlenecks, Ahead impact, feedback trends; every metric has `source` |

**Outbound items** (chase, W-9 request): table `outbound(id PK, kind: approver_nudge \| w9_request, ticket_id NULL, vendor_id NULL, to_email, subject, body, state: pending \| approved \| sent, created_by, created_at, approved_by, sent_at, message_id)`.
- `workflow.create_outbound(kind, to_email, subject, body, *, created_by, ticket_id=None, vendor_id=None) -> int`. The text comes from records. It is checked with `egress_guard.check_outbound` before approve and before send.
- `GET /api/outbound?kind=`, `PUT /api/outbound/{id}` `{state: approved \| pending}`, `POST /api/outbound/{id}/send` (staff).

**Approver** (`approver` role; `cfo` read):
- `GET /api/approver/queue` → `{bills: [{bill_id, tranId, vendor, amount, status, since, blocked_tickets: [{ticket_id, subject, from_name}], commitment}], digest}`
- `POST /api/approver/bills/{bill_id}/ack`
- `POST /api/approver/bills/{bill_id}/commit {date}`: internal only; never shown to vendors.

**Feedback** (`feedback.py`): `POST /api/feedback {run_id, ticket_id, category: tone \| facts \| missing_info \| other, note}`, `GET /api/feedback/trends` (cfo). Table `feedback(id PK, run_id, ticket_id, by, category, note, at)`. The draft-save and approve handlers in `server.py` record `edited=true` so the UI knows to ask.

Tables (owner identity-live): `sessions`, `workflow_state(ticket_id PK, state, category, assignee, signoff_hash, signoff_by, signoff_at, decided, updated_at)`, `audit_log(id PK, at, actor, ticket_id, action, from_state, to_state, detail)`, `expertise`, `outbound`, `approver_actions(bill_id, approver, kind, date, at)`, `feedback`.

## 7. Delivery hooks (seam; `delivery.py` owner `p3/identity-live` after the seam)

- `delivery.ON_SENT: list[Callable[[run_id, ticket_id, actor: dict | None, info: dict], None]]`. Called after a successful send, each in `try/except` (logged, never raised).
- `delivery.deliver_reply(run_id, ticket_id, expect_hash=None, actor=None)`. `actor` = `{name, email}` or `None` (scheduled send).
- `delivery.prepare` calls `workflow.can_send(...)` (409 with its reason) and adds `documents.attachments_for(run_id, ticket_id)` to the message.
- `mailer.Message.attachments: list[tuple[filename, mime, bytes]]` (seam adds the field and its `.eml` encoding).

Registered hooks: `workflow` (state → `sent`, audit), `inbox` (write-back), `direct` (Messages, when the ticket came from Direct).

## 8. Documents (`documents.py`, owner `p3/inbox-sync`)

- `documents.render(kind: "invoice" | "remittance", bill_internal_id: str, fmt: "html" | "pdf") -> tuple[bytes, str mime, str filename]`. From records only: bill, vendor, payment, run. Account numbers are masked to the last 4. A remittance exists only for `Settled` or `Released` payments, and never shows a reference for returned payments. Raises `documents.NotAvailable`.
- `documents.attachments_for(run_id, ticket_id) -> list[tuple]` and the table `draft_attachments(id PK, run_id, ticket_id, kind, bill_id, filename, added_by, added_at)`.
- Staff: `GET /api/documents/{kind}/{bill_internal_id}.{html|pdf}`. Vendors: through Direct (§9), scoped to their vendor.
- **Download.** The browser fetches with its headers and opens a `blob:` URL. No document URL carries a secret.
- **CSP** (done in the seam). A document route sets the response header `X-Conductor-Frame: self`. The middleware turns that into `frame-ancestors 'self'` and removes the marker. Every other response keeps `frame-ancestors 'none'`. The global CSP already has `img-src 'self' data: blob:` and `frame-src 'self' blob:`.
- PDFs use reportlab (installed). No other PDF writer.

## 9. Direct (`direct.py`, owner `p3/direct-w9`)

Every route: `require_role("vendor")`. The vendor comes from the session, never from the request. Any invoice that is missing, belongs to another vendor or cannot be shown gets the same **404 `{"detail": "We couldn't find that invoice."}`**.

| Method and path | Answer |
|---|---|
| `GET /api/direct/me` | `{contact: {email, name}, vendor: {name, subsidiary}, w9: {status, label}, unread_messages, unread_updates}` |
| `GET /api/direct/invoices?q=&status=` | `{rows: [{invoice, date, amount, currency, balance, status: {code, label, date?}}], updated: "Nov 13, 2026"}`. **No totals or counts across invoices.** |
| `GET /api/direct/invoices/{invoice}` | `{invoice, date, due, amount, balance, status, timeline: [{label, date?, done}], message (status_service wording), documents: [{kind, label}], source: "Orchestra accounts payable records, updated Nov 13, 2026"}` |
| `GET /api/direct/invoices/{invoice}/documents/{kind}.{html\|pdf}` | `documents.render`, scoped |
| `POST /api/direct/questions` | `{invoice, text}` (text ≤ 2000) → `{ok, message}`. Builds a ticket and calls `inbox.ingest(..., source="direct")`. Publishes `direct.question` |
| `GET /api/direct/messages` | `{rows: [{at, invoice, subject, body}]}`: only replies a person approved and sent |
| `GET /api/direct/updates` | `{rows: [{at, title, body}]}`: Ahead notices sent to this vendor |
| `GET /api/direct/preferences`, `PUT` | `{email_updates: bool, notice_types: [...]}` |
| `GET /api/direct/w9` | `{status, label, last_upload}` |
| `POST /api/direct/w9/uploads` | `{filename, size, mime}` → `{upload_id, chunk_size: 1048576}`. Refuses over 50 MB or a non-PDF |
| `PUT /api/direct/w9/uploads/{id}/chunks/{n}` | raw bytes → `{received}` |
| `POST /api/direct/w9/uploads/{id}/complete` | `{sha256}` → `{ok, status}`. The server hashes as it streams and compares |

Status chips (`status.code`): `received`, `pending_approval` (no date), `approved` ("typically paid within 5 to 10 business days"), `scheduled` (run date), `payment_sent` (release date), `paid` (date), `under_review` (every `NEEDS_REVIEW` state; never says why). The list runs each of the vendor's bills through `rules.classify_bill` → `drafts` snippets → `egress_guard`, the same path as `status_service.lookup_status`. It never builds its own wording.

Self-serve lookups: table `direct_lookups(at, vendor_id, invoice)`. `direct.lookup_count(since=None) -> int` feeds Ahead impact as its own line, **never** as tickets prevented.

Tables (owner direct-w9): `direct_messages`, `direct_updates`, `direct_prefs`, `direct_lookups`, `direct_questions(ticket_id PK, vendor_id, invoice, contact)`.

## 10. W-9 (`w9.py`, owner `p3/direct-w9`)

- Seed: `dashboards/conductor/seed/w9/status.json` = `{vendor_id: {status: on_file \| missing \| expired \| name_mismatch \| tin_mismatch, tin_last4?, legal_name?, entity_type?, address?, on_file_at?}}` for every vendor in `vendors.csv`. Sample PDFs in `seed/w9/samples/` from `scripts/make_w9_samples.py` (fictional TINs). **Never store or show more than the last 4 TIN digits**, outside the generated sample PDFs themselves.
- Uploads are stored under `<CONDUCTOR_STATE_DIR>/uploads/w9/`, never in the repo.
- Staff endpoints: `GET /api/w9/queue` → `{rows: [{vendor_id, vendor, status, bills_held: [{tranId, amount, status}]}]}`; `GET /api/w9/{vendor_id}`; `POST /api/w9/{vendor_id}/request` → an outbound `w9_request` (§6); `GET /api/w9/uploads/{upload_id}` → `{fields: [{name, value_masked, record, match}], sha256, size}`; `POST /api/w9/uploads/{upload_id}/verify` → records who and when (NetSuite is unchanged; the next step is shown as "Update NetSuite vendor record").
- Any bank-detail content in an upload or a question sends it to the fraud path. No bank detail is ever accepted.

Tables: `w9_status`, `w9_uploads(id PK, vendor_id, filename, size, sha256, path, state, fields JSON, uploaded_at, verified_by, verified_at)`.

## 11. Ahead (prevention)

The existing `prevention.py` routes and `/api/runs/{id}/prevention*` stay, used with the inbox run. The Ahead view reads them, plus `direct.lookup_count()` and `GET /api/inbox/summary.prevented_this_week`. Every notice or digest send (the build list and the one-invoice demo) calls `delivery.notice_sent(run_id, kind, key, item, info)`, which runs the `delivery.ON_NOTICE_SENT` hooks (seam). `direct` registers one that adds a `direct_updates` row when `item` has a `vendor_id` (for the demo, it finds the vendor by `item["to"]`). `inbox` registers one that publishes `ahead.sent`. Keep `egress_guard.check_outbound` and the stale-record 409.

## 12. Pages and front-end modules

| URL | File | Owner |
|---|---|---|
| `/` | `conductor/assets/hub.html` | design-shell |
| `/app` | `conductor/assets/index.html` (staff workspace) | design-shell (shell markup), wave 2 (views) |
| `/direct` | `conductor/assets/direct.html` | direct-ui (design-shell supplies the shell component) |

The server replaces `__AP_TOKEN__` in all three. Static files stay at `/static/…` (`conductor/assets/`) and `/shared/…` (`assets/`).

- **`http.js`** (seam): `request(method, path, body, opts)`, `getJSON`, `postJSON`, `putJSON`, `del`, `blob(path)`, `liveTicket()`, `session.get/set/clear()`. It adds `x-ap-token` and `x-conductor-session`. A 401 clears the session and sends the browser to `/`. Every `api-*.js` uses it. No view calls `fetch` directly.
- Data modules: `api-session.js`, `api-live.js` (identity-live); `api-inbox.js` (inbox-sync); `api-direct.js`, `api-w9.js` (direct-w9); the existing `api.js`, `api-chat.js`, `api-schedule.js` (workspace-ui, wave 2). Each exports plain async functions. No DOM.
- `api-live.js` exports `subscribe(handler) -> unsubscribe`. It gets a ticket, opens `EventSource`, and reconnects with a fresh ticket. `handler(event)` receives the parsed data object (which has `type`).
- `api-session.js` exports exactly these (each returns the JSON answer from §2 and stores the session with `http.session.set(...)` when one is created):
  `directory()`, `ssoStaff(email)`, `ssoVendor(provider, email)`, `requestCode(email, invoice)`, `verifyCode(email, invoice, code)`, `current()` (resolves `null` when signed out, never redirects), `signOut()` (clears storage, then `location.assign('/')`), and `homeFor(role)` (`/app#/inbox`, `/app#/escalations`, `/app#/approver` or `/direct`).
  Until identity-live merges, the stub exports nothing. design-shell's hub imports through its own `hub/session-port.js`, which uses the real functions when they exist and a local fake otherwise. The orchestrator removes the fake at merge.
- Components (design-shell): `components/*.js` export functions that return DOM nodes, built with `lib.js`'s `h()`. Class names use the `c-` prefix (`c-btn`, `c-chip`, `c-badge`, `c-table`, `c-pane`, `c-tabs`, `c-modal`, `c-toast`, `c-skeleton`, `c-avatar`, `c-empty`, `c-field`, `c-menu`, `c-split`). The full list is in the style guide (`#/styleguide`).
- Router (`router.js`): the seam adds the routes `#/inbox[/:ticketId]`, `#/escalations[/:ticketId]`, `#/team`, `#/approver`, `#/ahead`, `#/vendor-setup[/:vendorId]`, `#/settings`, `#/settings/advanced`, `#/styleguide`. The `#/runs…` routes still parse. workspace-ui owns `router.js` in wave 2 and redirects old links.
- Views: one module per route in `views/`, with today's convention: `export function mount(root, { route, session }) { …; return { update?({ route }), destroy?() } }`. `app.js` calls `update` when only the query or ticket id changes, and calls `destroy` (if present) on teardown. Views get live events from `api-live.js`'s `subscribe` and unsubscribe in `destroy`.

**Who owns each existing front-end file after the seam:** `app.js` and `index.html` → design-shell (wave 1). `router.js`, `state.js`, `api.js`, `api-chat.js`, `api-schedule.js`, `chat.js`, `schedule.js`, `views/tickets.js`, `views/review.js`, `views/not-found.js` → workspace-ui (wave 2). `views/overview.js`, `views/runs.js`, `views/run-new.js`, `views/prevent.js`, `views/settings.js` → leadership-ui (wave 2), to retire into Ahead and Advanced. `ui.js`, `lib.js` → design-shell.

## 13. Tests

- `tests/signin.py` (seam stub, identity-live fills it in): `headers(role="ap_specialist", email=None) -> dict`, which returns `x-ap-token` plus a real session header made with `identity.create_session(...)` directly, not over HTTP. Every route-calling test (`test_webapp.py`, `test_chat.py`, `test_scheduler.py`, `test_prevention.py`, `test_prevention_demo.py`, `test_local_model.py`, `test_native_dialog.py`) builds its headers from it.
- Known baseline failure at `60564ec`: `test_local_model.ModelSelectionTests.test_selected_model_is_the_one_used_everywhere` (the fake records two calls instead of one). The gate is "no new failures". Do not mask it.
