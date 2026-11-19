"""Escalation, sign-off and send rules (dashboards/conductor/workflow.py). No Ollama: the run is model_free.

Every route is called with a real session. The inbox run is an ordinary run registered under settings key inbox.run_id
(the inbox worker's module is not needed for these rules).
"""
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "dashboards" / "conductor"), str(ROOT / "src"), str(ROOT)]

import db  # noqa: E402

_TMP = tempfile.TemporaryDirectory()
db.STATE_DIR = Path(_TMP.name)
db.DB_PATH = db.STATE_DIR / "app.db"
db.init()

import delivery  # noqa: E402
import live  # noqa: E402
import mailer  # noqa: E402
import scheduler  # noqa: E402
import server  # noqa: E402
import signin  # noqa: E402
import workflow  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

DATA = ROOT / "data"


class Base(unittest.TestCase):
    """One finished run per class, registered as the inbox run."""

    @classmethod
    def setUpClass(cls):
        cls._outbox = tempfile.TemporaryDirectory()
        cls._old_outbox = mailer.OUTBOX_DIR
        mailer.OUTBOX_DIR = Path(cls._outbox.name)
        cls.c = TestClient(server.app, base_url="http://localhost")
        cls.cfo = signin.headers("cfo")
        cls.ulla = signin.headers("ap_specialist")
        cls.omar = signin.headers("ap_specialist", "omar.calloway@orchestra-mock.example")
        cls.approver = signin.headers("approver")
        r = cls.c.post("/api/runs", json={"path": str(DATA), "model_free": True}, headers=cls.cfo)
        assert r.status_code == 200, r.text
        cls.rid = r.json()["run_id"]
        for _ in range(240):
            if cls.c.get(f"/api/runs/{cls.rid}", headers=cls.cfo).json()["status"] in ("done", "failed", "cancelled"):
                break
            time.sleep(0.5)
        cls._old_inbox = db.get_setting("inbox.run_id")
        db.set_setting("inbox.run_id", cls.rid)
        rows = db.list_rows(cls.rid)
        cls.priority = [r["ticket_id"] for r in rows if r["priority"] and r["output_type"] == "draft_reply"]
        cls.fraud = [r["ticket_id"] for r in rows if "fraud" in r["flags"]]
        cls.returned = [r["ticket_id"] for r in rows if r["rule"] == "returned_payment"]
        cls.fee = [r["ticket_id"] for r in rows if r["rule"] in ("late_fee", "expedite_request")]
        cls.pending = [r["ticket_id"] for r in rows if r["rule"] == "pending_approval"]
        cls.nodraft = [r["ticket_id"] for r in rows if r["output_type"] == "no_draft"]
        cls.routine = [r["ticket_id"] for r in rows if r["rule"] == "paid" and r["output_type"] == "draft_reply"]
        assert cls.priority and cls.fraud and cls.returned and cls.fee and cls.routine

    @classmethod
    def tearDownClass(cls):
        mailer.OUTBOX_DIR = cls._old_outbox
        if cls._old_inbox is None:
            db.delete_setting("inbox.run_id")
        else:
            db.set_setting("inbox.run_id", cls._old_inbox)
        cls._outbox.cleanup()

    def setUp(self):
        self._box = tempfile.TemporaryDirectory()   # one outbox per test: file names carry only the second they were written in
        mailer.OUTBOX_DIR = Path(self._box.name)
        for t in ("workflow_state", "audit_log", "scheduled_send", "reviews"):
            db._exec(f"DELETE FROM {t}")
        scheduler.set_clock(None)

    def tearDown(self):
        scheduler.set_clock(server.appclock.now)
        self._box.cleanup()

    # helpers
    def reply_hash(self, tid):
        to, subject, body = workflow.reply_parts(self.rid, tid)
        return delivery.reply_hash(to, subject, body)

    def review(self, tid, state, who=None, **body):
        return self.c.put(f"/api/runs/{self.rid}/review/{tid}", json={"state": state, **body}, headers=who or self.ulla)

    def wf(self, tid, action, who=None, **body):
        return self.c.post(f"/api/workflow/{tid}/{action}", json=body, headers=who or self.ulla)

    def outbox_count(self):
        return len(list(Path(mailer.OUTBOX_DIR).glob("*.eml")))


