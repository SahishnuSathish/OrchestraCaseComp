"""The live event bus: stream tickets, audience filtering, and the SSE endpoints over a real socket."""
import json
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "dashboards" / "conductor"), str(ROOT / "src"), str(ROOT)]

import db  # noqa: E402

_TMP = tempfile.TemporaryDirectory()
db.STATE_DIR = Path(_TMP.name)
db.DB_PATH = db.STATE_DIR / "app.db"
db.init()

import identity  # noqa: E402
import live  # noqa: E402
import server  # noqa: E402
import signin  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

VENDOR_A = "billing@quillfernstudio.example"       # vendor 3000
VENDOR_B = "accounts@bramblewickprintco.example"   # vendor 3001


def drain(stream):
    out = []
    while True:
        ev = stream.get()
        if ev is None:
            return out
        out.append(ev)


class Tickets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(server.app, base_url="http://localhost")

    def tearDown(self):
        live._mono = __import__("time").monotonic

    def test_a_ticket_is_single_use(self):
        h = signin.headers("ap_specialist")
        r = self.c.post("/api/live/ticket", headers=h)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["expires_in"], 60)
        t = r.json()["ticket"]
        first = live.consume_ticket(t)
        self.assertEqual(first.subject, h.session.subject)    # bound to the session that asked
        self.assertIsNone(live.consume_ticket(t))             # spent
        self.assertIsNone(live.consume_ticket("made-up"))

    def test_a_ticket_expires(self):
        s = signin.session_for("cfo")
        t = live.issue_ticket(s)
        now = live._mono()
        live._mono = lambda: now + 61
        self.assertIsNone(live.consume_ticket(t))
        live._mono = lambda: now
        t = live.issue_ticket(s)
        live._mono = lambda: now + 59
        self.assertEqual(live.consume_ticket(t).id, s.id)

    def test_a_ticket_dies_with_its_session(self):
        s = signin.session_for("cfo")
        t = live.issue_ticket(s)
        identity.end_session(s.id)
        self.assertIsNone(live.consume_ticket(t))

    def test_the_stream_needs_a_valid_ticket_and_the_ticket_endpoint_a_session(self):
        self.assertEqual(self.c.get("/api/live?ticket=nope").status_code, 401)
        self.assertEqual(self.c.get("/api/live").status_code, 401)
        self.assertEqual(self.c.post("/api/live/ticket", headers={"x-ap-token": server.TOKEN}).status_code, 401)
        self.assertEqual(self.c.post("/api/live/ticket").status_code, 401)
        # a vendor may ask for a ticket (own events only)
        self.assertEqual(self.c.post("/api/live/ticket", headers=signin.headers("vendor", VENDOR_A)).status_code, 200)

    def test_the_run_progress_stream_takes_a_ticket_for_staff_only(self):
        vendor = live.issue_ticket(signin.session_for("vendor", VENDOR_A))
        approver = live.issue_ticket(signin.session_for("approver"))
        self.assertEqual(self.c.get(f"/api/runs/abc/events?ticket={vendor}").status_code, 403)
        self.assertEqual(self.c.get(f"/api/runs/abc/events?ticket={approver}").status_code, 403)
        self.assertEqual(self.c.get("/api/runs/abc/events?ticket=made-up").status_code, 401)
        # the old ?token= alone no longer opens it
        self.assertEqual(self.c.get(f"/api/runs/abc/events?token={server.TOKEN}").status_code, 401)
        self.assertEqual(self.c.get("/api/runs/abc/events", headers=signin.headers("vendor", VENDOR_A)).status_code, 403)
        staff = live.issue_ticket(signin.session_for("ap_specialist"))
        self.assertEqual(self.c.get(f"/api/runs/nosuchrun/events?ticket={staff}").status_code, 404)  # past the guard


