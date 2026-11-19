# Browser smoke suite

Playwright drives the three Conductor entry points: the sign-in hub (`/`), the staff workspace (`/app`) and the vendor
dashboard (`/direct`). It covers the demo stories: hub sign-in, Ulla's morning, sign-off across two browsers, fraud,
the approver, Ahead, the vendor dashboard, W-9, live arrivals, Advanced, and a layout/console/wording sweep of every
page at 375, 768, 1280 and 1440 px.

## Run

```
npm install --no-save --no-audit --no-fund playwright     # once
node tests/ui/smoke.mjs                                    # everything, about 2 minutes
node tests/ui/smoke.mjs "^3 "                              # only tests whose name matches the regex
UI_SHOTS=1 node tests/ui/smoke.mjs "^2 "                   # also save a screenshot of every page of a failing test
                                                           # to <temp>/conductor-ui-failures
```

Needs Node 22+, Python 3 with the app's requirements (the suite looks for `CONDUCTOR_PYTHON`, then `python3`, `python`,
`py`) and a Chromium that Playwright can launch (`npx playwright install chromium` if it cannot). Without the
`playwright` package the script prints `skipped: ...` and exits 0.

## What it does to your machine

- Starts Conductor on **8808** (all stories) and **8809** (the background-arrival story), each with `CONDUCTOR_STATE_DIR`
  in a fresh folder under the OS temp directory. Both are stopped and the folders removed at the end, also on Ctrl+C.
- The main server's arrivals are set to one an hour (seeded into the new state DB), so "Sync now" is predictable.
- Mail uses the default outbox mode: `.eml` files in the temp state dir. Nothing is ever sent, nothing is written to the
  repo. The last test checks `git status` for `dashboards/conductor/state` and `out`.
- Setup (picking a ticket, API sign-in, cross-checks of 401/403) uses the API. Every story itself is driven through the UI.

## Files

- `smoke.mjs`: the stories and `main()`.
- `harness.mjs`: servers, sign-in, the `test()` runner, layout/accessibility/wording checks.

## Known failures

A test can carry `{ known: '<the product bug>' }`. When it fails it prints `KNOWN` instead of `FAIL` and does not fail the
run; when it passes it prints a note so the flag can be removed. Exit code is 1 only for failures that are not known.
