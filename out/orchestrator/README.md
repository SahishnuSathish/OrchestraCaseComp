# Local-AI orchestrator: what was built and how to run it

Branch `feat/orchestrator`. Everything is local (Ollama on 127.0.0.1), standard library plus the existing `pydantic`. Nothing is ever sent: notices and digests are files.

## Commands

```bash
python prototype/run_orchestrated.py --out out/orch_off                       # identical to run_all.py
python prototype/run_orchestrated.py --model --workers 2 --novelty annotate --reports --out out/orch_model
python prototype/run_orchestrated.py --tickets PATH_TO_NOV19.json --model --novelty guard --reports --out out/nov19
python prototype/reports.py --out out/regex          # batch tools only, no model
python prototype/portal_server.py                    # vendor status demo on http://127.0.0.1:8790 (codes print in the console)
python webapp/server.py                              # staff pane: import out/<dir>/bundles.json
ollama pull nomic-embed-text                         # needed once, for --novelty
python -m unittest discover -s tests -v
```

## Pieces

| File | Job |
|---|---|
| `model_client.py` | Local-only `/api/chat` and `/api/embed` client. Redacts every text it sends. Refuses a non-local host. |
| `gate.py` | Skips the 9B model when regex is confident (known sender, known invoice, no cue, short thread, no unusual words, not novel). |
| `cache.py` | Disk cache of model readings keyed by model, prompt, schema and redacted text. Gated or failed reads are never cached. |
| `orchestrator.py` | Runs `pipeline.process_ticket` as a black box, optional worker pool, crash becomes an internal note. |
| `run_orchestrated.py` | CLI. All flags off = same results as `run_all.py`. |
| `brief_facts.py` | Structured facts for the staff pane: what was asked, what each record said, retrieval status, code-chosen next action. |
| `egress_guard.py` | One gate for every outward text (wraps `draft_check`, adds email, link, returned-payment checks). |
| `status_service.py`, `portal_server.py` | Read-only vendor self-service lookup and a localhost demo with a one-time code. |
| `notices.py`, `approver_digest.py`, `batch_groups.py`, `deflection_report.py`, `reports.py` | Fewer-tickets tools and the business-case numbers. |
| `novelty.py` | Embedding distance to the practice tickets; annotates, or in `guard` mode turns a reply into a note. Caution only. |
| `note_summary.py` | `--summaries`: attaches the staff-brief facts to each bundle. No model, no comment text. |

## Staff brief pane (what the employee sees per ticket)

Issue, Sources (per platform, what each lookup returned, ending in a retrieval status: complete, partial, failed or skipped), Reply, **Next** (action item), and Watch when something needs attention.
Code chooses the retrieval status and the next action from a fixed table (`brief_facts.next_action_for`): verify_fraud, manual_read, manual_handle, send_holding_and_escalate, review_and_send, escalate_to, investigate, close.
The local model may only reword. `summarize.validate` rejects a bullet that adds a number, names a different approver, says "send" when the action is not to send, omits the retrieval word, or says a payment was found when none is on file; the template bullets are the fallback.
Edits in `webapp/`: `summarize.py` (structured facts, Next bullet, validator rules, prompt/schema) and `runner.py` (structured facts at import and run time, store-aware extractor factory, crash bug fixed). Row and brief shapes are unchanged except that briefs now have 4 or 5 bullets.

## Measured on this machine (RTX 4070 Laptop, 8 GB, qwen3.5:9b), 100 practice tickets

- Orchestrator with every feature off: identical results to `run_all.py`. 100% correct, 100% safe.
- `--model --gate always`: 100 model calls, mean 3.1 s each, 100% correct, 100% safe, results identical to the no-model run.
- Same command again: 100% cache hits, mean 7 ms per ticket.
- `--gate auto`: 44% of tickets skip the model (below the 50% target, see below). No skipped ticket would have gained a cue or reference; results identical.
- Staff-brief model upgrade on 23 varied tickets: 20 passed the validator (about 3.7 s each); 3 fell back to the template.
- 74 unit tests pass. Live red-team of 12 novel phrasings: regex alone 6, regex plus model 12.
- Deflection (estimate from the practice pack): 61 of 100 tickets self-servable; 21 covered by a drafted notice; 10 pending-approval notes become 6 digests; 0 same-invoice duplicates in this batch.

## Things to know

- **Gate skip rate is 44%, not 50 to 70%.** The plan's rule (never skip a ticket whose model reading would have added a cue) forced one widening of the unusual-word net ("receivable"). Widening it further (for example "payable" or "remit") dropped the rate to 36% because those words are common in ordinary mail. Most non-skipped tickets are unknown senders (17), a regex cue already present (25), a thread of more than 2 comments (15) or no invoice on file (13).
- **Novelty runs live** (`nomic-embed-text` pulled). Embedding the 100 practice tickets takes about 51 s once (then cached); the leave-one-out 95th-percentile threshold is 0.203. On the practice set itself nothing is novel (each ticket's nearest neighbour is itself), so `--novelty guard` changes no result and safe stays 100%. On the 12 hand-written red-team phrasings it flagged both prompt-injection tickets and 2 of 3 fraud-style ones, but also 1 ordinary status request ("our new office manager started this week"). In guard mode that reply would become a note for a person: safe, but a cost. These tickets are much shorter than the practice ones, so treat the scores as rough; the real test is the unseen file.
- Self-servable counts `not_on_file` (5 tickets): the portal answers those with "send us the PDF", which saves staff time but not a vendor email.
- The Nov 19 files are not available locally, so none of this has been run on them.

## Later: document reader (not built)

There are no PDFs in the data pack. A future `doc_reader.py` would extract text from attached invoice PDFs with a local tool, redact it, run a schema reader (invoice number, vendor name, PO), and pass the result through `validator.literal_present` against the extracted text and then `lk.canonical_refs`. That validator chain is what keeps it safe to add.

## Open question for Orchestra

Would vendors accept a sign-in code sent to their listed billing address in order to check status themselves?
