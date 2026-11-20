# Brief: foundation (Tier 1, step 1)

Read `docs/ui-upgrade/briefs/_common.md` first; its rules apply. Worktree: `/home/user/wt-foundation`, branch
`ui/foundation`. Smoke port base **8810**, shots port **8830**. Skills: `design-system` (lead for you), `unslop`
(signs.md, tokens.md), `frontend-design`, `emil-design-eng` (easings), `ui-ux-pro-max` (advisory: palettes, pairings).

## Your job
Evolve the design system so the whole app reads as the direction in `docs/ui-upgrade/DIRECTION.md`, while every view
keeps working. This is the base every other worker builds on, so make it complete, coherent and documented.

1. **Rewrite `assets/css/tokens.css`** (three layers: primitive → semantic → component; extend, do not fork). Rewrite its
   header comment to state the new rules (the old "square, hairlines only, color for status only" rule is lifted).
   - **Neutrals tinted toward the world**: a warm green-grey paper ramp replaces pure greys (canvas, surfaces, borders,
     three text roles). Re-measure contrast for every text pair and write the ratio beside it, as today.
   - **Richer green / ink ranges** around Orchestra green `#223307` (keep that exact value as the anchor and the primary
     action). Keep mint/navy/peach/crimson recognisable.
   - **Status tokens keep their meaning** (green = settled, navy = scheduled, peach = waiting, crimson = risk). You may
     refine their shades if contrast holds.
   - **A decorative palette** (`--deco-*`): e.g. a pale brass, a deep "hall" ink, soft mint/sky/peach light washes for art.
     Document that decorative color is only for art and moments and never on the same element type as a status chip, and
     that it must not be confusable with a status color on the same screen.
   - **Radius scale** (`--radius-xs/sm/md/lg/xl` + semantic `--radius-control`, `--radius-card`, `--radius-panel`,
     `--radius-pill`). Decide what tiles flush (the inbox panes, the rail, the top bar should stay square or nearly so)
     versus what floats (cards, modals, menus, toasts, landing card). Keep `--radius-surface` working for old users.
   - **Elevation scale**: 3-4 soft, layered, neutral (green-ink tinted) shadows `--shadow-1..4` + semantic
     (`--shadow-card`, `--shadow-raised`, `--shadow-float`, `--shadow-modal`).
   - **Type**: a deliberate scale (add the missing in-between steps), the pairing Geist (UI) + Geist Mono (figures, IDs) +
     Bricolage Grotesque (headings) + **Instrument Serif** for one editorial moment per screen (`--font-editorial` and a
     `.editorial` utility). Letter-spacing tokens for display sizes. Weights 400/500/600.
   - **Spacing rhythm** on the 4px grid (keep the existing `--s-*` names).
   - **Motion tokens**: durations (`--dur-instant` 90, fast 120, base 160, slow 240, enter 320-480 for page entrances),
     easings (`--ease-out` one strong ease-out, `--ease-in-out`, `--ease-emphasized`), and a reduced-motion strategy.
   - **Focus ring** tokens (a 2px ring with offset that works on paper, green and navy) and `--focus-ring-on-dark`.
   - **Component tokens** for button, input, badge, card, table row, top bar, rail, modal, menu, toast, skeleton.
   - **Keep every legacy name** at the end of the file working (`--bg`, `--surface`, `--r-md`, ...): the old vendor portal
     (`dashboards/vendor_portal/page.py`) and older views use them. Repoint them to the new semantics.
2. **Base and components**: `dashboards/conductor/assets/css/base.css`, `css/components.css`, `css/components/core.css`
   (buttons with press feedback, inputs, badges, cards/panels with the new radius and elevation, tables, modals, menus,
   toasts, skeletons, tabs, segmented controls). Hover/press/focus states per `emil-design-eng`: e.g. buttons
   `transform: scale(0.97)` on `:active`, colour transitions named (never `transition: all`), 120-160 ms, one ease-out.
   **Do not touch** the "marks and lockups" section of core.css (the brand worker overrides it in a new
   `css/components/brand.css`, already imported after core.css).
   Badges: keep icon + words; they may become softer (radius, tinted fills, hairline). Status chips must stay calmer
   than now in long columns (AUDIT: a column of identical sky chips is loud).
3. **The style guide** (`js/views/styleguide.js`, `css/views/styleguide.css`, `css/components/styleguide.css`, route
   `#/styleguide`): make it the visual spec of the new system: palette (primitive + semantic + decorative, with
   contrast), type scale and the editorial moment, radius, elevation, motion (durations, easings, a press demo), focus,
   components, status chips, and the staff-rule signature (a CSS utility `.c-staff-rule`: five 1px lines 4px apart,
   decorative, `aria-hidden`; only used to mark a moment).
4. A short section in the tokens.css header (or a comment block) explaining how later workers should use these.

## Files you own (edit nothing else)
`assets/css/tokens.css`, `assets/css/fonts.css` (keep every existing @font-face rule: a Python test checks them),
`dashboards/conductor/assets/css/base.css`, `css/components.css`, `css/components/core.css` (minus marks/lockups),
`css/components/styleguide.css`, `css/views/styleguide.css`, `js/views/styleguide.js`,
`docs/ui-upgrade/shots/foundation/` (new).

## Out of scope (others will do these next)
The shell (`shell.css`, `shell.js`), hub, Direct, workspace and leadership view CSS. Your token changes will flow into
them automatically; check they still look right (and fix only through tokens / core components), but do not restyle them.

## Done means
- `gate.sh smoke 8810` → GATE GREEN (axe clean on all 13 pages).
- Screenshots at 375 and 1440 of: styleguide, hub, inbox, inbox-ticket, ahead, team, direct-invoices, saved to
  `docs/ui-upgrade/shots/foundation/` and looked at by you. The app must look at least as good as before everywhere
  (nothing broken by the new radius/shadow/neutral tokens) and the style guide must look like a spec a design lead
  would sign.
