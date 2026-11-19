# Demo runbook

Run both servers at once, each in its own terminal, from the repo root.

Start Conductor (port 8790):

```bash
python dashboards/conductor/server.py
```

Start the vendor portal (port 8791):

```bash
python dashboards/vendor_portal/server.py
```

Open `http://127.0.0.1:8790` for Conductor and `http://127.0.0.1:8791` for the portal. Both bind to 127.0.0.1 only.

## What to show
1. **Review queue.** Open a reply, read the draft, approve it, then send. Nothing goes out without the approve step.
2. **Ticket chat.** Open one ticket and ask a question about it. The local Qwen model answers from that ticket's records.
3. **Scheduled send.** Approve a reply, then schedule it for later instead of sending now.
4. **Prevent page.** Show the demo chain on a real invoice. Headless: `python src/demo_prevention.py`.
5. **Portal lookup.** In the portal, enter a vendor email and an invoice number. Read the 6-digit code from the portal terminal (it is printed there, not emailed). Enter it to see the status. Try an unknown email: the answer is the same.

Items 1 to 4 come from other features built alongside this one. Item 5 is this page.
