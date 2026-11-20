# Brief: motion (Tier 4)

Read `docs/ui-upgrade/briefs/_common.md` first; its rules apply. Then the tokens.css header (motion section), the style
guide's motion section, and `docs/ui-upgrade/DIRECTION.md`.
Worktree `/home/user/wt-motion`, branch `ui/motion`, smoke base **8810**, shots port **8830**.
Skills: `emil-design-eng` (lead), `unslop` (motion pass), `frontend-design`.

## The job
Micro-interactions that make the app feel alive without ever looping on a working screen.
- Button press scale (already in core: verify everywhere), hover lifts only on cards that open something (1-2 px, with
  `--shadow-raised`), row selection (the selected row's background/indicator transitions in 120-160 ms), list reorder
  / new arrivals (a new inbox row fades and slides in a few px; no layout animation), focus transitions (the ring
  appears without delay; color transitions only).
- **Count-ups** for the hero numbers once on arrival (Ahead's prevented count, the "While you were away" figures, Team
  KPI figures): a small presentational helper (e.g. `js/components/motion.js` exporting `countUp(el)`) that animates
  the *displayed* text from 0 to the final value in ≤ 600 ms once, keeps the final text in the DOM for screen readers
  and tests from the start (`aria-label` or an sr-only copy), and does nothing under reduced motion. Tests read these
  numbers: the final text must be exact and present immediately for assistive tech; check the smoke suite still passes.
- **A single shared motion spec** in the style guide (durations, easings, what moves and what never moves).
- **A global kill-switch for reduced motion**: one place (base.css plus a tiny JS check, e.g. `html.reduce-motion`)
  that every animation in the app honors, including the hub looks' canvas/SVG and the count-ups.
- Audit every `transition` and `animation` in the CSS: no `transition: all`, nothing animating width/height/top/left,
  nothing looping on inbox/review/tables (the live "Live" dot pulse, if any, may stay only if it really means live).

## Files you own
New `js/components/motion.js` and `css/components/motion.css` (import it from components.css), `css/base.css` motion
section, presentational one-line hooks to call `countUp` in `js/views/ahead.js`, `js/views/team.js`, `js/views/inbox.js`
(the away card) — nothing else in those files — the motion section of `js/views/styleguide.js`, and transition/animation
declarations anywhere in `dashboards/conductor/assets/css/**` (only those properties). `docs/ui-upgrade/shots/motion/`.

## Done means
`gate.sh smoke 8810` → GATE GREEN; a short note in your report listing every animation in the app with its duration
and what it responds to.
