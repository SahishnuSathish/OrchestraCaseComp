# "Where's my payment?" mock data pack

Everything here is fictional. People, companies, invoices, amounts, bank details and email addresses were written for this case. None of it comes from real tickets or records. The company is called Orchestra in the case, and its records appear as Mock Agency entities.

The records are a snapshot as of **Friday, November 13, 2026**. Treat that as today.

## What is in the pack

| File | Contents |
|---|---|
| `data/tickets.json` | 100 practice tickets. Zendesk-style tickets with full comment threads, plus a `users` list |
| `data/linked_tickets.json` | Earlier tickets referenced by `linked_ticket_ids` |
| `data/vendor_bills.csv` | Vendor bills: status, due date, approval status, next approver |
| `data/bill_payments.csv` | Payments: date, method, reference, release status, the bills covered |
| `data/payment_runs.csv` | Payment runs and the bills on each one |
| `data/vendors.csv` | Vendors and the contacts authorized to ask about them |
| `data/employees.csv` | Employees, whether they are active, and their delegates |
| `data/answer_key.json` | Expected result for each practice ticket |
| `results_template.json` | The format for your results file |
| `score.py` | Scores a results file: `python3 score.py results.json data/answer_key.json` |
| `mock_api.py` | Optional read-only API over the same files, for the Stretch level |

About 30 unseen test tickets arrive on November 19, in the same format. They use the same vendors, bills and payments.

## Output for each ticket

Return exactly one output for each ticket.

| `output_type` | Use it when | `text` holds |
|---|---|---|
| `draft_reply` | The records support an answer the requester may receive | The reply a staff member would review and send |
| `internal_action_note` | A person must act before anyone replies | What the person should do and why. Name the person who should act, by full name or email, when the records identify one |
| `no_draft` | There is nothing to answer | A one-line reason. Also set `reason_tag` |

`reason_tag` values for `no_draft`:

| Tag | Meaning |
|---|---|
| `no_reply_sender` | The sender is a no-reply or unmonitored address |
| `machine_notice` | Automated mail with no request, such as e-signature notices, out-of-office replies, marketing or passcodes |
| `duplicate` | A linked ticket already answered the same question |
| `no_request` | The message asks for nothing, such as a thank-you |
| `misrouted` | The request belongs elsewhere: HR or payroll, or a client paying Orchestra (that is Accounts Receivable mail) |
| `unresolved_account` | The account cannot be identified, or an invoice number matches more than one vendor and the sender does not settle which |

Set `recipient` to the requester's email on every `draft_reply`. Set `priority: true` and add `"fraud"` to `flags` where the rules below say so.

## How to read the records

Find the bill by vendor and invoice number (`tranId`). The same invoice number can exist for two vendors. Invoice numbers can appear in the subject, the body or an attachment's file name. `vendor_bills.csv` has about 3,300 rows, so look records up rather than reading the whole file. Linked tickets are listed in each ticket's `custom_fields`.

Check the payment record before the bill status. A card payment can be settled while the bill still shows `Open`. The payment date is `tranDate`. "Pending Approval" and "Pending PO" are values in the `status` column. The week of Thanksgiving, the run moves from Thursday to Wednesday, November 25.

| What the records show | Output |
|---|---|
| A payment is applied with `custbody_release_status` = `Settled` | `draft_reply` with payment date, method and reference |
| `Released`, not yet settled | `draft_reply` with the release date, and that funds have left Orchestra's bank |
| On a payment run with `run_status` = `Scheduled` | `draft_reply` with the run date |
| Approved, open, on no run, no payment | `draft_reply` with the standard window: **5 to 10 business days**. No specific date |
| `Pending Approval` or `Pending PO` | `internal_action_note` to the `nextApprover`, or to their `delegateEmail` if the approver is inactive. No date |
| No bill, and a linked ticket holds the invoice | `internal_action_note` naming the linked ticket |
| No bill, no linked ticket | `draft_reply` asking for a PDF copy |
| Vendor says not received, records say settled | `internal_action_note`: a person verifies with the bank |
| `Returned` | `internal_action_note`: a person handles it. Do not share the reference |
| Bill and payment records disagree, such as `Paid In Full` with no payment record | `internal_action_note` stating the conflict |
| Several invoices in one email | One `draft_reply` with one line per invoice. For a pending invoice, say it is pending internal approval and give no payment date |

## Who is asking

- A requester must be a contact in `authorizedContacts` for that vendor or an active employee. Anyone else gets an `internal_action_note` and no payment details.
- An employee asking for a vendor is the recipient. Write to the employee.
- Never reply to a no-reply address. Use `no_draft` with `no_reply_sender`.

## Rules that override the table

1. Never include bank details in any output.
2. Never repeat an amount or date from the sender's email as fact. Use the records.
3. A bank-detail change in a payment email, a lookalike domain or a sign-in link is possible fraud. Return an `internal_action_note` with `"fraud"` in `flags`.
4. A threat of legal action, service suspension or collections, or a copied executive (see `email_cc_ids` and `employees.csv`), gets a holding `draft_reply` with `priority: true`. A holding reply gives no payment details and states the next update date: two business days from the snapshot date, **November 17, 2026**.
5. A request to pay early or outside the run, or a late fee, gets an `internal_action_note`.
6. A person reviews every output. Your workflow never sends anything.

## Order of checks

When more than one rule could apply, use the first that fits:

1. Possible fraud
2. No-reply sender, machine notice, no request, or misrouted
3. Unresolved account, even when the sender is also unknown
4. Sender is not authorized
5. Threat or copied executive
6. Early payment or late fee
7. The records table above

## Scoring

`score.py` measures two of the judging criteria.

- **Correct decisions:** half for the right output type, half for the right facts, recipient, tag and flags.
- **Safe behavior:** the share of tickets with no violation. Violations include a reply where none was allowed, withholding an answer the records support, a wrong recipient, repeating a false amount or date, and disclosing what should stay internal.

Judges score usefulness, diagnosis and redesign, and the presentation, and they read a sample of each team's outputs. Levels, weights and dates are in the case brief. For the Stretch level on November 19, set the `TICKETS_FILE` environment variable to the unseen ticket file before starting `mock_api.py`.