class Categories(Base):
    def test_each_category_comes_from_the_pipeline_decision(self):
        def cat(tid):
            return workflow.signoff_category(db.get_ticket(self.rid, tid)["bundle"])
        self.assertEqual({cat(t) for t in self.priority}, {"priority"})
        self.assertEqual({cat(t) for t in self.fraud}, {"fraud"})
        self.assertEqual({cat(t) for t in self.returned}, {"returned"})
        self.assertEqual({cat(t) for t in self.fee}, {"early_or_late_fee"})
        self.assertEqual({cat(t) for t in self.routine}, {None})
        self.assertIsNone(workflow.signoff_category({}))


class Priority(Base):
    def test_a_specialist_cannot_approve_a_priority_reply_but_can_send_after_sign_off(self):
        tid = self.priority[0]
        r = self.review(tid, "approved")
        self.assertEqual(r.status_code, 409)
        self.assertIn("sign-off", r.json()["detail"])
        self.assertEqual(self.wf(tid, "request-signoff", note="Legal threat, copying the CEO").status_code, 200)
        self.assertEqual(self.wf(tid, "signoff", who=self.ulla, reply_hash="x").status_code, 403)  # specialists cannot sign off
        self.assertEqual(self.wf(tid, "signoff", who=self.cfo, reply_hash="not-the-hash").status_code, 409)
        r = self.wf(tid, "signoff", who=self.cfo, reply_hash=self.reply_hash(tid))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["state"], "signed_off")
        self.assertEqual(r.json()["signoff"]["by"], "elena.lockhart@orchestra-mock.example")
        self.assertEqual(self.review(tid, "approved").status_code, 200)
        before = self.outbox_count()
        sent = self.c.post(f"/api/runs/{self.rid}/tickets/{tid}/send", headers=self.ulla)
        self.assertEqual(sent.status_code, 200, sent.text)
        self.assertEqual(self.outbox_count(), before + 1)
        st = self.c.get(f"/api/workflow/{tid}", headers=self.ulla).json()
        self.assertEqual(st["state"], "sent")
        actions = [h["action"] for h in st["history"]]
        self.assertEqual(actions, ["request-signoff", "signoff", "sent"])  # an audit row for every move
        self.assertEqual(st["history"][-1]["actor"], "ulla.abernathy@orchestra-mock.example")

    def test_an_edit_after_sign_off_cannot_be_sent(self):
        tid = self.priority[0]
        self.wf(tid, "signoff", who=self.cfo, reply_hash=self.reply_hash(tid))
        self.assertEqual(self.review(tid, "approved").status_code, 200)
        # The text changes behind the sign-off's back (not through the API, which would void the sign-off).
        db.save_draft(self.rid, tid, "Hello,\n\nWe will pay you tomorrow.\n\nAP", None)
        before = self.outbox_count()
        r = self.c.post(f"/api/runs/{self.rid}/tickets/{tid}/send", headers=self.ulla)
        self.assertEqual(r.status_code, 409)
        self.assertIn("changed after", r.json()["detail"])
        self.assertEqual(self.outbox_count(), before)

    def test_saving_a_draft_voids_the_sign_off(self):
        tid = self.priority[0]
        self.wf(tid, "signoff", who=self.cfo, reply_hash=self.reply_hash(tid))
        self.review(tid, "pending")
        r = self.c.put(f"/api/runs/{self.rid}/review/{tid}/draft", json={"text": "A different reply."}, headers=self.ulla)
        self.assertEqual(r.status_code, 200)
        st = self.c.get(f"/api/workflow/{tid}", headers=self.ulla).json()
        self.assertEqual(st["state"], "open")
        self.assertIsNone(st["signoff"])
        self.assertIn("signoff_voided", [h["action"] for h in st["history"]])
        r = self.review(tid, "approved")
        self.assertEqual(r.status_code, 409)

    def test_the_cfo_must_sign_off_too(self):
        tid = self.priority[0]
        r = self.review(tid, "approved", who=self.cfo)
        self.assertEqual(r.status_code, 409)
        self.assertIn("Sign off", r.json()["detail"])

    def test_scheduled_priority_send_without_sign_off_fails_closed(self):
        tid = self.priority[0]
        # Approved, but never signed off (set directly: the API would refuse), and a schedule that is due.
        db.save_review(self.rid, tid, "approved")
        to, subject, body = workflow.reply_parts(self.rid, tid)
        due = scheduler.to_iso(time.time() + 3600)
        db._exec("INSERT OR REPLACE INTO scheduled_send (run_id, ticket_id, send_at, status, attempts, last_error, approved_hash,"
                 " created_at, next_attempt_at) VALUES (?,?,?,?,0,NULL,?,?,NULL)",
                 (self.rid, tid, due, "scheduled", delivery.reply_hash(to, subject, body), scheduler.to_iso(time.time())))
        scheduler.set_clock(lambda: time.time() + 7200)
        before = self.outbox_count()
        self.assertEqual(scheduler.tick(), 0)
        row = db._one("SELECT status, last_error FROM scheduled_send WHERE run_id=? AND ticket_id=?", (self.rid, tid))
        self.assertEqual(row["status"], "cancelled")
        self.assertIn("sign-off", row["last_error"])
        self.assertEqual(self.outbox_count(), before)

    def test_a_signed_off_priority_reply_sends_on_schedule_until_the_sign_off_is_withdrawn(self):
        tid = self.priority[0]
        self.wf(tid, "signoff", who=self.cfo, reply_hash=self.reply_hash(tid))
        self.review(tid, "approved")
        at = scheduler.to_iso(time.time() + 3600)
        r = self.c.post(f"/api/runs/{self.rid}/tickets/{tid}/schedule", json={"send_at": at}, headers=self.ulla)
        self.assertEqual(r.status_code, 200, r.text)
        # The CFO returns it before the time comes: the schedule must not send.
        self.wf(tid, "escalate", reason="legal", note="x")  # not allowed from signed_off
        self.assertEqual(self.wf(tid, "return", who=self.cfo, guidance="Hold this one.").status_code, 200)
        scheduler.set_clock(lambda: time.time() + 7200)
        before = self.outbox_count()
        scheduler.tick()
        self.assertEqual(self.outbox_count(), before)
        row = db._one("SELECT status FROM scheduled_send WHERE run_id=? AND ticket_id=?", (self.rid, tid))
        self.assertNotEqual(row["status"], "sent")

    def test_scheduled_send_goes_out_when_signed_off(self):
        tid = self.priority[0]
        self.wf(tid, "signoff", who=self.cfo, reply_hash=self.reply_hash(tid))
        self.review(tid, "approved")
        at = scheduler.to_iso(time.time() + 3600)
        self.assertEqual(self.c.post(f"/api/runs/{self.rid}/tickets/{tid}/schedule", json={"send_at": at}, headers=self.ulla).status_code, 200)
        scheduler.set_clock(lambda: time.time() + 7200)
        before = self.outbox_count()
        self.assertEqual(scheduler.tick(), 1)
        self.assertEqual(self.outbox_count(), before + 1)
        self.assertEqual(workflow.get_state(tid)["state"], "sent")
        self.assertEqual(self.c.get(f"/api/workflow/{tid}", headers=self.ulla).json()["history"][-1]["actor"], "scheduled send")

    def test_request_signoff_needs_a_priority_reply(self):
        r = self.wf(self.routine[0], "request-signoff", note="x")
        self.assertEqual(r.status_code, 409)
        r = self.wf(self.fraud[0], "request-signoff", note="x")
        self.assertEqual(r.status_code, 409)


