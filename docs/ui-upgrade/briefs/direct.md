# Brief: Direct, the vendor dashboard (Tier 2)

Read `docs/ui-upgrade/briefs/_common.md` first; its rules apply. Then `DIRECTION.md` (apply the chosen look's language;
no new directions), `AUDIT.md`, `BRAND.md`, the tokens.css header and the style guide (`#/styleguide`).
Worktree `/home/user/wt-direct`, branch `ui/direct`, smoke base **8824**, shots port **8844**.
Skills: `unslop` (lead), `frontend-design`, `emil-design-eng`.

## The job
`/direct`, where vendors (e.g. Dovetail Lane Printing) see their invoices. **The vendor-facing side should feel the
friendliest of all**: warm, reassuring, plain, while staying credible.
- **Invoices list**: the column of identical status chips is the loudest thing today (AUDIT). Give status a calmer
  rhythm (e.g. a status dot/icon + short words, softer fill) while keeping each chip's icon and full words (the suite
  checks status chips and that there are no totals). Search/filter row, table rows, hover.
- **The W-9 banner**: keep its meaning (waiting = peach) but make it a designed callout, not the loudest slab.
- **Invoice detail**: "Paid Oct 29, 2026", the remittance advice in the page, Download PDF, asking a question: make
  the paid state a small, warm moment (e.g. a settled receipt with the staff-rule signature).
- **Messages, Documents & W-9 (upload progress, "Under review"), Updates**: friendly empty states and progress.
- The page header area (title, lede) inside Direct pages.
- Keep every role/name/aria/`data-*` hook and visible text (smoke stories 7 and 8). JS edits only for presentation.

## Files you own (edit nothing else)
`dashboards/conductor/assets/css/direct/direct.css`, `js/direct/views/*.js` and `js/direct/components/*.js`
(presentational edits only), `docs/ui-upgrade/shots/direct/`. NOT the Direct top bar/frame (`direct-shell.*`, owned by
the shell worker) and not `js/direct/app.js` / `routes.js` / `format.js`.

## Done means
`gate.sh smoke 8824` → GATE GREEN; shots at 375 and 1440 of direct-invoices, direct-invoice, direct-messages,
direct-documents, direct-updates in `docs/ui-upgrade/shots/direct/`, looked at.
