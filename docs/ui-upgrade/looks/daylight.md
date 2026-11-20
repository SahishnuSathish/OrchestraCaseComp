# Look C: Daylight

`/?look=c`. Files: `dashboards/conductor/assets/css/hub/looks/daylight.css`, `dashboards/conductor/assets/js/hub/looks/daylight.js`.
Screenshots: `docs/ui-upgrade/shots/looks/daylight/` (hub, staff picker, vendor step, code, handshake at 375 and 1440;
`hub-reduced@1440.jpg` under reduced motion).

## The idea

Morning light in the hall before the first rehearsal: five tall-window shafts fall across a pale sky-mint room, and the
Conductor mark is drawn at the size of the room, in light, with its staff running in from behind the sign-in card and
its sweep leaving the lowest line and swelling to the upper right.

## Why only Conductor could own it

- The gesture is the brand mark's own construction (BRAND.md): a staff, and one sweep that leaves the lowest line and
  swells as it rises to the upper right. At room scale it is a crescendo of light, not a picture of music.
- The staff is the signature staff rule exactly (five 1px lines, 4px apart), used once, at the start of the moment.
- The card sits where the score would be: the staff runs behind it and the sweep rises past its corner, so the sign-in
  reads as the downbeat. On the handshake the air warms and the sweep lifts: the day (and the workday) begins.
- Swap the product name and the mark-shaped gesture no longer fits. That is the template check.

## What it changes

- **Art** (`.hub-art`): a 172-degree air gradient (sky-mint at the windows to warm floor light), five CSS-gradient light
  shafts (soft across, fading along their length), two SVGs: the blurred bands (the main sweep and a fainter "downbeat"
  that dips under the card) and the crisp lines (the staff and a 1.5px ink line along the sweep, fading as it swells).
- **Brand column on light**: the green slab is gone. Lockup and family marks take their paper variants. The headline is
  Bricolage Grotesque at 54px (40 to 54 fluid), weight 500, width 96%, Orchestra green. The three proof points sit side
  by side as three beats of one bar with fine bar lines (from 1200px; a hairline list below). Copy is word for word.
- **Card**: pure white, the brightest thing on the screen, 20px radius, 12px controls, a layered green-ink shadow that
  falls down and to the right (the light comes from the upper left). Nothing inside it is tinted.
- **Provider window**: the same radius and shadow, a lighter scrim (ink 22%), white sticky group titles.
- **Handshake**: the card rises in (420 ms); behind it the air warms, the beams come to full strength and the sweep
  settles 14px higher over 0.9 to 1.2 s. Opacity and transform only.
- **Entrance (first load, 620 ms, done by 700)**: the light comes up (beams fade in), the bands swell in from 16px down
  and left, the ink line draws along the sweep, the card rises 12px, the brand column fades. One gesture, not a cascade.
- **Reduced motion**: no entrance, no parallax, no lift; the room is shown at its finished morning state (see
  `hub-reduced@1440.jpg`). Base.css collapses the remaining fades to a frame.
- **375 to 960px**: no staff and no crisp line (the stack scrolls and a printed line would cross the headline); only the
  air, the beams and the soft band rising to the top right, still. The card stays first and full width.

## Knobs

| Knob | Where | Effect |
|---|---|---|
| Air colours | `--dl-air-top/-mid/-low`, `--dl-air-warm` (css) | the room's tint; keep `--color-text-muted` >= 4.5:1 on the darkest |
| Light strength | `--dl-beam` alpha, `.dl-beams` opacity 0.82, `KNOBS.beams` (x, width, strength per shaft) | how present the window light is |
| The sweep | `KNOBS.swell` [start px, swell as fraction of width], `--dl-band-cool/-warm`, blur `stdDeviation` in `scene()` | the crescendo's width, warmth and softness |
| Staff and line | `KNOBS.staffAt` (height on the page), `--dl-staff-alpha`, `--dl-core-alpha` | where the gesture starts and how printed it reads |
| Motion | `KNOBS.parallax` (px), `--dl-enter` | pointer depth on desktop; first-load duration |

## Frame cost (measured in Playwright, headless Chromium, 1440x900)

- Per-frame JS (`tick()`, the only code that runs per frame), timed with `performance.now()` over 300 frames:
  **mean 0.03 to 0.05 ms, p95 0.10 ms, max 0.2 ms** at DPR 1 and 2. Drawing the art on mount or resize: 1 to 2 ms, once.
- While the pointer moves (parallax live), CDP metrics per frame: script 0.10 ms, style 0.12 ms, layout 0 (no layout,
  no layout shift). At rest there is **no animation at all**: idle frames run at 16.7 ms, the same as with no art.
- The rAF loop runs only while the layer catches up with the pointer, stops at rest, and is cancelled when the tab is
  hidden; it never runs under reduced motion, on touch or on narrow screens.
- Note: this container has no GPU. Moving one full-viewport layer under software compositing drops frames to ~30 ms
  while the pointer moves (main-thread cost stays ~0.25 ms). On a GPU this is a plain layer translate.

## Contrast

Measured on the rendered art (text hidden, darkest art pixel under each text run): worst **5.08:1** (the 12px muted
caption "Practice data, snapshot Nov 13, 2026") at 1440, 1280 and 1024; 10.8:1 at 768 and 375. Against the air stops:
text 13.1 to 13.9, secondary 6.4 to 6.9, muted 4.8 to 5.1, display green 10.8 to 11.5. The light only lightens.

## Decisions and what was rejected

- **A continuous drift of the beams (the sun moving) was built and removed.** It kept the compositor busy every frame;
  in this GPU-less container idle frames fell to 20 to 30 fps. The room now rests; only the pointer moves it.
- **Parallax on one layer, not two.** Moving the beams too doubled the composited area for little visible depth.
- **No staff or ink line on narrow screens**: they crossed the headline in the scrolling stack.
- **Status colours stay out of the card**: mint, sky and peach only appear as very large, very low-chroma air and
  white light; no chip-sized shape anywhere.
- **The `brand` skill** was not loaded separately: BRAND.md is the brand for this product and was followed directly.
- Rejected a frosted-glass panel behind the proof points (a trend, and a second box competing with the card).

## Proposed tokens (scoped in daylight.css under "proposed tokens")

`--dl-air-top #dbe8e6`, `--dl-air-mid #e8eee6`, `--dl-air-low #f2ebdf`, `--dl-air-warm #f8efe0`,
`--dl-beam rgb(255 250 238 / 0.72)`, `--dl-band-cool #f7fcf2`, `--dl-band-warm #fff5df`, `--dl-echo #eef6f3`,
`--dl-ink` (#223307 channels), `--dl-staff-alpha 0.2`, `--dl-core-alpha 0.34`, `--dl-enter 620ms`,
`--dl-card-radius 20px` (= `--radius-2xl`), `--dl-control-radius 12px` (= `--radius-lg`), `--dl-card-shadow`
(a layered green-ink shadow offset down-right), `--dl-hairline` (ink 9%). The art colours can stay local to the look.

## Known limits

- The art is fixed to the viewport and the layout scrolls on short or narrow screens, so the staff and sweep line up
  with the gutter only at the top of the page (by design they sit behind the card and in empty space at any scroll).
- `.hub-art` geometry assumes hub.css centres a card of at most 440px in the right column and this look's grid
  (`minmax(440px, 6fr) minmax(480px, 5fr)`); `columnWidth()` in the JS mirrors it. Change both together.
- Between 961 and 1199px the family list may sit below the fold on 768px-tall screens (as before).
- At 768px the card is centred while the headline is left-aligned (hub.css layout, kept).
