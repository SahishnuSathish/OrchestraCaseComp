"""Inbox (dashboards/conductor/inbox.py): the inbox run, arrivals, threads, queues, attachments, write-back, Advanced.

Run from the repo root:  python -m unittest discover -s tests -p "test_inbox.py" -v
No model is ever called.
"""
import hashlib
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "dashboards" / "conductor"))
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

import db  # noqa: E402

_TMP = tempfile.TemporaryDirectory()
db.STATE_DIR = Path(_TMP.name)
db.DB_PATH = db.STATE_DIR / "app.db"
db.init()

import delivery  # noqa: E402
import documents  # noqa: E402
import inbox  # noqa: E402
import run_all  # noqa: E402
import score as scorer  # noqa: E402
import server  # noqa: E402
import signin  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

inbox.AUTOSYNC = False  # no background arrivals while tests run
DATA = ROOT / "data"


def data_fingerprint():
    return {p.name: hashlib.sha1(p.read_bytes()).hexdigest() for p in sorted(DATA.iterdir()) if p.is_file()}


def file_tickets():
    return json.loads((DATA / "tickets.json").read_text(encoding="utf-8"))["tickets"]


class InboxCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(server.app, base_url="http://localhost")
        cls.h = signin.headers()
        cls.cfo = signin.headers("cfo")
        cls._get_mailer = server.mailer.get_mailer
        cls._outbox = tempfile.TemporaryDirectory()
        server.mailer.get_mailer = lambda env=None: server.mailer.OutboxMailer(cls._outbox.name)  # never the real outbox
        inbox.reset()
        cls.fingerprint = data_fingerprint()

    @classmethod
    def tearDownClass(cls):
        server.mailer.get_mailer = cls._get_mailer
        cls._outbox.cleanup()

    def get(self, path, **kw):
        r = self.c.get(path, headers=self.h, **kw)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()


