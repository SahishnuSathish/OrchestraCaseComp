# Brief: leadership (Tier 3)

Read `docs/ui-upgrade/briefs/_common.md` first; its rules apply. Then `DIRECTION.md` (apply the chosen look's language;
no new directions), `AUDIT.md`, `BRAND.md`, the tokens.css header and the style guide (`#/styleguide`, as Elena). Look at
how Tier 2 already treated the shell and the inbox (`docs/ui-upgrade/shots/after/tier2/`) so these pages match.
Worktree `/home/user/wt-leadership`, branch `ui/leadership`, smoke base **8826**, shots port **8846**.
Skills: `dataviz` if the Skill tool has it (charts, stat tiles, palette), `unslop` (lead: details pass on charts and
stat cards), `frontend-design`, `emil-design-eng`.

## The job
The pages leaders open: **Ahead, Escalations, Team, Overview, Prevent**, plus **Waiting on you** (approver), **Vendor
setup**, **Settings / Connections / Advanced**. Charts and KPI blocks get the "one bright element" treatment.
- **Ahead** (`#/ahead`): "Tell vendors before they ask." is the page's editorial moment; the "19 tickets prevented" hero
  is the bright element (the figure set large in tabular figures, the staff-rule signature, a single crescendo line
  drawn from *real* data only if the page has a series; otherwise no chart). The four stat cells below become quiet,
  varied, compact (unslop: no equal cards side by side; stat cards are numbers). Fix the radius mismatch the foundation
  noted (rounded stat group inside a square hero). The vendor-update and digest lists stay working surfaces.
- **Team** (`#/team`): one chart leads, the rest are smaller and different in kind. **The chart palette is separate
  from status colors and colorblind-safe** (today's bars are navy = "scheduled"; change that). KPI row: varied rhythm.
- **Escalations** (`#/escalations`): the empty right pane ("Choose a ticket") becomes a calm, designed empty state;
  the queue rows read cleanly; priority/legal chips calmer.
- **Approver** (`#/approver`), **Vendor setup**, **Settings/Connections/Advanced**: page header, tables and forms in the
  new system; no extra decoration.
- Keep every role/name/aria/`data-*` hook and visible text (stories 5, 6, 8, 10 and the sweep). JS edits only for
  presentation. Numbers come from the API: never invent figures.

## Files you own (edit nothing else)
`dashboards/conductor/assets/css/views/{ahead,escalations,team,approver,vendor-setup,connections,settings}.css`,
`css/components/leadership.css`, `js/views/{ahead,escalations,team,overview,prevent,approver,vendor-setup,connections,settings}.js`
(presentational edits only), `js/components/leadership/*.js` (presentational only), `docs/ui-upgrade/shots/leadership/`.
Not the shared empty/skeleton/notice components (`c-empty`, `c-skeleton`, `c-notice`: the states worker owns them);
use them.

## Done means
`gate.sh smoke 8826` → GATE GREEN; shots at 375 and 1440 of ahead, team, escalations, approver, vendor-setup, settings,
advanced in `docs/ui-upgrade/shots/leadership/`, looked at.
