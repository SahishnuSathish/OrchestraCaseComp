# Prevent demo on one real invoice

Shows the whole prevention chain on one invoice from the data pack. Nothing leaves this computer.

## What it shows

1. Draft. A notice is built from the records: the invoice's status and its amount and open balance (`status_service.balance_line`). It passes `egress_guard.check_outbound` before it is stored.
2. Approve. A person approves it.
3. Send. Simulated: an `.eml` in the outbox. Recipient, subject and body come from the stored draft, never from the request. The records are rebuilt first. If the text differs, the send is refused with 409.
4. Vendor lookup. The vendor's own status lookup for that invoice gives the same status and balance as the notice.

Then the page names the ticket the notice would have prevented (`notices.coverage`).

## Which invoice

Chosen by `notices.pick_demo_bill`, not by hand. It takes the pending-approval bill that has waited longest (oldest `tranDate`, then `internalId`) and already produced a ticket. The vendor must be active, have an email on record, and have no returned or conflicting bill. The invoice number must be unique. On the practice data this is invoice 26390 (Oxbow Courier Service, USD 18,325.62), which would have prevented ticket 41262. The CSVs are not edited.

## Commands

    python src/demo_prevention.py
    python src/demo_prevention.py --out <folder>

It prints the chosen invoice and the four steps, and exits 0 when the chain holds. The default output folder is under the system temp folder, not the repo.

## On the page

Open a finished run, then Prevent (`#/runs/<runId>/prevent`). The "Demo on one invoice" section at the top has the four steps. Click Draft notice, Approve, Send. The last step shows the lookup answer and the prevented ticket.

Endpoints, all behind the token: `GET /api/runs/{id}/prevention/demo`, `POST .../demo/draft`, `.../demo/approve`, `.../demo/send`.
