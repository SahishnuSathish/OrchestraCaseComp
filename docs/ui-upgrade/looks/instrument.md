# Look B: Instrument

`/?look=b`. Files: `dashboards/conductor/assets/css/hub/looks/instrument.css`, `dashboards/conductor/assets/js/hub/looks/instrument.js`.
Screenshots: `docs/ui-upgrade/shots/looks/instrument/` (hub, staff picker, vendor, code, handshake at 375 and 1440, plus
`hub-reduced@1440.jpg`).

## The idea in one sentence

The Conductor mark rebuilt as a precision instrument on a deep ink-green stage: its staff bent into a dial's bezel,
tempo ticks around it, and its sweep turned into the one slow hand, with the sign-in card as the instrument's face.

## Why it could only be Conductor

- The bezel is the **staff rule** (five 1px lines on a 5px pitch), the product's signature, bent into a circle.
- The **hand is the mark's sweep**: 1px at the pivot, swelling to 3.2px at the tip (the mark's 1.6 to 4.6 crescendo),
  in pale brass, the one decorative highlight. It is the only solid thing on the stage, as the sweep is in the mark.
- The **ticks are rhythm, not a clock**: 128 = 8 bars x 4 beats x 4 sixteenths. Sixteenths cross the staff, beats
  reach past it, bars reach furthest. The beats the hand has just passed light up in brass and stand up a little,
  then settle: the score being read, not seconds being counted.
- The dial is centred on the sign-in card, so everything on the stage points at the one bright thing. In the handshake
  the dial glides to the hand-off card and the hand quickens (an accelerando into `/app`).
- Swap the product name and the staff-bezel, the swelling hand and the bar/beat count no longer mean anything.

No numbers, labels or readouts are drawn in the art. The only "readout" is text already on the page: the practice-data
snapshot date, set in Geist Mono.

## What the look includes

1. **Art** (one canvas): stage tone shift (CSS radial from `--p-green-950` to `--deco-hall`, same hue), three faint
   outer rings, the inner track (ring + 64 short ticks, mostly behind the card), the staff bezel with 128 tempo ticks,
   the hand with its lit beat trail. Pointer (fine pointers only): ticks near the pointer lengthen and brighten (a
   loupe, eased over ~240 ms), and the dial drifts up to 5px against the pointer.
2. **Brand column, an instrument's legend**: no green slab; the headline in Bricolage Grotesque at weight 300,
   `font-stretch: 84%` (light condensed, like dial lettering; deliberately not Instrument Serif, so look B does not read
   like the paper/editorial looks), proof points on a scale (one vertical hairline, an index tick per point), the
   snapshot line as a mono readout, the family list under a faint hairline.
3. **Card**: bright paper panel (`--color-surface`), 14px radius, no border, a layered near-black-green shadow that reads
   darker than the stage. The provider dialog and the simulated mailbox float with the same shadow; the dialog
   backdrop is the same near-black green at 60%.
4. **Handshake**: transparent over the stage, the card arrives (opacity + 8px rise + 0.985 scale, 480 ms emphasized
   ease); the dial and the stage light glide to the screen centre in 700 ms and the hand runs 4x faster.
5. **Entrance (< 700 ms)**: the hand makes one fast turn from twelve o'clock and draws the dial in behind it (660 ms,
   ease-out quart), the card column rises 14px and fades in (480 ms after 120 ms = 600 ms), the legend fades (420 ms
   after 60 ms). Nothing else moves.
6. **Reduced motion**: one designed still frame: the whole dial, the hand standing just above nine o'clock where most
   of it shows beside the card, the beats behind it lit. No entrance, no loop, no pointer response, no CSS animations.
7. **Narrow (stacked layout, <= 960px)**: a quarter of the dial rises from the top-right corner behind the header,
   with no hand and no trail, drawn once (static after the 660 ms draw-in). The card stays first-class. The handshake
   on a phone centres a larger dial that shows above and below the card.

## How to tune it (the knobs)

