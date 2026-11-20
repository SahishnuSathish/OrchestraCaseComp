# Look A: Score

**The idea in one sentence.** The sign-in page is a printed score on warm paper: faint staves run across it, and one
line leaves a staff line at the left, quietly, then swells like a crescendo into a ribbon of fine engraved strokes that
opens toward the sign-in card and runs under it, a crisp white sheet lying on the score.

Files: `dashboards/conductor/assets/css/hub/looks/score.css`, `dashboards/conductor/assets/js/hub/looks/score.js`.
Screenshots: `docs/ui-upgrade/shots/looks/score/` (hub, picker, vendor, code, handshake at 375 and 1440; `hub@1920.jpg`;
`hub-reduced@1440.jpg`).

## Why it could only be Conductor

- The ribbon is the **Conductor mark drawn at page scale**: the mark is three staff lines and one sweep that leaves the
  lowest of them and swells as it rises. Here the line starts on a real staff line (the middle line of the staff that
  sits in the band under the headline), swells and climbs to the upper right. It is the brand's own construction.
- **The layout is set on the score.** Bar lines fall on the layout's own edges: the text column's left edge and both
  edges of the sign-in card. Staves step aside (a soft clearing) wherever there is copy, the way a printed page leaves
  room for text, so no line runs through words.
- A **crescendo**, not a decoration: quiet at the left (one hairline fading in from nothing), loud where the person acts.
  The page reads from the promise to the card.
- On the **handshake**, the line draws again, now toward the centred card, so the hand-off to /app keeps the same paper,
  the same staves and the same gesture. The card is the only thing that changes.

Everything else is quiet: the Instrument Serif headline is the one editorial moment, proof points and the family sit on
hairlines in the normal ink ramp, the card uses only existing component tokens.

## Tuning knobs

| Knob | Where | Default | Effect |
|---|---|---|---|
| Ribbon swell | `KNOBS.swellMax` in `score.js` | `0.09` | half-height of the ribbon at the right edge, as a share of page width |
| Ribbon climb | `KNOBS.rise` | `0.2` | how far the line climbs from left to right, as a share of the viewport height |
| Strokes | `KNOBS.strokes` | `15` | engraved lines in the ribbon (fewer is quieter) |
| Waveform | `KNOBS.wave` | `0.16` | ripple amplitude, as a share of the ribbon's half-height |
| Staves | `KNOBS.staffGap`, `KNOBS.systemPitch`; `--score-staff`, `--score-bar` in `score.css` | `8`, `128`; 8.5% and 16% ink | line spacing, system spacing and strength of the score |
| Breathing | `@keyframes score-breathe` in `score.css` | `scaleY(1.045)`, 9 s, alternate | set the `to` scale to 1 to turn it off |
| Paper and sheet | `--score-paper`, `--score-sheet-shadow` | paper-50 mixed with 26% brass wash (about `#f5f4eb`) | warmth of the page, lift of the card |

## Motion

- First load (under 700 ms): staves fade in (360 ms), the ribbon draws itself from the left with stroke-dashoffset
  (560 ms, `--ease-emphasized`, outer strokes up to 80 ms behind the centre), the card settles 10 px with a fade
  (480 ms from 60 ms), the brand column fades without moving.
- Ambient: the ribbon breathes (scaleY 1 to 1.045 over 9 s) on its own compositor layer; no JS runs per frame.
  Paused on `visibilitychange` (class `is-paused`).
- Handshake: the ribbon is rebuilt toward the centred card and draws again; the card settles.
- Reduced motion: the composition is drawn complete, nothing moves (class `is-still` plus a media query); the static
  page is the designed state (`hub-reduced@1440.jpg`).

## Measured frame cost

Playwright + CDP `Performance.getMetrics` (main-thread task time divided by frames), Chromium headless:

| Viewport | Build (JS, once per layout) | Entrance (36 frames) | Breathing (300 frames) | Frame interval p95 |
|---|---|---|---|---|
| 1440x900 @1x | 7.5-10 ms | 1.2 ms/frame | 0.40 ms/frame | 16.8 ms |
| 1440x900 @2x | 10-27 ms | 1.2 ms/frame | 0.42-0.49 ms/frame | 16.8 ms |
| 375x812 @2x | 6 ms | 0.8 ms/frame | 0.41-0.43 ms/frame | 16.8 ms |

The breathing figure is mostly the sampling loop itself; layout per frame is 0. The build runs on load, on resize
(debounced 140 ms) and on the handshake, never per frame. No canvas, so no DPR cap is needed; SVG only.

## Contrast

Paper is `rgb(245 244 235)`. Measured on it: headline 12.3:1, proof points 14.9:1, family taglines 7.3:1, the proof
source (muted, 12 px) 5.5:1, the lockup 12.3:1. Text never sits on the ribbon (it is fitted to the empty band between
the headline and the proof list) and the staves are masked away around every text block, so the worst spot behind
text is the paper itself. Card text sits on white. axe is clean (smoke 11).

## Decisions

- The art layer is `position: absolute` over the whole body (the body is made `position: relative` in this look) rather
  than `fixed`, so the ribbon stays in its band when the page scrolls (1280x720, phones) instead of sliding behind copy.
  It never takes part in layout.
- The script reads (never writes) the hub's layout to place the ribbon: `.hub-value`, `.hub-proof-list`, `.hub-brand`,
  `.hub-signin-inner > .hub-card`, `.hub-handshake-card`. A MutationObserver on `#hub-root` notices the handshake.
- A slight fold and a waveform keep the bundle reading as a ribbon; a stronger twist (tried first) pinched the ribbon to
  nothing beyond the card, so it was cut.
- Bar lines only on real edges; a bar at the brand column's edge was tried and read as random, so it was dropped.
- One brass stroke in the ribbon, olive-gold, thin; nothing brass touches the card or any chip.
- Picker rows keep square ends (rounding them bent the hairline separators).

## Known limits

- The ribbon's position is computed from the layout at load; if the card changes height (code panel, simulated inbox)
  the ribbon stays where it was. Only the staves extend with the page.
- On very short desktop windows (under about 700 px tall) the band between the headline and the proof list is narrow, so
  the ribbon stays a hairline across the text column and opens only past it.
- At 375 the ribbon lives in a band under the headline and tucks under the card's top edge; it scrolls away with the
  page, by design.
- No markup hooks were needed.
