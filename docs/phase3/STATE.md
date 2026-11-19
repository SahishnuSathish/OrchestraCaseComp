# Phase 3 state (checkpoint)

Resume rule: read this file and `git log` on every branch below before doing anything. Never redo merged work.
Prompt: `C:/Users/Sahishnu Sathish/Projects/Orchestra Case Comp/docs/phase3-orchestrator-prompt.md` (Part A). Playwright option (a) chosen by the user: installed in this worktree (`npm install --no-save playwright`, Chromium headless shell 1255).

## Where we are

- Wave: **2 running** (started Nov 18, ~23:50 CST) from `a78b09b` (adds `api-workflow.js`, the shared data module for workflow routes). (started Nov 18, ~22:25 CST). Seam head `a357880`; all four wave-1 branches started there.
- Next step: wave-2 worktrees from `e03dbb1`; start workspace-ui, leadership-ui, direct-ui in one message; merge in that order, gate after each.
- 22:30: identity-live, inbox-sync and design-shell hit the usage limit mid-work (work on disk, mostly uncommitted). 22:37: all three resumed via SendMessage with the same agent ids. direct-w9 had already finished.

## Branches

| Branch | Worktree | Head | Status |
|---|---|---|---|
| `phase3/integration` | `orchestra-wt/p3-integration` | `e03dbb1` | wave 1 merged, gate green |
| `p3/identity-live` | `orchestra-wt/p3-identity-live` | `ec149c6` | **merged** (tiers 1+2) as `8378235` |
| `p3/inbox-sync` | `orchestra-wt/p3-inbox-sync` | `6971e78` | **merged** (tiers 1+2) as `49475e0`, plus integration fix |
| `p3/direct-w9` | `orchestra-wt/p3-direct-w9` | `0e863d7` | **merged** (tiers 1-3) as `bd5285d`, plus fix `3ff281f` |
| `p3/workspace-ui` | `orchestra-wt/p3-workspace-ui` | from `a78b09b` | running (Opus) |
| `p3/leadership-ui` | `orchestra-wt/p3-leadership-ui` | from `a78b09b` | running (Opus) |
| `p3/direct-ui` | `orchestra-wt/p3-direct-ui` | from `a78b09b` | running (Opus) |
| `p3/design-shell` | `orchestra-wt/p3-design-shell` | `345af43` | **merged** (tiers 1-2) as `1ba41f5`; stand-in session removed `56b4fc6` |

## Worker agents

| Branch | Agent id |
|---|---|
| p3/identity-live | a619aa0adc6caf17a |
| p3/inbox-sync | aea55e76ba0103c85 |
| p3/direct-w9 | a7d5d3e5582bc1292 |
| p3/design-shell | afb5cc5f3bc50dae1 |
| p3/workspace-ui | ad8cafd01c57948dc |
| p3/leadership-ui | acf401ca9e503f8ec |
| p3/direct-ui | aa0569610840b4010 |

If the session was interrupted, these agents are gone: check each branch's `git log` and restart a worker for whatever tier is missing, with the same brief (the brief text is reproducible from CONTRACTS.md and the prompt's section 6.3).

## Gate results

| When | Unit (python) | JS (node) | Pipeline score | App pages | Smoke |
|---|---|---|---|---|---|
| Baseline `60564ec` | 218 run: 216 pass, 1 fail, 1 skip. The failure is `test_local_model…test_selected_model_is_the_one_used_everywhere`, which is **flaky on main** (the fake records two model calls instead of one) | 75/75 | 100% correct, 100% safe | `/` old app | 49/49 (old suite) |
| After identity | 286 run, 1 fail (`test_run_processed_every_ticket_with_a_brief`: model race, fixed in `3579ba5`) | 75/75 | 100% / 100% | | |
| After inbox (+fix `efd7afc`) | 324 run, OK (1 skip) | 75/75 | 100% / 100% | | |
| After direct-w9 (+fix `3ff281f`) | 383 run, 1 fail (notice-hook test looked only at the last publish; fixed) | 75/75 | 100% / 100% | E2E over HTTP: staff and vendor SSO, 403/404 isolation, invoices, remittance PDF, Direct question lands in the inbox, W-9 queue, approver queue | |
| After design-shell (wave 1 complete) | 383 run, **OK** (1 skip) | 75/75 | **100% / 100%** | Browser: hub → Microsoft picker → Ulla → handshake → `/app#/inbox`, no console errors | old suite retired |
| Seam | 218 run: 217 pass, 1 skip, 0 fail (the flaky test passed this time). One legitimate test change: `test_webapp.BrandTests` now reads `/app` (the workspace moved; `/` is the hub) | 75/75 | 100% / 100% | `/` hub, `/app`, `/direct`, `/api/health` all answer | not run: the old suite targets `/` as the workspace. Rewritten in wave 3 (`p3/smoke`) |

Gate rule: **no new failures**. The flaky model-selection test is a known baseline issue, not to be masked.

## Decisions made by the orchestrator

- Staff workspace moves to `/app`; `/` is the sign-in hub; `/direct` is the vendor dashboard.
- The inbox reuses one hidden run (`settings` key `inbox.run_id`), so review, send, chat, schedule and prevention routes work unchanged.
- `delivery.prepare` calls `workflow.can_send` and `documents.attachments_for`, so scheduled send obeys sign-off with no scheduler change.
- `delivery.ON_SENT` hooks carry write-back (inbox), state (workflow) and vendor Messages (direct).
- Seven route-calling test files (not five: `test_local_model.py` and `test_native_dialog.py` too) build headers from `tests/signin.py`.
- The old smoke suite is retired from the gate until `p3/smoke` replaces it.

## Integration fixes made by the orchestrator

- `3579ba5` test_webapp: the shared ApiTests run is model-free. With qwen3.5:9b installed, the brief writer upgraded template briefs in the background and raced `test_run_processed_every_ticket_with_a_brief` (pre-existing on main whenever a chat model is installed; the assertion is unchanged).
- After the inbox merge, `test_inbox.py` hung: each inbox list called `workflow.get_state` per thread (746 DB connections, over 2 s). Fixed with `workflow.get_states` (batch) and a cached route kind; lists are ~0.06 s warm.
- `workflow_state` is keyed by ticket id only, so Advanced → Reset now calls `workflow.reset_states()`; a rebuilt inbox no longer inherits old states.
- `test_inbox` assignee-filter test updated to routed assignees (it assumed the workflow stub).

## Open problems

- Open for wave 2: `api.js` run-progress stream must use `http.liveTicket()` (workspace-ui). Done by the orchestrator: `ticket.scheduled` publish, `workflow.decide` → `inbox.on_decided`, stand-in session removed.
- Note for the hand-off: scheduling a priority reply is refused until the CFO signs off (scheduling runs the same checks as sending), which is stricter than the spec's "does not send when due".
