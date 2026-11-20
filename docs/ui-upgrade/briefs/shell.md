# Brief: shell (Tier 2)

Read `docs/ui-upgrade/briefs/_common.md` first; its rules apply. Then `DIRECTION.md` (the decision on the landing look is
at the end: apply *its* language, no new directions), `AUDIT.md`, `BRAND.md`, the `assets/css/tokens.css` header and the
style guide (`#/styleguide`). Worktree `/home/user/wt-shell`, branch `ui/shell`, smoke base **8820**, shots port **8840**.
Skills: `unslop` (lead: quiet chrome), `emil-design-eng` (transitions, press feedback), `frontend-design`.

## The job
The chrome around every staff and vendor page. Quiet, precise, unmistakably Conductor.
- **Staff top bar** (`.c-topbar`): green chrome with depth (a 2-stop tone shift within the green, a hairline, maybe a
  barely visible staff-line texture), the search field, the connection pills (Zendesk / Outlook / NetSuite: keep their
  live meaning), bell, the avatar/menu.
- **The rail** and its active state, the **open-tickets tab strip**, the **page headers** (title, lede, "Data as of").
- **Toasts** (`.c-toast`, in core.css and overlays.js) and **menus/avatar menu**: crisp, layered, short motion.
- **The hub-to-app hand-off**: when `/app` first paints after sign-in, a short graceful arrival (the shell fades/rises
  in under ~400 ms, the content after it), never a spinner wall; skeletons stay as they are (the states worker owns them).
  Check the handshake end (hub) and the `/app` first paint together so it feels like one motion.
- **The Direct shell** (`.c-direct-*`, `js/components/direct-shell.js`): today two heavy navy bands. Make it lighter and
  friendlier while keeping navy as Direct's identity (e.g. a single navy bar with a lighter tab row on paper, or navy
  only in the brand area). The vendor side should feel the friendliest of all.
- Bottom bar under 768 px (the rail becomes a bottom bar): make it feel native.
- Keep every role/name/aria/`data-*` hook and every visible text. `shell.js` / `direct-shell.js` changes only for
  presentation (wrappers, classes, decorative SVG).

## Files you own (edit nothing else)
`dashboards/conductor/assets/css/components/shell.css`, `css/components/direct-shell.css`, `js/shell.js`
(presentational edits only), `js/components/direct-shell.js` (presentational only), `js/components/overlays.js`
(presentational only), the toast, menu and avatar sections of `css/components/core.css` (nothing else in that file),
`css/components/leadership.css` **page-head section only** (`.lv-page-head`, `.lv-eyebrow`, title/lede/as-of rules) if
page headers are styled there, `docs/ui-upgrade/shots/shell/`.

## Done means
`gate.sh smoke 8820` → GATE GREEN; shots at 375 and 1440 of inbox, ahead, team, approver, direct-invoices,
direct-messages, hub-handshake (`--only`) in `docs/ui-upgrade/shots/shell/`, looked at.
