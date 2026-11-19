"""Tests for scheduled send (dashboards/conductor/scheduler.py, dashboards/conductor/delivery.py). No Ollama, no network.

The clock is injected and tick() is driven by hand, so nothing waits. Run from the repo root:
    python -m unittest tests.test_scheduler -v
"""
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "dashboards" / "conductor"))
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

import db  # noqa: E402

_TMP = tempfile.TemporaryDirectory()
db.STATE_DIR = Path(_TMP.name)          # never touch the real dashboards/conductor/state/app.db
db.DB_PATH = db.STATE_DIR / "app.db"
db.init()

import mailer  # noqa: E402
import scheduler  # noqa: E402
import server  # noqa: E402
import signin  # noqa: E402  (Phase 3: token + a signed-in session)
from fastapi.testclient import TestClient  # noqa: E402

DATA = ROOT / "data"
HOUR = 3600


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class ScheduleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._saved = (db.STATE_DIR, db.DB_PATH)
        db.STATE_DIR = Path(_TMP.name)
        db.DB_PATH = db.STATE_DIR / "app.db"
        db.init()
        cls.c = TestClient(server.app, base_url="http://localhost")
        cls.h = signin.headers()
        r = cls.c.post("/api/runs", json={"path": str(DATA), "use_model": False}, headers=cls.h)
        assert r.status_code == 200, r.text
        cls.rid = r.json()["run_id"]
        for _ in range(240):
            run = cls.c.get(f"/api/runs/{cls.rid}", headers=cls.h).json()
            if run["status"] in ("done", "failed", "cancelled"):
                break
            time.sleep(0.5)
        assert run["status"] == "done", run
        cls.rows = cls.c.get(f"/api/runs/{cls.rid}/tickets", headers=cls.h).json()["rows"]
        cls.plain = [r["ticket_id"] for r in cls.rows if r["output_type"] == "draft_reply" and not r["flags"] and r["recipient"]]
        cls.flagged = [r["ticket_id"] for r in cls.rows if r["output_type"] == "draft_reply" and r["flags"] and r["recipient"]]
        cls.used = 0

    @classmethod
    def tearDownClass(cls):
        scheduler.set_clock(None)
        db.STATE_DIR, db.DB_PATH = cls._saved

    def setUp(self):
        self.now = time.time()
        scheduler.set_clock(lambda: self.now)
        self.outbox = tempfile.TemporaryDirectory()
        self._get = mailer.get_mailer
        self.mail = mailer.OutboxMailer(self.outbox.name)
        mailer.get_mailer = lambda env=None: self.mail
        self.pick()

    def tearDown(self):
        mailer.get_mailer = self._get
        scheduler.set_clock(None)
        db._exec("DELETE FROM scheduled_send")                          # tick() looks at every row: leave none behind
        self.outbox.cleanup()

    # ---------------------------------------------------------------- helpers
    def pick(self):
        """Use the next untouched plain reply, so tests never share a ticket."""
        cls = type(self)
        self.tid = cls.plain[cls.used]
        cls.used += 1
        self.base = f"/api/runs/{self.rid}/review/{self.tid}"
        self.url = f"/api/runs/{self.rid}/tickets/{self.tid}/schedule"

    def approve(self):
        r = self.c.put(self.base, json={"state": "approved"}, headers=self.h)
        self.assertEqual(r.status_code, 200, r.text)

    def schedule(self, seconds=HOUR):
        return self.c.post(self.url, json={"send_at": iso(self.now + seconds)}, headers=self.h)

    def row(self):
        return scheduler._row(self.rid, self.tid)

    def eml_count(self):
        return len(list(Path(self.outbox.name).glob("*.eml")))

    def review_state(self):
        return db.get_review(self.rid, self.tid)["state"]

    # ---------------------------------------------------------------- tests
    def test_due_send_goes_through(self):
        self.approve()
        r = self.schedule()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["schedule"]["status"], "scheduled")
        self.assertEqual(scheduler.tick(self.now + HOUR - 5), 0)       # not due yet
        self.assertEqual(self.eml_count(), 0)
        self.assertEqual(scheduler.tick(self.now + HOUR + 1), 1)
        self.assertEqual(self.eml_count(), 1)
        self.assertEqual(self.review_state(), "sent")
        self.assertEqual(self.row()["status"], "sent")
        self.assertEqual(scheduler.tick(self.now + 2 * HOUR), 0)       # exactly once
        self.assertEqual(self.eml_count(), 1)

    def test_emit_after_send(self):
        seen = []
        scheduler._emit = lambda run_id, kind, data: seen.append((run_id, kind, data))
        try:
            self.approve()
            self.schedule()
            scheduler.tick(self.now + HOUR + 1)
        finally:
            scheduler._emit = None
        self.assertEqual(seen, [(self.rid, "review", {"ticket_id": self.tid, "state": "sent"})])

    def test_text_edited_after_scheduling_does_not_send(self):
        self.approve()
        self.assertEqual(self.schedule().status_code, 200)
        # the API refuses an edit while scheduled
        orig = self.c.get(f"/api/runs/{self.rid}/tickets/{self.tid}", headers=self.h).json()["draft"]["original_text"]
        self.assertEqual(self.c.put(self.base + "/draft", json={"text": orig + "\nmore"}, headers=self.h).status_code, 409)
        # and if the text changes behind its back anyway, nothing goes out
        db.save_draft(self.rid, self.tid, orig + "\n\nSneaky change.", None)
        self.assertEqual(scheduler.tick(self.now + HOUR + 1), 0)
        self.assertEqual(self.eml_count(), 0)
        self.assertEqual(self.row()["status"], "cancelled")
        self.assertIn("changed", self.row()["last_error"])
        self.assertEqual(self.review_state(), "approved")

    def test_cancelled_schedule_sends_nothing(self):
        self.approve()
        self.schedule()
        self.assertEqual(self.c.delete(self.url, headers=self.h).json()["schedule"]["status"], "cancelled")
        self.assertEqual(scheduler.tick(self.now + HOUR + 1), 0)
        self.assertEqual(self.eml_count(), 0)

    def test_flagged_ticket_never_sends(self):
        self.approve()
        self.assertEqual(self.schedule().status_code, 200)
        real = db.get_ticket

        def flagged(run_id, ticket_id):                                 # the ticket picks up a fraud flag after scheduling
            rec = real(run_id, ticket_id)
            if rec and ticket_id == self.tid:
                rec["bundle"]["result"]["flags"] = ["fraud"]
            return rec

        db.get_ticket = flagged
        try:
            self.assertEqual(scheduler.tick(self.now + HOUR + 1), 0)
            r = self.c.post(self.url, json={"send_at": iso(self.now + 2 * HOUR)}, headers=self.h)
            self.assertEqual(r.status_code, 409)                        # and it can't be scheduled again
        finally:
            db.get_ticket = real
        self.assertEqual(self.eml_count(), 0)
        self.assertEqual(self.row()["status"], "cancelled")
        self.assertIn("flagged", self.row()["last_error"])
        self.assertEqual(self.review_state(), "approved")

    def test_return_reopen_and_reapprove_cancel_the_schedule(self):
        for state, extra in (("returned", {"note": "fix it"}), ("pending", {})):
            self.approve()
            self.assertEqual(self.schedule().status_code, 200)
            r = self.c.put(self.base, json={"state": state, **extra}, headers=self.h)
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(self.row()["status"], "cancelled", state)
            self.assertEqual(scheduler.tick(self.now + HOUR + 1), 0)
        self.approve()
        self.schedule()
        self.approve()                                                  # approving again also cancels
        self.assertEqual(self.row()["status"], "cancelled")
        self.assertEqual(self.eml_count(), 0)

    def test_restart_sends_within_grace_and_marks_older_missed(self):
        self.approve()
        self.schedule()
        # the server was down; it comes back 12 hours after the due time
        self.assertEqual(scheduler.tick(self.now + HOUR + 12 * HOUR), 1)
        self.assertEqual(self.row()["status"], "sent")
        self.pick()
        self.approve()
        self.schedule()
        self.assertEqual(scheduler.tick(self.now + HOUR + 30 * HOUR), 0)
        self.assertEqual(self.row()["status"], "missed")
        self.assertEqual(self.eml_count(), 1)                           # still only the first one
        self.assertEqual(self.review_state(), "approved")
        # a person can schedule it again
        self.assertEqual(self.schedule().status_code, 200)
        self.assertEqual(self.row()["status"], "scheduled")

    def test_failure_retries_then_fails(self):
        calls = []

        class Down:
            mode, label = "smtp", "down"

            def send(self, msg):
                calls.append(1)
                raise mailer.MailError("The mail server did not accept the message. Nothing was sent.")

        self.mail = Down()
        self.approve()
        self.schedule()
        t = self.now + HOUR
        self.assertEqual(scheduler.tick(t), 0)
        self.assertEqual((self.row()["status"], self.row()["attempts"]), ("scheduled", 1))
        scheduler.tick(t + 5)                                           # backoff not over: no new attempt
        self.assertEqual(len(calls), 1)
        for step, expect in ((40, 2), (200, 3), (600, 4)):
            t += step
            scheduler.tick(t)
            self.assertEqual(len(calls), expect)
        self.assertEqual(self.row()["status"], "failed")
        self.assertIn("Nothing was sent", self.row()["last_error"])
        scheduler.tick(t + 10 * HOUR)
        self.assertEqual(len(calls), 4)
        self.assertEqual(self.review_state(), "approved")

    def test_window_and_state_rules(self):
        self.assertEqual(self.schedule().status_code, 409)              # not approved yet
        self.approve()
        self.assertEqual(self.schedule(30).status_code, 400)            # under 1 minute
        self.assertEqual(self.schedule(31 * 24 * HOUR).status_code, 400)
        self.assertEqual(self.c.post(self.url, json={"send_at": "2030-01-01T10:00:00"}, headers=self.h).status_code, 400)
        self.assertEqual(self.c.post(self.url, json={"send_at": "soon"}, headers=self.h).status_code, 400)
        self.assertEqual(self.schedule(90).status_code, 200)
        self.assertEqual(self.schedule(HOUR).status_code, 409)          # already scheduled
        got = self.c.get(self.url, headers=self.h).json()
        self.assertEqual(got["schedule"]["status"], "scheduled")
        self.assertEqual(got["mail_mode"], "simulated")
        self.assertEqual(self.c.delete(self.url, headers=self.h).json()["schedule"]["status"], "cancelled")

    def test_send_now_ends_the_schedule(self):
        self.approve()
        self.schedule()
        r = self.c.post(f"/api/runs/{self.rid}/tickets/{self.tid}/send", headers=self.h)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.row()["status"], "cancelled")
        self.assertEqual(scheduler.tick(self.now + HOUR + 1), 0)
        self.assertEqual(self.eml_count(), 1)

    def test_schedule_rows_are_removed_with_the_run(self):
        db.create_run("zz-sched", "x", "path", False, None, 0)
        db._exec("INSERT INTO scheduled_send (run_id, ticket_id, send_at, status) VALUES ('zz-sched', 1, 'x', 'scheduled')")
        db.delete_run("zz-sched")
        self.assertIsNone(scheduler._row("zz-sched", 1))


if __name__ == "__main__":
    unittest.main()
