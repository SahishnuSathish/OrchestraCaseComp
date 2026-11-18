# PLAN: "Where's my payment?" prototype

Snapshot date: Friday 2026-11-13 (treated as today). Read-only over `data/`. Never sends, never writes records.

## Principle
Code decides, records supply facts, the model only reads messy text and can only make things safer.

## Module layout (`prototype/`)

| Module | Job |
|---|---|
| `trace.py` | `Trace` object: every lookup appends `{seq, platform, action, endpoint, key, result_count, ms}` |
| `data_layer.py` | `Store` with exact-key lookups (vendor by contact/domain/name, bill by tranId, payments by bill, run by bill, employee by email, linked ticket by id, user by id). `FileBackend` reads CSVs/JSON; `HttpBackend` calls `mock_api.py` (`--api`). Rules code only sees `Store` methods. |
| `ticketing.py` | Normalizes a Zendesk ticket: requester, end-user-only text, attachment names, cc users, linked ids |
| `prechecks.py` | Fraud cues, no-reply, machine notice, no-request, misrouted (HR, AR). Pure functions over ticket text + sender |
| `extract_regex.py` | Invoice references (subject, body, attachment names), vendor-name hints, intent + risk cues via keyword families |
| `extract_model.py` | Phase C: same output shape via `qwen3.5:9b` in Ollama, schema-constrained JSON, redacted input |
| `validate.py` | Drops any extracted reference not literally present in ticket text (normalized) |
| `resolve.py` | Sender kind (vendor contact / employee / unknown), authorization, vendor resolution, bill resolution (handles duplicate tranIds) |
| `rules.py` | README order of checks + record-state table. Produces a `Decision` |
| `bundle.py` | Evidence bundle assembly (stable step names) |
| `drafts.py` | Templates + reply-snippet library keyed by outcome |
| `draft_check.py` | Whitelist of dates/amounts/references from records; rejects bank-like content, sender-only facts, forbidden "paid" wording where not paid. Failed check => downgrade to internal note |
| `pipeline.py` | `process_ticket(ticket, store, extractor) -> bundle` |
| `run_all.py` | CLI: `--tickets PATH --data DIR --out DIR --no-model --api URL --team NAME` |
| `eval/split.py`, `eval/report.py` | Stratified 70/30 split (fixed seed, `split.json`), score dev / held-out / full, group failures by cause |
| `tests/` | `unittest` tests for order of checks, fraud, unauthorized sender, holding reply, bank-number redaction; red-team tickets |

## Build order
1. Phase A: trace + data layer -> ticket normalizer -> prechecks -> regex extraction + validator -> resolve -> rules -> drafts + check -> bundle -> run_all -> eval scripts -> first score.
2. Phase B: failure triage (general fixes only, dev tickets only), red-team adversarial tickets, unit tests.
3. Phase C: install `ollama` python package, `extract_model.py`, comparison script (regex vs model on references, intent, end-to-end score, safety regressions).
4. Write `out/SCORE_REPORT.md` and `PROTOTYPE_README.md`.

## Key decisions on ambiguous points
- Ticket text = subject + end-user comments only (agent holding replies ignored).
- Bill resolution: candidate refs that exist as `tranId`. If a tranId has several vendors, settle by the sender's vendor (contact/domain) or a vendor name in the text; else `unresolved_account`.
- Unknown sender: if no vendor can be pinned down at all -> `unresolved_account` (README order puts it before unauthorized). If a vendor is identifiable -> unauthorized internal note, no payment details.
- Payment record checked before bill status. Settled + "not received" language -> bank verification note. Paid In Full without payment, or payment without bill agreement -> conflict note.
- Holding reply (threat / copied exec): no payment details, update date November 17, 2026, `priority: true`.
- Multi-invoice: one reply, one line per invoice. If any invoice needs a human (returned, conflict, not-found with linked ticket), fall back to an internal note covering all.
- Any uncertainty -> internal action note explaining why.
- Output written ASCII-safe (`ensure_ascii`) because `score.py` opens files with the platform default encoding (cp1252 on Windows).

## Risks
- Bare 4-5 digit references collide with other numbers (passcodes, years, amounts). Mitigation: candidate must match a real `tranId`, plus context and vendor checks.
- Over-eager keyword families (e.g. "account" in normal mail) causing false fraud flags; under-eager ones missing new phrasing on Nov 19. Mitigation: keep families broad but paired (bank word + change word), test on held-out, model as second opinion that can only add caution.
- Scorer's `any_date` regex catches words like "Market 10" or "1/2"; drafts that must carry no date must avoid those shapes. Draft check runs the same pattern.
- Overfitting to the 100 practice tickets. Mitigation: no ticket ids, no ticket-specific vendor names or sentences; held-out split reported separately.
- Qwen 3.5 thinking mode / JSON breakage. Mitigation: `think=False`, schema format, Pydantic validation, one retry, regex fallback.
