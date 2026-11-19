# Phase 3 state (checkpoint)

Resume rule: read this file and `git log` on every branch below before doing anything. Never redo merged work.
Prompt: `C:/Users/Sahishnu Sathish/Projects/Orchestra Case Comp/docs/phase3-orchestrator-prompt.md` (Part A). Playwright option (a) chosen by the user: installed in this worktree (`npm install --no-save playwright`, Chromium headless shell 1255).

## Where we are

- Wave: **1 running** (started Nov 18, ~22:25 CST). Seam head `a357880`; all four wave-1 branches started there.
- Next step: when each worker reports, review its diff, then merge in order identity-live → inbox-sync → direct-w9 → design-shell, gate after each.

## Branches

| Branch | Worktree | Head | Status |
|---|---|---|---|
| `phase3/integration` | `orchestra-wt/p3-integration` | `a357880` + this STATE commit | seam done |
| `p3/identity-live` | `orchestra-wt/p3-identity-live` | from `a357880` | running (Sonnet) |
| `p3/inbox-sync` | `orchestra-wt/p3-inbox-sync` | from `a357880` | running (Sonnet) |
| `p3/direct-w9` | `orchestra-wt/p3-direct-w9` | `0e863d7` | done, all 3 tiers; 277 tests OK, 100/100; waiting to merge (after identity, inbox). Demo vendor: Dovetail Lane Printing, billing@dovetaillaneprinti.example (W-9 missing) |
| `p3/design-shell` | `orchestra-wt/p3-design-shell` | from `a357880` | running (Opus) |

## Worker agents

| Branch | Agent id |
|---|---|
| p3/identity-live | a619aa0adc6caf17a |
| p3/inbox-sync | aea55e76ba0103c85 |
| p3/direct-w9 | a7d5d3e5582bc1292 |
| p3/design-shell | afb5cc5f3bc50dae1 |

If the session was interrupted, these agents are gone: check each branch's `git log` and restart a worker for whatever tier is missing, with the same brief (the brief text is reproducible from CONTRACTS.md and the prompt's section 6.3).

## Gate results

| When | Unit (python) | JS (node) | Pipeline score | App pages | Smoke |
|---|---|---|---|---|---|
| Baseline `60564ec` | 218 run: 216 pass, 1 fail, 1 skip. The failure is `test_local_model…test_selected_model_is_the_one_used_everywhere`, which is **flaky on main** (the fake records two model calls instead of one) | 75/75 | 100% correct, 100% safe | `/` old app | 49/49 (old suite) |
| Seam | 218 run: 217 pass, 1 skip, 0 fail (the flaky test passed this time). One legitimate test change: `test_webapp.BrandTests` now reads `/app` (the workspace moved; `/` is the hub) | 75/75 | 100% / 100% | `/` hub, `/app`, `/direct`, `/api/health` all answer | not run: the old suite targets `/` as the workspace. Rewritten in wave 3 (`p3/smoke`) |

Gate rule: **no new failures**. The flaky model-selection test is a known baseline issue, not to be masked.

## Decisions made by the orchestrator

- Staff workspace moves to `/app`; `/` is the sign-in hub; `/direct` is the vendor dashboard.
- The inbox reuses one hidden run (`settings` key `inbox.run_id`), so review, send, chat, schedule and prevention routes work unchanged.
- `delivery.prepare` calls `workflow.can_send` and `documents.attachments_for`, so scheduled send obeys sign-off with no scheduler change.
- `delivery.ON_SENT` hooks carry write-back (inbox), state (workflow) and vendor Messages (direct).
- Seven route-calling test files (not five: `test_local_model.py` and `test_native_dialog.py` too) build headers from `tests/signin.py`.
- The old smoke suite is retired from the gate until `p3/smoke` replaces it.

## Open problems

(none)