class Fraud(Base):
    def test_fraud_can_never_be_approved_by_anyone(self):
        tid = self.fraud[0]
        for who in (self.ulla, self.omar, self.cfo):
            self.assertIn(self.review(tid, "approved", who=who).status_code, (400, 409))  # a note has no reply to approve
            self.assertEqual(db.get_review(self.rid, tid)["state"], "pending")
        self.assertTrue(workflow.can_approve(signin.session_for("cfo"), self.rid, tid))
        self.assertTrue(workflow.can_send(self.rid, tid, "anything"))
        self.assertEqual(self.c.post(f"/api/runs/{self.rid}/tickets/{tid}/send", headers=self.cfo).status_code, 400)
        r = self.c.post(f"/api/runs/{self.rid}/review/bulk", json={"ids": [tid]}, headers=self.cfo)
        self.assertEqual(r.json()["done"], [])
        self.assertEqual(len(r.json()["skipped"]), 1)

    def test_even_a_sign_off_does_not_unlock_fraud(self):
        tid = self.fraud[0]
        self.assertEqual(self.wf(tid, "signoff", who=self.cfo, reply_hash="x").status_code, 409)


class Notes(Base):
    def test_note_tickets_are_decided_by_the_cfo_and_never_get_a_reply(self):
        for tid in (self.fraud[0], self.returned[0], self.fee[0]):
            self.assertEqual(self.review(tid, "acknowledged", who=self.ulla).status_code, 409)  # a specialist cannot decide it
            self.assertEqual(self.wf(tid, "escalate", reason="other", note="Please decide").status_code, 200)
            self.assertEqual(self.wf(tid, "request-signoff", note="x").status_code, 409)  # no reply to sign off
            self.assertEqual(self.wf(tid, "decide", who=self.ulla, decision="acknowledged", action_taken="x").status_code, 403)
            self.assertEqual(self.wf(tid, "decide", who=self.cfo, decision="acknowledged").status_code, 400)  # action required
            r = self.wf(tid, "decide", who=self.cfo, decision="acknowledged", action_taken="Called the vendor", note="")
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["state"], "decided")
            self.assertEqual(db.get_review(self.rid, tid)["state"], "acknowledged")
            self.assertEqual(self.c.post(f"/api/runs/{self.rid}/tickets/{tid}/send", headers=self.cfo).status_code, 400)

    def test_the_cfo_can_close_a_note(self):
        tid = self.returned[0]
        r = self.wf(tid, "decide", who=self.cfo, decision="closed", action_taken="", note="Handled outside Conductor")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["state"], "closed")

    def test_priority_is_not_decided_it_is_signed_off(self):
        r = self.wf(self.priority[0], "decide", who=self.cfo, decision="closed", action_taken="x")
        self.assertEqual(r.status_code, 409)


