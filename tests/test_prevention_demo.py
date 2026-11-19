"""Prevention demo on one real invoice. No Ollama."""
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "dashboards" / "conductor"), str(ROOT / "src"), str(ROOT)]

import db  # noqa: E402

_TMP = tempfile.TemporaryDirectory()
db.STATE_DIR = Path(_TMP.name)
db.DB_PATH = db.STATE_DIR / "app.db"
db.init()

import egress_guard  # noqa: E402
import notices  # noqa: E402
import rules  # noqa: E402
import server  # noqa: E402
import signin  # noqa: E402  (Phase 3: token + a signed-in session)
from data_layer import FileBackend, Store  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from trace import NullTrace  # noqa: E402

DATA = ROOT / "data"
H = signin.headers("cfo")
STORE = Store(FileBackend(DATA))
DEMO = notices.build_demo(STORE)


class Chain(unittest.TestCase):
    def test_the_rule_picks_a_pending_bill_with_a_ticket(self):
        inv = DEMO["invoice"]
        self.assertEqual(inv["status"], "pending")
        self.assertTrue(DEMO["covered_tickets"])
        bill = next(b for b in STORE.backend.all("vendorBill") if b["internalId"] == inv["internal_id"])
        self.assertEqual(bill["approvalStatus"], "Pending Approval")
        vendor = next(v for v in STORE.vendors if v["internalId"] == bill["entity"])
        self.assertEqual(inv["vendor_email"], vendor["email"])

    def test_notice_has_the_exact_amount_and_status(self):
        inv, text = DEMO["invoice"], DEMO["notice"]["text"]
        self.assertIn(f"Invoice amount: USD {inv['amount']:,.2f}.", text)
        self.assertIn("pending internal approval", text)
        self.assertIn(inv["ref"], text)

    def test_egress_check_passes(self):
        bill = next(b for b in STORE.backend.all("vendorBill") if b["internalId"] == DEMO["invoice"]["internal_id"])
        o = rules.classify_bill(bill, STORE.session(NullTrace()))
        n = DEMO["notice"]
        self.assertEqual(egress_guard.check_outbound(n["text"], [o], n["bills"], recipient=n["to"]), [])
        self.assertEqual(n["egress_problems"], [])

    def test_vendor_lookup_gives_the_same_answer(self):
        lk = notices.demo_lookup(DEMO, STORE)
        self.assertTrue(lk["same_answer"], lk)


class Api(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(server.app, base_url="http://localhost")
        rid = cls.c.post("/api/runs", json={"path": str(DATA), "model_free": True}, headers=H).json()["run_id"]
        for _ in range(240):
            if cls.c.get(f"/api/runs/{rid}", headers=H).json()["status"] in ("done", "failed", "cancelled"):
                break
            time.sleep(0.5)
        cls.rid = rid

    def setUp(self):
        self._outbox = tempfile.TemporaryDirectory()
        self._get = server.mailer.get_mailer
        server.mailer.get_mailer = lambda env=None: server.mailer.OutboxMailer(self._outbox.name)

    def tearDown(self):
        server.mailer.get_mailer = self._get
        self._outbox.cleanup()

    def url(self, tail=""):
        return f"/api/runs/{self.rid}/prevention/demo{tail}"

    def test_chain_and_stale_check(self):
        self.assertTrue(self.c.get(self.url(), headers=H).json()["available"])
        d = self.c.post(self.url("/draft"), headers=H).json()
        self.assertEqual(d["state"], "pending")
        self.assertEqual(self.c.post(self.url("/send"), headers=H).status_code, 409)  # not approved
        self.assertEqual(self.c.post(self.url("/approve"), headers=H).json()["state"], "approved")
        real = notices.build_demo

        def changed(store, index=None):
            x = real(store, index)
            return {**x, "notice": {**x["notice"], "text": "changed"}}

        notices.build_demo = changed
        try:
            r = self.c.post(self.url("/send"), headers=H)
        finally:
            notices.build_demo = real
        self.assertEqual(r.status_code, 409)
        self.assertIn("records changed", r.json()["detail"])
        self.assertEqual(list(Path(self._outbox.name).glob("*.eml")), [])
        r = self.c.post(self.url("/send"), json={"to": "evil@evil.example"}, headers=H)
        self.assertEqual(r.status_code, 200, r.text)
        v = r.json()
        self.assertEqual(v["state"], "sent")
        self.assertTrue(v["lookup"]["same_answer"])
        self.assertEqual(v["covered_tickets"], DEMO["covered_tickets"])
        emls = list(Path(self._outbox.name).glob("*.eml"))
        self.assertEqual(len(emls), 1)
        eml = emls[0].read_text(encoding="utf-8")
        self.assertIn(f"To: {DEMO['notice']['to']}", eml)
        self.assertNotIn("evil", eml)
        self.assertEqual(self.c.post(self.url("/send"), headers=H).status_code, 409)  # already sent

    def test_token_required(self):
        self.assertIn(self.c.get(self.url()).status_code, (401, 403))


class Headless(unittest.TestCase):
    def test_exits_zero_and_prints_four_steps(self):
        with tempfile.TemporaryDirectory() as out:
            r = subprocess.run([sys.executable, str(ROOT / "src" / "demo_prevention.py"), "--out", out],
                               capture_output=True, text=True, timeout=120)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            for n in ("1. Draft", "2. Approve", "3. Send", "4. Vendor lookup"):
                self.assertIn(n, r.stdout)
            self.assertEqual(len(list(Path(out, "outbox").glob("*.eml"))), 1)


if __name__ == "__main__":
    unittest.main()
