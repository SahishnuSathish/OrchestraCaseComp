# Direction

Written by the orchestrator in Phase 0 (unslop step 4; the "wait for the user" step is waived for this unattended run).
The landing-look decision is appended at the end once the three looks have been reviewed.

## The five lines

- **Product.** An accounts-payable inbox that reads every vendor email, matches it to the NetSuite records and drafts the
  answer, so Orchestra's AP team approves instead of researching; plus Direct, where vendors see where their invoices stand.
- **Character.** Composed, exact, quietly warm. A finance leader should feel *it has already been checked*.
- **World.** A conductor's score on a ledger desk: warm off-white paper, printed staff lines, deep forest-green ink,
  a brass-pale highlight, the hush of a hall before the downbeat. Rhythm and alignment are the material.
- **Moments.** (1) The sign-in hub's art: the score and its one swelling line. (2) "What Conductor found", the insight
  strip on the review screen: the product's proof, raised and lit. (3) The Ahead hero figure with a single crescendo
  line. (4) The "sent" confirmation. Everything else stays quiet.
- **Signature.** The **staff rule**: five fine parallel lines (1px, 4px apart) that mark the start of a moment, and only
  a moment: the hub art, the insight strip header, the Ahead hero, the sent receipt. Never a general divider, never on
  working rows.

## Rules that follow

- **Quiet chrome, one bright element per screen.** Working surfaces (inbox list, reading pane, tables, forms) keep
  their density and calm. Richness goes only into the four moments above.
- **Neutrals tinted toward the world**: a warm green-grey paper ramp instead of pure grey, so the green chrome and the
  pages belong together. Surfaces stay near-neutral; the world shows in the moments.
- **Orchestra green `#223307` is the anchor** (chrome, primary action, display ink). A deeper ink-green ramp gives the
  chrome depth (a 2-stop tone shift inside one hue, never hue to hue).
- **Decorative color is never a status color.** Status keeps mint/green = settled, sky/navy = scheduled, peach = waiting,
  crimson = risk, always with icon and words. Decorative accents (a pale brass and a deep "hall" ink) are only used in
  art and moments, and never on the same element type as a status chip.
- **Type**: Geist for the interface, Geist Mono for IDs and figures, Bricolage Grotesque for headings, and **Instrument
  Serif for one editorial moment per screen at most** (the hub headline, the Ahead promise, big empty-state lines).
- **Depth**: soft radii (controls 8, cards 12, panels 14 on landing surfaces; working panes stay at 0-6 where they tile)
  and a short elevation scale of neutral, layered shadows. Floating layers get the higher steps.
- **Motion**: one ease-out curve, 120-240 ms in response to actions; one short entrance per page; ambient motion only on
  the hub and only within the performance budget; everything has a designed static state under reduced motion.
- **Template check**: if the product name were swapped for another, the hub art, the staff rule and the insight strip
  would no longer fit. That is the test.

## Decision: the landing look (Tier 1, step 4)

**Default: A "Score".** All three stay in the branch (`/?look=a|b|c`); the owner chooses in the morning.

Why A, in my own ranking (it agrees with the blind reviewer, `looks/REVIEW.md`, A 4.1 > C 3.5 > B 3.4):
1. **It continues into the product.** The app behind the sign-in is a light, paper-and-ink workspace. A's warm paper,
   printed staves and green ink are the same world, so sign-in → handshake → inbox reads as one place. B's dark
   stage is a beautiful room you then leave.
2. **Credibility for this audience.** Business and HR leaders read A as a well-set financial document; B's dial
   leans toward trading terminals; C is pleasant but generic.
3. **It is the brand mark at page scale** (staff lines + one swelling sweep), so the identity is learned on the first
   screen and recognised in every later moment (the staff rule).
4. **Cheapest to run**: two static SVGs and one compositor-only breathing layer.

What I would take from the others into Tier 2+: B's handshake confidence (the art carrying the hand-off) and its
precise mono details for figures; C's rounded friendliness for the vendor side (Direct).

**Language for Tier 2+ (from A):** warm paper canvas, green ink, the editorial serif for one line per screen, the staff
rule marking each moment, brass only as a single thread of light inside art, white sheets with soft layered shadows
for floating things, and hairlines everywhere else.


## Owner's choice (Nov 20, after the run)

The owner picked **look B "Instrument"** as the permanent default (`DEFAULT = 'b'` in `js/hub/looks/index.js`). A and C remain reachable with `/?look=a|c` until deleted (see HANDOFF.md section 2).
