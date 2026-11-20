# Brief: a landing look for the sign-in hub (Tier 1, step 3). One brief, three workers: A Score, B Instrument, C Daylight.

Read `docs/ui-upgrade/briefs/_common.md` first; its rules apply. Then `DIRECTION.md`, `AUDIT.md`, `BRAND.md`, the new
`assets/css/tokens.css` header (the foundation just landed: radius, elevation, decorative palette, motion, the
editorial face), and `css/hub/hub.css`, `js/hub/{hub,staff,vendor}.js`, `js/hub/looks/index.js`.
Skills: `frontend-design` (lead for you), `unslop` (the hero and visuals passes, `references/visuals.md`, `refs.md`),
`emil-design-eng` (the entrance), `brand`.

## The job
The sign-in hub (`/`) gets **three genuinely different background and branding directions**, selectable with
`?look=a|b|c`. You build **one** of them (your letter and name are at the end). The other two are being built in
parallel by others; never touch their files. They must be truly different, not recolors.

The loader (`js/hub/looks/index.js`, done) sets `<html data-look="<name>">`, loads `css/hub/looks/<name>.css`, imports
`js/hub/looks/<name>.js` and calls `mount(artEl, { reduced })`, where `artEl` is `<div class="hub-art" aria-hidden="true">`,
the first child of `<body>`, `position: fixed; inset: 0; z-index: 0`, outside `#hub-root`. It survives the handshake
(staff.js replaces `#hub-root`'s content with `.hub-handshake`), so your art carries the hand-off to `/app`.

Your look includes, all scoped to `html[data-look="<name>"]`:
1. **The full-page background art** (SVG/CSS/canvas you draw; inside `.hub-art`).
2. **The left/brand composition**: the lockup, the headline `.hub-value`, the proof points `.hub-proof`, the family
   `.hub-family` (restyle and re-place with CSS; the copy stays word for word). The editorial face may set the headline.
3. **The card treatment** (`.hub-card`, `.hub-choice`, buttons inside it, `.hub-link`, `.hub-help`, the code panel
   `.hub-code-*` and the simulated mailbox `.hub-inbox`) and the provider dialog (`dialog.hub-provider`) so it belongs
   to the look.
4. **The handshake** (`.hub-handshake`, `.hub-handshake-card`, `.hub-step*`): a short, graceful hand-off, never a
   spinner wall; the art stays behind it.
5. **A first-load entrance under 700 ms** (one choreographed fade/rise or a line drawing in; not everything flying in).
6. **The reduced-motion static version**: designed, not just frozen mid-animation.
7. **375 px**: the art degrades gracefully (simpler or static), never clipped awkwardly, never covering or competing
   with the sign-in form; the card stays first-class.

Constraints: the sign-in is the brightest, clearest thing on the screen; nothing competes with it ("one bright element").
Performance: CSS transform/opacity or SVG or **one** canvas: DPR capped at 2, paused on `visibilitychange` and under
reduced motion, no layout shift, < ~4 ms/frame (measure with `performance.now()` around your draw for a few hundred
frames in Playwright and note the number in your doc). Contrast: every text >= 4.5:1 on whatever is behind it (check
the worst spot of your art behind text). axe must stay clean (smoke test 11 runs axe on the hub and the picker).
Decorative colour must not look like a status chip colour next to the card.

You may NOT edit `hub.js`, `staff.js`, `vendor.js`, `hub.css`, `looks/index.js`, the html files, tokens.css. If you need
a markup hook (an extra wrapper or class), do not hack it: put it in your report and work around it in CSS. Your JS may
only draw inside `artEl` (and listen to resize/pointer/visibility); it must not move or restyle hub markup from JS.

## Files you own (edit nothing else)
`dashboards/conductor/assets/css/hub/looks/<name>.css`, `dashboards/conductor/assets/js/hub/looks/<name>.js`,
`docs/ui-upgrade/looks/<name>.md`, `docs/ui-upgrade/shots/looks/<name>/`.

## Done means
- The smoke suite opens the hub with the DEFAULT look, which may not be yours. To gate yours: temporarily set
  `DEFAULT = '<your letter>'` in `js/hub/looks/index.js`, run `gate.sh smoke <your base>` until GATE GREEN, then
  `git checkout -- dashboards/conductor/assets/js/hub/looks/index.js` (never commit that file). The orchestrator re-runs
  the suite with each look as the default before merging.
- Screenshots in `docs/ui-upgrade/shots/looks/<name>/`: `node docs/ui-upgrade/tools/shots.mjs
  docs/ui-upgrade/shots/looks/<name> --widths 375,1440 --port <your shots port> --look <letter> --only '^hub'`
  (gives hub, staff picker = the staff step, vendor = the vendor step, code, handshake). Look at every one.
  Also one reduced-motion shot at 1440 (a tiny Playwright script outside the repo with `reducedMotion: 'reduce'`),
  saved as `hub-reduced@1440.jpg`.
- `docs/ui-upgrade/looks/<name>.md`: the idea in one sentence; what makes it ownable (why it could only be Conductor);
  how to tune it (the 3-5 knobs, with the variables/constants that control them); measured frame cost; known limits.
