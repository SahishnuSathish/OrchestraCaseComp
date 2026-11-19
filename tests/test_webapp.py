"""Tests for the Conductor web app (dashboards/conductor/). No Ollama needed: the model is never called.

Run from the repo root:  python -m unittest tests.test_webapp -v
"""
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "dashboards" / "conductor"))
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

import db  # noqa: E402

_TMP = tempfile.TemporaryDirectory()
db.STATE_DIR = Path(_TMP.name)          # never touch the real dashboards/conductor/state/app.db
db.DB_PATH = db.STATE_DIR / "app.db"
db.init()                               # (also when another test module already imported server)

import runner  # noqa: E402
import summarize  # noqa: E402
import server  # noqa: E402
import signin  # noqa: E402  (Phase 3: token + a signed-in session)
from fastapi.testclient import TestClient  # noqa: E402

DATA = ROOT / "data"


def facts_for(**over):
    bundle = {
        "ticket_id": 1, "stages": [
            {"name": "sender", "summary": "vendor_contact, authorized=True: listed contact for V1"},
            {"name": "extract_regex", "summary": "intent=status_request; refs=['INV-100']; cues=[]"},
            {"name": "lookups", "summary": "1 item(s): [('INV-100', 'found')]; vendor=Acme Print"},
            {"name": "draft_check", "summary": "passed"}],
        "model": None, "advisory": None, "plan": {"skipped": False},
        "trace": [{"seq": 1, "platform": "netsuite", "action": "find_bills_by_tranId", "endpoint": "/record/v1/vendorBill?tranId=INV-100",
                   "key": "INV-100", "result_count": 1, "ms": 1},
                  {"seq": 2, "platform": "payment_system", "action": "find_payments_for_bill", "endpoint": "/x", "key": "55",
                   "result_count": 1, "ms": 1}],
        "result": {"ticket_id": 1, "output_type": "draft_reply", "recipient": "ap@acme.example", "reason_tag": None, "priority": False,
                   "flags": [], "text": "Hi Sam,\n\nInvoice INV-100 was paid on October 22, 2026 by ACH transfer, reference ACH578416.\n\nBest regards,\nAP"},
        "decision": {"rule": "paid", "why": "Payment settled.", "act_by": None},
    }
    bundle.update(over)
    return summarize.build_facts(bundle, {"subject": "Checking in on INV-100", "sender_name": "Sam"})


