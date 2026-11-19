# Conductor Phase 3: security notes

Conductor runs on one machine, bound to `127.0.0.1:8790`. It never calls a cloud service: the only model is a local Ollama server (`local_model.py`), and pages load no CDN assets. This note says what protects each part, what is simulated, and what a real deployment would swap in.

## Layers on every request

| Layer | What it does | Where |
|---|---|---|
| Host and Origin | A request whose `Host` is not localhost is refused (403). A state-changing request from another origin is refused. | `server.local_only` |
| Per-launch token | Every `/api/*` call needs `x-ap-token`, a random value created at start-up and placed in the three pages. | `server.auth` |
| Session | Every `/api/*` route except `/api/health` and `/api/session/*` needs `x-conductor-session`. Sessions live in the state database, one per browser tab (`sessionStorage`), never in a URL. | `identity.py`, `server.auth` |
| Role guard | Each route declares its roles (`identity.require_role`). No session is 401; a wrong role is 403. A vendor session can reach only `/api/direct/*`, `/api/session/*`, `/api/live/*` and `/api/health`, whatever a route's own guard says. | `identity.py`, `server.auth`; list in `ROUTES.md` |
| Headers | `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a CSP: `default-src 'self'`, `frame-ancestors 'none'` (document routes only: `'self'`, so the app can preview its own rendered invoice). | `server.local_only` |

Requests that cannot send headers use **single-use tickets**:
- `EventSource` streams (`/api/live`, run progress) take a ticket from `POST /api/live/ticket`. It is valid for 60 seconds, works once, and is bound to the session that asked for it.
- Document downloads are fetched with headers and opened as `blob:` URLs. No document URL carries a secret.

## Simulated sign-in (what is real and what is not)

**Simulated on localhost:**
- **Staff "Sign in with Microsoft"** shows a picker of the 13 people who have a dashboard: Ulla Abernathy and Omar Calloway (AP specialists), Elena Lockhart (CFO), and the budget approvers on pending bills. Picking one creates a session with no password.
- **Vendor "Continue with Microsoft / Google"** asks for the work email first. It never lists vendors or contacts. A known authorized contact gets a session. An unknown, inactive or ambiguous address gets the same neutral 401: "We couldn't sign you in with that account."
- **The vendor sign-in code** (email + invoice → 6 digits) reuses the old portal's `PortalLogic` rate limits, expiry and constant-time compare. The code appears in a "Your inbox" panel on the page, standing in for the email. Because that panel only gets a code for an authorized address, it reveals which addresses are on file. This is accepted only because the mailbox is simulated.

**A real deployment would swap in:**
- Staff: **Microsoft Entra ID** (OIDC), with the role taken from a group or app role. There would be no picker.
- Vendors: a **magic link or one-time code sent by email** (or OIDC through the vendor's own identity provider). The answer would be the same "check your inbox" screen for every address, so nothing reveals whether an address is on file.
- The per-launch token and localhost binding would be replaced by TLS, a real origin, and session cookies (`HttpOnly`, `Secure`, `SameSite=Strict`) with CSRF protection.

## What vendors can and cannot see

Vendors see their own invoices only: invoice number, dates, amount, open balance and a plain status. Status wording comes from the same records-only path as staff drafts (`rules.classify_bill` → `drafts` snippets → `egress_guard`). Vendors never see:
- totals or counts across invoices
- internal names, ticket IDs, approval dates, or who changed a record
- the reason an invoice is "Under review"

A missing invoice, another vendor's invoice and an un-showable one all get the identical 404. Vendor live streams receive only events tagged with their own vendor id.

## Nothing leaves without a person

Replies, Ahead notices, approver digests, approver nudges ("chase") and W-9 requests each have a review state. Each needs an explicit approve, then send, and recipient, subject and body always come from server records. The CFO's sign-off rule (decision 6) is enforced on the server:
- `workflow.can_approve` runs inside the review handlers.
- `workflow.can_send` runs inside `delivery.prepare`, which covers both Send now and scheduled send.
- A priority reply sends only after the CFO signs off on its exact text (a SHA-256 of recipient, subject and body). Any later edit clears the sign-off.
- Fraud tickets can never be approved, by anyone.
- Note tickets (fraud, returned payment, early payment or late fee) are decided by the CFO. Conductor never writes a vendor reply for them.

## Masking

Bank account and routing numbers and TINs show at most the last 4 digits in the UI, API answers, logs, model prompts, outgoing email, rendered PDFs and test fixtures. The data pack itself has no bank account fields, so documents show `****`.

**One known exception:** an uploaded W-9 PDF is kept as the vendor sent it, so the full TIN is inside that file under `$CONDUCTOR_STATE_DIR/uploads/w9/`, outside the repo. Every database row, API answer, event and log line keeps only the last 4. A real deployment would store uploads in an encrypted document store with access logging, and delete them after the vendor record is updated.

## Uploads

- W-9 uploads are chunked (1 MB parts) with a 50 MB cap and a PDF check (`%PDF` magic bytes).
- A streaming SHA-256 is compared with the client's.
- Each vendor may have at most 5 unfinished uploads; cancelled uploads are closed.
- Any bank-detail content sends the upload to the CFO's fraud review path; bank details are never accepted.

## Records are read-only

Conductor reads `data/` and never writes it. It does not approve bills, change vendor records, or move money:
- Approver "commit to a date" is an internal note, never shown to vendors.
- "Mark verified" on a W-9 records who checked it. The next step, "Update NetSuite vendor record", stays with a person.
