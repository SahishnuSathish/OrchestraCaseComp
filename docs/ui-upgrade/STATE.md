# Overnight UI upgrade: state (the orchestrator's memory)

On resume: read this file, then `git log --oneline -15` on `ui/overnight` and each worker branch, `git worktree list`,
and `git status` in each worktree. Never redo merged work.

## Now
- **Tier**: 1 (foundation + brand running in parallel, disjoint files)
- **Next step**: when both report, review diff + shots, run full gate on each, merge foundation then brand into
  `ui/overnight`, push. Then add the hub look loader + art hooks (orchestrator), then spawn looks A/B/C.

## Environment (cloud container, rebuilt on restart)
- Setup: `pip install -r requirements.txt`; `npm install --no-save --no-audit --no-fund playwright@1.63.0 axe-core`
  (1.63.0 matches the pre-installed Chromium in /opt/pw-browsers; do not run `playwright install`).
- Worktrees live in `/home/user/wt-<area>`; each gets `ln -s /home/user/OrchestraCaseComp/node_modules node_modules`.
- Tools: `docs/ui-upgrade/tools/gate.sh [smoke|py|js|git|all] [port-base]`, `docs/ui-upgrade/tools/shots.mjs`.
- Port plan: smoke bases 8808 (orchestrator), 8810 foundation, 8812 brand, 8814/8816/8818 looks a/b/c,
  8820+ tier 2; shots ports 8830+ (orchestrator 8820).

## Baseline gate (Phase 0, on bc8ea0c)
| Check | Result |
|---|---|
| Smoke (`node tests/ui/smoke.mjs`) | 24/24 PASS in 70 s; axe 0 serious/critical on all 13 pages |
| JS (`node --test tests/js/*.test.mjs`) | 85/85 |
| Python (`python3 -m unittest discover -s tests -p "test_*.py" -t tests`) | 396 run, 4 errors, 1 skipped. **Pre-existing**: the 4 errors are all `test_native_dialog.TkHelperTests` (`No module named 'tkinter'` in this container). |
| git status state/out | clean |

## Branches
| Branch | Worktree | Base | Head | Status |
|---|---|---|---|---|
| `ui/overnight` | /home/user/OrchestraCaseComp | ui/overnight-base bc8ea0c | (see git) | integration branch |
| `ui/foundation` | /home/user/wt-foundation | ui/overnight | - | running |
| `ui/brand` | /home/user/wt-brand | ui/overnight | - | running |

## Workers
| Area | Agent id | Brief | Model | Status |
|---|---|---|---|---|
| foundation | (pending) | briefs/foundation.md | opus | starting |
| brand | (pending) | briefs/brand.md | opus | starting |

## Gate results after merges
(none yet)

## Decisions
- Phase 0: verdict "light slop, heavy blandness" (AUDIT.md). Direction written to DIRECTION.md.
- Foundation and brand run in parallel (disjoint files: brand overrides core.css's mark rules from a new
  `css/components/brand.css`, imported by components.css; orchestrator added the stub + import). Foundation merges first.
- The orchestrator (not a look worker) writes the hub look loader and presentational hooks in hub.js before the three
  look workers start, so the three never touch the same file.
- Screenshots are JPEG (q78) to stay well under 300 KB.

## Open problems
(none)

## Last limit hit
(none)
