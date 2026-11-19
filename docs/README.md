# Documentation

This folder is kept out of git. Only this README and `.gitignore` are tracked.

| Path | What it is |
|---|---|
| [conductor.md](conductor.md) | Conductor, the review app (dashboard 1): how to start it, its pages, local model, mail and security model |
| [features/](features/) | One note per feature: demo runbook, vendor portal, prevention demo, scheduled send, ticket chat |
| [plans/](plans/) | Planning notes: `PLAN.md`, `CONDUCTOR_PLAN.md`, `LOCAL_AI_ORCHESTRATOR_PLAN.md` |
| [opus-orchestrator-prompt.md](opus-orchestrator-prompt.md) | The orchestrator prompt used for earlier builds |

Generated documents go here too. `python scripts/make_brief.py` writes `docs/pipeline_brief.pdf`.

## Where things run

| Dashboard | Start from the repo root | Address |
|---|---|---|
| Conductor (dashboard 1) | `python dashboards/conductor/server.py` | http://127.0.0.1:8790 |
| Vendor portal (dashboard 2) | `python dashboards/vendor_portal/server.py` | http://127.0.0.1:8791 |
