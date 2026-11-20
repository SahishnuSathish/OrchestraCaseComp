# Brand: the Conductor family

Specimen: `docs/ui-upgrade/brand/specimen.html` (static, open it in a browser). Code: `js/components/marks.js`
(`mark()`, `lockup()`), styles in `css/components/brand.css`, files in `dashboards/conductor/assets/brand/`.

## Names

- **Orchestra** is the client. It appears as text only, in the lockup and in copy. We never draw an Orchestra logo.
- **Conductor** is the staff workspace (`/app`). **Conductor: Direct** is the vendor dashboard (`/direct`).
  **Conductor: Ahead** is the proactive notices. Write them exactly so: capital C, a colon and a space before the
  sub-brand. Never "Direct" alone in a heading, never "Conductor Direct" or "Conductor-Ahead".
- In running text the first mention is the full name; after that "Conductor" is fine for the staff workspace.

## The mark

One construction for the whole family, drawn on a 32-unit grid:

- a **field** with a corner radius of 7 units;
- **three staff lines**, 2 units thick at y 8, 14 and 20, in the ink at 42% strength (on even units, so at 16 px each
  line is exactly one pixel);
- **one sweep**: a line that leaves the lowest staff line at 1.6 units and swells to 4.6 as it rises across the staff
  to the upper right. It is the crescendo and the conductor's gesture at once, and it is the only solid thing in the
  mark.

Variants change the field colour or one detail, never the drawing:

| Product | On chrome (dark) | On paper (light) | Detail |
|---|---|---|---|
| Conductor | field `--color-chrome-highlight`, ink `--color-chrome` | field `--color-chrome`, ink `--color-chrome-highlight` | staff lines full width |
| Conductor: Direct | field `--color-direct-highlight`, ink `--color-direct` | field `--color-direct`, ink `--color-direct-highlight` | staff lines full width |
| Conductor: Ahead | field `--color-ahead`, ink `--color-ahead-ink` | the same, plus a 1-unit inner edge at 30% | staff lines 16, 13, 8 long: the sweep runs ahead of the score |

**Sizes.** Minimum 16 px (favicon, inline beside a heading). In the interface: 20 (small lockup, inline), 28 (top
bars), 36 (sign-in hub). Prefer 16, 24, 32, 48, 64 when you choose a new size: the staff lines stay pixel-crisp there.

**Clear space.** Half the mark's width on every side, inside which nothing else sits (the chrome edge counts).

**Do not** recolour the mark outside the pairs above, add a shadow, glow, gradient or outline, rotate it, put the sweep
at full strength with the staff, draw it without its field, or animate it in the chrome.

## The lockup

`[mark]  Orchestra | Conductor`, set in Bricolage Grotesque: "Orchestra" at weight 640, the product name at 430, a 1px
rule at 0.82 em between them (38% on paper, 45% on chrome). Sizes: **sm** 15 px text with a 20 px mark, **md** 17 px
with 28, **lg** 24 px with 36. The lockup is one line, never stacked. Below 768 px the chrome may drop "Orchestra" and
the rule (the shells already do); the screen-reader label still says "Orchestra Conductor".
Minimum width for the full lockup: 120 px.

## Favicons

`/static/brand/favicon.svg` (Conductor, for `/` and `/app`) and `/static/brand/favicon-direct.svg` (for `/direct`):
the paper variant, so the field carries the mark on light and dark browser tabs. `mark-ahead.svg` is for decks and
documents; the app draws every mark inline.

## The orchestral motif

Allowed, as abstract structure: staff lines, the sweep and a single swelling line, tempo ticks and beat counts used as
rhythm, waveforms, a crescendo as a shape that widens, alignment to a baseline. Never clip-art: no clefs, notes, rests,
batons, instruments, music stands, sheet-music pages, or anything that reads as a picture of music. If a shape needs a
caption to not look like an icon of an instrument, it is clip-art.

**Signature: the staff rule.** Five fine parallel lines (1px, 4px apart) mark the start of a moment, and only a moment:
the hub art, the insight strip header, the Ahead hero, the sent receipt. Never a general divider, never on working rows.
The mark's three lines are the same staff reduced for small sizes; do not add the staff rule next to the mark.

**Colour.** Decorative colour is never a status colour. The mark's mint and sky are brand fields, not "settled" or
"scheduled" chips; never place a mark where it could be read as a status.

## Voice

Plain: say what happened and what is next, in words a vendor or an approver uses, without exclamation marks.
Specific: name the invoice, the amount, the date and the record it came from; no hype, no vague reassurance.
Calm: one idea per sentence, sentence case, short labels; the work has already been checked, so the copy does not shout.
