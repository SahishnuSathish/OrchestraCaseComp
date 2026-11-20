# Brief: workspace (Tier 2)

Read `docs/ui-upgrade/briefs/_common.md` first; its rules apply. Then `DIRECTION.md` (apply the chosen look's language;
no new directions), `AUDIT.md`, `BRAND.md`, the tokens.css header and the style guide (`#/styleguide`).
Worktree `/home/user/wt-workspace`, branch `ui/workspace`, smoke base **8822**, shots port **8842**.
Skills: `unslop` (lead), `emil-design-eng` (the sent moment, row selection), `frontend-design`.

## The job
The screens the AP team lives in all day. **Quiet and dense where needed; one bright element per screen.** No
continuous animation here: motion only as 120-240 ms responses to actions.
- **Inbox list** (`#/inbox`): queues column, message rows (hover vs selected vs keyboard focus must read apart), the
  "While you were away" card (make it a small moment: the figures set beautifully, maybe the staff-rule signature),
  "Reading…" arrivals, badges in rows (calmer: fewer competing chips; keep every chip's words and icon).
- **The reading pane / review** (`#/inbox/<id>`): **"What Conductor found" (the insight strip) is the bright element of
  this screen**: raise it (surface, elevation, the staff rule at its head, the editorial face for "They want" if it reads
  well), keep its structure and text. The message, the composer, the Details/evidence panel and source chips stay quiet.
- **Send / approve moments**: after **Approve & send**, a brief, satisfying "sent" confirmation (e.g. the toast plus a
  short check/stroke draw-in on the sent receipt, < 400 ms, reduced-motion: static), never a modal, never blocking.
- Tickets, schedule, chat, the fraud banner (crimson = risk, keep it serious, not loud), note/decide panels.
- Keep every role/name/aria/`data-*` hook and visible text (the smoke suite drives these screens heavily: stories 2,
  3, 4, 9). JS edits only for presentation.

## Files you own (edit nothing else)
`dashboards/conductor/assets/css/components/workspace.css`, `css/views/{inbox,review,tickets,chat,schedule,runs,prevent}.css`,
`js/components/workspace/*.js` (presentational edits only), `js/views/inbox.js` (presentational edits only: class
names, wrappers, decorative SVG; never logic), `js/chat.js` and `js/schedule.js` (presentational only, and only if
needed), `docs/ui-upgrade/shots/workspace/`.

## Done means
`gate.sh smoke 8822` → GATE GREEN; shots at 375 and 1440 of inbox and inbox-ticket, plus a shot of the sent state
(a tiny Playwright script outside the repo that approves one draft, using the same API sign-in as the shots tool), in
`docs/ui-upgrade/shots/workspace/`, looked at.
