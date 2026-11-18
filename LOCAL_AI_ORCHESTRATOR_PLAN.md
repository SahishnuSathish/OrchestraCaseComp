# Plan: local-AI orchestrator, cheap extraction, and ticket deflection

Written 2026-11-16 for a Sonnet agent to implement. Read this whole file before writing code.

## Design in 5 bullets

1. **Wrap the pipeline. Don't edit it.** Every new piece is a new file. The orchestrator runs `pipeline.process_ticket()` as a black box. The only thing it hands in is an extractor *wrapper* that keeps the same `.read(view) -> (reading, info)` interface, so `pipeline.py`, `extract_model.py`, `cues.py`, `rules.py` and `planner.py` don't change, and nothing collides with the agent working on the intent checker.
2. **Call the model only when it helps.** A deterministic gate skips the 9B model on tickets where regex is already confident. A disk cache makes re-runs cost nothing, and a worker pool runs tickets in parallel. Together these should cut model calls by roughly 50 to 70% and make eval loops nearly instant, with no change in decisions.
3. **Subagents are narrow local readers, and the staff brief pane is one of them.** Code dispatches each one, and each has a single job and a strict output. Novelty is measured by embedding distance and can only add caution. The **staff brief pane** (already started in `webapp/summarize.py`) works like this: code builds a structured facts packet covering what was asked, which platform returned what, whether retrieval succeeded, and the *code-chosen* next action (escalate or send after review). The local model only rephrases that packet, a validator rejects any invented number or any next step that contradicts the code, and the template bullets are always the fallback. No subagent ever makes a decision, writes a reply to a vendor, or sees bank data.
4. **Cut tickets at the source, using code.** Most of the ticket reduction comes from deterministic code, not AI. Four pieces do this: a read-only vendor self-service status lookup that reuses `rules.classify_bill` and the reply snippets; drafts of proactive "your payment is scheduled or released" notices; one approver digest per approver in place of one note per ticket; and grouping of same-invoice tickets within a batch. All of them only draft, and a person approves anything that goes out.
5. **One egress gate for every new output channel.** The portal, notices, digests and summaries all go through `egress_guard.py`, which wraps the existing `draft_check.check_reply` and adds checks for bank and email leaks and protection against invoice-number enumeration. A `deflection_report.py` turns the bundles into the business-case numbers: tickets self-servable, tickets preventable, and approver nudges consolidated.

---

## 0. Ground rules for the implementing agent

### Do NOT edit these files
Another agent owns these files, or they are load-bearing for scoring:

- `prototype/pipeline.py`, `prototype/extract_model.py`, `prototype/cues.py`, `prototype/planner.py`
- `prototype/rules.py`, `prototype/prechecks.py`, `prototype/resolve.py`, `prototype/drafts.py`, `prototype/draft_check.py`
- `prototype/run_all.py`, `score.py`, `mock_api.py`, everything in `data/`

You may **import** from all of them. If something in them truly blocks you, stop and write the needed change into `out/orchestrator/NEEDS_UPSTREAM.md`; don't patch the file.

### Shared with the UI agent: `webapp/`
`webapp/` (FastAPI `server.py`, `runner.py`, `db.py`, `summarize.py`) is owned by the UI agent. In it you may make **only the additive edits listed in section 3.3**, and only after checking `git status`/`git diff webapp/` to confirm that the UI agent isn't mid-edit on the same file. If it is, put the change in `out/orchestrator/NEEDS_UPSTREAM.md` instead. Don't rename or remove any existing function, field, bullet label or API route; the front end depends on them.

### New files only
Everything goes in `prototype/` with the names below, plus `tests/test_orchestrator.py` and `tests/test_deflection.py`.

