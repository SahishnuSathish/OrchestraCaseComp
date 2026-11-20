# Look C: Daylight

`/?look=c`. Files: `dashboards/conductor/assets/css/hub/looks/daylight.css`, `dashboards/conductor/assets/js/hub/looks/daylight.js`.
Screenshots: `docs/ui-upgrade/shots/looks/daylight/` (hub, staff picker, vendor step, code, handshake at 375 and 1440;
`hub-reduced@1440.jpg` under reduced motion).

## The idea

Morning light in the hall before the first rehearsal: five tall-window shafts fall across a pale sky-mint room, and the
Conductor mark is drawn at the size of the room: a five-line staff laid across the empty band under the headline, and
one sweep that leaves its lowest line and swells, green into sunlit brass, up the gutter beside the sign-in card.

## Why only Conductor could own it

- The gesture is the brand mark's own construction (BRAND.md): a staff, and one sweep that leaves the lowest line and
  swells as it rises to the upper right. At room scale it is a crescendo of light, not a picture of music.
- The staff is the signature staff rule opened up for room scale (five 1px lines, 6px apart instead of 4), opened by a
  bar line at the text margin, used once, at the start of the moment.
- The card sits on the score: the staff runs on behind it, and the sweep rises past its corner, so the sign-in reads as
  the downbeat. On the handshake the same staff and sweep sit settled behind the centred card.
- Swap the product name and the mark-shaped gesture no longer fits. That is the template check.

## What it changes

- **Art** (`.hub-art`): a 172-degree air gradient (sky-mint at the windows to warm floor light), five CSS-gradient light
  shafts (soft across, fading along their length), and per state two SVGs: a soft daylight halo around the sweep
  (blurred once) and the crisp motif (staff, bar line, and the sweep as a solid tapered shape, green ink at 50% into
  brass at 62%, the way the mark's sweep is the one solid thing).
- **Placement** (refinement round 1): the JS reads where the headline's text ends, where the proof points start and
  where the card's left edge is, and draws the staff in the band between headline and proof points (`.hub-proof` has
  104px top padding to keep that band) and the sweep only to the right of the headline's last character, running off
  the top edge. On wide screens `.hub-art` is `position: absolute` with `body` relative (my CSS), so the art scrolls
  with the page and never ends up behind text. It never writes to hub markup.
- **Brand column on light**: the green slab is gone. Lockup and family marks take their paper variants. The headline is
  Bricolage Grotesque at 54px (40 to 54 fluid), weight 500, width 96%, Orchestra green. The three proof points sit side
  by side as three beats of one bar with fine bar lines (from 1200px; a hairline list below). Copy is word for word.
- **Card**: pure white, the brightest thing on the screen, 20px radius, 12px controls, a layered green-ink shadow that
  falls down and to the right (the light comes from the upper left). Nothing inside it is tinted.
- **Family list**: a footnote to the proof points: 12px, secondary and muted, 16px marks; the pale Ahead mark gets a
  firmer edge (`.c-mark-edge` in Orchestra green at 62%; BRAND.md has 30%, too faint on this page).
- **Provider window**: the same radius and shadow, white sticky group titles, and a scrim of green ink at 58% with
  `backdrop-filter: saturate(0.7)`, so the page behind recedes. The parallax does not run while a dialog is open.
- **Handshake**: the card rises in (420 ms); behind it the hub motif crossfades (700 ms, opacity on composited layers)
  to the settled one: the staff across the lower middle of the room (below the card on phones) with a bar line at the
  left, and the sweep rising from it behind the card to the upper right. Beams come to full strength.
- **Entrance (first load, 620 ms, done by 700)**: the light comes up (beams fade in), the staff and sweep are laid in
  from left to right (a clip reveal), the halo swells in, the card rises 12px, the brand column fades.
- **Reduced motion**: no entrance, no parallax; the state change is instant. The room is shown finished
  (`hub-reduced@1440.jpg`).
- **375 to 960px**: the hub is light only (air, beams and a soft band, still): the stack scrolls and leaves no band
  free of text for a printed staff. The handshake shows the full motif at every width.

## Knobs

