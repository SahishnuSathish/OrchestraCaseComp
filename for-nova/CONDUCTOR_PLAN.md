# Conductor Phase 2 Implementation Plan: fewer tickets in the first place

> **For agentic workers:** REQUIRED SUB-SKILL: use `executing-plans` to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Read **Global Constraints** and **Background** before touching code.

**Goal:** Rename AP Desk to **Conductor** and add the second half of the case: self-serve and preventive features that stop AP tickets from being created, built on the pipeline that already scores 100/100.

**Architecture:** Every new feature is additive. It reads the same `Store` (NetSuite/payment/Zendesk mock records) through the existing prototype modules, sends every outbound word through `egress_guard`, and waits for a person to approve before anything leaves. Deterministic code decides. The local Qwen model only reads documents, rewords facts that code supplies, and adds caution. Small local classifiers only route and flag. The ticket pipeline's decisions are frozen.

**Tech Stack:** Python 3.13, FastAPI and uvicorn, SQLite (`webapp/db.py`), vanilla ES-module front end (`webapp/static/js`), stdlib `unittest`, Node `--test`, Playwright smoke test, Ollama (`qwen3.5:9b`, `nomic-embed-text`), `pypdf` and `reportlab` (both already installed), and `numpy` (installed, used for classifiers; no scikit-learn).

Written 2026-11-17 from the Orchestra executive Q&A. Commands run from `for-nova/`.

## Global Constraints

- **Pipeline freeze until the November 19 stretch run is scored.** Don't edit `prototype/rules.py`, `pipeline.py`, `prechecks.py`, `cues.py`, `drafts.py`, `draft_check.py`, `planner.py`, `resolve.py`, `extract_regex.py`, `extract_model.py`, `gate.py` or `validator.py`. New behaviour goes in new files or in `webapp/`.
- **Regression gate (run before every commit):** `python prototype/run_all.py --out out/gate` (the regex reader is the default; it also prints the score) then `python score.py out/gate/results.json data/answer_key.json`. The result must stay at 100% correct and 100% safe. `python -m unittest discover -s tests -p "test_*.py"` must pass.
- **The user has uncommitted UI work** in `webapp/static/js/ui.js`, `views/review.js`, `views/tickets.js` and `css/views/review.css`. Don't edit, revert or stage those files. Use `git add <explicit paths>` only, never `git add -A` or `git add .`.
- **Nothing is sent without a person.** Every new outbound item (notice, digest, chase email, document) has a review state and needs an explicit approve and then send. The server builds the recipient, subject and body from its own records, never from the request.
- **Bank account numbers, routing numbers and TINs never reach a model, a log, an email or the browser in full.** Show at most the last 4 digits.
- **Local only.** Conductor binds to 127.0.0.1. Models run on Ollama at a local address. There's no cloud API.
- **Vendors may see** the status and balance of their own invoice. **Vendors may never see** internal approver names, who updated a record, failure reasons for returned payments, data from other vendors, or totals across vendors (exec Q&A, Q1).
- **Same answer for "no match", "another vendor's invoice" and "not authorized"** on every vendor-facing surface. This prevents invoice-number enumeration.
- **Naming:** the product is "Conductor". Keep these technical identifiers so nothing breaks: header `x-ap-token`, `localStorage` key `ap.run`, env var `AP_DESK_STATE_DIR` (still accepted; `CONDUCTOR_STATE_DIR` is added and wins).
- **Copy rules (exec Q&A):** emails are fast, accurate, helpful, direct and simple. Short sentences. No filler.

---

## Background: what the Q&A changed

| Exec said | Where it lands |
|---|---|
| Vendors may see **balance and last status**, not internal detail | Phase B, Task 2 (balance line) and Task 3 (proactive notices) |
| Data should appear **"in the inbox of the person"**; open to our recommendation | Recommendation: **push by email first** (proactive notices, approver digests). The magic-link status page is optional, never a login portal. Fits "against a third platform" and avoids the fate of their old employee form. |
| **W9 and bank info exchange** is the biggest manual cost (volume, chasing) | Phase C: vendor onboarding packet |
| Exception to focus on: **requests for a document or file (PDF)**; bonus for **large-file plumbing** | Phase D: document desk |
| Edge cases: **ambiguity and mismatch** | Already covered (`unresolved_account`, conflict notes, novelty guard). Phase C adds name/TIN-type mismatch flags. |
| Tickets **assigned by expertise**, basic **semantic filters**, AP/AR split | Phase E: routing classifier and tiers |
| **Feedback mechanisms**; anticipate human error | Phase F: edit and return feedback loop |
| **Holidays disrupt** the flow | Phase G: business-day calendar (after the freeze lifts) |
| Everything **easily migratable**; NetSuite and Zendesk stay | Every new store is SQLite plus JSON export. Exports are NetSuite-shaped CSV/JSON. Nothing needs a new SaaS. |

