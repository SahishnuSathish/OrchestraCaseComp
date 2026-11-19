# API routes and the roles they allow

Owner: `p3/identity-live`. This is the contract of docs/phase3/CONTRACTS.md section 1, applied route by route.
`server.auth` also enforces it as a baseline for every `/api/*` route, so a route that forgets its own guard still
fails closed: no session gives 401, and a vendor session gets 403 anywhere outside the vendor prefixes.

Legend: **S** `ap_specialist`, **C** `cfo`, **A** `approver`, **V** `vendor`, **-** nobody. Every `/api/*` route also needs the
per-launch `x-ap-token` header. A session travels in `x-conductor-session`.
Guard names: `server.staff` (S, C), `server.cfo_only` (C), `identity.require_role(...)` inside a module's own router.

| Status | Meaning |
|---|---|
| 401 | no session (or an idle or ended one). Body `{"detail": "Sign in to continue."}` |
| 403 | a session with the wrong role. Body `{"detail": "You don't have access to that."}` |

## Public (token only)

| Route | Roles |
|---|---|
| `GET /api/health` | any caller with the token |
| `GET /api/session/directory`, `POST /api/session/sso`, `POST /api/session/code/request`, `POST /api/session/code/verify` | no session needed |
| `GET /api/session`, `DELETE /api/session` | any session (GET answers 401 without one) |

## Any signed-in role

| Route | Roles |
|---|---|
| `POST /api/live/ticket` | S C A V |
| `GET /api/live?ticket=` | the ticket's session (S C A V). Token and session header not needed: the single-use ticket stands for both. A vendor stream receives only events that carry its `vendor_id`. |

## Vendors only

| Route | Roles |
|---|---|
| `/api/direct/*` | V (each route uses `identity.require_role("vendor")`; owner `p3/direct-w9`) |

## CFO only

| Route | Roles |
|---|---|
| `GET /api/runs`, `POST /api/runs`, `POST /api/runs/import`, `DELETE /api/runs/{run_id}` | C |
| `PUT /api/settings/model` | C |
| `GET /api/fs/list`, `POST /api/fs/pick`, `POST /api/dataset/validate` | C |
| `/api/admin/*` (reset, import, export; inbox worker) | C |
| `POST /api/workflow/{ticket_id}/signoff`, `/return`, `/decide` | C |
| `GET /api/workflow/escalations`, `GET /api/workflow/audit`, `PUT /api/workflow/expertise` | C |
| `GET /api/feedback/trends`, `GET /api/team/overview` | C |

## Staff (specialist and CFO)

| Route | Roles |
|---|---|
| `GET /api/model/status`, `POST /api/model/test`, `GET /api/settings`, `GET /api/mail/status` | S C |
| `GET /api/runs/{run_id}`, `POST /api/runs/{run_id}/cancel` | S C |
| `GET /api/runs/{run_id}/events` (`?ticket=` from `/api/live/ticket`; the old `?token=` alone no longer opens it) | S C |
| `GET /api/runs/{run_id}/tickets`, `GET /api/runs/{run_id}/tickets/{ticket_id}` | S C |
| `POST /api/runs/{run_id}/tickets/{ticket_id}/brief`, `POST /api/runs/{run_id}/briefs/upgrade` | S C |
| `PUT /api/runs/{run_id}/review/{ticket_id}`, `POST /api/runs/{run_id}/review/bulk`, `PUT /api/runs/{run_id}/review/{ticket_id}/draft` | S C (a sign-off category blocks a specialist's approval: `workflow.can_approve`) |
| `POST /api/runs/{run_id}/tickets/{ticket_id}/send` | S C (`workflow.can_send` through `delivery.prepare`) |
| `GET/POST/DELETE /api/runs/{run_id}/tickets/{ticket_id}/schedule` | S C |
| `GET/POST/DELETE /api/runs/{run_id}/tickets/{ticket_id}/chat` | S C |
| `GET /api/runs/{run_id}/export` | S C |
| `GET /api/runs/{run_id}/prevention`, `POST .../prevention/build`, `PUT/POST .../prevention/{kind}/{key}[/send]`, `.../prevention/demo*` | S C |
| `GET /api/workflow/{ticket_id}`, `POST /api/workflow/{ticket_id}/escalate`, `/request-signoff`, `/assign`, `/chase`, `/forward`, `/no-reply` | S C |
| `GET /api/workflow/expertise` | S C |
| `GET /api/outbound`, `PUT /api/outbound/{id}`, `POST /api/outbound/{id}/send` | S C |
| `POST /api/feedback`, `GET /api/feedback/prompt` | S C |
| `/api/inbox/*`, `GET /api/connections`, `/api/documents/*`, `/api/w9/*` (owners `p3/inbox-sync`, `p3/direct-w9`) | S C |

## Approver

| Route | Roles |
|---|---|
| `GET /api/approver/queue` | A (their own bills), C (read; any approver with `?approver=`) |
| `POST /api/approver/bills/{bill_id}/ack`, `POST /api/approver/bills/{bill_id}/commit` | A (own bills only) |

Approvers and vendors get 403 on every inbox, run, workflow, outbound and settings route. Commitment dates are internal: no
vendor route reads `approver_actions`.
