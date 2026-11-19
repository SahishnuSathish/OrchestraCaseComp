# Polish review (wave 3): the items being fixed

A senior-designer review of every page at 1440 and 375 px found 25 problems. This file lists the ones assigned to fix workers, by owner. Paths are under `dashboards/conductor/assets/` unless they end in `.py`.

**Not being fixed (decision for the user):** #1 and #2, the word "Mock" in subsidiary names ("Mock Agency Studio Inc") and in `@orchestra-mock.example` / `mailbox-mock.example` addresses. These come from the data pack. Recipient chips must show the exact address on record, so addresses are not rewritten on screen.

## Inbox (`views/inbox.js`, `components/workspace/*`, `css/views/inbox.css`, `css/components/workspace.css`)
- **#7 "Why this outcome" reads like a debug trace.**
  - Collapse the steps into a closed disclosure, "How Conductor got here", with plain-word step names and correct plurals ("1 invoice reference" not "reference(s)").
  - Hide the draft steps ("Draft written", "Draft checked") when there is no draft (fraud and notes).
  - Do not show "Local model reading: Not used".
- **#8 Contradictory chips.**
  - When a risk flag (Fraud, Legal, Exec cc'd) is set, show the sender as a neutral grey "Listed contact", never a green "Verified contact".
  - In the insight strip, an unmatched invoice reads "Invoice: Not found", never "matched … not found".
  - A priority ticket (sign-off category `priority`) shows the outcome "Needs sign-off", not "Draft ready".
- **#11 The away card goes stale.** When new mail arrives, update its "still arriving" line live, or let it collapse to a one-line summary.
- **#12 Ticket tabs carry over between people.** Key the tabs store by the signed-in email, clear it on sign-out, and show the strip only on the Inbox and at 768 px or wider.
- **#13 Cramped composer at 1440.**
  - Toolbar labels never wrap (`white-space: nowrap`), and the recipient chip never wraps.
  - The action row stays on one line.
  - Give the reading column at least about 600 px at 1440: narrow the queue column, or collapse the evidence column below 1600 px into the Message/Details toggle.
- **#14 The list order looks random.** Sort newest first within each queue (arrivals naturally on top), and state the order in a quiet label ("Newest first").
- **#15 The same chips on every row.**
  - On list rows, show only exceptions: risk flags, "Not on file", "Action needed", "Needs sign-off", plus "Conductor: Direct" for web questions.
  - Drop "Draft ready", "Verified contact" and the "Outlook" chip from rows. The reading pane keeps them.
- **#22 (UI part).** Show the "Why" line once, not repeated. Where the ticket shows a raw rule string such as `Bank-detail change language: 'change of bank'`, show "The email asks us to change bank details."

## Leadership views (`views/{escalations,team,ahead,connections,vendor-setup,approver}.js`, their CSS, `components/leadership/*`)
- **#3 Advanced reads like a test harness.**
  - Use "Export signed-off replies" and "Import a mailbox export (tickets file)".
  - Remove "score.py", "stretch", "pipeline" and "walkthrough" from the copy.
  - Show runs as "Live inbox · Nov 13, 10:49 AM" or "Imported file · …", not by raw run id.
  - Use the placeholder "Choose a file…".
- **#5 Source lines show file paths.** Use "Source: past replies in Zendesk", "Since this morning", "Change history". No `data/…` paths or table names.
- **#6 A hex "Text fingerprint" sits by Sign off.** Remove it, or replace it with "Draft as of 10:49 AM". Keep the hash in the request only.
- **#9 Case-study wording.**
  - Replace the per-tile "practice data, snapshot Nov 13" footers with one "Data as of Nov 13, <time>" line by each page title.
  - "case baseline" becomes "Before Conductor: more than 1.5 days".
  - Do not say "The case figure".
- **#10 "Escalated" means three things.** Rename the Escalations group "Waiting for your sign-off". On Team, use "3 waiting for CFO sign-off".
- **#11 Counters disagree.**
  - Use one denominator for "tickets prevented" on Ahead and Team.
  - Label Team's approver bars "tickets blocked" (Ben holds 43 bills but blocks 4 tickets; say which is which).
- **#16 Ahead tabs are clipped at 375.** Make the tabs fit (a select or segmented control under 480 px), and keep "Built from records at 10:49 AM" on one line.
- **#17 Page gutters.** Use the shell's standard page container and title block on every leadership page, so the title's left edge is the same everywhere. The Ahead hero title is weight 600.
- **#19 Vendor setup bills.** Sort numerically by due date. Split "Held by the W-9" from "Already scheduled", or call the list "Open bills".
- **#20 Ahead jargon.**
  - "Would have answered 19 vendor emails, e.g. Foxglove Talent (2)" instead of a wall of ticket chips; the chips can sit in a disclosure.
  - "10 reminders become 6", not "10 → 6".
  - "No reminder sent yet".
  - Sort digests by oldest wait.
  - One row action label: "Preview".
- **#23 Settings shows model internals.**
  - On Connections, the AI card reads "AI assistant · Ready, runs on this computer". Move the model detail (model name, Ollama version, quantization) and the mail-delivery mode into Advanced.
  - Derive "Last sync" from the sync log.
- **#25 Waiting on you.**
  - Use one compact KPI row on mobile, so the first bill is above the fold.
  - The banner reads "Only our AP team sees your notes and dates."
  - Make "Open in NetSuite" look like a link that is unavailable here, with a tooltip.

## Hub and shell (`js/hub/*`, `css/hub/*`, `js/shell.js`, `css/components/shell.css`, `css/components/core.css`, `css/components/direct-shell.css`)
- **#24 Sign-in at 375 and the code preview.**
  - Picker sheets are full height on phones (`100dvh`); no blank band, no clipped rows.
  - The handshake uses spinner, then check icons, not empty checkboxes. "Connecting NetSuite (read-only)".
  - The "Your inbox" code preview scrolls into view when the code is sent, and is never cut off at 1440.
- **#25 (nav).**
  - A role with one destination (approver) gets no rail or bottom tab bar on mobile.
  - The rail label is "Approvals", short enough to fit on one line.
- **#17 (shell).**
  - One page max-width and gutter token in `shell.css` (the `.page` container) that every view uses.
  - Direct's tab panels align: no 8 px jump between Invoices and Messages.
- **Small items:**
  - Email addresses use the interface font, not Geist Mono (mono is for IDs and amounts).
  - At 768, the connection indicator shows labels or a tooltip, not three bare dots.
  - The notification tray line reads "Recent updates" instead of "Keeps the last 50 updates for this window".

## Backend wording (`documents.py`, `direct.py`, `workflow.py`, `summarize.py`, `src/notices.py`)
- **#4** In `src/notices.py`, the demo-bill rule text must not name columns (`tranDate`, `internalId`): "We picked the bill that has waited longest for approval and that a vendor has already asked about."
- **#5** In `workflow.py` team-overview `source` and `basis` strings: no file paths or table names.
- **#7** In `summarize.py`: drop the "Retrieval: partial (missing bill for …)" sentence from what staff see.
- **#18** Remittance and invoice copy (`documents.py`): with no account number on record, say "Paid by ACH to the bank account on file" and drop "Only the last 4 digits are shown". When a number exists, show "••••1180". Direct's summary sentence (`direct.py`) uses the same `$41,775.42` style as the tiles, not "USD 41,775.42".
- **#21** Vendor notice body (`src/notices.py`, assembly only): group lines by status (scheduled, then payment sent, then paid, then awaiting approval), use one phrasing per status, and sort by date within each group. **Do not change `src/drafts.py` or `src/status_service.py` wording**: those feed the scored replies and the 100%/100% gate.
