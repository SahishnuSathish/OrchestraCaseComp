# Brief: states (Tier 3)

Read `docs/ui-upgrade/briefs/_common.md` first; its rules apply. Then `DIRECTION.md`, `AUDIT.md`, `BRAND.md`, the
tokens.css header and the style guide (`#/styleguide`, as Elena), and `docs/ui-upgrade/shots/after/tier2/`.
Worktree `/home/user/wt-states`, branch `ui/states`, smoke base **8828**, shots port **8848**.
Skills: `unslop` (lead), `emil-design-eng`, `frontend-design`, `brand`.

## The job
Where "less dead" lives: **small, branded, never cute.**
- **Empty states** (`empty()` in `js/components/data.js`, `.c-empty` in core.css): a small drawn mark from the brand
  language (e.g. a few staff lines with one rest, or the sweep at rest) instead of an icon in a square; title in the
  display face, text quiet. One component, used everywhere it already is.
- **Loading**: skeletons (`skeleton*()` in data.js, `.c-skeleton*`) that match the final layout (rows with avatar +
  two lines for lists, text blocks for panes). Replace the breathing animation with a calm, slow single shimmer or a
  still state; nothing loops fast; reduced motion: static. "Conductor is reading…" (`reading()`) gets a tiny, quiet
  staff-line motif.
- **Notices** (`notice()`, `.c-notice`): success / info / waiting / risk, consistent with the new badges.
- **404** (`js/views/not-found.js`, route `#/no-such-page`): branded, helpful, one action back.
- **Not signed in / session ended / no access**: find where these render (a 401 sends the browser back to the hub via
  `js/http.js`, and role guards in `js/shell.js` show a "no access" message, e.g. "Only the CFO can open Advanced.");
  style what exists, do not change the flow or the wording.
- **Direct boot** (`.dx-boot*` in `css/direct/direct.css`, `direct.html`): a branded first paint instead of a bare bar.

## Files you own (edit nothing else)
`dashboards/conductor/assets/js/components/data.js` (presentational: the skeleton/empty/reading/notice helpers' markup
only; `table`, `stat`, `timeline` signatures and behavior unchanged), the skeleton, empty-state, reading and notice
sections of `css/components/core.css` (nothing else there), `js/views/not-found.js`, the `.dx-boot*` rules in
`css/direct/direct.css` and the boot markup in `direct.html`, the no-access/guard *styling* hooks in `js/shell.js`
(class names only), `docs/ui-upgrade/shots/states/`.

## Done means
`gate.sh smoke 8828` → GATE GREEN; shots of not-found, escalations (its empty pane), direct-messages (an empty list),
and a loading state (a Playwright script outside the repo that delays `/api/inbox/threads` by 2 s with `page.route` and
shoots the inbox skeleton) at 375 and 1440, in `docs/ui-upgrade/shots/states/`, looked at.