class BriefTests(unittest.TestCase):
    def test_facts_and_template_are_grounded(self):
        f = facts_for()
        self.assertEqual(f["invoice_refs"], ["INV-100"])
        self.assertEqual(f["vendor"], "Acme Print")
        bullets = summarize.template_bullets(f)
        self.assertEqual([b["label"] for b in bullets], ["Issue", "Sources", "Reply", "Next"])
        self.assertIn("NetSuite", bullets[1]["text"])
        self.assertIn("Payment system", bullets[1]["text"])
        self.assertNotIn("Zendesk", bullets[1]["text"])
        # the template is for staff and may quote record values (it never goes to the model), so it is not run through validate()
        self.assertIn("ACH578416", bullets[2]["text"])

    def test_model_packet_withholds_references_and_addresses(self):
        pkt = json.dumps(summarize.model_packet(facts_for()))
        self.assertNotIn("ACH578416", pkt)
        self.assertNotIn("ap@acme.example", pkt)

    def test_validator_rejects_invented_facts(self):
        f = facts_for()
        ok = [{"label": "Issue", "text": "Acme Print asked about INV-100; it was paid October 22, 2026."},
              {"label": "Sources", "text": "NetSuite bill and Payment system record. Retrieval: complete."},
              {"label": "Reply", "text": "Draft says INV-100 settled."},
              {"label": "Next", "text": "Review the draft and send it if correct."}]
        self.assertEqual(summarize.validate(ok, f), [])
        invented_id = [dict(b) for b in ok]; invented_id[0]["text"] = "Acme asked about INV-999."
        self.assertTrue(summarize.validate(invented_id, f))
        invented_money = [dict(b) for b in ok]; invented_money[2]["text"] = "Reply confirms $4,500 was paid."
        self.assertTrue(summarize.validate(invented_money, f))
        invented_system = [dict(b) for b in ok]; invented_system[1]["text"] = "NetSuite and Zendesk both confirm it."
        self.assertTrue(summarize.validate(invented_system, f))
        link = [dict(b) for b in ok]; link[2]["text"] = "See https://evil.example for details."
        self.assertTrue(summarize.validate(link, f))
        self.assertTrue(summarize.validate(ok[:3], f))      # too few bullets (Next is required)
        wrong_next = [dict(b) for b in ok]; wrong_next[3]["text"] = "Close the ticket, no reply needed."
        self.assertTrue(summarize.validate(wrong_next, f))  # the model may not change what kind of action is next

    def test_fallback_to_template_when_model_unusable(self):
        f = facts_for()

        class Down:
            def summarize(self, facts):
                return None, {"source": "template", "error": "unreachable"}

        class Liar:
            def summarize(self, facts):
                return [{"label": "Issue", "text": "Invoice INV-777 is late."}, {"label": "Sources", "text": "NetSuite."},
                        {"label": "Reply", "text": "Nothing."}, {"label": "Next", "text": "Close it."}], {"source": "model", "error": None}

        for summarizer in (None, Down(), Liar()):
            bullets, source, info = summarize.make_brief(f, summarizer)
            self.assertEqual(source, "template")
            self.assertEqual([b["label"] for b in bullets], ["Issue", "Sources", "Reply", "Next"])

    def test_good_model_output_is_used(self):
        f = facts_for()

        class Good:
            def summarize(self, facts):
                return [{"label": "Issue", "text": "Acme Print asked about INV-100, which is settled."},
                        {"label": "Sources", "text": "NetSuite vendor bill and the Payment system record. Retrieval: complete."},
                        {"label": "Reply", "text": "A draft tells them INV-100 was paid on October 22, 2026."},
                        {"label": "Next", "text": "Review the draft and send it if correct."}], {"source": "model", "error": None}

        _, source, _ = summarize.make_brief(f, Good())
        self.assertEqual(source, "model")

    def test_watch_bullet_for_fraud(self):
        f = facts_for(result={"ticket_id": 1, "output_type": "internal_action_note", "recipient": None, "reason_tag": None,
                              "priority": False, "flags": ["fraud"], "text": "INTERNAL ACTION NOTE"})
        labels = [b["label"] for b in summarize.template_bullets(f)]
        self.assertEqual(labels[-1], "Watch")

    def test_non_local_model_host_is_refused(self):
        s = summarize.OllamaSummarizer(url="http://example.com:11434")
        bullets, info = s.summarize(facts_for())
        self.assertIsNone(bullets)
        self.assertIn("not local", info["error"])


class DatasetTests(unittest.TestCase):
    def test_validates_the_practice_dataset(self):
        v = runner.validate_dataset(DATA)
        self.assertTrue(v["ok"], v)
        self.assertEqual(v["tickets"], 100)

    def test_rejects_bad_paths_without_raising(self):
        for p in ("", str(ROOT / "does-not-exist"), str(ROOT / "src")):
            v = runner.validate_dataset(p)
            self.assertFalse(v["ok"])
            self.assertTrue(v.get("error"))


