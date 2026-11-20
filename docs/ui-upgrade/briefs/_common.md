# Rules for every worker (read fully before you start)

You are one worker in an unattended overnight UI upgrade of **Conductor** (Orchestra's accounts-payable workspace).
Nobody will answer questions. Decide, note the decision in your report, keep going. The orchestrator merges your branch.

## Goal (from the owner)
The product works and its layouts and features are right. It looks **bland**. It will be shown to business and HR
people. Make it look like a product a finance or HR leader would be proud to put on a screen: distinctive, calm,
premium, quick to read. **Keep** every layout, route, feature, flow and behavior. **Change** how it looks and feels.
**Do not overcrowd**: richness in a few memorable moments; working surfaces (inbox, review, tables) stay quiet. If a
screen gets busier, it got worse. Mood: crisp high-trust fintech **plus** the orchestral brand story used as an
*abstract* visual language (staff lines, waveforms, tempo ticks, crescendo, rhythm, a conductor's sweep). **Never
clip-art**: no treble clefs, notes, violins, batons as icons. Read `docs/ui-upgrade/DIRECTION.md` and
`docs/ui-upgrade/AUDIT.md` first.

## Hard rules (breaking one fails the whole run)
1. **Git**: work only in your worktree on your branch. Commit small and often (`git add` only your files). Never touch
   `main`, never force-push, never open a PR, never merge other branches, never `git push` (the orchestrator pushes).
   End every commit message with:
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
2. **Frozen**: never edit `*.py`, `data/`, `src/`, `scripts/`, `requirements.txt`, `tests/**/*.py`, any API contract.
   JS changes only for presentation (markup structure for styling, SVG, class names, animation, new presentational
   modules). **Never change logic, routes, request/response handling, state, permissions, event handlers' behavior.**
3. **Test hooks**: `tests/ui/smoke.mjs` selects by role, accessible name, visible text, ids, `data-*` and the route hash.
   Keep all of them. Do not change user-visible text; if you truly must, list it with the reason in your report.
   Never edit tests to make them pass.
4. **Accessibility** stays at or above today: text contrast >= 4.5:1 (3:1 for large text and non-text UI), visible focus
   on every control, touch targets >= 24px, one `<h1>`, one `<main>`, landmarks intact. Every decorative SVG/canvas is
   `aria-hidden="true"` (the suite fails on any `<svg>` that is not aria-hidden and not `role="img"` with a label).
   Every animation respects `prefers-reduced-motion: reduce` with a static fallback that still looks designed.
5. **Performance**: CSS transforms/opacity, SVG, or a single canvas that caps DPR at 2, pauses on `visibilitychange`
   and under reduced motion, causes no layout shift, < ~4 ms/frame. **No continuous JS animation on working screens**
   (inbox, review, tables): there, motion is only 120-240 ms transitions in response to a user action.
6. **Responsive**: 375, 768, 1280, 1440 px, no horizontal scroll (the suite checks).
7. **Truthfulness**: never invent client facts, logos, testimonials, numbers. Never "9 operating companies" (there are 3).
   The words demo / prototype / mock / test must never appear in visible text (the suite checks).
8. **Offline, self-made**: SVG/CSS/canvas you draw. No images from the web, no CDN, no new dependencies, no build step
   (plain ES modules + CSS). Fonts in `assets/fonts/`: Bricolage Grotesque, Geist, Geist Mono, Instrument Serif.
9. **Tokens**: `assets/css/tokens.css` is owned by the foundation worker. Other workers use its tokens; if you need a new
   token, define it at the top of *your own* CSS file under a `/* proposed tokens */` block scoped to your component and
   list it in your report; the orchestrator moves it into tokens.css. No raw hex outside tokens.css except inside your own
   art files (hub looks, brand SVG), where it must be commented.
10. **Edit only the files on your ownership list.** If you need a change elsewhere, describe it in your report.

## Skills
Load with the Skill tool if you can (`unslop`, `frontend-design`, `emil-design-eng`, `design-system`, `brand`,
`ui-ux-pro-max`); otherwise read `.claude/skills/<name>/SKILL.md` and the references it points to. `unslop` leads:
quiet chrome, one bright element per screen; its "wait for the user" step is waived. `ui-ux-pro-max` is advisory only:
never create `design-system/MASTER.md`, never adopt Tailwind/shadcn/React.

## Running and checking (from your worktree root)
- `node_modules` is symlinked into your worktree by the orchestrator (gitignored). If missing:
  `ln -s /home/user/OrchestraCaseComp/node_modules node_modules`.
- Run the app by hand: `CONDUCTOR_STATE_DIR=$(mktemp -d) python3 dashboards/conductor/server.py --port <your app port>`
  (sign in per `docs/phase3/HANDOFF.md` section 2). Prefer the screenshot tool below.
- **Screenshots** (every page, signed in as the right people):
  `node docs/ui-upgrade/tools/shots.mjs <outdir> --widths 375,1440 --port <your shots port> [--only <regex>] [--look a]`
  Page names: hub, hub-staff-picker, hub-vendor, hub-code, hub-handshake, inbox, inbox-ticket, ahead, vendor-setup,
  settings, styleguide, not-found, escalations, team, advanced, approver, direct-invoices, direct-invoice,
  direct-messages, direct-documents, direct-updates. It exits 1 and prints them if any page logs a console error.
  **Look at your screenshots** with the Read tool (it shows images). Judge them honestly against the goal.
  Before-shots of today's app: `docs/ui-upgrade/shots/before/`.
- **Gate** for your area: `docs/ui-upgrade/tools/gate.sh smoke <your smoke port base>` (about 75 s; must end
  `GATE GREEN`). `gate.sh js` is fast. The orchestrator runs the full gate (python too) before merging.
- Save the screenshots you want the orchestrator to see under the folder your brief names (JPEG, < 300 KB each), commit them.

## Report (your final message)
What changed (by file), what you rejected and why, which screenshots you took and where, the gate result (paste the
last lines), proposed tokens, anything you could not verify, and any copy you had to change. Keep it under 400 words.
A report is a claim: the orchestrator will check the diff and the screenshots.

## Content-Security-Policy (server.py, frozen)
`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:` — so **no inline `<script>`** and no
inline event-handler attributes; scripts are ES modules loaded from `/static/...`. Inline `style` attributes and inline SVG
are fine. URL map: `assets/` (repo root) is served at `/shared/` (fonts also at `/static/fonts/`);
`dashboards/conductor/assets/` is served at `/static/`.
