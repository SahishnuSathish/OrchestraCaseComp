# Audit: what makes each page feel dead (Phase 0, before)

Screens: `shots/before/<page>@{375,1440}.jpg`. Checked against unslop `references/signs.md` and by eye.

**Verdict in unslop's terms: light slop, heavy blandness.** There is almost no AI slop: no purple gradients, no glows, no
emoji, no uppercase tracked labels, sentence case, tabular figures, honest copy. The problem is the opposite: the system
was built as "square, hairlines only, color for status only", so every surface is the same white box on the same grey,
nothing has depth, and no screen has a bright element. It reads like a well-made internal admin tool, not a product a
finance leader would show. The fix is not to remove slop but to add character in a few deliberate places, while keeping
the working surfaces quiet.

## Ranked by audience exposure

### 1. Sign-in hub (`/`) and handshake
- **Flat green slab** on the left: one solid `#223307` panel, no texture, light or depth. The "staff lines" idea is in the
  CSS comment (hairlines between proof points) but invisible as an idea.
- The **right half is a white box on grey `#efefef`** with a 1px border: the default auth card of every template.
- Headline (`Accounts payable email, read and matched…`) is good copy but set like body text scaled up: Bricolage medium,
  no editorial moment, no contrast in type.
- Proof points are three plain list rows; the family list is tiny marks with text. Nothing is memorable.
- The **mark** (a diagonal stroke and a small diamond in a mint square) reads as a pen nib / baton; it is close to the
  clip-art the brief bans, and at 16px it is a mint square with a smudge.
- At 375 the green band is a short header, then the white card: no art, no brand moment at all.
- The **handshake** is a white card centered on blank grey with a spinner list: the brand disappears exactly when the
  person is waiting and looking.
- Signs: "template look" (white card on grey), "a hero visual that is an empty box".

### 2. Inbox, ticket review, composer (`#/inbox`, `#/inbox/<id>`)
- Top bar and rail are good bones; the rail is white with a mint active tile, the top bar a flat green band. No depth
  between chrome and content.
- Every pane is white with grey hairlines; the selected row is mint with a 3px green bar. Panes have equal visual
  weight, so the eye has no entry point.
- The **insight strip** ("They want / Records say / Sender / Why") is the product's best moment and is styled like
  every other box: a grey hairline grid on white with a green left bar. It should be the one bright element of the
  review screen.
- The "While you were away" card is a hairline box with three hairline cells: correct, but lifeless.
- Status badges are flat square tags (`Draft ready`, `Verified contact`, `Needs sign-off`, `Legal`); good semantics,
  but crowded next to each other and all the same shape as reference chips.
- Signs: "every element the same weight", "table row states barely read apart" (hover vs selected vs focus).

### 3. Conductor: Ahead, Escalations, Team, Waiting on you (approver)
- **Ahead**: the hero number "19 tickets prevented" is the right idea (one big figure) but sits in a hairline box with
  a dark top border, next to four equal stat cells: unslop's "equal cards side by side". No visual says "ahead of the
  question".
- **Team**: five equal KPI cells in a row, then two equal chart cards; bars are one flat navy, which collides with the
  navy "scheduled" status meaning. No chart leads.
- **Escalations**: an empty right pane with an icon in a square and "Choose a ticket": a dead empty state taking 60% of
  the screen.
- **Approver**: a dense table with flat chips; fine as a working surface, no character in the header.

### 4. Conductor: Direct (vendor `/direct`)
- Navy top bar and a second navy tab band: heavy, corporate, the least friendly part of the product, yet it is the
  vendor-facing side.
- Invoice table: 10 identical sky-blue "Approved, typically paid within 5 to 10 business days" chips in a column; the
  page is one long repeated pill. Status needs a calmer rhythm (dot + short label, details on the row).
- The W-9 banner is a peach slab: correct meaning (waiting), but it is the loudest thing on the screen.
- Messages / Updates empty states are bare text.

### 5. The rest (Settings, Connections, Advanced, Vendor setup, style guide, 404)
- Settings and Advanced: long hairline forms; fine for their job.
- 404 (`not-found`): plain text on grey.
- Loading: skeleton bars are grey blocks that do not match the final layout in places; Direct's boot is a bar.

## Cross-cutting
- **Type**: one display family (Bricolage) used at medium weight everywhere; Instrument Serif is installed but unused.
  No editorial contrast. Sizes jump 20 → 28 → 34 with nothing between.
- **Color**: the neutral ramp is pure grey (`#efefef`, `#d8d8d8`), not tinted toward the green world, so the green
  chrome sits on a cold page.
- **Depth**: zero radius, zero shadow on every surface. Floating layers (menus, toasts, modals) have one shadow.
- **Motion**: 120-200 ms fades only; no press feedback, no arrival moments, no "sent" moment.
- **Icons**: one Lucide set, consistent; keep.
- **Copy**: clear and specific; keep. No changes needed for the upgrade.