class MailerTests(unittest.TestCase):
    def msg(self, **kw):
        import mailer
        base = dict(sender="ap@orchestra.example", to="vendor@acme.example", subject="Re: Invoice", body="Hello.", ticket_id=7)
        base.update(kw)
        return mailer.Message(**base)

    def test_outbox_writes_an_eml_and_sends_nothing(self):
        import mailer
        with tempfile.TemporaryDirectory() as d:
            info = mailer.OutboxMailer(d).send(self.msg(subject="Re: Hi\r\nBcc: spy@evil.example"))
            text = Path(info["path"]).read_text(encoding="utf-8")
            self.assertEqual(info["mode"], "simulated")
            self.assertIn("To: vendor@acme.example", text)
            self.assertNotIn("\nBcc:", text)            # a newline in the subject cannot start a new header
            self.assertIn("Subject: Re: Hi Bcc: spy@evil.example", text)

    def test_rejects_bad_addresses_and_empty_bodies(self):
        import mailer
        for bad in (self.msg(to="not-an-address"), self.msg(to="a@b.example, c@d.example"), self.msg(body="  ")):
            with self.assertRaises(mailer.MailError):
                mailer.OutboxMailer(tempfile.gettempdir()).send(bad)

    def test_smtp_mode_is_opt_in_and_uses_env_only(self):
        import mailer
        self.assertIsInstance(mailer.get_mailer({}), mailer.OutboxMailer)
        self.assertIsInstance(mailer.get_mailer({"ORCHESTRA_MAIL_MODE": "smtp"}), mailer.OutboxMailer)   # no host: stay safe
        m = mailer.get_mailer({"ORCHESTRA_MAIL_MODE": "smtp", "ORCHESTRA_SMTP_HOST": "smtp.orchestra.example", "ORCHESTRA_SMTP_USER": "u", "ORCHESTRA_SMTP_PASSWORD": "p"})
        self.assertIsInstance(m, mailer.SmtpMailer)
        self.assertEqual(mailer.default_sender("ap@in.example", {}), "ap@in.example")
        self.assertEqual(mailer.default_sender("ap@in.example", {"ORCHESTRA_MAIL_FROM": "ap@out.example"}), "ap@out.example")

    def test_smtp_send_and_failures(self):
        import smtplib
        from unittest import mock
        import mailer
        m = mailer.SmtpMailer("smtp.orchestra.example", 587, "u", "p")
        with mock.patch("smtplib.SMTP") as smtp:
            conn = smtp.return_value.__enter__.return_value
            conn.send_message.return_value = {}
            info = m.send(self.msg())
            conn.starttls.assert_called_once()
            conn.login.assert_called_once_with("u", "p")
            self.assertEqual(info["mode"], "smtp")
            conn.send_message.return_value = {"vendor@acme.example": (550, b"no")}
            with self.assertRaises(mailer.MailError):
                m.send(self.msg())
        with mock.patch("smtplib.SMTP", side_effect=smtplib.SMTPConnectError(421, "busy")):
            with self.assertRaises(mailer.MailError):
                m.send(self.msg())


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(server.app, base_url="http://localhost")
        cls.h = signin.headers("cfo")
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

    def test_run_processed_every_ticket_with_a_brief(self):
        self.assertEqual(len(self.rows), 100)
        self.assertFalse([r for r in self.rows if r["output_type"] == "error"])
        d = self.c.get(f"/api/runs/{self.rid}/tickets/{self.rows[0]['ticket_id']}", headers=self.h).json()
        self.assertGreaterEqual(len(d["brief"]["bullets"]), 3)
        self.assertEqual(d["brief"]["source"], "template")
        self.assertTrue(d["ticket"]["body"])

    def test_token_and_host_guards(self):
        self.assertEqual(self.c.get("/api/runs").status_code, 401)
        self.assertEqual(self.c.get("/api/runs", headers={"x-ap-token": "nope"}).status_code, 401)
        self.assertEqual(self.c.get("/api/runs", headers={**self.h, "host": "evil.example"}).status_code, 403)
        self.assertEqual(self.c.post("/api/runs", json={"path": str(DATA)}, headers={**self.h, "origin": "http://evil.example"}).status_code, 403)

    def test_fs_listing_is_directories_only(self):
        r = self.c.get("/api/fs/list", params={"path": str(ROOT)}, headers=self.h).json()
        names = {e["name"] for e in r["entries"]}
        self.assertIn("data", names)
        self.assertNotIn("README.md", names)
        self.assertTrue(next(e for e in r["entries"] if e["name"] == "data")["has_tickets"])

    def test_review_rules_and_export(self):
        by_type = {}
        for r in self.rows:
            by_type.setdefault(r["output_type"], []).append(r)
        reply = next(r for r in by_type["draft_reply"] if not r["flags"])
        tid = reply["ticket_id"]
        url = f"/api/runs/{self.rid}/review/{tid}"
        # returning needs a reason; notes cannot be "approved"
        self.assertEqual(self.c.put(url, json={"state": "returned"}, headers=self.h).status_code, 400)
        self.assertEqual(self.c.put(url, json={"state": "closed"}, headers=self.h).status_code, 400)
        note = by_type["internal_action_note"][0]
        self.assertEqual(self.c.put(f"/api/runs/{self.rid}/review/{note['ticket_id']}", json={"state": "approved"}, headers=self.h).status_code, 400)
        # approve with an edit
        r = self.c.put(url, json={"state": "approved", "text": "Edited reply text."}, headers=self.h)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["review"]["state"], "approved")
        self.assertTrue(r.json()["draft"]["edited"])
        ex = self.c.get(f"/api/runs/{self.rid}/export", headers=self.h).json()
        got = {x["ticket_id"]: x for x in ex["results"]}
        self.assertEqual(got[tid]["text"], "Edited reply text.")
        self.assertEqual(len(got), 1)
        # undo
        self.assertEqual(self.c.put(url, json={"state": "pending"}, headers=self.h).json()["review"]["state"], "pending")
        self.assertEqual(self.c.get(f"/api/runs/{self.rid}/export", headers=self.h).json()["results"], [])

    def test_flagged_ticket_cannot_be_approved(self):
        flagged = [r for r in self.rows if r["flags"]]
        self.assertTrue(flagged, "the practice data has fraud-flagged tickets")
        row = next((r for r in flagged if r["output_type"] == "draft_reply"), None)
        if row is None:  # fraud tickets normally come back as internal notes; check the guard directly
            from fastapi import HTTPException
            tid = flagged[0]["ticket_id"]
            rec = db.get_ticket(self.rid, tid)
            rec["row"]["output_type"] = "draft_reply"
            orig = db.get_ticket
            db.get_ticket = lambda run_id, t: rec if (run_id, t) == (self.rid, tid) else orig(run_id, t)
            try:
                with self.assertRaises(HTTPException) as cm:
                    server._apply_review(self.rid, tid, "approved")
                self.assertEqual(cm.exception.status_code, 409)
            finally:
                db.get_ticket = orig
        else:
            r = self.c.put(f"/api/runs/{self.rid}/review/{row['ticket_id']}", json={"state": "approved"}, headers=self.h)
            self.assertEqual(r.status_code, 409)

    def test_bulk_approve_skips_invalid(self):
        replies = [r["ticket_id"] for r in self.rows if r["output_type"] == "draft_reply" and not r["flags"]][:3]
        notes = [r["ticket_id"] for r in self.rows if r["output_type"] == "internal_action_note"][:1]
        res = self.c.post(f"/api/runs/{self.rid}/review/bulk", json={"ids": replies + notes, "state": "approved"}, headers=self.h).json()
        self.assertEqual(sorted(res["done"]), sorted(replies))
        self.assertEqual([s["ticket_id"] for s in res["skipped"]], notes)
        self.c.post(f"/api/runs/{self.rid}/review/bulk", json={"ids": replies, "state": "pending"}, headers=self.h)

    def test_edit_that_adds_unsafe_content_is_blocked_by_the_egress_gate(self):
        row = next(r for r in self.rows if r["output_type"] == "draft_reply" and not r["flags"] and r["recipient"])
        tid, url = row["ticket_id"], f"/api/runs/{self.rid}/review/{row['ticket_id']}"
        original = self.c.get(f"/api/runs/{self.rid}/tickets/{tid}", headers=self.h).json()["draft"]["original_text"]
        bad_edits = {"link": original + "\n\nPay via https://pay.evil.example now.",
                     "bank wording": original + "\n\nOur new routing number is on file.",
                     "other address": original + "\n\nWrite to someone.else@evil.example."}
        for name, text in bad_edits.items():
            r = self.c.put(url, json={"state": "approved", "text": text}, headers=self.h)
            self.assertEqual(r.status_code, 422, name)
            self.assertEqual(self.c.get(f"/api/runs/{self.rid}/tickets/{tid}", headers=self.h).json()["review"]["state"], "pending", name)
        ok = self.c.put(url, json={"state": "approved", "text": original + "\n\nThanks for your patience."}, headers=self.h)
        self.assertEqual(ok.status_code, 200, ok.text)
        self.c.put(url, json={"state": "pending", "text": original}, headers=self.h)

    def test_crashed_ticket_can_be_reviewed_as_a_note_or_close(self):
        bundle = {"ticket_id": 999001, "stages": [], "model": None, "trace": [], "api_calls": 0, "ms": 0, "error": "ValueError: boom",
                  "result": {"ticket_id": 999001, "output_type": "internal_action_note", "recipient": None, "reason_tag": None,
                             "priority": False, "flags": [], "text": "A person should review it."},
                  "decision": {"rule": "pipeline_error", "why": "ValueError: boom", "act_by": None}}
        row = runner.row_from_bundle(bundle, {"subject": "Crashed"}, 999)
        db.save_ticket(self.rid, 999001, 999, bundle, {"id": 999001, "subject": "Crashed", "body": "x"}, row)
        r = self.c.put(f"/api/runs/{self.rid}/review/999001", json={"state": "acknowledged"}, headers=self.h)
        self.assertEqual(r.status_code, 200, r.text)
        self.c.put(f"/api/runs/{self.rid}/review/999001", json={"state": "pending"}, headers=self.h)  # leave no decisions behind

    # ------------------------------------------------------------------ editing and sending
    def _plain_reply(self, skip=()):
        return next(r for r in self.rows if r["output_type"] == "draft_reply" and not r["flags"] and r["recipient"] and r["ticket_id"] not in skip)

    def test_draft_autosave_keeps_state_and_reports_problems(self):
        row = self._plain_reply()
        tid, base = row["ticket_id"], f"/api/runs/{self.rid}/review/{row['ticket_id']}"
        orig = self.c.get(f"/api/runs/{self.rid}/tickets/{tid}", headers=self.h).json()["draft"]
        ok = self.c.put(base + "/draft", json={"text": orig["original_text"] + "\n\nThanks!", "subject": "Re: custom subject"}, headers=self.h).json()
        self.assertEqual((ok["saved"], ok["edited"], ok["subject_edited"], ok["problems"]), (True, True, True, []))
        d = self.c.get(f"/api/runs/{self.rid}/tickets/{tid}", headers=self.h).json()
        self.assertEqual(d["review"]["state"], "pending")            # autosave never decides anything
        self.assertEqual(d["draft"]["subject"], "Re: custom subject")
        self.assertTrue(d["draft"]["text"].endswith("Thanks!"))
        bad = self.c.put(base + "/draft", json={"text": orig["original_text"] + "\nSee https://x.example"}, headers=self.h).json()
        self.assertTrue(bad["problems"])
        # newlines in the subject are flattened (no header injection)
        self.c.put(base + "/draft", json={"text": orig["original_text"], "subject": "A\r\nBcc: x@evil.example"}, headers=self.h)
        self.assertNotIn("\n", self.c.get(f"/api/runs/{self.rid}/tickets/{tid}", headers=self.h).json()["draft"]["subject"])
        # back to the original: nothing is stored as an edit
        back = self.c.put(base + "/draft", json={"text": orig["original_text"], "subject": orig["default_subject"]}, headers=self.h).json()
        self.assertEqual((back["edited"], back["subject_edited"]), (False, False))

    def test_zz_send_requires_approval_and_goes_out_once(self):  # runs last: a sent reply can't be reset
        import mailer
        row = self._plain_reply(skip=[r["ticket_id"] for r in self.rows if r["review_state"] != "pending"])
        tid = row["ticket_id"]
        base = f"/api/runs/{self.rid}/review/{tid}"
        send = f"/api/runs/{self.rid}/tickets/{tid}/send"
        with tempfile.TemporaryDirectory() as outbox:
            original_get = mailer.get_mailer
            mailer.get_mailer = lambda env=None: mailer.OutboxMailer(outbox)
            try:
                self.assertEqual(self.c.post(send, headers=self.h).status_code, 409)           # not approved yet
                orig = self.c.get(f"/api/runs/{self.rid}/tickets/{tid}", headers=self.h).json()["draft"]
                self.c.put(base + "/draft", json={"text": orig["original_text"] + "\n\nAdded by me.", "subject": "Re: my subject"}, headers=self.h)
                self.assertEqual(self.c.put(base, json={"state": "approved"}, headers=self.h).status_code, 200)
                # editing is closed once approved
                self.assertEqual(self.c.put(base + "/draft", json={"text": "x"}, headers=self.h).status_code, 409)
                r = self.c.post(send, headers=self.h)
                self.assertEqual(r.status_code, 200, r.text)
                body = r.json()
                self.assertEqual(body["review"]["state"], "sent")
                self.assertTrue(body["review"]["message_id"])
                self.assertEqual(body["mail"]["mode"], "simulated")
                files = list(Path(outbox).glob("*.eml"))
                self.assertEqual(len(files), 1)
                eml = files[0].read_text(encoding="utf-8")
                self.assertIn(f"To: {row['recipient']}", eml)
                self.assertIn("Subject: Re: my subject", eml)
                self.assertIn("Added by me.", eml)
                # exactly once, and a sent reply can't be changed or reopened
                self.assertEqual(self.c.post(send, headers=self.h).status_code, 409)
                self.assertEqual(self.c.put(base, json={"state": "pending"}, headers=self.h).status_code, 409)
                self.assertEqual(len(list(Path(outbox).glob("*.eml"))), 1)
                ex = {x["ticket_id"]: x for x in self.c.get(f"/api/runs/{self.rid}/export", headers=self.h).json()["results"]}
                self.assertIn("Added by me.", ex[tid]["text"])
            finally:
                mailer.get_mailer = original_get

    def test_flagged_ticket_cannot_be_sent_and_mail_failure_keeps_it_approved(self):
        import mailer
        flagged = next(r for r in self.rows if r["flags"])
        self.assertIn(self.c.post(f"/api/runs/{self.rid}/tickets/{flagged['ticket_id']}/send", headers=self.h).status_code, (400, 409))
        row = self._plain_reply(skip=[r["ticket_id"] for r in self.rows if r["review_state"] != "pending"])
        tid, base = row["ticket_id"], f"/api/runs/{self.rid}/review/{row['ticket_id']}"
        self.c.put(base, json={"state": "approved"}, headers=self.h)

        class Down:
            mode, label = "smtp", "Sent through down.example"

            def send(self, msg):
                raise mailer.MailError("The mail server did not accept the message (SMTPException). Nothing was sent.")

        original_get = mailer.get_mailer
        mailer.get_mailer = lambda env=None: Down()
        try:
            r = self.c.post(f"/api/runs/{self.rid}/tickets/{tid}/send", headers=self.h)
            self.assertEqual(r.status_code, 502)
            self.assertEqual(self.c.get(f"/api/runs/{self.rid}/tickets/{tid}", headers=self.h).json()["review"]["state"], "approved")
        finally:
            mailer.get_mailer = original_get
            self.c.put(base, json={"state": "pending"}, headers=self.h)

    def test_index_injects_token(self):
        html = self.c.get("/").text
        self.assertIn(server.TOKEN, html)
        self.assertNotIn("__AP_TOKEN__", html)


