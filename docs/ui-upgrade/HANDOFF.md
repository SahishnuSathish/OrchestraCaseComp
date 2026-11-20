# UI upgrade: hand-off

Branch **`ui/overnight`** (pushed). `main` is untouched. The run was **stopped after Tier 1** at the owner's request
(a demo recording); Tiers 2-4 were not done. What is on the branch is complete, gated and shippable.

## 1. Run it and the 5-minute tour

```bash
CONDUCTOR_STATE_DIR=$(mktemp -d) python3 dashboards/conductor/server.py --port 8790
```

1. Open `http://127.0.0.1:8790/`: the new sign-in, look B "Instrument" (the owner's choice): a dark stage, a fine dial around the card, a brass hand.
2. Try `/?look=a` (paper score) and `/?look=c` (daylight). The choice sticks for the tab; `/?look=b` goes back.
3. Sign in with Microsoft → **Ulla Abernathy**: the handshake keeps the art behind it, then the inbox.
4. The inbox and review screens: warm paper neutrals, softer badges and buttons with press feedback, new mark in the top bar.
5. Sign in as **Elena Lockhart** → avatar menu → **Style guide** (`#/styleguide`): the whole new system as a living spec.
6. Vendor: **billing@dovetaillaneprinti.example** → Direct, with its own mark and favicon.

The gallery `docs/ui-upgrade/gallery/index.html` shows before/after and the three looks side by side (open the file).

## 2. The three landing looks: see, choose, delete

- See: `/?look=a` Score, `/?look=b` Instrument (**default, the owner's choice**), `/?look=c` Daylight. Docs: `docs/ui-upgrade/looks/*.md`;
  blind review: `looks/REVIEW.md` (A 4.1 > C 3.5 > B 3.4); my reasoning: end of `DIRECTION.md`.
- Choose: set `DEFAULT` in `dashboards/conductor/assets/js/hub/looks/index.js`.
- Delete the losers: remove their entry from `LOOKS` in that file, then delete
  `dashboards/conductor/assets/css/hub/looks/<name>.css` and `dashboards/conductor/assets/js/hub/looks/<name>.js`
  (names: `score`, `instrument`, `daylight`). Optionally their `docs/ui-upgrade/looks/<name>.md` and `shots/looks/<name>/`.

## 3. What changed per page

- **All pages** (tokens + core components): warm green-grey paper ramp instead of pure grey; richer green/ink range;
  radius scale (controls 8, cards 12, modals 16; working panes stay square); a soft green-ink elevation scale; badges
  softer and calmer; buttons press to 0.97; menus, modals and toasts rounded; Instrument Serif available as one
  editorial line per screen; the staff-rule signature (`.c-staff-rule`).
- **Brand**: new Conductor mark (three staff lines + one crescendo sweep), variants for Direct and Ahead, refined
  "Orchestra | Conductor" lockup, SVG favicons for `/`, `/app`, `/direct`. Rules in `BRAND.md`.
- **Sign-in hub + handshake**: three complete looks (above).
- **Style guide**: rebuilt as the visual spec (palette with live contrast, type, space, radius, elevation, motion, focus).
- Inbox, review, Ahead, Team, Escalations, Direct pages: only what the tokens and core components give them (Tier 2/3 not run).

## 4. The new design rules

Stated in the header of `assets/css/tokens.css` (the old "square, hairlines only, color for status only" rule is
replaced): tinted neutrals; Orchestra green `#223307` as the anchor; status colors keep their meaning with icon and
words; decorative `--deco-*` color only in art and the four moments, never on status-like elements; radius and
elevation scales; motion = one ease-out, 120-240 ms for responses, one entrance per page, reduced motion respected.

## 5. Gate results

| After | Smoke (24 + axe on 13 pages) | JS | Python | git |
|---|---|---|---|---|
| Baseline (bc8ea0c) | 24/24, axe clean | 85/85 | 396 run, 4 errors (pre-existing: no `tkinter` in the container) | clean |
| Foundation + brand | 24/24, axe clean | 85/85 | no new failures | clean |
| Three looks (A default; B and C each tested as default) | 24/24, axe clean | 85/85 | no new failures | clean |
| **Final** (all three looks with round-1 fixes; A default, B re-tested as default) | **24/24, axe clean** | **85/85** | **no new failures** | **clean** |

## 6. Not verified, skipped, open decisions

- **Not done (stopped early)**: Tier 2 (shell chrome, inbox/review "What Conductor found" moment, sent confirmation,
  Direct pages), Tier 3 (Ahead/Team/Escalations charts, empty/loading/404 states), Tier 4 (count-ups, motion spec).
  Briefs for all of them are ready in `docs/ui-upgrade/briefs/` and can be re-issued as is.
- All three looks got one refinement round from the blind review (merged). The Tier 2 shell worker was stopped before
  it changed anything (`ui/shell` = no work).
- Only headless Chromium was used; no Safari/Firefox or real-GPU check. Entrance animations were checked as stills.
- Decision for you: which look; whether the Ahead mark's edge (BRAND.md 30%; look C uses 62%) should change globally.

## 7. Ideas rejected

Five-line staff in the 16 px mark (blurs); check-mark or fan marks (read as UI icons); a metronome/pendulum in look B
(clip-art); a radar wedge (reads as "hacker"); continuous drifting light in look C (too costly without a GPU);
backdrop blur over live canvas.

## 8. Suggestions outside the allowed files

The emailed replies and PDFs (remittance advice, invoice copy) are generated in Python and still carry the old look:
the new mark and the paper/green palette in their headers would make the vendor-facing documents match.