class Audience(unittest.TestCase):
    def setUp(self):
        self.sessions = {
            "ulla": signin.session_for("ap_specialist"),
            "omar": signin.session_for("ap_specialist", "omar.calloway@orchestra-mock.example"),
            "cfo": signin.session_for("cfo"),
            "ben": signin.session_for("approver"),
            "vendor_a": signin.session_for("vendor", VENDOR_A),
            "vendor_b": signin.session_for("vendor", VENDOR_B),
        }
        self.s = {k: live.open_stream(v) for k, v in self.sessions.items()}

    def tearDown(self):
        for s in self.s.values():
            live.close_stream(s)

    def test_default_audience_is_staff(self):
        live.publish("ticket.arrived", {"ticket_id": 1, "queue": "needs_reply", "from_name": "Pat", "subject": "Hi"})
        got = {k: [e["type"] for e in drain(s)] for k, s in self.s.items()}
        self.assertEqual(got["ulla"], ["ticket.arrived"])
        self.assertEqual(got["omar"], ["ticket.arrived"])
        self.assertEqual(got["cfo"], ["ticket.arrived"])
        self.assertEqual(got["ben"], [])
        self.assertEqual(got["vendor_a"], [])
        self.assertEqual(got["vendor_b"], [])

    def test_a_vendor_stream_never_receives_a_staff_event(self):
        for t in ("ticket.arrived", "ticket.escalated", "signoff.requested", "ticket.returned", "ticket.signed_off",
                  "ticket.sent", "approver.committed", "outbound.created", "w9.received", "queue.counts"):
            live.publish(t, {"ticket_id": 9, "summary": "staff only"})
            live.publish(t, {"ticket_id": 9}, roles={"cfo"}, subjects={"ulla.abernathy@orchestra-mock.example"})
        self.assertEqual(drain(self.s["vendor_a"]), [])
        self.assertEqual(drain(self.s["vendor_b"]), [])
        self.assertEqual(drain(self.s["ben"]), [])

    def test_a_vendor_event_reaches_only_that_vendor_and_hides_who_did_it(self):
        live.publish("direct.message", {"vendor_id": "3000", "actor": {"name": "Ulla", "email": "u@x"}, "to": ["a@b"]}, vendor_id="3000")
        a, b = drain(self.s["vendor_a"]), drain(self.s["vendor_b"])
        self.assertEqual([e["type"] for e in a], ["direct.message"])
        self.assertNotIn("actor", a[0])
        self.assertNotIn("to", a[0])
        self.assertEqual(b, [])
        self.assertEqual([e["type"] for e in drain(self.s["ulla"])], ["direct.message"])   # staff see it too (default audience)

    def test_vendor_only_when_roles_are_empty(self):
        live.publish("direct.update", {"vendor_id": "3001"}, roles=set(), vendor_id="3001")
        self.assertEqual([e["type"] for e in drain(self.s["vendor_b"])], ["direct.update"])
        for k in ("ulla", "omar", "cfo", "ben", "vendor_a"):
            self.assertEqual(drain(self.s[k]), [], k)

    def test_subjects_address_people(self):
        live.publish("ticket.assigned", {"ticket_id": 5, "assignee": "omar"}, roles=set(), subjects={"omar.calloway@orchestra-mock.example"})
        self.assertEqual([e["type"] for e in drain(self.s["omar"])], ["ticket.assigned"])
        for k in ("ulla", "cfo", "ben", "vendor_a"):
            self.assertEqual(drain(self.s[k]), [], k)
        live.publish("approver.committed", {"bill_id": "1"}, roles=set(), subjects={"BEN.merriweather@orchestra-mock.example"})
        self.assertEqual([e["type"] for e in drain(self.s["ben"])], ["approver.committed"])  # addresses are case-insensitive

    def test_event_shape(self):
        live.publish("ticket.sent", {"ticket_id": 7, "by": "x@y"}, roles={"cfo"})
        ev = drain(self.s["cfo"])[0]
        for k in ("id", "at", "type", "summary", "ticket_id", "by"):
            self.assertIn(k, ev)
        self.assertRegex(ev["at"], r"^2026-11-13T\d\d:\d\d:\d\d[+-]\d\d:\d\d$")      # the app clock
        self.assertTrue(ev["summary"])
        ids = [live.publish("queue.counts", {"counts": {}}) or None for _ in range(2)]
        a, b = drain(self.s["cfo"])
        self.assertLess(a["id"], b["id"])
        self.assertEqual(ids, [None, None])

    def test_a_stuck_stream_does_not_block_a_publisher(self):
        s = self.s["cfo"]
        for _ in range(1100):
            live.publish("queue.counts", {"counts": {}})
        self.assertLessEqual(s.q.qsize(), 1000)

    def test_publish_from_other_threads(self):
        def work():
            for _ in range(50):
                live.publish("queue.counts", {"counts": {}})
        ts = [threading.Thread(target=work) for _ in range(4)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(len(drain(self.s["ulla"])), 200)


class OverHttp(unittest.TestCase):
    """The real SSE endpoint on a real socket (the test client cannot stream an endless response)."""

    @classmethod
    def setUpClass(cls):
        import uvicorn
        with socket.socket() as sk:
            sk.bind(("127.0.0.1", 0))
            cls.port = sk.getsockname()[1]
        cls.srv = uvicorn.Server(uvicorn.Config(server.app, host="127.0.0.1", port=cls.port, log_level="error"))
        cls.thread = threading.Thread(target=cls.srv.run, daemon=True)
        cls.thread.start()
        for _ in range(100):
            if cls.srv.started:
                break
            time.sleep(0.1)
        assert cls.srv.started

    @classmethod
    def tearDownClass(cls):
        cls.srv.should_exit = True
        cls.thread.join(10)

    def open_stream(self, headers):
        base = f"http://127.0.0.1:{self.port}"
        req = urllib.request.Request(base + "/api/live/ticket", data=b"{}", method="POST",
                                     headers={**headers, "Content-Type": "application/json"})
        ticket = json.load(urllib.request.urlopen(req, timeout=10))["ticket"]
        return urllib.request.urlopen(f"{base}/api/live?ticket={ticket}", timeout=10), base, ticket

    def read_event(self, resp):
        event = data = None
        for raw in resp:
            line = raw.decode().rstrip("\n")
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
            elif line == "" and event:
                return event, data
        return None, None

    def test_a_staff_stream_gets_staff_events_and_the_ticket_is_spent(self):
        resp, base, ticket = self.open_stream(signin.headers("cfo"))
        self.assertTrue(resp.headers["Content-Type"].startswith("text/event-stream"))
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(f"{base}/api/live?ticket={ticket}", timeout=5)
        self.assertEqual(cm.exception.code, 401)
        time.sleep(0.5)
        live.publish("ticket.escalated", {"ticket_id": 77, "reason": "legal", "note": "n"}, roles={"cfo"})
        event, data = self.read_event(resp)
        self.assertEqual(event, "ticket.escalated")
        self.assertEqual(data["ticket_id"], 77)
        resp.close()

    def test_a_vendor_stream_over_the_wire_gets_nothing_from_staff(self):
        resp, base, _ = self.open_stream(signin.headers("vendor", VENDOR_A))
        time.sleep(0.5)
        live.publish("ticket.escalated", {"ticket_id": 78}, roles={"cfo", "ap_specialist"})
        live.publish("direct.message", {"vendor_id": "3000"}, vendor_id="3000")
        event, data = self.read_event(resp)
        self.assertEqual(event, "direct.message")   # the staff event before it was never sent
        resp.close()

    def test_the_run_stream_opens_with_a_staff_ticket(self):
        rid = "streamrun1"
        db.create_run(rid, str(ROOT / "data"), "test", False, None, 0, status="done")
        base = f"http://127.0.0.1:{self.port}"
        req = urllib.request.Request(base + "/api/live/ticket", data=b"{}", method="POST",
                                     headers={**signin.headers("ap_specialist"), "Content-Type": "application/json"})
        ticket = json.load(urllib.request.urlopen(req, timeout=10))["ticket"]
        resp = urllib.request.urlopen(f"{base}/api/runs/{rid}/events?ticket={ticket}", timeout=10)
        self.assertTrue(resp.headers["Content-Type"].startswith("text/event-stream"))
        self.assertEqual(resp.readline().decode().strip(), "retry: 3000")
        resp.close()


if __name__ == "__main__":
    unittest.main()
