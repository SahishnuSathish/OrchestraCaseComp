# Brief: brand (Tier 1, step 2)

Read `docs/ui-upgrade/briefs/_common.md` first; its rules apply. Worktree: `/home/user/wt-brand`, branch `ui/brand`.
Smoke port base **8812**, shots port **8832**. Skills: `brand` (lead), `frontend-design`, `unslop` (the logo rules in
the Details pass and "Do not"). Read `docs/ui-upgrade/DIRECTION.md`.

## Your job
A refined **Conductor mark, wordmark and favicon**, hand-drawn SVG, that works at 16 px and on green, navy and white,
used through one small brand module by the hub, the staff shell and the Direct shell; plus a one-page brand sheet.

- Today's mark (`js/components/marks.js`) is a baton/pen-nib diagonal with a diamond on a mint square: it reads as
  clip-art and turns into a smudge at 16 px. Replace it with an **abstract** mark from the orchestral language
  (examples, choose or better them: five staff lines with one line rising into a sweep / crescendo; a downbeat tick and
  the arc of a conductor's beat pattern; a waveform resolving into a check). No clefs, notes, batons, instruments.
  It must stay legible at 16 px (test it: render at 16, 20, 24, 32, 64).
- Family: **Conductor** (staff, on green chrome), **Conductor: Direct** (vendors, navy chrome), **Conductor: Ahead**
  (proactive notices). One construction, three variants (e.g. same mark, different field colour or one detail).
- **Wordmark / lockup**: "Orchestra | Conductor" stays as **text** (Orchestra is the real client: do **not** draw an
  Orchestra logo). Refine the lockup's type, weight, spacing, rule, and sizes (sm/md/lg) in the new type system.
- **Favicon**: an SVG file (and keep the data-URI fallback approach if you prefer) for `/` (hub), `/app` and `/direct`.
- Keep `marks.js`'s **exports and signatures** exactly: `PRODUCTS`, `TAGLINES`, `mark({product,size,label})`,
  `lockup({product,tone,orchestra,size,href})`; keep the `sr-only` accessible label text ("Orchestra Conductor", etc.),
  the class names `c-mark`, `c-mark-<product>`, `c-lockup`, `c-lockup-<tone>`, `c-lockup-<size>`, and `aria-hidden` on
  the decorative SVG. Tagline text must not change.
- `docs/ui-upgrade/BRAND.md`: name usage (Conductor, Conductor: Direct, Conductor: Ahead; Orchestra as the client),
  clear space, minimum sizes, colours (token names), the orchestral motif rules (what is allowed, what is clip-art),
  the staff-rule signature from DIRECTION.md, voice in three lines (the existing copy voice: plain, specific, calm).
- Render a small specimen sheet of the marks (16/24/32/64 on green, navy, paper) as a static HTML page under
  `docs/ui-upgrade/brand/specimen.html` (self-contained, inline SVG) and screenshot it with Playwright into
  `docs/ui-upgrade/shots/brand/`.

## Files you own (edit nothing else)
`dashboards/conductor/assets/js/components/marks.js`, `dashboards/conductor/assets/css/components/brand.css`
(new; already imported by components.css after core.css, so your rules override core.css's mark/lockup section),
`dashboards/conductor/assets/brand/` (new: favicon.svg etc., served at `/static/brand/...`), **only** the
`<link rel="icon" ...>` line in `dashboards/conductor/assets/{hub,index,direct}.html` (direct.html has none: add one
after the `<title>`), `docs/ui-upgrade/BRAND.md`, `docs/ui-upgrade/brand/`, `docs/ui-upgrade/shots/brand/`.

The foundation worker is rewriting tokens.css in parallel. Use existing token names (`--color-chrome`,
`--color-direct`, `--color-chrome-highlight`, `--color-direct-highlight`, `--color-ahead`, ...). If you need new
colours, define them as `--brand-*` custom properties at the top of brand.css with a comment, and list them in your
report.

## Done means
- `gate.sh smoke 8812` → GATE GREEN.
- Shots of hub, inbox, direct-invoices at 375 and 1440 (from `shots.mjs --only 'hub$|^inbox$|direct-invoices'`) and the
  specimen, in `docs/ui-upgrade/shots/brand/`, looked at by you. The mark must be crisp at 16 px in the specimen.