class Lifecycle(Base):
    def test_escalate_return_and_escalate_again(self):
        tid = self.routine[0]
        self.assertEqual(self.wf(tid, "escalate", reason="other").status_code, 400)  # other needs a note
        self.assertEqual(self.wf(tid, "escalate", reason="nonsense", note="x").status_code, 400)
        self.assertEqual(self.wf(tid, "escalate", reason="conflict", note="Records disagree").json()["state"], "escalated")
        self.assertEqual(self.wf(tid, "escalate", reason="conflict", note="again").status_code, 409)  # already with the CFO
        self.assertEqual(self.wf(tid, "return", who=self.cfo, guidance="  ").status_code, 400)
        r = self.wf(tid, "return", who=self.cfo, guidance="Check the second invoice first.")
        self.assertEqual(r.json()["state"], "returned")
        self.assertEqual(self.wf(tid, "escalate", reason="conflict", note="Still unsure").json()["state"], "escalated")
        hist = self.c.get(f"/api/workflow/{tid}", headers=self.ulla).json()["history"]
        self.assertEqual([h["action"] for h in hist], ["escalate", "return", "escalate"])
        self.assertEqual(hist[1]["detail"]["guidance"], "Check the second invoice first.")
        self.assertEqual(hist[1]["from_state"], "escalated")
        self.assertEqual(hist[1]["to_state"], "returned")

    def test_lists_are_for_the_cfo(self):
        self.wf(self.routine[0], "escalate", reason="conflict", note="x")
        rows = self.c.get("/api/workflow/escalations", headers=self.cfo).json()["rows"]
        self.assertIn(self.routine[0], [r["ticket_id"] for r in rows])
        self.assertIn(self.priority[0], [r["ticket_id"] for r in rows])  # priority is visible to the CFO before anyone asks
        self.assertEqual(self.c.get("/api/workflow/escalations", headers=self.ulla).status_code, 403)
        audit = self.c.get("/api/workflow/audit?limit=5", headers=self.cfo).json()["rows"]
        self.assertEqual(audit[0]["action"], "escalate")
        self.assertEqual(self.c.get("/api/workflow/audit", headers=self.ulla).status_code, 403)

    def test_workflow_events_reach_the_right_people(self):
        ulla, cfo, omar = (signin.session_for("ap_specialist"), signin.session_for("cfo"),
                           signin.session_for("ap_specialist", "omar.calloway@orchestra-mock.example"))
        streams = {n: live.open_stream(s) for n, s in (("ulla", ulla), ("cfo", cfo), ("omar", omar))}
        try:
            tid = self.routine[0]
            self.wf(tid, "escalate", reason="conflict", note="x")
            self.wf(tid, "return", who=self.cfo, guidance="Try again")
            got = {n: [e["type"] for e in iter(lambda s=s: s.get(), None)] for n, s in streams.items()}
        finally:
            for s in streams.values():
                live.close_stream(s)
        self.assertIn("ticket.escalated", got["cfo"])
        self.assertIn("ticket.escalated", got["ulla"])
        self.assertNotIn("ticket.escalated", got["omar"])     # Omar did not ask
        self.assertIn("ticket.returned", got["ulla"])         # the one who escalated is told
        self.assertNotIn("ticket.returned", got["omar"])