| Knob | Where | Default |
|---|---|---|
| Hand speed (calm vs alive) | `TUNE.turnSeconds` in instrument.js | 64 s per turn |
| Trail length / brightness of the lit beats | `TUNE.trail`, the brass alpha in the lit-ticks loop | 0.62 rad |
| Pointer response | `TUNE.lens` (loupe, 0 = off), `TUNE.parallax` (px) | 1, 5 |
| Entrance and hand-off | `TUNE.entranceMs`, `TUNE.handshakeTempo`, CSS `instr-rise` / `instr-arrive` | 660 ms, 4x |
| Line strength on phones | `TUNE.narrowAlpha`, `TUNE.narrowCap` | 0.7, cap 0.2 |
| Stage tone and card lift | CSS `--instr-stage`, `--instr-stage-lift`, `--instr-card-shadow` | hall ink, green-950 |
| Headline voice | `.hub-value` weight / `font-stretch` in instrument.css | 300 / 84% |

Line alphas per element (rings 0.04-0.09, staff 0.2, sixteenths 0.15, beats 0.3, bars 0.42) are inline in `draw()`.

## Measured frame cost

Playwright, headless Chromium, every `requestAnimationFrame` callback timed with `performance.now()` for ~360 frames
(6 s, pointer moving across the dial for the first 2.4 s so the loupe and parallax are included):

| Viewport | DPR | avg | p50 | p95 | max |
|---|---|---|---|---|---|
| 1440x900 | 2 | 0.27 ms | 0.30 | 0.40 | 0.70 |
| 1280x800 | 1 | 0.38 ms | 0.30 | 0.60 | 5.6 (one outlier, first frames) |
| 1920x1080 | 2 | 0.26 ms | 0.20 | 0.40 | 2.4 |

Mean frame interval 16.7 ms (60 fps held). Zero rAF callbacks while the tab reports hidden. Under reduced motion and on
the stacked layout the loop stops after one frame (or after the 660 ms draw-in). The draw is about 20 batched strokes
plus up to ~40 single strokes for lit ticks; raster/composite cost of the full-viewport canvas is not in these numbers.

## Contrast (worst spots)

Lines are mint (`--p-mint`) at the alpha above, over the stage (`#10170a` to `#182404`). White text over a line at 0.2
on the lighter stage: 8.7:1; muted text (`--color-chrome-text-muted`) over 0.2: 4.9:1. On the wide layout the brand
column only ever has the outer rings (<= 0.07) behind it (muted >= 7.5:1); the bezel, ticks, trail and hand are kept
inside the sign-in column by `geometry()` (radius bound to the brand column's text edge). On the stacked layout, where
text scrolls over the fixed art, no line is stronger than 0.2 and there is no brass. axe: hub and picker 0 violations.

## Decisions and known limits

- **The dial's centre mirrors hub.css's grid** (`minmax(420px, 5fr) | 7fr`, card centred in its column). If that grid
  changes, update `geometry()`. A CSS custom property for the card's centre (or a class on the column) would remove the
  mirroring; the brief forbids markup changes, so this is a request, not a change.
- The module **reads** `#hub-root` with a MutationObserver (childList only) to know when the handshake replaced the
  card, and CSS uses `:has(.hub-handshake)` to move the stage light. It never writes to hub markup.
- On short screens where the card is taller than the viewport, the card scrolls and the dial (fixed) stays centred on
  the viewport, so they part company until scrolled back.
- On phones the bezel passes behind the right end of the headline; lines are capped at 0.2 there (white text >= 8.7:1).
- `.hub-help` gained a hairline above it inside the card (closes the card like a dial's footer); no copy changed.
- Proposed tokens (in instrument.css, scoped to the look): `--instr-stage`, `--instr-stage-lift`, `--instr-line`,
  `--instr-index`, `--instr-shadow-rgb` (`3 6 1`, a near-black green: the shadow scale's `--p-shadow-rgb` is almost the
  stage colour, so shadows on the stage were invisible), `--instr-card-shadow`, and the registered
  `--instr-dial-x/--instr-dial-y`.
- Rejected: a metronome pendulum (reads as an object, near clip-art); a radar-style sweep wedge ("hacker"); numerals or
  bar numbers on the bezel (invented figures); Instrument Serif for the headline (the other looks are likelier to use
  it, and a light condensed grotesque reads more like an instrument); a backdrop blur under the dialog (it would
  re-blur the live canvas every frame).