class RunFinishTests(unittest.TestCase):
    def test_a_run_reported_done_can_be_deleted_at_once(self):
        """The slow post-run model check must not keep a 'done' run marked busy (delete used to get 409 here)."""
        mgr = server.get_manager()
        original = runner.model_status

        def slow_status(force=False):
            time.sleep(1.5)  # a refused localhost connection can take this long on Windows
            return {"usable": False, "state": "unreachable", "model": None}

        runner.model_status = slow_status
        try:
            rid = mgr.start_run(str(DATA), limit=3)
            for _ in range(500):
                if db.get_run(rid)["status"] == "done":
                    break
                time.sleep(0.01)
            self.assertEqual(db.get_run(rid)["status"], "done")
            mgr.delete_run(rid)  # raised RuntimeError ("still in progress") before the fix
            self.assertIsNone(db.get_run(rid))
            self.assertIsNone(mgr.running_run())
        finally:
            time.sleep(1.6)  # let the run thread finish its model check before restoring
            runner.model_status = original


class LiveStateTests(unittest.TestCase):
    def test_opening_a_finished_run_does_not_block_delete(self):
        """Viewing a done run (its event stream calls ensure_live) must not mark it busy: delete used to refuse it."""
        mgr = server.get_manager()
        rid = "livetest1"
        db.create_run(rid, "x", "run", False, None, 1, label="live test", status="done")
        try:
            mgr.live.pop(rid, None)  # as after a restart: no in-memory record yet
            mgr.ensure_live(rid)
            self.assertTrue(mgr.live[rid].finished)
            mgr.delete_run(rid)  # must not raise
            self.assertIsNone(db.get_run(rid))
        finally:
            mgr.live.pop(rid, None)
            db.delete_run(rid)

    def test_a_running_run_is_still_busy(self):
        mgr = server.get_manager()
        rid = "livetest2"
        db.create_run(rid, "x", "run", False, None, 1, label="live test", status="running")
        try:
            mgr.live.pop(rid, None)
            mgr.ensure_live(rid)
            self.assertFalse(mgr.live[rid].finished)
            with self.assertRaises(RuntimeError):
                mgr.delete_run(rid)
        finally:
            mgr.live.pop(rid, None)
            db.delete_run(rid)


class BrandTests(unittest.TestCase):
    def test_page_and_app_are_named_conductor(self):
        c = TestClient(server.app, base_url="http://localhost")
        html = c.get("/app").text  # Phase 3: "/" is the sign-in hub; the staff workspace is at /app
        self.assertIn("<title>Conductor</title>", html)
        self.assertNotIn("AP Desk", c.get("/").text)
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


if __name__ == "__main__":
    unittest.main()