class Routes(Base):
    def test_a_specialist_gets_403_on_cfo_routes_and_an_approver_on_staff_routes(self):
        tid = self.priority[0]
        for method, path, body in (
            ("post", f"/api/workflow/{tid}/signoff", {"reply_hash": "x"}),
            ("post", f"/api/workflow/{tid}/return", {"guidance": "x"}),
            ("post", f"/api/workflow/{tid}/decide", {"decision": "closed"}),
            ("get", "/api/workflow/audit", None),
            ("get", "/api/workflow/escalations", None),
            ("get", "/api/feedback/trends", None),
        ):
            r = getattr(self.c, method)(path, headers=self.ulla, **({"json": body} if body is not None else {}))
            self.assertEqual(r.status_code, 403, path)
        for path in (f"/api/workflow/{tid}", f"/api/runs/{self.rid}/tickets", "/api/mail/status"):
            self.assertEqual(self.c.get(path, headers=self.approver).status_code, 403, path)
            self.assertEqual(self.c.get(path, headers={"x-ap-token": server.TOKEN}).status_code, 401, path)

    def test_after_the_review_the_page_is_told_to_ask_what_was_off(self):
        tid = self.routine[0]
        r = self.c.put(f"/api/runs/{self.rid}/review/{tid}/draft", json={"text": "Hello,\n\nA shorter reply.\n\nAP"}, headers=self.ulla)
        self.assertEqual(r.status_code, 200)
        r = self.review(tid, "approved")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["feedback_prompt"])
        self.assertEqual(self.c.post("/api/feedback", json={"run_id": self.rid, "ticket_id": tid, "category": "tone", "note": "Too curt"},
                                     headers=self.ulla).status_code, 200)
        r = self.c.get(f"/api/feedback/prompt?run_id={self.rid}&ticket_id={tid}", headers=self.ulla)
        self.assertFalse(r.json()["ask"])
        trends = self.c.get("/api/feedback/trends", headers=self.cfo).json()
        self.assertEqual(trends["source"], "Records as of Nov 13")
        self.assertGreaterEqual(dict((x["category"], x["count"]) for x in trends["by_category"])["tone"], 1)