**What already exists (don't rebuild):** `prototype/status_service.py` (records-only lookup with enumeration protection), `prototype/portal_server.py` (demo magic-code page), `prototype/notices.py`, `prototype/approver_digest.py`, `prototype/batch_groups.py`, `prototype/deflection_report.py` and `prototype/egress_guard.py`. They run from the CLI only (`run_orchestrated.py --reports`). On the practice pack they show 62% of tickets self-servable, 21% preventable by a notice, and 10 notes becoming 6 digests. **No vendor data in the pack covers W9s, bank forms or PDFs**, so Phases C and D bring their own fixtures.

## Phases and order

| Phase | What | Detail level here | Before Nov 19? |
|---|---|---|---|
| A | Rebrand to Conductor | Full task code | Yes |
| B | Prevent page: balance in status answers, notices and digests reviewed and sent from Conductor | Full task code | Yes (demo-ready) |
| C | Vendor onboarding packet (W9 and bank details) | Design spec. Write its own task plan before building. | No |
| D | Document desk (remittance advice out, invoice PDFs in, large files) | Design spec, own task plan | No |
| E | Routing classifier and expertise tiers | Design spec, own task plan | No |
| F | Feedback loop | Design spec, own task plan | No |
| G | Holiday calendar | Design spec, own task plan, after freeze | No |

Phases C to G are separate subsystems. Each should get its own `writing-plans` pass with full code when it starts. The specs below fix their interfaces, security rules and acceptance tests so those plans don't drift.

---

## Phase A: Rebrand to Conductor

### Task 1: Rename the product to Conductor

**Files:**
- Modify: `webapp/server.py` (docstring line 1, `FastAPI(title=...)` line 59, startup print line 661)
- Modify: `webapp/db.py:1`, `webapp/db.py:13`; `webapp/mailer.py:1`, `webapp/mailer.py:29`
- Modify: `webapp/static/index.html` (lines 7, 85, 112), `webapp/static/css/tokens.css:1`
- Modify: `webapp/static/js/app.js` (lines 1, 112, 123, 128), `webapp/static/js/api.js` (lines 33, 42, 43, 73), `webapp/static/js/views/runs.js:44`, `webapp/static/js/views/settings.js:442`, `webapp/static/js/views/not-found.js:8`, `webapp/static/js/views/overview.js:130`
- Modify: `webapp/README.md`, `tests/test_webapp.py:1`, `tests/fake_ollama.py:4`, `tests/ui/smoke.mjs` (lines 3, 5, 10, 25, 144, 265, 796, 801, 808; line 144 also sets `CONDUCTOR_STATE_DIR` so the suite can never write to real state)
- Test: `tests/test_webapp.py` (new test class `BrandTests`)

**Interfaces:**
- Produces: `db.STATE_DIR` resolved from `CONDUCTOR_STATE_DIR`, then `AP_DESK_STATE_DIR`, then `webapp/state`. `mailer.OUTBOX_DIR` follows the same order.

- [ ] **Step 1: Write the failing test.** Append to `tests/test_webapp.py`:

```python
class BrandTests(unittest.TestCase):
    def test_page_and_app_are_named_conductor(self):
        c = TestClient(server.app, base_url="http://localhost")
        html = c.get("/").text
        self.assertIn("<title>Conductor</title>", html)
        self.assertNotIn("AP Desk", html)
        self.assertEqual(server.app.title, "Conductor")

    def test_state_dir_prefers_conductor_variable(self):
        import importlib
        import os
        old = {k: os.environ.get(k) for k in ("CONDUCTOR_STATE_DIR", "AP_DESK_STATE_DIR")}
        try:
            os.environ["AP_DESK_STATE_DIR"] = str(Path(_TMP.name) / "legacy")
            os.environ["CONDUCTOR_STATE_DIR"] = str(Path(_TMP.name) / "new")
            fresh = importlib.reload(importlib.import_module("db"))
            self.assertEqual(fresh.STATE_DIR, Path(_TMP.name) / "new")
            del os.environ["CONDUCTOR_STATE_DIR"]
            fresh = importlib.reload(fresh)
            self.assertEqual(fresh.STATE_DIR, Path(_TMP.name) / "legacy")
        finally:
            for k, v in old.items():
                os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
            fresh = importlib.reload(importlib.import_module("db"))
            fresh.STATE_DIR = Path(_TMP.name)
            fresh.DB_PATH = fresh.STATE_DIR / "app.db"
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `python -m unittest tests.test_webapp.BrandTests -v`
Expected: FAIL. `AssertionError: '<title>Conductor</title>' not found`.

- [ ] **Step 3: Replace the visible name.** Run this one command. It touches only the listed files. Don't include `ui.js`, `review.js`, `tickets.js` or `review.css`.

```bash
sed -i 's/AP Desk/Conductor/g' webapp/server.py webapp/db.py webapp/mailer.py webapp/README.md webapp/static/index.html webapp/static/css/tokens.css webapp/static/js/app.js webapp/static/js/api.js webapp/static/js/views/runs.js webapp/static/js/views/settings.js webapp/static/js/views/not-found.js webapp/static/js/views/overview.js tests/fake_ollama.py tests/ui/smoke.mjs
```

Don't run it on `tests/test_webapp.py`: it would turn the new `assertNotIn("AP Desk", html)` into a check for "Conductor". Rename that file's docstring by hand.

- [ ] **Step 4: Add the new state-dir variable.** In `webapp/db.py` line 13 replace the `STATE_DIR =` line with:

```python
STATE_DIR = Path(os.environ.get("CONDUCTOR_STATE_DIR") or os.environ.get("AP_DESK_STATE_DIR")
                 or (Path(__file__).resolve().parent / "state"))
```

In `webapp/mailer.py` line 29 replace the `OUTBOX_DIR =` line with:

```python
OUTBOX_DIR = Path(os.environ.get("CONDUCTOR_STATE_DIR") or os.environ.get("AP_DESK_STATE_DIR")
                  or (Path(__file__).resolve().parent / "state")) / "outbox"
```

In `webapp/README.md`, change the first paragraph to start with `Conductor (formerly AP Desk) is a local web app…`. Wherever the README says ``Set `AP_DESK_STATE_DIR` ``, make it say ``Set `CONDUCTOR_STATE_DIR` (or the older `AP_DESK_STATE_DIR`) ``.

- [ ] **Step 5: Check that nothing else still says AP Desk**

Run: `grep -rn "AP Desk" --include=*.py --include=*.js --include=*.mjs --include=*.html --include=*.css --include=*.md webapp tests`
Expected: only the "formerly AP Desk" line in `webapp/README.md`.

- [ ] **Step 6: Run the tests**

Run: `python -m unittest tests.test_webapp -v` then `node --test tests/js/router.test.mjs` then `node tests/ui/smoke.mjs`
Expected: all PASS. The smoke test now looks for `document.title.endsWith('Conductor')` and the "Conductor was restarted" banner.

- [ ] **Step 7: Run the regression gate (see Global Constraints) and commit**

```bash
git add webapp/server.py webapp/db.py webapp/mailer.py webapp/README.md webapp/static/index.html webapp/static/css/tokens.css webapp/static/js/app.js webapp/static/js/api.js webapp/static/js/views/runs.js webapp/static/js/views/settings.js tests/test_webapp.py tests/fake_ollama.py tests/ui/smoke.mjs
git commit -m "Rename AP Desk to Conductor; accept CONDUCTOR_STATE_DIR"
```

---

## Phase B: Prevent page (push the answer to the vendor's inbox)

What the user sees: a run gets a **Prevent** page beside Tickets and Review. It shows the deflection numbers, the proactive notices drafted for vendors ("here is where your invoices stand, no need to reply"), and the approver digests ("approvals waiting on you"). Each item is approved and then sent, or skipped, the same way a reply is reviewed. Vendor status answers now include the invoice amount and open balance, because the exec said vendors may see "balance and last status".

### Task 2: Balance line in vendor status answers; fix the portal port clash

**Files:**
- Modify: `prototype/status_service.py`
- Modify: `prototype/portal_server.py:27` (port 8790 clashes with Conductor's default 8790)
- Test: `tests/test_deflection.py` (new tests in a new class `BalanceTests`)

**Interfaces:**
- Consumes: `rules.classify_bill(bill, lk) -> {"ref", "bill", "outcome", "payment", "run", ...}`; bill fields `userTotal` (string decimal) and `currency` (e.g. `USD`).
- Produces: `status_service.balance_line(outcome: dict) -> str`, for example `"Invoice amount: USD 4,180.33. Open balance: USD 0.00."`. `lookup_status(...)["message"]` is the snippet followed by a space and `balance_line`, for the five shareable outcomes only. `status_service.AMOUNT` is a compiled regex matching `USD 4,180.33` and similar.

- [ ] **Step 1: Write the failing tests.** Append to `tests/test_deflection.py` (it already defines `STORE`, `LK`, `contact`, `bill_with`):

```python
class BalanceTests(unittest.TestCase):
    def test_paid_invoice_shows_amount_and_zero_balance(self):
        b = bill_with("paid")
        r = status_service.lookup_status(contact(b["entity"]), b["tranId"], STORE)
        amt = f"{b['currency']} {float(b['userTotal']):,.2f}"
        self.assertIn(f"Invoice amount: {amt}.", r["message"])
        self.assertIn(f"Open balance: {b['currency']} 0.00.", r["message"])

    def test_pending_invoice_shows_full_open_balance_and_no_approver(self):
        b = bill_with("pending")
        r = status_service.lookup_status(contact(b["entity"]), b["tranId"], STORE)
        amt = f"{b['currency']} {float(b['userTotal']):,.2f}"
        self.assertIn(f"Open balance: {amt}.", r["message"])
        if b.get("nextApprover"):
            self.assertNotIn(b["nextApprover"], r["message"])

    def test_review_outcomes_get_no_amount(self):
        for outcome in ("returned", "conflict"):
            b = bill_with(outcome)
            if b is None:
                continue
            r = status_service.lookup_status(contact(b["entity"]), b["tranId"], STORE)
            self.assertEqual(r["message"], status_service.NEEDS_REVIEW)
            self.assertIsNone(status_service.AMOUNT.search(r["message"]))

    def test_every_amount_in_an_answer_is_the_bills_own(self):
        for outcome in ("paid", "released", "scheduled", "approved_no_run", "pending"):
            b = bill_with(outcome)
            if b is None:
                continue
            r = status_service.lookup_status(contact(b["entity"]), b["tranId"], STORE)
            amts = set(status_service.AMOUNT.findall(r["message"]))
            self.assertLessEqual(amts, {f"{b['currency']} {float(b['userTotal']):,.2f}", f"{b['currency']} 0.00"})

    def test_portal_does_not_share_conductors_port(self):
        self.assertNotEqual(portal_server.PORT, 8790)
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `python -m unittest tests.test_deflection.BalanceTests -v`
Expected: FAIL. `AttributeError: module 'status_service' has no attribute 'AMOUNT'`.

- [ ] **Step 3: Implement.** In `prototype/status_service.py`, add below `SNIPPET_FOR`:

```python
AMOUNT = re.compile(r"\b[A-Z]{3} \d{1,3}(?:,\d{3})*\.\d{2}\b")
ZERO_BALANCE = {"paid", "released"}  # released: the funds have left Orchestra's bank


def _money(currency, value):
    return f"{currency or 'USD'} {float(value):,.2f}"


def balance_line(o):
    """Invoice amount and open balance, from the bill record only. Never a total across invoices."""
    b = o["bill"]
    if not b.get("userTotal"):
        return ""
    total = _money(b.get("currency"), b["userTotal"])
    open_bal = _money(b.get("currency"), 0) if o["outcome"] in ZERO_BALANCE else total
    return f"Invoice amount: {total}. Open balance: {open_bal}."


def _amounts_ok(msg, o):
    b = o["bill"]
    ok = {_money(b.get("currency"), 0)} | ({_money(b.get("currency"), b["userTotal"])} if b.get("userTotal") else set())
    return set(AMOUNT.findall(msg)) <= ok
```

Then in `lookup_status`, replace the last four lines (from `msg = drafts.SNIPPETS[key]...` to the final `return`) with:

```python
    msg = drafts.SNIPPETS[key].format(**fields)
    bal = balance_line(o)
    msg = f"{msg} {bal}" if bal else msg
    if egress_guard.check_outbound(msg, [o], [o["ref"]]) or not _amounts_ok(msg, o):
        return _result(True, NEEDS_REVIEW, o["outcome"], trace)
    return _result(True, msg, o["outcome"], trace)
```

In `prototype/portal_server.py` line 27, change `HOST, PORT = "127.0.0.1", 8790` to `HOST, PORT = "127.0.0.1", 8791`. Change "8790" to "8791" in that file's docstring line 1 as well.

- [ ] **Step 4: Run the tests**

Run: `python -m unittest tests.test_deflection -v`
Expected: PASS, including the existing portal and status tests. (`LONG_NUMBER` doesn't match `4,180.33` because commas break the digit run. Confirm this by checking that `test_paid_invoice_shows_amount_and_zero_balance` passes.)

- [ ] **Step 5: Regression gate, then commit**

```bash
git add prototype/status_service.py prototype/portal_server.py tests/test_deflection.py
git commit -m "Status answers show invoice amount and open balance; portal moves to port 8791"
```

### Task 3: Build and store prevention results per run

**Files:**
- Create: `webapp/prevention.py`
- Modify: `webapp/db.py` (`SCHEMA`, `delete_run`, new functions)
- Test: `tests/test_prevention.py`

**Interfaces:**
- Consumes: `runner.Manager.store_for(dataset_path) -> Store | None`, `runner._proto_on_path()`, `db.get_run`, `db.list_rows`, `db.get_ticket`, `notices.build(store) -> {"notices": [{vendor_id, vendor, to, bills, text, status}], "vendors_skipped": {...}}`, `notices.coverage(notices, index) -> [ticket_id]`, `approver_digest.build(index, store) -> {"digests": [{act_by, approver_name, bills, delegate_note, text, egress_problems}], "pending_notes", "digest_count", "summary"}`, `batch_groups.ticket_index(bundles, store)`, `batch_groups.build(index)`, `deflection_report.build(index, notices, digests, groups)`.
- Produces:
  - `prevention.build(run_id: str, mgr) -> dict` with keys `built_at`, `report`, `notices` (each item adds `key = vendor_id`), `digests` (each item adds `key = act_by or "unassigned"` and `sendable: bool`), `digest_summary`, `groups`
  - `prevention.Unavailable(Exception)`
  - `prevention.find(payload, kind: "notice" | "digest", key: str) -> dict | None`
  - `db.save_prevention(run_id, payload)`, `db.get_prevention(run_id) -> dict | None`
  - `db.set_prevention_state(run_id, kind, key, state)`, `db.save_prevention_sent(run_id, kind, key, message_id)`, `db.prevention_states(run_id) -> {(kind, key): {"state", "sent_at", "message_id"}}`

- [ ] **Step 1: Write the failing test.** Create `tests/test_prevention.py`:

```python
"""Prevention page backend: notices, digests and deflection numbers for one run. No Ollama."""
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "webapp"), str(ROOT / "prototype"), str(ROOT)]

import db  # noqa: E402

_TMP = tempfile.TemporaryDirectory()
db.STATE_DIR = Path(_TMP.name)
db.DB_PATH = db.STATE_DIR / "app.db"
db.init()

import prevention  # noqa: E402
import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

DATA = ROOT / "data"


def finished_run(c, h):
    rid = c.post("/api/runs", json={"path": str(DATA), "use_model": False}, headers=h).json()["run_id"]
    for _ in range(240):
        if c.get(f"/api/runs/{rid}", headers=h).json()["status"] in ("done", "failed", "cancelled"):
            break
        time.sleep(0.5)
    return rid


class BuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(server.app, base_url="http://localhost")
        cls.h = {"x-ap-token": server.TOKEN}
        cls.rid = finished_run(cls.c, cls.h)
        cls.p = prevention.build(cls.rid, server.get_manager())

    def test_report_matches_the_cli_numbers(self):
        r = self.p["report"]
        self.assertEqual(r["tickets"], 100)
        self.assertEqual(r["self_servable"]["count"], 62)
        self.assertEqual(r["preventable_by_notice"]["count"], 21)
        self.assertEqual(r["approver_consolidation"], {"notes": 10, "digests": 6})

    def test_notices_go_to_the_vendor_address_on_record(self):
        vendors = {v["internalId"]: v for v in server.get_manager().store_for(str(DATA)).vendors}
        self.assertTrue(self.p["notices"])
        for n in self.p["notices"]:
            self.assertEqual(n["key"], n["vendor_id"])
            self.assertEqual(n["to"], vendors[n["vendor_id"]]["email"])

    def test_digests_without_an_approver_cannot_be_sent(self):
        for d in self.p["digests"]:
            self.assertEqual(d["sendable"], bool(d["act_by"]) and not d["egress_problems"])
            self.assertEqual(d["key"], d["act_by"] or "unassigned")

    def test_payload_is_stored_and_deleted_with_the_run(self):
        self.assertEqual(db.get_prevention(self.rid)["report"]["tickets"], 100)
        db.set_prevention_state(self.rid, "notice", self.p["notices"][0]["key"], "approved")
        rid2 = finished_run(self.c, self.h)
        prevention.build(rid2, server.get_manager())
        db.delete_run(rid2)
        self.assertIsNone(db.get_prevention(rid2))
        self.assertEqual(db.prevention_states(rid2), {})
        self.assertEqual(db.prevention_states(self.rid)[("notice", self.p["notices"][0]["key"])]["state"], "approved")

    def test_find(self):
        n = self.p["notices"][0]
        self.assertIs(prevention.find(self.p, "notice", n["key"]), n)
        self.assertIsNone(prevention.find(self.p, "notice", "no-such-vendor"))
        self.assertIsNone(prevention.find(self.p, "other", n["key"]))

    def test_imported_run_without_dataset_is_unavailable(self):
        db.create_run("nodata01", None, "import", False, None, 0, status="done")
        with self.assertRaises(prevention.Unavailable):
            prevention.build("nodata01", server.get_manager())
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `python -m unittest tests.test_prevention -v`
Expected: FAIL. `ModuleNotFoundError: No module named 'prevention'`.

- [ ] **Step 3: Add the tables and accessors.** In `webapp/db.py`, append inside the `SCHEMA` string, before the closing `"""`:

```sql
CREATE TABLE IF NOT EXISTS prevention (run_id TEXT PRIMARY KEY, payload TEXT, built_at REAL);
CREATE TABLE IF NOT EXISTS prevention_reviews (
  run_id TEXT, kind TEXT, key TEXT, state TEXT, decided_at REAL, sent_at REAL, message_id TEXT,
  PRIMARY KEY (run_id, kind, key)
);
```

In `delete_run`, change the table tuple to `("reviews", "briefs", "tickets", "prevention", "prevention_reviews", "runs")`. Then append at the end of the file:

```python
# ------------------------------------------------------------------ prevention (notices, digests)
def save_prevention(run_id, payload):
    _exec("INSERT OR REPLACE INTO prevention (run_id, payload, built_at) VALUES (?,?,?)",
          (run_id, json.dumps(payload, ensure_ascii=True, default=sorted), payload.get("built_at")))


def get_prevention(run_id):
    r = _one("SELECT payload FROM prevention WHERE run_id=?", (run_id,))
    return json.loads(r["payload"]) if r else None


def set_prevention_state(run_id, kind, key, state):
    _exec("INSERT INTO prevention_reviews (run_id, kind, key, state, decided_at) VALUES (?,?,?,?,?) "
          "ON CONFLICT(run_id, kind, key) DO UPDATE SET state=excluded.state, decided_at=excluded.decided_at",
          (run_id, kind, key, state, time.time()))


def save_prevention_sent(run_id, kind, key, message_id):
    _exec("UPDATE prevention_reviews SET state='sent', sent_at=?, message_id=? WHERE run_id=? AND kind=? AND key=?",
          (time.time(), message_id, run_id, kind, key))


def prevention_states(run_id):
    return {(r["kind"], r["key"]): {"state": r["state"], "sent_at": r["sent_at"], "message_id": r["message_id"]}
            for r in _all("SELECT * FROM prevention_reviews WHERE run_id=?", (run_id,))}
```

(`db.py` already imports `json` and `time`. If `time` isn't imported, add `import time` to its imports.)

- [ ] **Step 4: Create `webapp/prevention.py`**

```python
"""Prevention for one run: proactive vendor notices, approver digests and the deflection numbers.

Built on request from the run's dataset with the existing prototype modules. Nothing here changes a ticket's
result. Everything it drafts waits for a person: a notice goes to the vendor's address on record, a digest to
the approver on record, and both are checked again when they are sent (see server.py).
"""
import time

import db
import runner

KINDS = ("notice", "digest")
STATES = ("pending", "approved", "skipped")


class Unavailable(Exception):
    pass


def build(run_id, mgr):
    run = db.get_run(run_id)
    if not run:
        raise KeyError(run_id)
    store = mgr.store_for(run["dataset_path"]) if run.get("dataset_path") else None
    if store is None:
        raise Unavailable("This run has no readable dataset, so notices and digests can't be built for it.")
    runner._proto_on_path()
    import approver_digest
    import batch_groups
    import deflection_report
    import notices

    bundles = []
    for row in db.list_rows(run_id):
        rec = db.get_ticket(run_id, row["ticket_id"])
        if rec and (rec["bundle"].get("decision") or {}).get("rule"):
            bundles.append(rec["bundle"])
    index = batch_groups.ticket_index(bundles, store)
    n = notices.build(store)
    n["covered_tickets"] = notices.coverage(n["notices"], index)
    d = approver_digest.build(index, store)
    g = batch_groups.build(index)
    payload = {
        "built_at": time.time(),
        "report": deflection_report.build(index, n, d, g),
        "notices": [{**x, "key": x["vendor_id"]} for x in n["notices"]],
        "digests": [{**x, "key": x["act_by"] or "unassigned", "sendable": bool(x["act_by"]) and not x["egress_problems"]}
                    for x in d["digests"]],
        "digest_summary": d["summary"],
        "groups": g["groups"],
    }
    db.save_prevention(run_id, payload)
    return payload


def find(payload, kind, key):
    if kind not in KINDS:
        return None
    return next((x for x in payload["notices" if kind == "notice" else "digests"] if x["key"] == key), None)
```

- [ ] **Step 5: Run the tests**

Run: `python -m unittest tests.test_prevention -v`
Expected: PASS (6 tests). If `test_report_matches_the_cli_numbers` is off by a few, compare with `out/regex/deflection.json`. Differences mean the run's bundles differ from the CLI bundles. Investigate the difference and don't loosen the test.

- [ ] **Step 6: Regression gate, then commit**

```bash
git add webapp/prevention.py webapp/db.py tests/test_prevention.py
git commit -m "Build and store notices, digests and deflection numbers per run"
```

### Task 4: Prevention API: build, review state, send

**Files:**
- Modify: `webapp/server.py` (new section after the export endpoint, before `def main`)
- Modify: `webapp/README.md` (API table: four new rows)
- Test: `tests/test_prevention.py` (new class `ApiTests`)

**Interfaces:**
- Consumes: Task 3's `prevention.build/find/Unavailable`, the `db.*prevention*` functions, `mailer.Message`, `mailer.get_mailer()`, `mailer.default_sender()`, `egress_guard.check_internal`, `notices.build`.
- Produces:
  - `GET /api/runs/{run_id}/prevention` returns `{"built": false}` or `{"built": true, ...payload, "states": {"notice:<key>": {...}, "digest:<key>": {...}}}`
  - `POST /api/runs/{run_id}/prevention/build` returns the same shape as GET. 409 if the run isn't `done`. 422 with the `Unavailable` message.
  - `PUT /api/runs/{run_id}/prevention/{kind}/{key}` with body `{"state": "pending"|"approved"|"skipped"}` returns the GET shape
  - `POST /api/runs/{run_id}/prevention/{kind}/{key}/send` returns the GET shape. 409 unless approved, 409 if already sent, 409 if the records changed since the build (notice) or the digest isn't sendable, 502 on mail failure.

- [ ] **Step 1: Write the failing tests.** Append to `tests/test_prevention.py`:

```python
class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(server.app, base_url="http://localhost")
        cls.h = {"x-ap-token": server.TOKEN}
        cls.rid = finished_run(cls.c, cls.h)

    def url(self, tail=""):
        return f"/api/runs/{self.rid}/prevention{tail}"

    def setUp(self):
        self._outbox = tempfile.TemporaryDirectory()
        self._get = server.mailer.get_mailer
        server.mailer.get_mailer = lambda env=None: server.mailer.OutboxMailer(self._outbox.name)  # never the real outbox

    def tearDown(self):
        server.mailer.get_mailer = self._get
        self._outbox.cleanup()

    def test_not_built_then_built(self):
        rid = finished_run(self.c, self.h)
        self.assertEqual(self.c.get(f"/api/runs/{rid}/prevention", headers=self.h).json(), {"built": False})
        r = self.c.post(self.url("/build"), headers=self.h)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["built"])
        self.assertEqual(r.json()["report"]["tickets"], 100)

    def test_send_needs_approval_and_uses_server_text(self):
        p = self.c.post(self.url("/build"), headers=self.h).json()
        n = p["notices"][0]
        k = f"/notice/{n['key']}"
        self.assertEqual(self.c.post(self.url(k + "/send"), headers=self.h).status_code, 409)
        self.assertEqual(self.c.put(self.url(k), json={"state": "approved"}, headers=self.h).status_code, 200)
        r = self.c.post(self.url(k + "/send"), json={"to": "attacker@evil.example", "body": "x"}, headers=self.h)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["states"][f"notice:{n['key']}"]["state"], "sent")
        self.assertEqual(self.c.post(self.url(k + "/send"), headers=self.h).status_code, 409)
        emls = list(Path(self._outbox.name).glob("*.eml"))
        self.assertEqual(len(emls), 1)
        eml = emls[0].read_text(encoding="utf-8")
        self.assertIn(f"To: {n['to']}", eml)
        self.assertNotIn("attacker@evil.example", eml)

    def test_unsendable_digest_is_refused(self):
        p = self.c.post(self.url("/build"), headers=self.h).json()
        bad = next((d for d in p["digests"] if not d["sendable"]), None)
        if bad is None:
            self.skipTest("every digest in the pack has an approver")
        k = f"/digest/{bad['key']}"
        self.c.put(self.url(k), json={"state": "approved"}, headers=self.h)
        self.assertEqual(self.c.post(self.url(k + "/send"), headers=self.h).status_code, 409)

    def test_bad_kind_state_and_key(self):
        self.c.post(self.url("/build"), headers=self.h)
        self.assertEqual(self.c.put(self.url("/other/x"), json={"state": "approved"}, headers=self.h).status_code, 404)
        self.assertEqual(self.c.put(self.url("/notice/nope"), json={"state": "approved"}, headers=self.h).status_code, 404)
        p = self.c.get(self.url(), headers=self.h).json()
        k = f"/notice/{p['notices'][0]['key']}"
        self.assertEqual(self.c.put(self.url(k), json={"state": "sent"}, headers=self.h).status_code, 422)

    def test_token_required(self):
        self.assertEqual(self.c.get(self.url()).status_code, 401)
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `python -m unittest tests.test_prevention.ApiTests -v`
Expected: FAIL with 404 responses (routes don't exist).

- [ ] **Step 3: Implement.** In `webapp/server.py`, add `import prevention  # noqa: E402` beside the other local imports (line 36). Then insert before `def main():`:

```python
# ---------------------------------------------------------------------------- prevention (notices, digests)
class PreventionStateBody(BaseModel):
    state: str


def _prevention_payload(run_id):
    p = db.get_prevention(run_id)
    if not p:
        return {"built": False}
    states = {f"{k}:{key}": v for (k, key), v in db.prevention_states(run_id).items()}
    return {"built": True, **p, "states": states}


def _prevention_item(run_id, kind, key):
    p = db.get_prevention(run_id)
    item = prevention.find(p, kind, key) if p else None
    if item is None:
        raise HTTPException(404, "No such notice or digest in this run.")
    return p, item


@app.get("/api/runs/{run_id}/prevention", dependencies=api)
def api_prevention(run_id: str):
    _run_or_404(run_id)
    return _prevention_payload(run_id)


@app.post("/api/runs/{run_id}/prevention/build", dependencies=api)
def api_prevention_build(run_id: str):
    run = _run_or_404(run_id)
    if run["status"] != "done":
        raise HTTPException(409, "Wait for the run to finish before building notices and digests.")
    try:
        prevention.build(run_id, get_manager())
    except prevention.Unavailable as e:
        raise HTTPException(422, str(e))
    return _prevention_payload(run_id)


@app.put("/api/runs/{run_id}/prevention/{kind}/{key}", dependencies=api)
def api_prevention_state(run_id: str, kind: str, key: str, body: PreventionStateBody):
    _run_or_404(run_id)
    _prevention_item(run_id, kind, key)
    if body.state not in prevention.STATES:
        raise HTTPException(422, f"state must be one of {', '.join(prevention.STATES)}")
    if (db.prevention_states(run_id).get((kind, key)) or {}).get("state") == "sent":
        raise HTTPException(409, "This was already sent.")
    db.set_prevention_state(run_id, kind, key, body.state)
    return _prevention_payload(run_id)


@app.post("/api/runs/{run_id}/prevention/{kind}/{key}/send", dependencies=api)
def api_prevention_send(run_id: str, kind: str, key: str):
    run = _run_or_404(run_id)
    p, item = _prevention_item(run_id, kind, key)
    st = (db.prevention_states(run_id).get((kind, key)) or {}).get("state", "pending")
    if st == "sent":
        raise HTTPException(409, "This was already sent.")
    if st != "approved":
        raise HTTPException(409, "Approve it before sending.")
    if kind == "notice":
        runner._proto_on_path()
        import notices
        fresh = {x["vendor_id"]: x for x in notices.build(get_manager().store_for(run["dataset_path"]))["notices"]}
        if (fresh.get(key) or {}).get("text") != item["text"]:
            raise HTTPException(409, "The records changed since this notice was drafted. Rebuild, then review it again.")
        to, subject = item["to"], "Your invoices with Orchestra: current status"
    else:
        import egress_guard
        allowed = [b["tranId"] for b in item["bills"]] + [str(t) for b in item["bills"] for t in b["ticket_ids"]]
        if not item["sendable"] or egress_guard.check_internal(item["text"], allowed):
            raise HTTPException(409, "This digest has no approver on record or failed the internal check, so it can't be sent.")
        to, subject = item["act_by"], f"Approvals waiting on you ({len(item['bills'])})"
    msg = mailer.Message(sender=mailer.default_sender(None), to=to, subject=subject, body=item["text"],
                         headers={"X-Conductor-Prevention": f"{kind}:{key}"})
    try:
        info = mailer.get_mailer().send(msg)
    except mailer.MailError as e:
        raise HTTPException(502, str(e))
    db.save_prevention_sent(run_id, kind, key, info.get("id"))
    return _prevention_payload(run_id)
```

Add these rows to the API table in `webapp/README.md`:

```
| GET | `/api/runs/{run_id}/prevention` | Notices, digests and deflection numbers for a run (`built: false` until built) |
| POST | `/api/runs/{run_id}/prevention/build` | Build them from the run's dataset (run must be done) |
| PUT | `/api/runs/{run_id}/prevention/{kind}/{key}` | Set `pending`, `approved` or `skipped` on a notice or digest |
| POST | `/api/runs/{run_id}/prevention/{kind}/{key}/send` | Send an approved notice (to the vendor on record) or digest (to the approver on record) |
```

- [ ] **Step 4: Run the tests**

Run: `python -m unittest tests.test_prevention -v`
Expected: PASS (11 tests). No `.eml` file appears in `webapp/state/outbox/`.

- [ ] **Step 5: Regression gate, then commit**

```bash
git add webapp/server.py webapp/README.md tests/test_prevention.py
git commit -m "Prevention API: build, review and send notices and approver digests"
```

### Task 5: Prevent page in Conductor

**Files:**
- Create: `webapp/static/js/views/prevent.js`
- Modify: `webapp/static/js/router.js` (`parse`, `href`, `crumbs`)
- Modify: `webapp/static/js/api.js` (four methods on `api`)
- Modify: `webapp/static/js/app.js` (`VIEWS`, nav links around line 57, leaf titles line 109)
- Test: `tests/js/router.test.mjs`, `tests/ui/smoke.mjs`

**Interfaces:**
- Consumes: Task 4 endpoints. `ui.js` exports `pageHeader`, `panel`, `statTile`, `emptyState`, `banner`, `toast`, `copyButton`. `lib.js` exports `h`, `icon`, `mount`, `fmtInt`, `plural`.
- Produces: route `{ name: 'prevent', runId }` at `#/runs/:runId/prevent`, and `href('prevent', { runId })`.

- [ ] **Step 1: Write the failing router test.** Append to `tests/js/router.test.mjs`:

```js
it('prevent route parses, links and has crumbs', () => {
  assert.deepEqual(parse('#/runs/ab12cd34/prevent', { lastRunId: null }), { name: 'prevent', runId: 'ab12cd34', query: {} });
  assert.equal(parse('#/runs/ab12cd34/prevent/5', { lastRunId: null }).name, 'not-found');
  assert.equal(href('prevent', { runId: 'ab12cd34' }), '#/runs/ab12cd34/prevent');
  assert.deepEqual(crumbs({ name: 'prevent', runId: 'ab12cd34' }, { label: 'Nov 13' }).map((c) => c.label), ['Runs', 'Nov 13', 'Prevent']);
});
```

(The file already imports `it`, `assert`, `parse`, `href` and `crumbs`.)

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test tests/js/router.test.mjs`
Expected: FAIL. `name: 'not-found'` where `'prevent'` was expected.

- [ ] **Step 3: Router.** In `parse`, insert directly after `if (seg.length === 2) return { name: 'overview', runId: b, query };`:

```js
    if (c === 'prevent') return seg.length === 3 ? { name: 'prevent', runId: b, query } : notFound(query);
```

In `href`, add before `case 'settings':`:

```js
    case 'prevent': return `#/runs/${runId}/prevent${qs}`;
```

In `crumbs`, add before `case 'settings':`:

```js
    case 'prevent': return [runs, runCrumb, { label: 'Prevent', href: null }];
```

- [ ] **Step 4: API client.** In `webapp/static/js/api.js`, add to the `api` object after `bulk:`:

```js
  prevention: (id) => request('GET', `/api/runs/${id}/prevention`),
  buildPrevention: (id) => request('POST', `/api/runs/${id}/prevention/build`),
  preventionState: (id, kind, key, state) => request('PUT', `/api/runs/${id}/prevention/${kind}/${encodeURIComponent(key)}`, { state }),
  preventionSend: (id, kind, key) => request('POST', `/api/runs/${id}/prevention/${kind}/${encodeURIComponent(key)}/send`, {}),
```

- [ ] **Step 5: The view.** Create `webapp/static/js/views/prevent.js`:

```js
// Prevent: tickets that never get written. Deflection numbers, proactive vendor notices and approver digests,
// each approved and sent (or skipped) by a person. Text and recipients come from the server's records only.
import { h, icon, mount as fill, fmtInt, plural } from '../lib.js';
import { api } from '../api.js';
import { pageHeader, panel, statTile, emptyState, banner, toast, copyButton } from '../ui.js';

const STATE_LABEL = { pending: 'To review', approved: 'Approved', skipped: 'Skipped', sent: 'Sent' };

export function mount(root, { route }) {
  const runId = route.runId;
  const body = h('div', { class: 'page-grid' });
  const buildBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => build() }, icon('rotate'), 'Build from records');
  fill(root, h('div', { class: 'page' },
    pageHeader({ title: 'Prevent', meta: 'Answers sent before anyone has to ask. Nothing goes out until you approve and send it.', actions: buildBtn }),
    body));

  let data = null;

  const stateOf = (kind, key) => (data.states[`${kind}:${key}`] || {}).state || 'pending';

  async function act(fn, okText) {
    try { data = await fn(); render(); if (okText) toast({ message: okText }); }
    catch (e) { toast({ message: e.message }); }
  }

  async function build() {
    buildBtn.disabled = true;
    await act(() => api.buildPrevention(runId), 'Built from the current records.');
    buildBtn.disabled = false;
  }

  function itemCard(kind, item, title, to, canSend) {
    const st = stateOf(kind, item.key);
    const btns = st === 'sent' ? [h('span', { class: 'badge badge-success' }, icon('check'), 'Sent')] : [
      st !== 'approved'
        ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => act(() => api.preventionState(runId, kind, item.key, 'approved')) }, 'Approve')
        : h('button', { class: 'btn btn-sm btn-primary', type: 'button', disabled: !canSend || null,
            onclick: () => act(() => api.preventionSend(runId, kind, item.key), `Sent to ${to}.`) }, icon('send'), 'Send'),
      st !== 'skipped'
        ? h('button', { class: 'btn btn-sm btn-quiet', type: 'button', onclick: () => act(() => api.preventionState(runId, kind, item.key, 'skipped')) }, 'Skip')
        : h('button', { class: 'btn btn-sm btn-quiet', type: 'button', onclick: () => act(() => api.preventionState(runId, kind, item.key, 'pending')) }, 'Undo skip'),
    ];
    return h('article', { class: 'prevent-item', 'data-kind': kind, 'data-key': item.key },
      h('header', { class: 'prevent-item-head' },
        h('div', null, h('h3', null, title), h('p', { class: 'muted' }, to ? `To ${to}` : 'No approver on record, so this cannot be sent'),
          h('span', { class: 'badge badge-quiet' }, STATE_LABEL[st])),
        h('div', { class: 'prevent-item-actions' }, copyButton(item.text), ...btns)),
      h('pre', { class: 'prevent-text' }, item.text));
  }

  function render() {
    if (!data.built) {
      fill(body, emptyState({ iconName: 'inbox', title: 'Not built yet',
        text: 'Build notices and approver digests from this run’s records. It takes a few seconds and changes no ticket.',
        action: h('button', { class: 'btn btn-primary', type: 'button', onclick: () => build() }, 'Build from records') }));
      return;
    }
    const r = data.report;
    const est = r.monthly_estimate.self_servable_tickets_per_month;
    fill(body,
      banner({ tone: 'info', text: 'Estimates from this run’s tickets, not measured on live mail.' }),
      h('div', { class: 'stat-row' },
        statTile({ label: 'Self-servable', value: `${r.self_servable.pct}%`, sub: `${fmtInt(r.self_servable.count)} of ${fmtInt(r.tickets)} tickets` }),
        statTile({ label: 'Preventable by a notice', value: `${r.preventable_by_notice.pct}%`, sub: plural(r.preventable_by_notice.count, 'ticket') }),
        statTile({ label: 'Approver notes', value: `${r.approver_consolidation.notes} → ${r.approver_consolidation.digests}`, sub: 'notes become digests' }),
        statTile({ label: 'Per month (estimate)', value: `${fmtInt(est[0])}–${fmtInt(est[1])}`, sub: 'tickets that need not be written' })),
      panel({ title: 'Vendor notices', icon: 'send', count: data.notices.length,
        body: data.notices.length ? h('div', { class: 'prevent-list' }, data.notices.map((n) => itemCard('notice', n, n.vendor, n.to, true)))
          : emptyState({ title: 'No notices', text: 'No vendor has a scheduled, released or just-paid invoice.' }) }),
      panel({ title: 'Approver digests', icon: 'inbox', count: data.digests.length,
        body: data.digests.length ? h('div', { class: 'prevent-list' }, data.digests.map((d) =>
          itemCard('digest', d, d.approver_name || d.act_by || 'No approver on record', d.act_by, d.sendable)))
          : emptyState({ title: 'No digests', text: 'No ticket in this run waits on an approver.' }) }));
  }

  (async () => {
    try { data = await api.prevention(runId); render(); }
    catch (e) { fill(body, emptyState({ iconName: 'circle-alert', title: 'Could not load', text: e.message })); }
  })();
  return {};
}
```

Append the layout CSS to `webapp/static/css/components.css`:

```css
/* Prevent page */
.stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-3, 12px); }
.prevent-list { display: grid; gap: var(--space-3, 12px); }
.prevent-item { border: 1px solid var(--border); border-radius: var(--radius, 8px); padding: var(--space-3, 12px); background: var(--surface); }
.prevent-item-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; }
.prevent-item-head h3 { margin: 0; font-size: 1rem; }
.prevent-item-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start; }
.prevent-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; font: inherit; color: var(--text-muted, inherit); }
```

Before saving, open `webapp/static/css/tokens.css` and swap `--border`, `--surface`, `--text-muted`, `--space-3` and `--radius` for the token names that file actually defines. The fallbacks above cover only the spacing tokens. The sprite in `index.html` has `send`, `rotate`, `inbox`, `check` and `circle-alert`, so the icons used here exist.

- [ ] **Step 6: Wire the shell.** In `webapp/static/js/app.js`:
  - after `import * as reviewView from './views/review.js';` add `import * as preventView from './views/prevent.js';`
  - in `VIEWS` add `prevent: preventView,`
  - after the `review: [href('review', ...), inRun('review')],` entry (line 59) add `prevent: [href('prevent', { runId }), inRun('prevent')],`
  - after `link('Review', 'review', ...r.review, r.pending))` (line 81) insert a sibling `link('Prevent', 'send', ...r.prevent),` before the closing parenthesis of the side section (move the `)` so Prevent sits inside the same `side-section` group)
  - in the leaf-title map (line 109) add `prevent: 'Prevent',`

- [ ] **Step 7: Smoke test.** Add to `tests/ui/smoke.mjs` after test 14. It uses the suite's own helpers (`createRun`, `removeRun`, `t.newPage`, `VP`, `gotoRoute`, `assertNoOverflow`). The server under test already runs in simulated mail mode with a temporary state folder, so sending writes only to that folder.

```js
test('15 prevent page builds, approves and sends a notice; no overflow @360 @1280', async (t) => {
  const run = await createRun();
  try {
    const page = await t.newPage(VP.desktop);
    await gotoRoute(page, `#/runs/${run}/prevent`);
    await page.getByRole('button', { name: 'Build from records' }).first().click();
    await page.getByText('Self-servable').waitFor();
    const first = page.locator('.prevent-item[data-kind="notice"]').first();
    await first.getByRole('button', { name: 'Approve' }).click();
    await first.getByRole('button', { name: 'Send' }).click();
    await first.locator('.badge-success', { hasText: 'Sent' }).waitFor();
    assert.ok(await page.locator('.prevent-item[data-kind="digest"]').count() > 0, 'digests are listed');
    await assertNoOverflow(page, 'prevent @1280');
    const phone = await t.newPage(VP.phone);
    await gotoRoute(phone, `#/runs/${run}/prevent`);
    await phone.getByText('Self-servable').waitFor();
    await assertNoOverflow(phone, 'prevent @360');
  } finally {
    await removeRun(run);
  }
});
```

- [ ] **Step 8: Run the tests and look at the page**

Run: `node --test tests/js/router.test.mjs` then `node tests/ui/smoke.mjs` then `python -m unittest discover -s tests -p "test_*.py"`
Expected: all PASS. Then start Conductor with `preview_start`, open a finished run's Prevent page at 360 px and 1280 px, check there's no horizontal scroll, and take a screenshot.

- [ ] **Step 9: Regression gate, then commit**

```bash
git add webapp/static/js/views/prevent.js webapp/static/js/router.js webapp/static/js/api.js webapp/static/js/app.js webapp/static/css/components.css tests/js/router.test.mjs tests/ui/smoke.mjs
git commit -m "Prevent page: deflection numbers, vendor notices and approver digests"
```

---

## Phase C (spec): Vendor onboarding packet (W9 and bank details)

**Problem (exec Q3):** W9 and bank-info exchange is the most manual step, because of volume and chasing. New vendors send invoices without the information AP needs. International vendors and state rules add variation. Their old intake form failed because people preferred email.

**Design:** replace "email us your W9 and bank letter" with one secure link sent from Conductor.

1. **Invite.** An employee (the vendor's Orchestra sponsor) clicks "Invite vendor" in Conductor, enters company name, contact email and country. Conductor emails a single-use link (expires in 14 days, 32-byte token, stored only as a SHA-256 hash). The email is drafted, then approved and sent like any reply. For an *existing* vendor, the link goes only to the address on record.
2. **Packet page** (a separate vendor-facing process, like `portal_server.py`, on its own port and never Conductor itself). It asks only what applies, decided by code:
   - Tax form: `W-9` for US persons. `W-8BEN` / `W-8BEN-E` for foreign individuals or entities (a choice driven by country plus "individual or company").
   - Payment method: ACH (US routing and account), wire (SWIFT and IBAN), or check (remit-to address).
   - Upload the signed tax form as a PDF (Phase D plumbing: streamed, at most 25 MB, magic-byte check).
   - It works on a phone and needs no account. That answers the "people didn't want to do the forms" problem: one link, a few fields, about 3 minutes.
3. **Completeness check (deterministic).** `onboarding/completeness.py: missing(packet) -> list[str]` covers required fields per method and form, a signature date within 12 months, a US TIN format check (9 digits, never stored in clear in the DB), and a legal name that is present.
4. **Chase drafts.** For each incomplete packet older than 3 business days, Conductor drafts one short reminder listing exactly what's missing, from `missing()`. Qwen may reword the draft. A validator rejects any item not in `missing()` and any number. A person sends it.
5. **Verification.** Every new bank account or bank change gets a **callback task**: a person calls a phone number taken from an independent source (the contract or the vendor record), never from the packet. The task can't be closed without entering who called and when. This is the anti-fraud control that pairs with the existing `bank_change` fraud rule.
6. **Export.** "Ready for NetSuite" produces a NetSuite vendor-record CSV/JSON row with the bank fields in an encrypted bundle for the person entering it. No NetSuite write API in the prototype.

**Where models help (all local, none decide):**
- **Qwen reads the uploaded W9 text** (from `pypdf`, or OCR for scans, see Phase D). The TIN is masked by regex before the prompt. Qwen returns JSON with `legal_name`, `business_name`, `entity_type` and `address`. Each value must appear literally in the extracted text (reuse `validator.literal_present`).
- **Mismatch flags (deterministic):** W9 legal name vs packet name vs invoice vendor name (normalized token match), and entity type vs form type (an LLC choosing W-8BEN-E while being US). Flags go to a person.
- Bank and TIN values are never in any model prompt. A unit test asserts that the prompt builder output matches no `\d{9}` and no IBAN pattern.

**Security:** bank and TIN fields are encrypted at rest with a key from an env var (`cryptography` isn't installed: add it, or keep the prototype's bank fields as last-4 plus a fixture flag, and state that in the README). The browser only ever sees last 4. Links are single use and rate limited. Uploads are stored outside the static folder under random names. Logs carry masked emails only.

**Fixtures:** `data_onboarding/` with 6 invite scenarios (complete US ACH, US missing signature, foreign W-8BEN-E wire, name mismatch, bank change on an existing vendor, expired link). Fake W9 PDFs are generated by `data_onboarding/make_fixtures.py` with `reportlab`, using obviously fake TINs (`000-00-0000` pattern).

**Acceptance tests:** a complete packet reaches "ready" only after the callback is recorded. A bank change always creates a callback task. `missing()` matches a table-driven expected list for all 6 fixtures. No API response contains more than 4 consecutive digits of a bank or TIN value. A chase draft with an invented item is rejected.

## Phase D (spec): Document desk and large-file plumbing

**Problem:** "requests for a document or file, i.e. a PDF" is the exception they want to focus on, with bonus points for plumbing that handles large files.

**Two directions:**
- **Out: vendor asks Orchestra for a document.** Remittance advice and payment confirmation, generated from records. `documents/remittance.py: build(payment, bills) -> bytes` produces a one-page PDF (`reportlab`) with payment date, method, reference, and the bills covered with amounts. It contains no bank details and no failure reason. It's offered as an attachment on a `paid` or `released` draft when the ticket text matches a document-request cue (`remittance|proof of payment|payment confirmation|statement`). The cue lives in a new post-reader, so the ticket's `output_type` is unchanged. `mailer.Message` gets an `attachments: list[(filename, mime, bytes)]` field. The send endpoint re-derives the attachment from records at send time, never from the browser.
- **In: vendor sends an invoice PDF.** This is the planned `doc_reader.py` (orchestrator plan 3.4). Extract text with `pypdf`, falling back to OCR for image-only pages. Redact. Qwen schema-reads `invoice_number`, `vendor_name` and `po`. Each must be `literal_present` in the extracted text and then pass `lk.canonical_refs`. A found invoice number adds to the refs the pipeline sees through the existing `added_refs` channel, so it can only help resolution and never invents a bill.

**Large-file plumbing:** streamed upload (`request.stream()` chunks of 1 MB to a temp file, aborted past 25 MB), SHA-256 while streaming, magic-byte type check (`%PDF-`, PNG, JPEG), page cap (first 20 pages for text extraction), and a background job queue (reuse `runner.Manager` threads) with progress over the existing SSE channel. Files are stored by hash, so duplicates are free. Only metadata lives in SQLite. The `.eml` outbox already handles attachments through `EmailMessage.add_attachment`.

**OCR choice:** add `pytesseract` with a local Tesseract install, or use `fitz` (PyMuPDF, already installed) for text and rendering plus Qwen-VL later. Decide in the Phase D plan and record the reason.

**Acceptance tests:** remittance PDF text contains only record values (extract it back with `pypdf` and run `egress_guard.check_outbound`). A 30 MB upload is refused with 413 and leaves no temp file. A renamed `.exe` posing as `.pdf` is refused. An invoice number inside a PDF but not in NetSuite is dropped.

## Phase E (spec): Routing classifier and expertise tiers

**Problem:** routing today is "basic semantic filters". Tickets are assigned by expertise. AP and AR are split, and AR mail is currently just `misrouted`.

- **Queue classifier:** `routing/queue_model.py`. Embed redacted subject and body with `nomic-embed-text` (already used by `novelty.py`, so the embedding cache is shared) and use a nearest-centroid or numpy logistic-regression model. Classes: `ap_status`, `ap_onboarding`, `ap_document`, `ar`, `hr_payroll`, `automated`. Labels come from pipeline decisions on the practice pack plus the Phase C and D fixtures. **Never read `answer_key.json` for training.** It **abstains** below a confidence set by leave-one-out (as in novelty), and abstentions go to the general queue. It only routes: it never changes a ticket's result, and an `ar` prediction suggests "Forward to AR" for a person to click.
- **Expertise tier (deterministic, no model):** map `decision.rule` to a tier. Tier 1 is templated status (`paid`, `released`, `scheduled_run`, `approved_no_run`, `multi_invoice`). Tier 2 is approvals, missing invoices and unauthorized senders. Tier 3 is fraud, returned payments, conflicts and holding replies. Show it as a column and filter in Tickets.
- **Fraud and anomaly signals (flag-only):** amount z-score per vendor across its bills, and first-time remittance-email changes. These add a `watch` item to the brief. They never clear an existing flag.

**Acceptance tests:** classifier accuracy is reported on a held-out split with abstention rate. Its output can't change `result` (assert byte-identical `results.json` with the classifier on and off). The tier mapping covers every rule in `rules.py` (a test enumerates them).

## Phase F (spec): Feedback loop

- **Capture:** Conductor already stores `edited_text` and the review state. Add a reason picker when a person returns a draft or edits more than 20% of it: `wrong_facts`, `tone`, `too_long`, `wrong_recipient`, `needs_human`, `other`.
- **Report:** `GET /api/feedback` gives edit rate per rule and template, top return reasons, and the median edit distance. These are inputs for snippet improvements, which a person makes. Nothing auto-tunes.
- **Vendor side:** each notice ends with "Reply to this email if anything looks wrong." Replies come back as normal tickets. No tracking links (the egress guard blocks links on purpose).

## Phase G (spec, after the freeze): Business-day calendar

Replace the hard-coded Thanksgiving move with `data/holidays.csv` (`date, name, run_moves_to`). `rules.add_business_days` and run-date logic read it. Do this only after November 19 is scored. Re-run the regression gate and the red-team set before merging.

---

## Open questions for Orchestra (for the next exec check-in)

1. "Balance": the open balance of the invoice asked about (our reading), or the vendor's total open balance? The Q&A says no aggregate information, so the plan shows per-invoice only.
2. Are proactive notices OK to send weekly at month end and mid-month (the peaks they named), or only when an invoice changes state?
3. For bank changes, which independent source holds the callback number: the contract, the NetSuite vendor record, or the sponsor employee?
4. Which document requests are most common: remittance advice, W9 copies of Orchestra's own form, or statements?
5. Can the onboarding link come from an AP mailbox address vendors already trust, so it doesn't look like phishing?

## Self-review notes

- Spec coverage: every row of the Background table maps to a phase. Exec Q1 is Tasks 2 to 5, Q2 is the Background recommendation plus Task 3, and Q3 is Phase C.
- Names used across tasks: `prevention.build/find/Unavailable/KINDS/STATES`, `db.save_prevention/get_prevention/set_prevention_state/save_prevention_sent/prevention_states`, `status_service.balance_line/AMOUNT`, and the route `prevent`. They're consistent in Tasks 2 to 5.
- Known judgment calls for the implementer: CSS token names in Task 5 Step 5,.
