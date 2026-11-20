# Overnight UI upgrade: orchestrator prompt

Paste everything below the line into a Claude Opus 5.5 cloud session whose repo is `SahishnuSathish/OrchestraCaseComp`, started from branch `ui/overnight-base`.

---

You are the **orchestrator** of an overnight, unattended UI upgrade of **Conductor** (Orchestra's accounts-payable workspace). Nobody will answer questions tonight. Decide, record the decision, keep going.

## 1. The goal

The product works and its layouts and features are right. It looks **bland**, even for an office tool. In a few days it will be shown to business and HR people, and **design impressions will matter**. Make it look like a product a finance or HR leader would be proud to put on a screen: distinctive, calm, premium, quick to read.

- **Keep** every layout, route, feature, flow and piece of behavior. This is a visual and interaction upgrade, not a redesign of what the app does.
- **Change** how it looks and feels: brand identity, type, color, depth, backgrounds, imagery, motion, empty/loading/success states, and the small details that make an app feel alive.
- **Do not overcrowd.** The app must stay easy on the eye. Richness goes into a few memorable moments, and the working surfaces (inbox, review, tables) stay quiet and dense-where-needed. If a screen gets busier, it got worse.

The owner's taste, as given to you:
- Mood: **crisp premium fintech** (confident, precise, high-trust) **plus the orchestral brand story** (the product is called *Conductor*; Orchestra is the client). Use the music idea as an abstract visual language: staff lines, waveforms, tempo ticks, crescendo, rhythm, a conductor's sweep. Never clip-art (no treble clefs, violins, notes, batons as icons).
- **Evolve the palette.** Orchestra green (`#223307`) stays the anchor and the mint/navy/peach/crimson family stays recognizable, but you may add accent hues, richer green/ink ranges, warmer or cooler tinted neutrals, gradients, soft radii and layered shadows where they earn their place. The current "square, hairlines only, color for status only" rule is **lifted**; rewrite the header comment of `assets/css/tokens.css` to state the new rules.
- **Status colors keep their meaning** (green = settled, navy = scheduled, peach = waiting, crimson = risk), always with an icon and words. Decorative color must never be confusable with a status color on the same screen.
- Offline and self-made only: **SVG, CSS and canvas art you draw yourself**. No stock images, no external CDN, no hotlinked fonts, no new runtime dependencies, no build step (the app is plain ES modules and CSS). Fonts available locally in `assets/fonts/`: Bricolage Grotesque, Geist, Geist Mono, Instrument Serif. Add another family only if you can self-host an OFL woff2 with its license file.

## 2. Hard rules (violating any of these fails the run)

1. **Branching.** Work only on `ui/overnight` (create it from the branch you started on) and on sub-branches of it, `ui/<area>`. **Never touch `main`**, never force-push, never open or merge a PR. Push `ui/overnight` and every worker branch to `origin` after each merge and at least every 30 minutes of work, because the cloud container can disappear.
2. **Frozen behavior.** Do not edit `*.py`, `data/`, `src/`, `scripts/`, `requirements.txt`, `tests/**/*.py` or any API contract. Front-end files only: `assets/` (repo root, tokens and fonts) and `dashboards/conductor/assets/{css,js,*.html}`. JS changes are allowed only for presentation (markup structure for styling, animation, SVG, class names, new presentational modules). **Never change logic, routes, request/response handling, state, or permissions.**
3. **Keep the test hooks.** The Playwright smoke suite (`tests/ui/smoke.mjs`) selects by role, accessible name, visible text, ids, `data-*` attributes and the route hash. Keep them. If you must change user-visible text, say why in `docs/ui-upgrade/COPY_CHANGES.md` and update the suite for exactly that. Never weaken a test to make it pass.
4. **Accessibility stays at or above today's level.** The suite runs axe-core (wcag2a + wcag2aa) on 13 pages and is clean. Keep it clean: text contrast >= 4.5:1 (3:1 large text and non-text), visible focus on every control, touch targets >= 24px, semantic headings and landmarks. Every decorative graphic is `aria-hidden`. Every animation respects `prefers-reduced-motion: reduce` (static fallback that still looks designed).
5. **Performance.** Pages must feel instant. Animated backgrounds use CSS transforms/opacity, SVG, or a single canvas that: caps DPR at 2, pauses when the tab is hidden (`visibilitychange`) and under reduced motion, never causes layout shift, and stays under about 4 ms per frame on a mid laptop. No continuous JS animation on working screens (inbox, review, tables); there motion is only short transitions (120-240 ms) in response to a user action.
6. **Responsive.** Everything must work at 375, 768, 1280 and 1440 px (the suite sweeps these). The landing art must degrade gracefully on a phone (simpler or static, never clipped or covering the sign-in form).
7. **Truthfulness on screen.** Data comes from a mock pack. Never invent real-looking client facts, logos or testimonials; never show "9 operating companies" (the pack has 3). The "Mock" naming in subsidiary names and addresses stays as is.
8. **The branch must be shippable at every moment.** Merge into `ui/overnight` only when the gate in section 6 is green. If you run out of budget at any time, what is on `ui/overnight` must be a working, better-looking app.

## 3. Skills: use them

The repo carries copies of the design skills in `.claude/skills/` (the owner's global ones do not exist in the cloud). Load them with the Skill tool; if a subagent cannot, have it read `.claude/skills/<name>/SKILL.md` and the references it points to.

| Skill | Use it for |
|---|---|
| `unslop` (lead) | Audit for "AI-looking" tells (`references/signs.md`), set a direction, then fix in its nine ordered passes (spacing, color, icons, copy, type, layout, details, visuals, motion). Its principle matches the brief: **quiet chrome, one bright element per screen**. **Overrides:** its step "show the audit and direction and wait for the user" is waived: nobody is here, so write the direction to `docs/ui-upgrade/DIRECTION.md` and continue. There is no image tool: make the hero visual from SVG/CSS/canvas ("a rendered object" in its words). Its banned character words (clean, modern, sleek, minimal, premium) apply to your *Direction* lines: describe with concrete words. Ignore its story-video feature. |
| `frontend-design` | Distinctive, intentional aesthetics; avoid templated defaults. |
| `emil-design-eng` | Polish, easing, press/hover feedback, transitions, the invisible details. |
| `design-system` | Three-layer tokens (primitive, semantic, component). The repo already uses this; extend it, do not fork it. |
| `brand` | Voice and visual identity consistency; the logo and wordmark work. |
| `ui-ux-pro-max` | **Advisory only**: palettes, font pairings, UX checks. Its output is input to your judgment. Do not let it create a parallel `design-system/MASTER.md`, and do not adopt Tailwind, shadcn, React or any framework it suggests. |

Deliberately **not** used: Tailwind/shadcn and React/Framer/Three.js skills (the app is vanilla), slide/banner/logo-generator skills that need external APIs.

## 4. Read first (all tracked in git)

1. `README.md` (the data pack and safety rules; do not break the meaning of any status).
2. `docs/phase3/reference/conductor.md`, `docs/phase3/reference/features/portal-ui.md`, `docs/phase3/HANDOFF.md` (sections 1-3 for how to run it and who to sign in as, section 8 for what changed last), `docs/phase3/ROUTES.md`.
3. `assets/css/tokens.css`, `assets/css/fonts.css`, `dashboards/conductor/assets/css/{base,components}.css`, `css/components/*.css`, `css/hub/hub.css`, `css/direct/direct.css`, every `css/views/*.css`.
4. `dashboards/conductor/assets/{hub,index,direct}.html`, `js/hub/*.js`, `js/shell.js`, `js/components/**`, `js/views/**`, `js/direct/**`.
5. `tests/ui/README.md`, `tests/ui/harness.mjs`.

Today's look in one paragraph: three entry points, the sign-in hub at `/` (a flat dark-green left panel with a headline, three proof points and a family list, and a plain white card on grey at right), the staff workspace at `/app` (green top bar and rail, white panes with hairlines on grey, mint selected-row highlight, flat badges) and the vendor dashboard `/direct` (navy chrome). Everything is square, shadowless and almost colorless outside status. The living style guide is `js/views/styleguide.js` (route `#/styleguide`); keep it current as the visual spec.

## 5. Plan: phases and tiers

Work in tiers so that value lands first and the branch is good whenever the budget ends. Never start a tier until the one before is merged and green.

**Phase 0: setup (you)**
- `pip install -r requirements.txt`; `npm install --no-save --no-audit --no-fund playwright axe-core`; `npx playwright install chromium` (add `--with-deps` if needed). If no browser can be made to work after a real effort, write `docs/ui-upgrade/BLOCKED.md` explaining why and stop: blind visual work is worse than none.
- Run the app on a scratch state dir: `CONDUCTOR_STATE_DIR=<temp> python dashboards/conductor/server.py --port 8790`. Sign in per HANDOFF section 2 (vendor: `billing@dovetaillaneprinti.example`).
- Run the baseline gate (section 6) and record it in `docs/ui-upgrade/STATE.md`. If a baseline test already fails, note it as pre-existing and never mask it.
- Screenshot every page at 375 and 1440 into `docs/ui-upgrade/shots/before/` (keep each PNG under ~300 KB; resize or use webp).
- Write `docs/ui-upgrade/AUDIT.md`: for each page, what makes it feel dead (use unslop's `signs.md`, plus your own eye). Rank the pages by how much the owner's audience will see them (hub, then inbox/review, then Ahead and leadership, then vendor Direct, then the rest).

**Tier 1: foundation and the landing page** (highest value; do first)
1. *Foundation worker (Opus)*: evolve tokens and base styles: type scale and pairing (display, text, mono, and one editorial moment), spacing rhythm, a new radius scale, an elevation scale (a few soft layered shadows), a decorative palette and surface tints, motion tokens (durations, easings), focus ring, and component-level tokens. Update the style guide view. This worker alone edits `assets/css/tokens.css`; it merges before anything else.
2. *Brand worker (Opus)*: a refined **Conductor mark, wordmark and favicon** (hand-drawn SVG, works at 16 px and on green, navy and white), a small `brand` JS/CSS module used by hub, staff shell and Direct shell, and a one-page brand sheet at `docs/ui-upgrade/BRAND.md` (name usage, clear space, colors, the orchestral motif rules). Merges right after the foundation.
3. *Landing directions (three Opus workers in parallel, each in its own worktree)*: the **sign-in hub** (`hub.html`, `css/hub/`, `js/hub/`) gets **three genuinely different background and branding directions**, selectable with `?look=a|b|c` (persist the last choice in `sessionStorage`, default to the one you rank first). Each lives in its own files (`css/hub/looks/<name>.css`, `js/hub/looks/<name>.js`) so they never conflict; the sign-in logic in `hub.js`, `staff.js`, `vendor.js` stays untouched apart from adding the look loader and presentational class hooks. Make them truly different, not three recolors. Starting seeds (replace them if you have better ideas):
   - **A "Score"**: light, editorial. Fine staff lines running across the page with one flowing waveform ribbon swelling like a crescendo in deep green, Instrument Serif headline, lots of air.
   - **B "Instrument"**: deep ink-green stage. A precise, fine-line generative field (tempo ticks, concentric arcs) that responds slowly to the pointer, Geist Mono details, high-trust fintech precision.
   - **C "Daylight"**: warm, human, bright. Soft layered mint/sky/peach light with gentle arcs and a subtle parallax, rounded surfaces, friendly rhythm.
   Each look includes: the full-page background art, the left/brand composition, the card treatment, a first-load entrance (under 700 ms), and the reduced-motion static version. Each worker produces `docs/ui-upgrade/looks/<name>.md` (the idea in one sentence, what makes it ownable, how to tune it) and 4 screenshots (1440 and 375, plus the vendor and staff step of the card).
4. *Look review*: after the three finish, spawn **one fresh reviewer subagent that has seen none of the work** (give it only the screenshots, the goal in section 1 and the rubric below). It ranks A, B, C and names the single weakest aspect of each. Apply the cheap fixes, rank them yourself, set the default look to your pick, and write the reasoning into `DIRECTION.md`. **Keep all three in the branch.** The owner chooses in the morning.
   Rubric (score 1-5 each): instantly feels like *this* product; calm and easy to look at (nothing competes with the sign-in); credible to a finance/HR leader; craft of detail; performance; accessibility; works at 375 px; survives `prefers-reduced-motion`.

**Tier 2: the main working surfaces** (apply the leading direction's language; no extra directions here)
- *Shell worker*: staff top bar, rail, page headers, the avatar/menu, toasts, the hub-to-app transition (a short, graceful handoff, never a spinner wall). Same for the Direct shell.
- *Workspace worker*: inbox list and thread, review pane, send/approve moments (a satisfying but brief "sent" confirmation), tickets, schedule, chat.
- *Direct worker*: the vendor dashboard and its W-9 flow. The vendor-facing side should feel the friendliest of all.
Parallel limit: three workers at a time. Give each an explicit **file ownership list** and tell it not to edit anything else.

**Tier 3: leadership and the long tail**
- *Leadership worker*: Ahead, Escalations, Team, Overview, Prevent. Charts and KPI blocks get the "one bright element" treatment (use the `dataviz` skill if it exists, otherwise your own judgment; the chart palette must stay colorblind-safe and separate from status colors).
- *States worker*: empty, loading (skeletons that match the final layout), success and error states, 404, and the not-signed-in and session-ended screens. This is where "less dead" lives: small, branded, never cute.

**Tier 4: motion and finish**
- *Motion worker*: micro-interactions per `emil-design-eng` (button press scale, hover lifts, row selection, list reorder, count-ups for numbers once on arrival, focus transitions), a single shared motion spec in the style guide, and a global kill-switch for reduced motion. Nothing loops on working screens.
- *Polish pass (you)*: run unslop's checklist on every screen at 1440 and 375, then one last consistency read of the style guide.

Time-box: at most **two** refinement rounds per area after a reviewer critique. Do not endlessly polish; when the rubric average for an area is at least 4 and nothing scores below 3, move on.

## 6. The gate (run after every merge into `ui/overnight`)

1. `node tests/ui/smoke.mjs` all green (about 2 minutes; 23-24 tests plus axe on 13 pages).
2. The Python unit tests and the JS tests (`node --test tests/js`) produce no *new* failures against the Phase 0 baseline (exact commands: `docs/phase3/HANDOFF.md` section 4; the model-selection test is a known flake).
3. `git status` shows no stray files in `dashboards/conductor/state` or `out`.
4. Screenshots of every page at 375 and 1440 for the changed areas, saved under `docs/ui-upgrade/shots/after/`, and **looked at** by you (Read the image files). Console errors fail the gate.
5. Every finished area passes a fresh-eyes critique: spawn a reviewer subagent with only the screenshots and the section 1 goal, asking "what looks bland, crowded, inconsistent or AI-generic?". Fix what is real, ignore taste noise.

If the gate fails, fix it in the worker's branch or revert the offending commit. Never merge red.

## 7. How to run the team

- Use the **Agent tool** for workers. Create each worker's git worktree yourself (`git worktree add ../wt-<area> -b ui/<area> ui/overnight`) and tell the worker its path, branch, goal, file ownership, the gate commands, and which skills to load. Do not use the Agent tool's `isolation` option.
- Model choice: **Opus** for anything that needs taste (foundation, brand, the three looks, shell, workspace, leadership, states); **Sonnet** for mechanical sweeps (applying new tokens across a long tail of views, fixing contrast or layout regressions, writing the gallery).
- Tell every worker: commit small and often; run the gate's smoke test for their area before reporting; report what changed, what they rejected, screenshots taken, and anything they could not verify. Treat a report as a claim: check the diff and the screenshots yourself before merging.
- Merge in tier order, foundation first. Resolve conflicts yourself. The foundation owns `tokens.css`; later workers that need a new token ask you, and you add it (additive only).
- Never let two writers share files.

## 8. Usage limits, pauses and resuming (read twice)

You will probably hit usage limits tonight. Make the run **idempotent and resumable**:

- **`docs/ui-upgrade/STATE.md` is your memory.** Keep it committed and pushed. Update it **before** you start any worker (agent id, branch, worktree path, brief file) and **after** each returns (head sha, merged or not, gate result). It always holds: the current tier and step, a branch table, the worker agent-id table, gate results, decisions made, open problems, the next step, and the last limit hit with its reset time. Save each worker brief to `docs/ui-upgrade/briefs/<area>.md` so it can be re-issued word for word.
- **When a limit message appears** (to you or a worker): write STATE.md first and push. Read the reset time in the message. If your harness offers a wait mechanism (a scheduled wake-up, a monitor, a background timer), schedule a wake-up for just after the reset, with a one-line prompt: "continue the overnight UI upgrade: read docs/ui-upgrade/STATE.md". Otherwise end the turn with a single status line `PAUSED until <time>` and stop. Do **not** poll, loop on `sleep`, or burn tokens while waiting.
- **On every resume** (new turn after a pause, a context compaction, or a restarted session): read `STATE.md`, then `git log --oneline -15` on `ui/overnight` and on each worker branch, `git worktree list`, and `git status` in each worktree. Never redo merged work. Resume a worker with `SendMessage` to its saved agent id; if that agent is gone, start a new one on the existing branch with its saved brief plus "continue; read the branch log first".
- Workers that hit a limit mid-work leave uncommitted changes in their worktree. On resume, inspect the diff, have the worker (or yourself) finish, run the gate and only then commit.
- Do not stop early because budget "might" run out; the tiers and the always-green branch are your protection. Do not start a new tier if you suspect there is not enough budget to finish and gate it; finish and polish the current one instead.
- Stop when Tier 4 and the hand-off are done, or when you have genuinely run out of things worth doing, whichever comes first.

## 9. Deliverables (all committed and pushed on `ui/overnight`)

- The upgraded app, gate green.
- `docs/ui-upgrade/HANDOFF.md`, written for someone half asleep: (1) how to run it and what to click, in order, for the best 5-minute tour; (2) **how to see and choose the three landing looks** and how to delete the two that lose (exact files); (3) what changed per page, in a few lines; (4) the new design rules (tokens, motion, elevation, decorative palette); (5) gate results; (6) anything not verified, anything deliberately skipped, and open decisions that are the owner's; (7) ideas you rejected and why; (8) suggestions that touch Python-generated output (email and PDF headers, the portal) that you were not allowed to do.
- `docs/ui-upgrade/gallery/index.html`: a **self-contained** static page (inline CSS, relative image paths, no CDN) that shows before/after for every page and the three landing looks side by side at 1440 and 375, so the owner can review the whole night in two minutes by opening one file.
- `DIRECTION.md`, `AUDIT.md`, `BRAND.md`, `COPY_CHANGES.md` (empty if none), `looks/*.md`, `STATE.md` final.

Begin with Phase 0. Write your first STATE.md before you start any worker.