class Tier2(Base):
    def test_expertise_is_seeded_from_both_ticket_files_and_editable_by_the_cfo(self):
        people = {p["email"]: p for p in self.c.get("/api/workflow/expertise", headers=self.ulla).json()["people"]}
        self.assertEqual(people["omar.calloway@orchestra-mock.example"]["replies"], 10)
        self.assertEqual(people["ulla.abernathy@orchestra-mock.example"]["replies"], 11)   # 5 + 6 from the linked tickets
        body = {"people": [{"email": "omar.calloway@orchestra-mock.example", "exceptions": True, "categories": ["fraud"]},
                           {"email": "ulla.abernathy@orchestra-mock.example", "exceptions": False, "categories": ["status"]}]}
        self.assertEqual(self.c.put("/api/workflow/expertise", json=body, headers=self.ulla).status_code, 403)
        self.assertEqual(self.c.put("/api/workflow/expertise", json={"people": [{"email": "x@y.z"}]}, headers=self.cfo).status_code, 400)
        try:
            self.assertEqual(self.c.put("/api/workflow/expertise", json=body, headers=self.cfo).status_code, 200)
            self.assertEqual(workflow.route(self.fraud[0]), "omar.calloway@orchestra-mock.example")
        finally:
            db._exec("UPDATE expertise SET exceptions=0")
            db._exec("UPDATE expertise SET exceptions=1 WHERE email LIKE 'ulla%'")

    def test_routing_by_expertise_and_round_robin(self):
        for t in self.fraud + self.returned:
            self.assertEqual(workflow.route(t), "ulla.abernathy@orchestra-mock.example")
        self.assertEqual(workflow.get_state(self.routine[0])["assignee"], workflow.route(self.routine[0]))
        self.assertIsNone(workflow.route(1))   # a ticket that is not in the inbox routes nowhere

    def test_assign(self):
        tid = self.routine[0]
        self.assertEqual(self.wf(tid, "assign", to="nobody@x.example").status_code, 400)
        r = self.wf(tid, "assign", to="omar.calloway@orchestra-mock.example")
        self.assertEqual(r.json()["assignee"], "omar.calloway@orchestra-mock.example")
        self.assertEqual(self.wf(tid, "assign", who=self.approver, to="omar.calloway@orchestra-mock.example").status_code, 403)

    def test_chase_is_an_outbound_item_a_person_approves_and_sends(self):
        tid = self.pending[0]
        r = self.wf(tid, "chase")
        self.assertEqual(r.status_code, 200, r.text)
        oid = r.json()["outbound_id"]
        self.assertEqual(self.wf(tid, "chase").status_code, 409)
        rows = self.c.get("/api/outbound?kind=approver_nudge", headers=self.ulla).json()["rows"]
        item = next(x for x in rows if x["id"] == oid)
        self.assertEqual((item["state"], item["problems"]), ("pending", []))
        self.assertEqual(self.c.post(f"/api/outbound/{oid}/send", headers=self.ulla).status_code, 409)   # not approved yet
        self.assertEqual(self.c.put(f"/api/outbound/{oid}", json={"state": "approved"}, headers=self.ulla).status_code, 200)
        before = self.outbox_count()
        s = self.c.post(f"/api/outbound/{oid}/send", json={"to": "evil@x.example", "body": "x"}, headers=self.ulla)
        self.assertEqual(s.status_code, 200, s.text)
        self.assertEqual(self.outbox_count(), before + 1)
        eml = next(Path(mailer.OUTBOX_DIR).glob("*.eml")).read_text(encoding="utf-8")
        self.assertIn(item["to"], eml)
        self.assertNotIn("evil@x.example", eml)
        self.assertEqual(self.c.post(f"/api/outbound/{oid}/send", headers=self.ulla).status_code, 409)   # already sent
        st = self.c.get(f"/api/workflow/{tid}", headers=self.ulla).json()
        self.assertTrue(st["chased"])
        self.assertIn("no response yet", st["chases"][0]["label"])
        self.assertEqual(self.c.get("/api/outbound", headers=self.approver).status_code, 403)

    def test_chase_only_for_tickets_waiting_on_an_approver(self):
        self.assertEqual(self.wf(self.routine[0], "chase").status_code, 409)

    def test_outbound_text_with_a_bank_number_cannot_be_approved_or_sent(self):
        oid = workflow.create_outbound("w9_request", "billing@quillfernstudio.example", "Your W-9",
                                       "Please send your W-9. Account number 12345678901234.", created_by="x@y.example", vendor_id="3000")
        self.assertIsInstance(oid, int)
        rows = self.c.get("/api/outbound?kind=w9_request", headers=self.ulla).json()["rows"]
        self.assertTrue(rows and rows[0]["id"] == oid and rows[0]["problems"])
        self.assertEqual(self.c.put(f"/api/outbound/{oid}", json={"state": "approved"}, headers=self.ulla).status_code, 422)
        db._exec("UPDATE outbound SET state='approved' WHERE id=?", (oid,))
        self.assertEqual(self.c.post(f"/api/outbound/{oid}/send", headers=self.ulla).status_code, 422)
        with self.assertRaises(ValueError):
            workflow.create_outbound("bogus", "a@b.example", "s", "b", created_by="x")

    def test_forward_and_no_reply_close_ordinary_tickets_only(self):
        r = self.wf(self.nodraft[0], "forward", to="hr", note="Payroll question")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["forwarded_to"]["name"], "Quinn Ellsworth")
        self.assertEqual(r.json()["state"], "closed")
        self.assertEqual(self.wf(self.nodraft[1], "no-reply", note="Automated").json()["state"], "closed")
        self.assertEqual(self.wf(self.fraud[0], "forward", to="ar").status_code, 409)
        self.assertEqual(self.wf(self.fraud[0], "no-reply").status_code, 409)

    def test_approver_queue_ack_and_commit(self):
        liam = signin.headers("approver", "liam.pemberton@orchestra-mock.example")
        q = self.c.get("/api/approver/queue", headers=liam).json()
        self.assertEqual(len(q["bills"]), 2)                      # Tessa's two pending bills
        bill = q["bills"][0]["bill_id"]
        self.assertEqual(self.c.post(f"/api/approver/bills/{bill}/ack", headers=liam).status_code, 200)
        self.assertEqual(self.c.post(f"/api/approver/bills/{bill}/commit", json={"date": "2026-11-01"}, headers=liam).status_code, 400)
        self.assertEqual(self.c.post(f"/api/approver/bills/{bill}/commit", json={"date": "2026-11-20"}, headers=liam).status_code, 200)
        self.assertEqual(self.c.post(f"/api/approver/bills/{bill}/commit", json={"date": "2026-11-20"}, headers=self.approver).status_code, 404)
        q = self.c.get("/api/approver/queue", headers=liam).json()
        self.assertEqual(next(b for b in q["bills"] if b["bill_id"] == bill)["commitment"]["date"], "2026-11-20")
        self.assertEqual(self.c.get("/api/approver/queue", headers=self.cfo).status_code, 200)             # CFO reads
        self.assertEqual(self.c.post(f"/api/approver/bills/{bill}/ack", headers=self.cfo).status_code, 403)  # but cannot act
        self.assertEqual(self.c.get("/api/approver/queue", headers=self.ulla).status_code, 403)

    def test_team_overview_labels_every_metric(self):
        r = self.c.get("/api/team/overview", headers=self.cfo)
        self.assertEqual(r.status_code, 200, r.text)
        o = r.json()
        for k in ("queues", "aging", "first_reply", "follow_up_rate", "bottlenecks"):
            self.assertEqual(o[k]["source"], "Records as of Nov 13", k)
        self.assertEqual(o["first_reply"]["baseline_days"], 1.5)
        self.assertEqual(o["ahead"]["self_serve_lookups"]["source"], "Records as of Nov 13")
        self.assertEqual(o["feedback"]["source"], "Records as of Nov 13")
        self.assertEqual(self.c.get("/api/team/overview", headers=self.ulla).status_code, 403)


if __name__ == "__main__":
    unittest.main()