class InboxRunTests(InboxCase):
    def test_run_excludes_exactly_the_last_eight_by_created_at(self):
        ts = file_tickets()
        held = [t["id"] for t in sorted(ts, key=lambda t: t["created_at"])[-8:]]
        self.assertEqual(sorted(inbox.held_back_ids()), sorted(held))
        rid = inbox.inbox_run_id()
        in_run = {r["ticket_id"] for r in db.list_rows(rid)}
        self.assertEqual(in_run, {t["id"] for t in ts} - set(held))
        self.assertEqual(len(in_run), len(ts) - 8)
        run = db.get_run(rid)
        self.assertEqual((run["source"], run["label"], run["status"]), ("inbox", "Inbox", "done"))
        self.assertEqual(db.get_setting("inbox.run_id"), rid)

    def test_existing_run_routes_work_on_the_inbox_run(self):
        rid = inbox.inbox_run_id()
        self.assertEqual(self.get(f"/api/runs/{rid}")["source"], "inbox")
        rows = self.get(f"/api/runs/{rid}/tickets")["rows"]
        self.assertEqual(len(rows), len(file_tickets()) - 8)
        d = self.get(f"/api/runs/{rid}/tickets/{rows[0]['ticket_id']}")
        self.assertIn("draft", d)
        self.assertIsNotNone(d["brief"])  # a template brief was stored

    def test_first_call_is_safe_from_many_threads(self):
        db.delete_run(db.get_setting("inbox.run_id"))
        db.delete_setting("inbox.run_id")
        inbox._drop_caches()
        out, errs = [], []

        def go():
            try:
                out.append(inbox.inbox_run_id())
            except Exception as e:  # pragma: no cover
                errs.append(e)
        threads = [threading.Thread(target=go) for _ in range(12)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(errs, [])
        self.assertEqual(len(set(out)), 1)
        self.assertEqual(len([r for r in db.list_runs(50) if r["source"] == "inbox"]), 1)

    def test_a_deleted_or_half_built_run_is_rebuilt(self):
        rid = inbox.inbox_run_id()
        db.update_run(rid, status="interrupted")
        new = inbox.inbox_run_id()
        self.assertNotEqual(new, rid)
        self.assertIsNone(db.get_run(rid))
        self.assertEqual(db.get_run(new)["status"], "done")


class IngestTests(InboxCase):
    def setUp(self):
        inbox.reset()

    def test_ingest_of_each_held_back_ticket_matches_run_all(self):
        rid = inbox.inbox_run_id()
        held = inbox.held_back_ids()
        expected = {b["ticket_id"]: b for b in run_all.run(None, str(DATA), None, False, only=set(held))}
        self.assertEqual(set(expected), set(held))
        before = data_fingerprint()
        for tid in held:
            t = inbox._get_store().backend.ticket(tid)
            self.assertEqual(inbox.ingest(t, None, "zendesk"), tid)
            got = db.get_ticket(rid, tid)["bundle"]
            self.assertEqual(got["result"], expected[tid]["result"], tid)
            self.assertEqual(got["decision"], expected[tid]["decision"], tid)
        self.assertEqual(inbox._pending_ids(rid), [])
        self.assertEqual(db.count_tickets(rid), len(file_tickets()))
        self.assertEqual(data_fingerprint(), before)  # data/ is never written

    def test_ingest_twice_reads_once(self):
        rid = inbox.inbox_run_id()
        t = inbox._get_store().backend.ticket(inbox.held_back_ids()[0])
        inbox.ingest(t, None)
        n = db.count_tickets(rid)
        inbox.ingest(t, None)
        self.assertEqual(db.count_tickets(rid), n)

    def test_ingest_of_a_new_ticket_with_an_overlay_user(self):
        rid = inbox.inbox_run_id()
        store = inbox._get_store()
        vendor = next(v for v in store.vendors if v["internalId"] == "3016")
        email = vendor["authorizedContacts"].split(";")[0]
        bill = next(b for b in store.backend.query("vendorBill", entity="3016"))
        uid, tid = inbox.new_user_id(), inbox.new_ticket_id()
        self.assertNotIn(uid, {u["id"] for u in json.loads((DATA / "tickets.json").read_text(encoding="utf-8"))["users"]})
        before = data_fingerprint()
        user = {"id": uid, "name": "Pat Newcomer", "email": email, "role": "end-user"}
        text = f"Hello, could you tell me the status of {bill['tranId']}?"
        ticket = {"id": tid, "subject": f"Where is {bill['tranId']}?", "description": text, "status": "open", "requester_id": uid,
                  "via": {"channel": "web", "source": {"from": {"address": email, "name": "Pat Newcomer"}, "to": {"address": "ap@orchestra-mock.example"}}},
                  "comments": [{"id": 1, "author_id": uid, "public": True, "body": text, "attachments": []}]}
        self.assertEqual(inbox.ingest(ticket, user, source="direct"), tid)
        rec = db.get_ticket(rid, tid)
        self.assertEqual(rec["bundle"]["result"]["output_type"], "draft_reply")
        self.assertEqual(rec["bundle"]["result"]["recipient"], email)
        self.assertEqual(data_fingerprint(), before)
        self.assertEqual(db._one("SELECT name FROM inbox_users WHERE id=?", (uid,))["name"], "Pat Newcomer")
        th = self.get(f"/api/inbox/threads/{tid}")
        self.assertEqual(th["from_name"], "Pat Newcomer")
        self.assertEqual(th["evidence"]["requester"]["email"], email)
        self.assertTrue(th["sender_verified"])
        self.assertNotIn(tid, inbox._pending_ids(rid))
        self.assertGreater(inbox.new_ticket_id(), tid)

    def test_new_ticket_id_never_collides(self):
        ids = []
        lock = threading.Lock()

        def go():
            for _ in range(50):
                i = inbox.new_ticket_id()
                with lock:
                    ids.append(i)
        threads = [threading.Thread(target=go) for _ in range(6)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(len(ids), len(set(ids)))
        known = {t["id"] for t in file_tickets()} | set(inbox._get_store().backend.tickets)
        self.assertTrue(min(ids) > max(known))

    def test_arrival_publishes_events_in_order(self):
        seen = []
        orig = inbox.live.publish
        inbox.live.publish = lambda type, payload, **kw: seen.append((type, payload))
        try:
            self.assertEqual(len(self.c.post("/api/inbox/sync", headers=self.h).json()["arrived"]), 1)
            time.sleep(inbox.READING_SECONDS + 0.5)
        finally:
            inbox.live.publish = orig
        types = [t for t, _ in seen]
        self.assertLess(types.index("ticket.arrived"), types.index("ticket.outcome"))
        self.assertIn("queue.counts", types)
        arrived = next(p for t, p in seen if t == "ticket.arrived")
        self.assertEqual({"ticket_id", "queue", "from_name", "subject"} - set(arrived), set())
        self.assertIn(next(p for t, p in seen if t == "ticket.outcome")["outcome"], ("draft_ready", "action_needed", "no_reply"))

    def test_sync_now_brings_one_in_until_none_are_left(self):
        self.assertEqual(self.get("/api/inbox/summary")["held_back"], 8)
        for n in range(8):
            self.assertEqual(len(self.c.post("/api/inbox/sync", headers=self.h).json()["arrived"]), 1)
            self.assertEqual(self.get("/api/inbox/summary")["held_back"], 7 - n)
        self.assertEqual(self.c.post("/api/inbox/sync", headers=self.h).json(), {"arrived": []})
        time.sleep(inbox.READING_SECONDS + 0.3)


class ThreadAndQueueTests(InboxCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        inbox.reset()

    def test_summary_shape_and_numbers(self):
        s = self.get("/api/inbox/summary")
        self.assertEqual(set(s), {"run_id", "read", "drafts_ready", "action_needed", "no_reply", "held_back", "prevented_this_week",
                                  "self_serve_lookups", "connected_at"})
        self.assertIsInstance(s["self_serve_lookups"], int)
        self.assertEqual(s["read"], len(file_tickets()) - 8)
        self.assertEqual(s["drafts_ready"] + s["action_needed"] + s["no_reply"], s["read"])
        self.assertEqual(s["held_back"], 8)
        self.assertEqual(s["run_id"], inbox.inbox_run_id())

    def test_queue_counts_add_up(self):
        qs = self.get("/api/inbox/queues")["queues"]
        self.assertEqual([q["id"] for q in qs], ["needs_reply", "needs_action", "escalated", "returned", "waiting_approver", "waiting_vendor",
                                                "scheduled", "sent", "closed"])
        rows = self.get("/api/inbox/threads")["rows"]
        self.assertEqual(len(rows), len(file_tickets()) - 8)
        member = {}
        for q in qs:
            listed = self.get("/api/inbox/threads", params={"queue": q["id"]})["rows"]
            self.assertEqual(q["count"], len(listed), q["id"])
            for r in listed:
                member.setdefault(r["ticket_id"], []).append(q["id"])
        self.assertEqual(set(member), {r["ticket_id"] for r in rows})  # every thread is in at least one queue
        by = {q["id"]: q["count"] for q in qs}
        # with nothing sent, scheduled or escalated, the three outcomes partition the inbox
        self.assertEqual(by["needs_reply"], sum(1 for r in rows if r["outcome"] == "draft_ready"))
        self.assertEqual(by["needs_action"], sum(1 for r in rows if r["outcome"] == "action_needed"))
        self.assertEqual(by["closed"], sum(1 for r in rows if r["outcome"] == "no_reply"))
        self.assertEqual(by["needs_reply"] + by["needs_action"] + by["closed"], len(rows))
        self.assertEqual(self.c.get("/api/inbox/threads?queue=nope", headers=self.h).status_code, 400)

    def test_thread_rows_have_the_contract_shape(self):
        rows = self.get("/api/inbox/threads")["rows"]
        keys = {"ticket_id", "from_name", "from_email", "company", "subject", "snippet", "received_at", "source", "zendesk_status", "outcome",
                "intent", "invoice_refs", "flags", "sender_verified", "assignee", "workflow_state", "review_state", "group_id", "group_size",
                "reading"}
        for r in rows:
            self.assertEqual(set(r), keys)
            self.assertEqual(r["source"], "Outlook")
            self.assertIn(r["outcome"], ("draft_ready", "action_needed", "no_reply"))
            self.assertLessEqual(set(r["flags"]), {"fraud", "legal", "exec_cc", "injection"})
        self.assertTrue(any(r["flags"] for r in rows))
        self.assertTrue(any(r["sender_verified"] for r in rows) and any(not r["sender_verified"] for r in rows))
        for r in rows:  # the practice data has no same-invoice groups, so every thread stands alone
            self.assertEqual((r["group_id"], r["group_size"]), (None, 1))

    def test_follow_up_threads_are_grouped(self):
        self.addCleanup(inbox.reset)  # this test adds a thread; the others expect the backlog only
        rid = inbox.inbox_run_id()
        base = next(r for r in self.get("/api/inbox/threads")["rows"] if r["sender_verified"] and r["outcome"] == "draft_ready")
        raw = dict(inbox._raw_ticket(base["ticket_id"]))
        tid = inbox.new_ticket_id()
        raw.update(id=tid, custom_fields=[{"id": "linked_ticket_ids", "value": [base["ticket_id"]]}], comments=[])
        inbox.ingest(raw, None, "zendesk")
        rows = {r["ticket_id"]: r for r in self.get("/api/inbox/threads")["rows"]}
        self.assertEqual(rows[tid]["group_id"], rows[base["ticket_id"]]["group_id"])
        self.assertEqual((rows[tid]["group_size"], rows[tid]["group_id"] is None), (2, False))
        self.assertEqual(db.get_run(rid)["source"], "inbox")

    def test_search_and_assignee_filters(self):
        rows = self.get("/api/inbox/threads")["rows"]
        pick = next(r for r in rows if r["invoice_refs"])
        hit = self.get("/api/inbox/threads", params={"q": pick["invoice_refs"][0].lower()})["rows"]
        self.assertIn(pick["ticket_id"], [r["ticket_id"] for r in hit])
        # Phase 3 merge: workflow routes every unassigned ticket by expertise, so each thread has an assignee and the
        # per-person filters partition the inbox ("unassigned" is what is left: nothing, once routing is live).
        unassigned = self.get("/api/inbox/threads", params={"assignee": "unassigned"})["rows"]
        self.assertEqual(len(unassigned), sum(1 for r in rows if not r["assignee"]))
        by_person = sum(len(self.get("/api/inbox/threads", params={"assignee": a})["rows"])
                        for a in {r["assignee"] for r in rows if r["assignee"]})
        self.assertEqual(by_person + len(unassigned), len(rows))
        self.assertEqual(self.get("/api/inbox/threads", params={"assignee": "nobody@orchestra-mock.example"})["rows"], [])

    def test_thread_detail_headers_evidence_and_masking(self):
        rows = self.get("/api/inbox/threads")["rows"]
        cc_row = next(r for r in rows if (inbox._raw_ticket(r["ticket_id"]) or {}).get("email_cc_ids"))
        th = self.get(f"/api/inbox/threads/{cc_row['ticket_id']}")
        self.assertTrue(th["headers"]["cc"])
        self.assertTrue(all("@" not in c for c in th["headers"]["cc"]), "cc is resolved to names")
        self.assertEqual(th["headers"]["to"], "ap@orchestra-mock.example")
        self.assertEqual(th["run_id"], inbox.inbox_run_id())
        for k in ("messages", "insight", "result", "decision", "review", "workflow", "evidence", "attachments", "schedule"):
            self.assertIn(k, th)
        self.assertEqual(set(th["insight"]), {"wants", "invoice", "status_line", "why"})
        self.assertEqual(set(th["evidence"]), {"requester", "vendor", "items", "linked", "brief", "rule_trail"})
        # a ticket with a matched, paid invoice: labelled sources, a payment, a run, and nothing unmasked
        paid = next(r for r in rows if "INV-21529" in r["invoice_refs"])
        ev = self.get(f"/api/inbox/threads/{paid['ticket_id']}")["evidence"]
        it = next(i for i in ev["items"] if i["bill"])
        labels = [s["label"] for s in it["sources"]]
        self.assertIn(f"NetSuite · bill {it['bill']['internalId']}", labels)
        self.assertTrue(it["payment"] and "account" in it["payment"])
        self.assertTrue(ev["vendor"] and ev["vendor"]["contacts"])
        self.assertTrue(any(c["is_requester"] for c in ev["vendor"]["contacts"]))
        self.assertTrue(any(s["name"] == "rules" for s in ev["rule_trail"]))
        self.assertEqual(self.c.get("/api/inbox/threads/1", headers=self.h).status_code, 404)

    def test_evidence_sources_and_returned_payment_reference(self):
        rid = inbox.inbox_run_id()
        returned = {r["referenceNumber"] for r in documents._backend().tables["vendorPayment"] if r["custbody_release_status"] == "Returned"}
        labels, seen_returned = [], 0
        for tid, m in inbox._meta(rid).items():
            ev = inbox._evidence(tid, m, rid)
            blob = json.dumps(ev)
            for ref in returned:
                self.assertNotIn(ref, blob)
            for it in ev["items"]:
                labels += [s["label"] for s in it["sources"]]
                if it["payment"] and it["payment"]["release_status"] == "Returned":
                    seen_returned += 1
                    self.assertIsNone(it["payment"]["referenceNumber"])
        self.assertTrue(any(l.startswith("Payment run RUN-") for l in labels))
        self.assertTrue(any(l.startswith("NetSuite · bill ") for l in labels))
        self.assertGreater(seen_returned, 0)

    def test_data_was_not_written(self):
        self.assertEqual(data_fingerprint(), self.fingerprint)


class AttachmentTests(InboxCase):
    def setUp(self):
        inbox.reset()
        rows = self.get("/api/inbox/threads")["rows"]
        self.row = next(r for r in rows if r["outcome"] == "draft_ready" and "INV-21529" in r["invoice_refs"])
        self.tid = self.row["ticket_id"]
        self.ev = self.get(f"/api/inbox/threads/{self.tid}")["evidence"]
        self.bill = next(i["bill"]["internalId"] for i in self.ev["items"] if i["bill"])
        self.url = f"/api/inbox/threads/{self.tid}/attachments"

    def test_attach_list_remove(self):
        r = self.c.post(self.url, json={"kind": "invoice", "bill_id": self.bill}, headers=self.h)
        self.assertEqual(r.status_code, 200, r.text)
        atts = r.json()["attachments"]
        self.assertEqual([(a["kind"], a["bill_id"]) for a in atts], [("invoice", self.bill)])
        self.assertTrue(atts[0]["filename"].endswith(".pdf"))
        again = self.c.post(self.url, json={"kind": "invoice", "bill_id": self.bill}, headers=self.h).json()["attachments"]
        self.assertEqual(len(again), 1)  # adding the same document twice is a no-op
        self.assertEqual(self.get(f"/api/inbox/threads/{self.tid}")["attachments"][0]["id"], atts[0]["id"])
        got = documents.attachments_for(inbox.inbox_run_id(), self.tid)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0][1], "application/pdf")
        self.assertTrue(got[0][2].startswith(b"%PDF"))
        r = self.c.delete(f"{self.url}/{atts[0]['id']}", headers=self.h)
        self.assertEqual(r.json(), {"attachments": []})
        self.assertEqual(self.c.delete(f"{self.url}/{atts[0]['id']}", headers=self.h).status_code, 404)

    def test_a_bill_not_on_the_ticket_is_refused(self):
        other = next(b for b in documents._backend().tables["vendorBill"] if b["internalId"] != self.bill)["internalId"]
        self.assertEqual(self.c.post(self.url, json={"kind": "invoice", "bill_id": other}, headers=self.h).status_code, 404)
        self.assertEqual(self.c.post(self.url, json={"kind": "invoice", "bill_id": "99999999"}, headers=self.h).status_code, 404)
        self.assertEqual(documents.list_attachments(inbox.inbox_run_id(), self.tid), [])
        self.assertEqual(self.c.post(self.url, json={"kind": "w9", "bill_id": self.bill}, headers=self.h).status_code, 422)

    def test_remittance_refused_when_the_matched_bill_has_no_settled_payment(self):
        rid = inbox.inbox_run_id()
        found = None
        for tid, m in inbox._meta(rid).items():
            if m["output_type"] != "draft_reply":
                continue
            for it in inbox._evidence(tid, m, rid)["items"]:
                if it["bill"] and not it["payment"]:
                    found = (tid, it["bill"]["internalId"])
        self.assertTrue(found)
        r = self.c.post(f"/api/inbox/threads/{found[0]}/attachments", json={"kind": "remittance", "bill_id": found[1]}, headers=self.h)
        self.assertEqual(r.status_code, 409)

    def test_a_note_ticket_takes_no_attachments(self):
        note = next(r for r in self.get("/api/inbox/threads")["rows"] if r["outcome"] == "action_needed")
        self.assertEqual(self.c.post(f"/api/inbox/threads/{note['ticket_id']}/attachments", json={"kind": "invoice", "bill_id": "50000"},
                                     headers=self.h).status_code, 409)

    def test_attachment_goes_out_in_the_eml_and_write_back_runs(self):
        rid = inbox.inbox_run_id()
        self.c.post(self.url, json={"kind": "invoice", "bill_id": self.bill}, headers=self.h)
        self.assertEqual(self.c.put(f"/api/runs/{rid}/review/{self.tid}", json={"state": "approved"}, headers=self.h).status_code, 200)
        r = self.c.post(f"/api/runs/{rid}/tickets/{self.tid}/send", headers=self.h)
        self.assertEqual(r.status_code, 200, r.text)
        emls = list(Path(self._outbox.name).glob(f"ticket-{self.tid}-*.eml"))
        self.assertEqual(len(emls), 1)
        raw = emls[0].read_bytes()
        self.assertIn(b"application/pdf", raw)
        self.assertIn(b"Invoice-", raw)
        # write-back: Zendesk solved, an internal note, Sent items, a sync-log line
        th = self.get(f"/api/inbox/threads/{self.tid}")
        self.assertEqual(th["zendesk_status"], "solved")
        self.assertTrue(th["write_back"]["sent_folder"])
        self.assertIn("internal note", th["write_back"]["internal_note"].lower())
        self.assertEqual(th["messages"][-1]["attachments"], [th["attachments"][0]["filename"]])
        self.assertIn(self.tid, [x["ticket_id"] for x in self.get("/api/inbox/threads", params={"queue": "sent"})["rows"]])
        self.assertNotIn(self.tid, [x["ticket_id"] for x in self.get("/api/inbox/threads", params={"queue": "needs_reply"})["rows"]])
        log = self.get("/api/connections")["log"]
        self.assertTrue(any(f"#{self.tid}" in x["text"] and "Solved" in x["text"] for x in log))
        self.assertTrue(any("Sent items" in x["text"] for x in log))
        # a sent reply can no longer take attachments
        self.assertEqual(self.c.post(self.url, json={"kind": "invoice", "bill_id": self.bill}, headers=self.h).status_code, 409)

    def test_notice_hook_publishes_ahead_sent_and_hooks_are_registered_once(self):
        seen = []
        orig = inbox.live.publish
        inbox.live.publish = lambda type, payload, **kw: seen.append((type, payload))
        try:
            delivery.notice_sent(inbox.inbox_run_id(), "notice", "3016", {"to": "x@y.example"}, {})
        finally:
            inbox.live.publish = orig
        self.assertEqual([p for t, p in seen if t == "ahead.sent"][0]["kind"], "notice")
        db.init()  # a second init must not double the hooks
        self.assertEqual(sum(1 for h in delivery.ON_SENT if h.__name__ == "inbox_write_back"), 1)
        self.assertEqual(sum(1 for h in delivery.ON_NOTICE_SENT if h.__name__ == "inbox_ahead_sent"), 1)


class ConnectionsAndAdvancedTests(InboxCase):
    def test_connections(self):
        d = self.get("/api/connections")
        self.assertEqual([c["id"] for c in d["connections"]], ["zendesk", "outlook", "netsuite", "model"])
        z, o, n, m = d["connections"]
        self.assertEqual(z["detail"], "orchestra-mock.zendesk.com")
        self.assertIn("ap@orchestra-mock.example", o["detail"])
        self.assertIn("No write access", " ".join(n["scopes"]))
        for c in d["connections"]:
            self.assertTrue(c["status"] and c["scopes"])
        self.assertIn(m["status"], ("connected", "unavailable"))
        self.assertTrue(d["log"] and set(d["log"][0]) == {"at", "text"})

    def test_reset_rebuilds_the_inbox_run(self):
        old = inbox.inbox_run_id()
        r = self.c.post("/api/admin/reset", headers=self.cfo)
        self.assertEqual(r.status_code, 200, r.text)
        new = r.json()["run_id"]
        self.assertNotEqual(old, new)
        self.assertIsNone(db.get_run(old))
        self.assertEqual(db.get_setting("inbox.run_id"), new)
        self.assertEqual(db.count_tickets(new), len(file_tickets()) - 8)
        self.assertEqual(r.json()["held_back"], 8)

    def test_export_matches_the_results_template_and_scores(self):
        inbox.reset()
        rid = inbox.inbox_run_id()
        while inbox.arrive_next(reading_seconds=0):
            pass
        r = self.c.get(f"/api/admin/export?run_id={rid}&scope=all", headers=self.cfo)
        self.assertEqual(r.status_code, 200)
        self.assertIn("attachment", r.headers["content-disposition"])
        out = r.json()
        tpl = json.loads((ROOT / "results_template.json").read_text(encoding="utf-8"))
        self.assertEqual(set(out), set(tpl))
        self.assertEqual(len(out["results"]), len(file_tickets()))
        for res in out["results"]:
            self.assertEqual(set(res), set(tpl["results"][0]))
        path = Path(_TMP.name) / "export.json"
        path.write_text(json.dumps(out), encoding="utf-8")
        key = json.loads((DATA / "answer_key.json").read_text(encoding="utf-8"))
        s = scorer.score(scorer.load_results(path), key)
        self.assertEqual((s["correct_decisions_pct"], s["safe_behavior_pct"]), (100.0, 100.0))
        # signed-off scope exports only what a person approved
        self.assertEqual(self.c.get(f"/api/admin/export?run_id={rid}", headers=self.cfo).json()["results"], [])
        self.assertEqual(self.c.get("/api/admin/export?run_id=nope", headers=self.cfo).status_code, 404)

    def test_import_a_tickets_file_runs_as_a_normal_batch(self):
        ts = json.loads((DATA / "tickets.json").read_text(encoding="utf-8"))
        small = {"tickets": ts["tickets"][:6], "users": ts["users"], "count": 6}
        f = Path(_TMP.name) / "stretch-tickets.json"
        f.write_text(json.dumps(small), encoding="utf-8")
        before = data_fingerprint()
        r = self.c.post("/api/admin/import", json={"path": str(f)}, headers=self.cfo)
        self.assertEqual(r.status_code, 200, r.text)
        rid = r.json()["run_id"]
        for _ in range(100):
            run = self.get(f"/api/runs/{rid}")
            if run["status"] not in ("starting", "running"):
                break
            time.sleep(0.2)
        self.assertEqual(run["status"], "done")
        self.assertEqual(run["total"], 6)
        self.assertEqual(run["label"], "stretch-tickets.json")
        self.assertEqual(len(self.get(f"/api/runs/{rid}/tickets")["rows"]), 6)
        self.assertEqual(data_fingerprint(), before)
        self.assertEqual(self.c.post("/api/admin/import", json={"path": str(Path(_TMP.name) / "nope.json")}, headers=self.cfo).status_code, 400)


if __name__ == "__main__":
    unittest.main()