| Knob | Where | Effect |
|---|---|---|
| Air colours | `--dl-air-top/-mid/-low` (css) | the room's tint; keep `--color-text-muted` >= 4.5:1 on the darkest |
| Light strength | `--dl-beam` alpha, `.dl-beams` opacity 0.82, `KNOBS.beams` (x, width, strength per shaft) | how present the window light is |
| The sweep | `KNOBS.swellMax`, `KNOBS.halo`, `--dl-sweep-from/-to`, `--dl-halo` | the crescendo's width, strength, colour and its daylight |
| The staff | `KNOBS.staffGap`, `--dl-staff-alpha`, `.hub-proof` padding-top (the band it lives in) | how printed and how open the staff reads |
| Motion | `KNOBS.parallax` (px), `--dl-enter` | pointer depth on desktop; first-load duration |

## Frame cost (measured in Playwright, headless Chromium, 1440x900)

- Per-frame JS (`tick()`, the only code that runs per frame), timed with `performance.now()` over 300 frames:
  **mean 0.04 to 0.05 ms, p95 0.10 ms, max 0.2 to 2.1 ms** at DPR 1 and 2. Measuring the layout and drawing both states
  on mount or resize: 3 to 4 ms, once.
- While the pointer moves (parallax live), CDP metrics per frame: script 0.10 ms, style 0.12 ms, layout 0 (no layout,
  no layout shift). At rest there is **no animation at all**: idle frames run at 16.7 ms, the same as with no art.
- The rAF loop runs only while the layer catches up with the pointer, stops at rest, and is cancelled when the tab is
  hidden; it never runs under reduced motion, on touch or on narrow screens.
- Note: this container has no GPU. Moving one full-viewport layer under software compositing drops frames to ~30 ms
  while the pointer moves (main-thread cost stays ~0.25 ms). On a GPU this is a plain layer translate.

## Contrast

Measured on the rendered art (text hidden, darkest art pixel under each text run): worst **5.06:1** (a 12px muted
caption "Practice data, snapshot Nov 13, 2026") at 1440, 1280 and 1024; 10.8:1 at 768 and 375. Against the air stops:
text 13.1 to 13.9, secondary 6.4 to 6.9, muted 4.8 to 5.1, display green 10.8 to 11.5. The light only lightens.

## Decisions and what was rejected

- **Round 1 (reviewer):** the thin arc diving behind the card and the staff stubs read as stray render lines; replaced by
  the layout-anchored staff and solid sweep. The handshake was washed out (the warm-air fade); the warm fade is gone and
  the settled motif carries it. The scrim went from 22% to 58% with desaturation.
- **A continuous drift of the beams (the sun moving) was built and removed.** It kept the compositor busy every frame;
  in this GPU-less container idle frames fell to 20 to 30 fps. The room now rests; only the pointer moves it.
- **Parallax on one layer, not two.** Moving the beams too doubled the composited area for little visible depth.
- **No staff or ink line on narrow screens**: they crossed the headline in the scrolling stack.
- **Status colours stay out of the card**: mint, sky and peach only appear as very large, very low-chroma air and
  white light; no chip-sized shape anywhere.
- **The `brand` skill** was not loaded separately: BRAND.md is the brand for this product and was followed directly.
- Rejected a frosted-glass panel behind the proof points (a trend, and a second box competing with the card).

## Proposed tokens (scoped in daylight.css under "proposed tokens")

`--dl-air-top #dbe8e6`, `--dl-air-mid #e8eee6`, `--dl-air-low #f2ebdf`, `--dl-beam rgb(255 250 238 / 0.72)`,
`--dl-halo #fff8e6`, `--dl-ink` (#223307 channels), `--dl-staff-alpha 0.3`, `--dl-sweep-from` (green ink 50%),
`--dl-sweep-to` (brass-400 62%), `--dl-scrim` (ink 58%), `--dl-enter 620ms`,
`--dl-card-radius 20px` (= `--radius-2xl`), `--dl-control-radius 12px` (= `--radius-lg`), `--dl-card-shadow`
(a layered green-ink shadow offset down-right), `--dl-hairline` (ink 9%). The art colours can stay local to the look.

## Known limits

- The motif reads `.hub-value`, `.hub-proof-list` and `.hub-signin-inner` positions; renaming those classes in hub.js
  turns the wide-screen motif off (the light stays). It redraws on resize and once fonts are ready, not on other
  reflows; nothing in the hub reflows those three after load.
- The handshake geometry assumes hub.css centres a card of at most 460px.
- Between 961 and 1199px the family list may sit below the fold on 768px-tall screens (as before).
- At 768px the card is centred while the headline is left-aligned (hub.css layout, kept).
