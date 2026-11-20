# The 30 unseen tickets (Nov 19): what Conductor did, and what it means

Orchestra sent 30 tickets we had never seen, in the same format as the practice set, with no answer key. Every one went through the same pipeline the app uses: `python src/run_all.py --tickets unseen_tickets.json`.

**Run.** It took about 1 second for all 30, with no model, and made 4.0 record lookups per ticket. A second run used the local model (`qwen3.5:9b`) as a second reader, at about 6 seconds per ticket. **The model agreed with the rules on all 30 decisions.** The rules decide; the model is a cross-check that can only add caution.

**Outcomes:**
- **12 draft replies** a person can approve.
- **11 internal notes**: a person must act first.
- **7 no-reply**: nothing to answer.

None were sent. Every outbound reply waits for a person.

## Two misses, found and fixed the same day

We read every output against the case's rules and order of checks. Two were wrong on the first run:

| Ticket | What it is | First result | Why it was wrong | Fixed result |
|---|---|---|---|---|
| **41758** | "Ben from Foxglove Talent" asks for payment details from a personal freemail address, "because I'm out of the office" | No reply (automated notice) | The words "out of the office" triggered the auto-reply detector, but a person was asking for something. The sender is not on the vendor's contact list. | **Internal note**: unknown sender, do not share payment details, verify through the contact on record |
| **41770** | "Thanks for confirming, much appreciated!" above our own forwarded AP reply | Draft reply asking for a PDF | The forwarded text ("Subject: Re: … payment", "let us know") made a thank-you look like a question | **No reply** (`no_request`) |

**The fix.** An out-of-office phrase no longer counts as an automated notice when the message still asks for something. And when an email quotes or forwards earlier mail, the "is this only a thank-you?" check reads only the sender's own words. Both have regression tests (`tests/test_prechecks_unseen.py`). **The practice set still scores 100% correct and 100% safe.**

## Every ticket

| # | Subject | Result | Rule |
|---|---|---|---|
| 41723 | Question about payment of our invoice | Draft reply | `paid` |
| 41729 | Missing pay stub | No reply | `misrouted` (HR/payroll) |
| 41737 | URGENT payment needed today | Internal note | `fraud` (lookalike domain + sign-in link) |
| 41738 | Document signed: completed | No reply | `machine_notice` |
| 41740 | Invoice status | Draft reply | `paid` |
| 41741 | Quick question + new bank info | Internal note | `fraud` (bank change; numbers withheld) |
| 41743 | FT62395 payment? | Draft reply | `released` |
| 41744 | Fwd: Verdigris Signage invoice 34786 | Draft reply (to the employee) | `paid` |
| 41750 | Fernhollow Photo INV-15303 | Internal note | `records_conflict` (Paid In Full, no payment) |
| 41755 | re: 2026-3347 | Draft reply | `paid` |
| 41758 | Payment details for FT52537? | Internal note | `unauthorized_sender` (fixed) |
| 41765 | Could invoice 2026-32895 be paid early? | Internal note | `expedite_request` |
| 41770 | Fwd: Thistledown Staffing payment | No reply | `no_request` (fixed) |
| 41773 | Imani Okoye-Reed invoice 2026-6081 | Internal note | `pending_approval` |
| 41777 | Invoice Reminder A-92254 | No reply | `no_reply_sender` |
| 41783 | Question regarding a payment | Internal note | `paid_not_received` (verify with the bank) |
| 41784 | Following up on INV-93806 | Draft reply, **priority** | `holding_reply` (CEO copied) |
| 41790 | Ironbark Rentals invoice | Draft reply | `scheduled_run`: **Wednesday, Nov 25** (Thanksgiving week, handled) |
| 41794 | Fwd: Invoice from your agency | No reply | `misrouted` (a client paying us: AR) |
| 41800 | Fwd: Invoice A-38569 status | Internal note | `pending_approval` |
| 41803 | Past due account notice | Draft reply, **priority** | `holding_reply` (collections threat) |
| 41811 | Fwd: Invoice 2026-85572 | Internal note | `returned_payment` (no reference shared) |
| 41820 | Kestrel Hollow Web 2026-88302 | Draft reply | `paid`: the email's "$794.66, due Sep 19" is **not** repeated; the reply uses records only |
| 41829 | Question about one invoice | No reply | `unresolved_account` (10004 matches two vendors) |
| 41832 | Follow-up on outstanding invoice | Draft reply | `not_on_file` (asks for a PDF) |
| 41841 | Invoice submitted, Ninebark Surveys | Internal note | `not_on_file_linked` (linked ticket #3000 holds it) |
| 41848 | oxbow invoice | Internal note | `pending_inactive_approver` (goes to the delegate) |
| 41857 | Following up on my earlier note | No reply | `duplicate` (linked #3004 already answered) |
| 41862 | INV-50405 paid? | Draft reply | `approved_no_run` (5 to 10 business days, no date) |
| 41864 | Open invoices, Ironbark Rentals | Draft reply | `multi_invoice`: paid, scheduled and pending, one line each |

## What this tells us (for the deck and Q&A)

**Strengths**
- **Records over claims.** #41820 quotes an amount and due date; the reply uses only NetSuite's facts. #41864 answers three invoices in three different states in one reply, and gives no date for the pending one.
- **The dangerous ones are caught first.** Lookalike domain plus sign-in link (#41737), a bank change hidden in a friendly status question (#41741), and a payment-details request from a personal address (#41758). None of them can produce a reply.
- **Calendar and records edge cases:** the Thanksgiving-week run (#41790), a records conflict (#41750), a returned payment (#41811), an inactive approver's delegate (#41848), an ambiguous invoice number (#41829), and a linked ticket that holds the invoice (#41841).
- **Not everything needs a reply.** Payroll (#41729), a client paying us (#41794), no-reply mail (#41777), e-signature notices (#41738), a duplicate (#41857) and a thank-you (#41770) each get a one-line reason and leave the queue.

**Limits (and why a person reviews everything)**
- **Wording traps.** The two misses came from wording the rules had not seen ("out of the office" inside a real request, a thank-you above a quoted thread). The fixes are small and tested, but new phrasings will keep appearing. That is why every output is a draft or a note, and a person approves.
- **Priority holding replies say "our Accounts Payable lead"** while the CFO signs them off in Conductor. The wording is the case's; we kept it because changing reply text is scored.
- **No attachment reading.** "Our statement is attached" (#41723, #41864) is not opened; the answer comes from NetSuite. A statement that disagrees with NetSuite would need a person.
- **Unknown or new senders** always go to a person, never to an automatic answer.

**When a person must act** (11 of 30 here)
- possible fraud
- an unknown sender
- early-payment requests and late fees
- returned payments
- paid-but-not-received claims
- records that disagree
- an invoice not yet entered (linked ticket)
- anything waiting on an approver (Conductor drafts the reminder; a person sends it)

Priority replies (legal threat, collections, executive copied) are drafted, but go out only after the CFO signs off.