### Hard invariants (acceptance gates)
1. **Same output with the new features off.** `python prototype/run_orchestrated.py --out out/orch_off` must write a `results.json` whose `results` array is identical to `python prototype/run_all.py --out out/regex_check`.
2. **No safety regressions.** With every feature on, `score.py` safe % must not drop compared with the same run with the features off.
3. **Model input is always redacted.** Every model call (generation or embedding) goes through `extract_model.redact()` or `build_prompt()`. No record values (amounts, bank fields, payment references) are ever sent to a model, except the staff summarizer in section 3.3, which receives only linked-ticket comment text after redaction.
4. **Local only.** Every model URL must pass `extract_model.is_local()`. If it fails, raise at start-up. Don't fall back silently to a remote host.
5. **Nothing is sent.** No SMTP, no HTTP POST to anything other than the local Ollama and the local portal. Notices and digests are files in `out/`.
6. **Standard library only.** No new pip dependencies; `pydantic` is already used. Call Ollama with `urllib` the way `extract_model.py` does (the `ollama` package isn't installed).
7. **No ticket-specific code.** No ticket ids, vendor names or sentences from the practice pack in logic or thresholds.

### Environment facts (checked)
- Windows, Python 3, Ollama binary at `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`. Python `ollama` package: not installed, and not needed.
- `run_all.py` has no per-ticket try/except. The orchestrator adds one (section 2.4).
- `out/regex/results.json` and `out/regex/bundles.json` already exist as the baseline.
- `bundles.json` is a JSON **array** (not jsonl). Sets are serialized with `default=sorted`.
- Bundles now also carry `bundle["advisory"]` (a model safety advisory string or None), written by the intent agent in `pipeline.py`.
- `webapp/runner.py` already runs `process_ticket` per ticket with its own crash handler (`error_bundle`) and accepts `Manager(extractor_factory=...)`. Briefs are stored per ticket in SQLite keyed by `summarize.facts_hash(facts)`. A `BriefWorker` upgrades template briefs to model briefs in the background after a run.
- **Known safety bug (fix in 3.3, step E):** `webapp/runner.py:error_bundle` turns a crashed ticket into `output_type: "no_draft"`. The README counts withholding an answer as a violation, and the brief says "a crash becomes a note". It must be an `internal_action_note`.
- Rules seen in the baseline: paid 21, pending_approval 9, scheduled_run 9, no_reply_sender 8, released 6, approved_no_run 6, not_on_file 5, multi_invoice 5, paid_not_received 4, and smaller counts for the rest.

---

## 1. Architecture

```
run_orchestrated.py  (new CLI)
   │
   ├─ Orchestrator (orchestrator.py)
   │    ├─ builds Store (data_layer) once
   │    ├─ builds extractor chain:  CachedExtractor( GatedExtractor( OllamaExtractor ) )   ← same .read(view) API
   │    ├─ ThreadPool over tickets ──► pipeline.process_ticket(ticket, store, extractor_chain)   [UNCHANGED]
   │    │                                 └─ crash ⇒ safe internal note bundle (2.4)
   │    └─ post-readers on each finished bundle (never change result unless a flag says so):
   │         ├─ novelty.py        (embedding distance; annotate, or optionally reply→note)
   │         └─ note_summary.py   (optional; staff-only one-paragraph history summary)
   │
   ├─ writes out/<dir>/results.json + bundles.json   (via run_all.write_outputs)
   └─ writes out/<dir>/orchestrator.json  (gate stats, cache hits, timings)

Batch tools (read bundles.json + Store; no model):
   deflection_report.py   → out/<dir>/DEFLECTION_REPORT.md + deflection.json
   approver_digest.py     → out/<dir>/approver_digests.json
   notices.py             → out/<dir>/proactive_notices.json
   batch_groups.py        → out/<dir>/same_invoice_groups.json

Staff brief pane (shared with UI agent, section 3.3):
   prototype/brief_facts.py  → structured facts + code-chosen next action (no model)
   webapp/summarize.py       → prefers brief_facts; adds "Next" bullet + stricter validator
   webapp/runner.py          → extractor_factory gets gate+cache; crash ⇒ internal note

Vendor self-service (read-only, localhost demo):
   status_service.py      → lookup_status(email, invoice_ref, store)   (pure function)
   portal_server.py       → stdlib HTTP on 127.0.0.1:8790 around status_service

Shared:
   egress_guard.py        → every new outward text passes here
   model_client.py        → tiny urllib client for /api/chat and /api/embed (local-only)
```

---

## 2. Phase 1: Cheap, fast extraction (no decision changes)

### 2.1 `prototype/model_client.py`
- `class LocalOllama(url=extract_model.OLLAMA_URL)`: raises `ValueError` in `__init__` if `not extract_model.is_local(url)`.
- `embed(texts: list[str], model="nomic-embed-text") -> list[list[float]]` calls `POST /api/embed` with `{"model", "input": texts}`. Pass the inputs through `extract_model.redact()` inside the method, so no caller can skip redaction.
- `chat_json(system, user, schema_model, model, num_predict=300)` mirrors `OllamaExtractor._chat` (temperature 0, `think: False`, `format` = schema, `keep_alive` "30m"). It returns a validated Pydantic object or raises.
- `available() -> bool`: `GET /api/tags` with a 2 s timeout.

### 2.2 `prototype/gate.py`: `GatedExtractor`
Wraps any object that has `.read(view)`. Constructor: `GatedExtractor(inner, store, mode="auto")`, where mode is one of `auto|always|never`.

`read(view)`:
1. Compute **cheap signals** from the view only. Use `store.session(NullTrace())` so the gate's lookups don't pollute the per-ticket trace (`trace.NullTrace` exists):
   - `ext = extract_regex.extract(view, lk, store.vendors)` (cheap, in memory)
   - `refs_ok`: `len(ext["invoice_refs"]) >= 1` and every ref is on file
   - `sender_known`: `lk.find_vendor_by_contact(view.sender_email)` returns non-empty, or the sender is an employee
   - `cue_fams = set(ext["cues"])`
   - `unusual`: regex for the "unusual words" net from brief §12: `\b(clause|terms?|rights?|agency|solicitor|statutory|accru\w*|surcharge|queue|exception|one-off|recover\w*)\b`
   - `long_body`: `len(view.body) > 1200`
   - `has_attachments_without_ref`: `view.attachments and not refs_ok`
2. **Skip the model** (return `(None, {"model": inner.model, "error": "gated: regex confident", "gated": True, "ms": 0, "attempts": 0, "local": True, "signals": {...}})`) only when **all** of these hold:
   - `refs_ok and sender_known`
   - `not cue_fams` (regex saw no risk, machine or HR cue at all)
   - `not unusual and not long_body`
   - `view.comment_count <= 2`
3. Otherwise call `inner.read(view)` and add `info["gated"] = False` and `info["signals"]`.

Why this is safe: when the model is skipped, the result equals the `--no-model` result, which is the scored baseline. The gate only removes model calls on tickets with a known sender, a known invoice and no risky words, where the model could at most have added a cue. The `unusual` net catches exactly the phrasing families the blind tests missed (brief §07 table).

Calibrate once: log the per-ticket gate decision to `orchestrator.json` and report the skip rate on the 100 practice tickets and both blind sets if they exist locally. Target: skip at least 50% and never skip a ticket whose model reading would have added a cue. To verify that, run `--gate always` once and diff `notes.added_cues` for the tickets the gate would have skipped. If any gated ticket gained a cue, widen `unusual`; never special-case the ticket.

### 2.3 `prototype/cache.py`: `CachedExtractor`
- `CachedExtractor(inner, cache_dir="out/.cache/model")`
- key = `sha256(inner_model_name + extract_model.SYSTEM + json.dumps(ModelReading.model_json_schema(), sort_keys=True) + extract_model.build_prompt(view))`. If the other agent changes SYSTEM or the schema, the key changes on its own.
- A hit loads `ModelReading.model_validate_json(file)` and returns `info = {..., "cache": "hit", "ms": 0}`.
- On a miss it calls inner. If `reading is not None`, it writes `reading.model_dump_json()`. Gated or failed results are never cached.
- The cache holds only the model's redacted-derived JSON: refs, vendor names, cues, a short safety reason. Add `out/.cache/` to `.gitignore` (create the file if missing; only add lines).
- Write atomically (temp file plus `os.replace`) so threads don't collide.

### 2.4 `prototype/orchestrator.py`
```python
class Orchestrator:
    def __init__(self, store, extractor=None, workers=1, post_readers=()):
    def run(self, tickets) -> list[bundle]   # preserves input order
    def _one(self, ticket) -> bundle:
        try:
            b = pipeline.process_ticket(ticket, self.store, self.extractor)
        except Exception as e:
            b = crash_bundle(ticket, e)      # see below
        for pr in self.post_readers:
            try: pr.apply(b, ticket, self.store)
            except Exception as e: b.setdefault("post_errors", []).append(f"{pr.name}: {e!r}"[:200])
        return b
```
- `crash_bundle`: `result = {"ticket_id", "output_type": "internal_action_note", "recipient": None, "reason_tag": None, "priority": False, "flags": [], "text": "The assistant could not process this ticket automatically (internal error). A person should review it from the original email."}`, plus `decision = {"rule": "pipeline_error", "why": repr(e)[:200], "act_by": None}`, `stages=[]`, `trace=[]`, `api_calls=0`. **Never put the exception text in `result.text`.** It could echo ticket content.
- Run workers with `concurrent.futures.ThreadPoolExecutor(max_workers=workers)` and collect results in order. `Store` is read-only after `__init__`. `Trace` is per ticket. Thread-safety note: `FileBackend` holds in-memory lists and dicts and is only read, so this is safe. Double-check that `HttpBackend` builds a new request per call.
- When workers > 1 and the model is on, print a hint that `OLLAMA_NUM_PARALLEL` should be at least the worker count. On an 8 GB laptop, recommend `--workers 2` with the model and `--workers 8` without it.
- Collect stats: tickets, gated count, cache hits, model calls, mean and p95 ms, crash count. Write them to `orchestrator.json`.

### 2.5 `prototype/run_orchestrated.py` (new CLI; mirror `run_all.py`)
Flags: `--tickets --data --out --api --limit --ids` (same meanings as `run_all.py`), plus:
- `--model` (off by default)
- `--gate auto|always|never` (default `auto`; only matters with `--model`)
- `--cache/--no-cache` (default on)
- `--workers N` (default 1)
- `--novelty off|annotate|guard` (default `off`)
- `--summaries` (default off)
- `--reports` runs the Phase 3 batch tools on the output

Reuse `run_all.write_outputs` and the scoring printout in `run_all.main` by importing them; copy the scoring block only if it can't be imported. With every flag at its default, this CLI must give results identical to `run_all.py` (invariant 1).

---

## 3. Phase 2: Narrow subagents (post-readers)

Each post-reader has `name` and `apply(bundle, ticket, store)`. It writes **only** into `bundle["readers"][name]`, except novelty in `guard` mode, which is described below.

### 3.1 `prototype/novelty.py`: unusual-wording detector (embeddings)
- **Reference corpus:** the redacted `subject + body` of every ticket in `data/tickets.json`. Practice tickets only. **Never read `answer_key.json`.** Embed them once with `nomic-embed-text` and cache to `out/.cache/embed/corpus_<sha>.json`.
- **Per ticket:** embed the redacted text with `build_view` → `extract_model.build_prompt(view)`. `novelty = 1 - max cosine similarity to the corpus`. Also store the id of the nearest practice ticket so the dashboard can show "most like ticket N".
- **Threshold:** set it from the corpus with leave-one-out. For each practice ticket, compute its novelty against the other 99 and set `threshold = 95th percentile`. Store the threshold in the cache file. Don't hand-tune it.
- **annotate mode:** `bundle["readers"]["novelty"] = {"score", "threshold", "nearest_ticket_id", "novel": bool}`. Results don't change.
- **guard mode** (caution only, the "net" from brief §12): if `novel` and `result.output_type == "draft_reply"` and `decision.rule != "holding_reply"`, convert the result to `internal_action_note` with `recipient=None` and keep `priority` and `flags`. Set `text = "Unusual wording: this message reads unlike past tickets, so a person should confirm the intent before replying. Proposed reply for review:\n\n" + original_text`. Set `decision.rule = "novelty_guard"`.
  - It may never touch `no_draft` or an existing note, and may never clear flags. This matches the brief's merge rules: the model can turn a reply into a note, but never into a no-draft.
- If Ollama is unavailable, write `{"skipped": "embedding model unavailable"}` and change nothing.
- Cost: one embedding per ticket, about 10 to 30 ms on GPU and about 100 ms on CPU, so it's cheap enough to run on every ticket.

### 3.2 Gate-plus-novelty combination (optional, after 3.1 works)
Let `GatedExtractor` take an optional `novelty_fn(view) -> float`. If the ticket is novel, never gate it; always call the 9B reader. That's the only coupling between the two. Add it behind `--gate auto` and record it in `signals`.

### 3.3 Staff brief pane: a local-model summary for the employee (shared with the UI agent)

**What the employee sees for every ticket** (the four things requested):
1. **Issue:** what was requested, by whom, for which invoice(s).
2. **Sources:** where the data came from (NetSuite, Payment system, Zendesk), what each lookup returned *in words* (for example "bill found: Pending Approval", "payment: none on file", "run: Scheduled for Wednesday, November 18, 2026"), and whether retrieval was **complete**, **partial** or **failed**.
3. **Reply:** what goes back to the requester, or why nothing does.
4. **Next (NEW):** the action item, *chosen by code*. One of the fixed set below, plus who acts.
5. **Watch:** fraud, injection, failed draft check, advisory or priority (unchanged).

**What already exists (don't rebuild it):** `webapp/summarize.py` has `build_facts(bundle, ctx)`, `model_packet`, `template_bullets`, `validate`, `OllamaSummarizer` and `make_brief`. It already does Issue, Sources (found or "no match" per record), Reply and Watch. It has the template fallback, the local-only check, the "no number that isn't in the facts" validator, and SQLite caching by `facts_hash`. Keep that design. The steps below fill the gaps.

**Principle:** the model never decides the action item or the retrieval status. Code computes both. The model may only reword them, and the validator rejects any bullet that disagrees with them.

#### Step A: `prototype/brief_facts.py` (new, deterministic, no model)
Why: `summarize.build_facts` currently gets intent, refs and vendor by **regex-parsing human-readable stage summaries** (`"intent=(\w+)"`, `"refs=\[(.*?)\]"`). The intent agent is actively editing `pipeline.py`, so any rewording of a stage summary silently breaks the pane. Give the pane structured facts that don't depend on that text.

```python
def structured_facts(bundle, ticket, store) -> dict
```
- Re-derive what's needed with **zero traced calls**, using `lk = store.session(NullTrace())`. Everything is in memory, so this is cheap:
  - `view = build_view(ticket, store.backend.user)`
  - `ext = extract_regex.extract(view, lk, store.vendors)`, then union in `bundle["model"]["notes"]["added_refs"]` if present
  - `sender = resolve.resolve_sender(view, lk)`
  - `items = resolve.resolve_items(ext, sender, lk)`
  - `outcomes = [rules.classify_bill(i["bill"], lk) for i in items if i["status"] == "found"]`
- Return:
  ```
  {
    "requested": {"intent", "invoice_refs", "vendor", "sender_kind", "sender_authorized"},
    "records": [ {"ref", "bill_status", "approval_status", "payment": "settled|released|returned|none",
                  "payment_date"?, "run": "scheduled|completed|none", "run_date"?, "outcome"} ],
    "retrieval": {"status": "complete|partial|failed|skipped", "missing": [ "payment record for 26390", ... ],
                  "errors": [ ... ]},
    "next_action": {"kind": <see table>, "who": act_by or None, "label": <fixed human text>}
  }
  ```
- **Records never include** amounts, `referenceNumber` for a `Returned` payment, `custbody_failure_reason`, bank fields or emails. Dates come from records only.
- **`retrieval.status`** comes from `bundle["trace"]` and `bundle["plan"]`. A missing record is not a failure (a missing payment is a valid answer). A failure means a lookup the plan called for has no trace event, or the bundle has `error`.
  - `skipped`: `plan.skipped` is true (stopped at pre-checks)
  - `failed`: `bundle.get("error")` is set, or the trace is empty while the plan wasn't skipped
  - `partial`: an invoice ref was planned but `find_bills_by_tranId` returned 0, or a linked ticket couldn't be read (`rule == "linked_ticket_unavailable"`)
  - `complete`: otherwise
- **`next_action.kind`** is a fixed mapping from `(output_type, rule, flags)`:

  | condition | kind | label |
  |---|---|---|
  | `"fraud" in flags` | `verify_fraud` | "Do not reply. Verify with the vendor through a known contact; escalate to the AP lead." |
  | rule `injection_suspected` / `model_flagged` | `manual_read` | "Read the original email before doing anything." |
  | rule `pipeline_error` | `manual_handle` | "The assistant failed on this ticket: handle it manually." |
  | `draft_reply` and rule `holding_reply` | `send_holding_and_escalate` | "Review and send the holding reply, then escalate to the AP lead (update due November 17, 2026)." |
  | `draft_reply` (other) | `review_and_send` | "Review the draft and send it if correct." |
  | `internal_action_note` with `act_by` | `escalate_to` | "Escalate to {who}." |
  | `internal_action_note`, no `act_by` | `investigate` | "A person must investigate before anyone replies." |
  | `no_draft` | `close` | "No reply needed: close the ticket ({reason_tag})." |
- `"November 17, 2026"` comes from `drafts.fmt_date(rules.HOLDING_UPDATE_DATE)`, not a literal string.

#### Step B: additive edits to `webapp/summarize.py`
1. `build_facts(bundle, ctx, store=None, ticket=None)`: if `store` and `ticket` are given, call `brief_facts.structured_facts` and fill `intent`, `invoice_refs`, `vendor`, `sender_kind` and `sender_authorized` from it. Add three new keys: `records`, `retrieval` and `next_action`. If they aren't given, keep today's regex parsing as the fallback, and set `retrieval`/`next_action` from the same mapping function, imported from `brief_facts.next_action_for(bundle)`, which needs no store.
2. `model_packet`: add `"records"` (with the record dates), `"retrieval"` and `"next_action"` (kind plus label; `who` goes through `_scrub` like `act_by`).
3. `template_bullets`:
   - Sources text becomes per platform: what was found and what it said, using `records`, and ending with "Retrieval: complete/partial (missing …)/failed/skipped."
   - Add a **Next** bullet = `next_action.label` (with `{who}` filled in).
   - The order becomes Issue, Sources, Reply, Next, Watch.
4. `LABELS = ("Issue", "Sources", "Reply", "Next", "Watch")`. In `validate`, change the count to `4 <= len(bullets) <= 5` and require `{"Issue","Sources","Reply","Next"}`.
5. New validator rules (the model can reword but not change meaning):
   - **Next consistency.** Classify the Next text with a keyword map: `send` (send/reply), `escalate` (escalate/forward/approve/ask), `close` (close/no reply), `verify` (verify/fraud/known contact).
     - It must match `next_action.kind`'s family.
     - It must contain `who`'s name or local-part when `who` is set.
     - It must never contain "send" unless the kind is `review_and_send` or `send_holding_and_escalate`.
   - **Retrieval consistency.** The Sources text must contain the retrieval status word ("complete", "partial", "failed" or "skipped"). It must not say "found" for a record whose payment or run is "none" (check per ref).
   - The existing number, link, bank and platform checks remain. Dates in `records` are added to the allowed tokens through `model_packet`.
6. `SYSTEM` and `SCHEMA`: add a `next` string field ("restate the next_action label in plain words; do not change who acts or what kind of action it is"), and tell the model to state the retrieval status. `OllamaSummarizer.summarize` maps `next` to the `Next` bullet.
7. Front end: if the pane renders bullets generically by `label`, nothing to do. If it hardcodes the labels, put "add Next bullet rendering" in `NEEDS_UPSTREAM.md` for the UI agent. Don't edit the front end yourself.

#### Step C: additive edits to `webapp/runner.py`
- In `Manager._store_ticket` (and `import_run`), pass `store` and the raw `ticket` into `build_facts`. `_work` already has both. `import_run` has the ticket; build a `Store(FileBackend(ds))` once per import.
- **Gate and cache for runs started from the UI:** let `_work` call `self.extractor_factory(store)` when the factory accepts an argument (use `inspect.signature`, keep the zero-arg form working). Then in `server.get_manager`, wire `extractor_factory=lambda store: CachedExtractor(GatedExtractor(OllamaExtractor(), store))`. This is the only place sections 2.2 and 2.3 touch the webapp.

#### Step D: brief cache and cost
- Briefs are already cached by `facts_hash`. Because facts are now structured, the hash is stable across reruns of the same data.
- Model cost: one call per ticket, in the background after the run (`BriefWorker`), so it never slows the run itself. On the 8 GB laptop, keep the BriefWorker at concurrency 1 so it doesn't fight the extractor for VRAM.
- The model never sees the raw ticket body, only `model_packet`, which already scrubs emails, money and references. Amounts are excluded from `records` at the source.

#### Step E: crash bug fix (`webapp/runner.py:error_bundle`)
Change `output_type` to `"internal_action_note"` and set `text` to the same safe sentence as `orchestrator.crash_bundle` (section 2.4). **Don't put the exception message in `text`**; keep it in `bundle["error"]` and `decision.why`, which are staff-only and not scored. Better still, import `crash_bundle` from `prototype/orchestrator.py` so both runners share one definition. Its `next_action` becomes `manual_handle`.

#### Linked-ticket history (folded in from the old 3.3, optional)
If the bundle has a found linked ticket, `structured_facts` may add `"history": [{"id", "status", "answered": bool}]` from `linked.read_linked` on the NullTrace session. Pass **no comment text** to the model. The Sources bullet can then say "Zendesk: linked ticket #N (solved, answered)." This gives most of the value of a free-text history summary with no leak risk. A free-text summary of linked comments stays out of scope for now.

### 3.4 (Later, documented only) Document reader
There are no PDFs in the data pack, so **don't build this.** Add a short section to `out/orchestrator/README.md` describing the future `doc_reader.py`. It would extract text from attached invoice PDFs with a local tool, redact it, run a schema reader (invoice number, vendor name, PO), and send the result through `validator.literal_present` against the *extracted* text and then `lk.canonical_refs`. That validator chain is what keeps it safe to add later.

---

## 4. Phase 3: Fewer tickets (deterministic, no model)

These tools target the strategic question in the case: whether to answer faster or have fewer requests arise. They read `bundles.json` and the `Store`, and they write files to `out/`.

### 4.1 `prototype/egress_guard.py` (build first; everything below uses it)
- `check_outbound(text, outcomes, refs) -> list[str]` returns `draft_check.check_reply(text, outcomes, refs)` plus:
  - any email address other than the intended recipient
  - any `custbody_failure_reason` value
  - the word "returned" combined with a payment reference
- `check_internal(text, allowed_numbers) -> list[str]`, as described in 3.3.
- `mask_email(e)` turns `zane@vendor.example` into `z***@vendor.example` for logs.
- Unit tests: bank-like strings, foreign dates and other vendors' refs are all rejected.

### 4.2 `prototype/status_service.py`: vendor self-service lookup (pure function)
```python
def lookup_status(contact_email: str, invoice_ref: str, store) -> dict
# returns {"ok": bool, "message": str, "state": str|None, "trace": [...]}
```
1. Authorization comes from records only. `lk.find_vendor_by_contact(email)` must return exactly one vendor. An employee email is also allowed if `isInactive != "T"`.
2. Resolve the ref with `lk.canonical_refs(invoice_ref)` and then `lk.find_bills_by_tranid`. Keep only bills whose `entity` is the requester's vendor. Employees may see any vendor's bill.
3. **Enumeration protection.** If there's no bill, the bill belongs to another vendor, or the sender is unauthorized, return the **same** message: "We couldn't match that invoice to your account. Please email ap@… with the invoice PDF." Use the same `ok=False` and no state. Never say "exists for another vendor."
4. Run `rules.classify_bill(bill, lk)` and map the outcome to a message:
   | outcome | portal message |
   |---|---|
   | paid | `drafts.SNIPPETS["paid"]` with `outcome_fields(o)` |
   | released | `SNIPPETS["released"]` |
   | scheduled | `SNIPPETS["scheduled"]` |
   | approved_no_run | `SNIPPETS["approved_no_run"]` |
   | pending | `SNIPPETS["pending"]` (no date, no approver name) |
   | returned, conflict, anything else | "Our team needs to review this invoice. Please contact ap@… and we'll follow up." (no reference, no reason) |
5. Pass the message through `egress_guard.check_outbound`. If it fails, return the generic "contact us" message.
6. The input is structured fields only (email and invoice ref, with the ref limited to `^[A-Za-z0-9#\- ]{1,20}$`). There's no free text, so there's nowhere to inject a prompt, no fraud surface, and no bank changes.
7. "Paid" wording appears only for the `paid` outcome, which already holds because of the snippet mapping and `check_reply`.

### 4.3 `prototype/portal_server.py`: demo-only localhost server
- Use stdlib `http.server`, bound to `127.0.0.1` only (refuse other hosts), on port 8790.
- `GET /` serves a minimal HTML form with the email and invoice number fields.
- `POST /status` with form fields `email` and `invoice`:
  - **Mock one-time code:** the first POST "sends" a 6-digit code by *printing it to the server console* and returns a code field. The second POST with the code calls `lookup_status`. Codes expire in 10 minutes. In a real deployment this becomes a magic link emailed to the vendor's listed contact address. Document that, and note that the email goes only to an address already on the vendor record, never to an address the user types in.
  - **Rate limit:** 5 lookups per email per 10 minutes and 20 per IP, both in memory.
  - Log the masked email, the ref and the outcome state to `out/portal_log.jsonl`. Never log the message text.
- The server never writes records, never sends email, and never calls the model.

### 4.4 `prototype/notices.py`: proactive status-notice drafts
- For every vendor with at least one bill in a state that vendors typically ask about, draft one notice per vendor contact address (the vendor `email`), listing each bill with a `multi_invoice` line snippet (`drafts.SNIPPETS["line_*"]`). The states are:
  - `scheduled` on a `Scheduled` run in the next 10 days
  - `released` but not settled
  - `paid` with `tranDate` in the last 3 days
- Skip a vendor if any of its open bills is `returned` or `conflict`, or if the vendor is inactive.
- Every notice goes through `egress_guard.check_outbound`. Output `out/<dir>/proactive_notices.json` as a list of `{vendor_id, to, bills: [...], text, status: "draft_pending_approval"}`.
- The report counts how many of the current batch's tickets had a notice covering the same vendor and invoice. That's the "would have been prevented" metric.

### 4.5 `prototype/approver_digest.py`: one nudge per approver
- From bundles whose `decision.rule in {"pending_approval", "pending_inactive_approver"}` and that have an `act_by`, plus (optional switch `--all-pending`) every `Pending Approval` or `Pending PO` bill in the Store, group by `act_by`.
- Each digest has the approver's name, the list of bills (tranId, vendor name, `userTotal` from the record, days pending computed from `tranDate` against `rules.SNAPSHOT`), the related ticket ids, a "stuck > 14 days" mark (`rules.approval_stuck`), and the inactive-approver delegate note.
- It's internal, so amounts are fine, but bank fields are still excluded and `check_internal` still runs.
- Output `approver_digests.json` and add a summary line to the report: "N pending-approval notes become M digests."

### 4.6 `prototype/batch_groups.py`: same-invoice grouping within a batch
- Group bundles by `(vendor_id, frozenset(found refs))` using the `lookups` stage data. You may need to re-resolve with `resolve.resolve_items` on a NullTrace session if the bundle doesn't carry vendor_id and refs in structured form. Check `bundle["stages"]` first; if the data isn't structured, re-run extraction plus resolve with NullTrace.
- Groups of 2 or more mean staff answer once and link the rest. This is an annotation only; `results.json` isn't changed. Write `same_invoice_groups.json`.

### 4.7 `prototype/deflection_report.py`: the business-case numbers
Reads `bundles.json` and the outputs from 4.4 to 4.6, and writes `DEFLECTION_REPORT.md` and `deflection.json`:
- **Self-servable:** a ticket counts as self-servable when all of these hold:
  - the sender kind is `vendor_contact` or `employee` and authorized
  - the rule is in `{paid, released, scheduled_run, approved_no_run, pending_approval*, not_on_file, multi_invoice}`
  - there are no risk cues
  - there's no fraud flag

  The report shows the % of tickets and the count, broken down by rule. (*pending_approval counts because the portal's "pending internal approval" answer is enough for the vendor; the internal nudge still happens through the digest.)
- **Preventable by a notice:** the share covered by 4.4.
- **Approver consolidation:** N notes become M digests.
- **Within-batch duplicates:** the count of grouped tickets.
- **Model cost:** gate skip rate, cache hit rate, model calls per ticket, mean ms. This comes from `orchestrator.json`.
- Scale to the case's figures (2,000 to 2,300 tickets a month, about 1 in 5 of them payment status) and **label the result clearly as an estimate from the practice pack.**

---

## 5. Tests (`tests/`, stdlib `unittest`, no Ollama needed)

Use a `FakeExtractor` with `.model = "fake"` and a canned `read()`, and a fake `LocalOllama` for embeddings (fixed vectors).

1. `test_orchestrator.py`
   - With features off, the orchestrator's results equal `run_all.run(...)` results for all 100 tickets.
   - `GatedExtractor` never calls inner on a fixture that meets every skip condition, and always calls inner when the body contains "clause", "solicitor" or "queue", when the sender is unknown, or when there's no ref.
   - `CachedExtractor`: the second read is a hit, the inner call count is 1, and a `None` reading isn't cached.
   - A crash bundle comes from a pipeline that raises (monkeypatch `pipeline.process_ticket`). The result is an `internal_action_note` and the text doesn't contain the exception message.
   - With `workers=4`, the order and content match `workers=1`.
2. `test_novelty.py`
   - Guard mode turns `draft_reply` into a note. It leaves `no_draft`, existing notes and `holding_reply` alone, and keeps flags.
3. `test_deflection.py`
   - `lookup_status` returns the same message for an unknown ref, another vendor's ref and an unauthorized email.
   - A returned or conflict bill gets the generic message with no reference.
   - No output from `status_service`, `notices` or `approver_digest` matches `draft_check.LONG_NUMBER` or `BANKISH`.
   - For each outcome, a settled-paid bill is the only case whose message contains "paid on".
4. A red-team pass: if a red-team ticket file exists locally, run the orchestrator with `--novelty guard`. Safe must stay at 100%. `tests/redteam_live.py` and `tests/test_model_guards.py` already exist; run them and don't modify them.
5. `test_staff_brief.py` (uses `out/regex/bundles.json` and `data/tickets.json`, no Ollama):
   - For all 100 bundles, `structured_facts` returns a `next_action.kind` from the fixed set, and `template_bullets` passes `validate`.
   - Mapping spot checks: fraud gives `verify_fraud`; a `pending_approval` note gives `escalate_to` with `who == decision.act_by`; `no_reply_sender` gives `close`; `holding_reply` gives `send_holding_and_escalate`.
   - Retrieval: a pre-check stop gives `skipped`; the 41262-style pending bill gives `complete` with payment "none"; an `error_bundle` gives `failed`.
   - The validator **rejects** fake model bullets that:
     - say "send the draft" on an internal note
     - name a different approver
     - omit the retrieval word
     - include an amount
     - say "payment found" when the payment is "none"
   - `records` never contains `userTotal`, `referenceNumber` of a returned payment, or `custbody_failure_reason`.
   - `error_bundle` produces `internal_action_note`, and its `result.text` doesn't contain the exception message.

---

## 6. Build order and checkpoints

| Step | Build | Checkpoint |
|---|---|---|
| 1 | `model_client.py`, `egress_guard.py` + tests | unit tests pass |
| 2 | `orchestrator.py`, `run_orchestrated.py` (no gate/cache yet) | **Invariant 1**: identical results vs `run_all.py`; crash test passes |
| 3 | `cache.py`, `gate.py` | with `--model --gate always` twice: second run 100% cache hits, results identical; record skip rate with `--gate auto` |
| 4 | `status_service.py`, `portal_server.py` | enumeration and egress tests pass; manual demo: one authorized vendor sees a scheduled bill |
| 5 | `approver_digest.py`, `notices.py`, `batch_groups.py`, `deflection_report.py` | report generated on `out/regex` bundles |
| 6 | `novelty.py` (annotate → guard) | leave-one-out threshold stored; guard tests pass; safe % unchanged |
| 2b | **Staff brief:** `brief_facts.py`, then the `webapp/summarize.py` and `runner.py` edits (3.3 A to C), then the crash fix (3.3 E) | `test_staff_brief.py` passes; open the webapp, import `out/regex/bundles.json`, and every ticket shows Issue/Sources/Reply/Next with a retrieval status; the model upgrade passes `validate` on most tickets, and the rejected ones fall back to the template |
| 7 | Linked-ticket history in the brief (optional, 3.3) | no comment text reaches `model_packet` |
| 8 | `out/orchestrator/README.md`: commands, what each piece does, measured numbers | — |

Commit after each step on a branch `feat/orchestrator` (don't commit to `main`). Don't stage `out/.cache/`.

### Commands the README should list
```bash
python prototype/run_orchestrated.py --out out/orch_off
python prototype/run_orchestrated.py --model --workers 2 --novelty annotate --reports --out out/orch_model
python prototype/run_orchestrated.py --tickets PATH_TO_NOV19.json --model --novelty guard --reports --out out/nov19
python prototype/portal_server.py
python webapp/server.py        # staff pane: import out/<dir>/bundles.json, briefs upgrade in background
ollama pull nomic-embed-text
```

---

## 7. How this maps to the brief and the case

- **"Code decides, records supply facts, model only reads"** still holds. The gate, cache and orchestrator are plumbing. Novelty can only add caution. The summary is staff-only and gated.
- **Brief §12 "Before November 19":** the "net for unusual words" is §2.2 `unusual` plus §3.1 guard mode.
- **Brief §12 "Propose for later":** vendor notices (§4.4), a self-serve status view (§4.2 and §4.3), and an approver-aging report (§4.5). These are now demonstrable prototypes; label them as such in the deck.
- **Case questions:** "redesign so fewer requests arise" is answered by `DEFLECTION_REPORT.md`. "Fit existing tools" is answered by the fact that `status_service` takes the same `Store` (and so `HttpBackend` and `--api`) and would sit behind Orchestra's vendor portal or a Zendesk help-center widget.
- **Open question for Orchestra (add to Tuesday's list):** "Would vendors accept a sign-in code sent to their listed billing address in order to check status themselves?"
