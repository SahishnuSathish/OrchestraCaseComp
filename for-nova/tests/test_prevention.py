"""Prevent page backend: notices, digests and deflection numbers for one run. No Ollama (runs are model_free)."""
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "webapp"), str(ROOT / "prototype"), str(ROOT)]

import db  # noqa: E402

_TMP = tempfile.TemporaryDirectory()
db.STATE_DIR = Path(_TMP.name)          # never touch the real webapp/state/app.db
db.DB_PATH = db.STATE_DIR / "app.db"
db.init()

import prevention  # noqa: E402
import server  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

DATA = ROOT / "data"
H = {"x-ap-token": server.TOKEN}


def finished_run(c):
    r = c.post("/api/runs", json={"path": str(DATA), "model_free": True}, headers=H)
    assert r.status_code == 200, r.text
    rid = r.json()["run_id"]
    for _ in range(240):
        if c.get(f"/api/runs/{rid}", headers=H).json()["status"] in ("done", "failed", "cancelled"):
            break
        time.sleep(0.5)
    return rid


class BuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(server.app, base_url="http://localhost")
        cls.rid = finished_run(cls.c)
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
        self.assertTrue(self.p["digests"])
        for d in self.p["digests"]:
            self.assertEqual(d["sendable"], bool(d["act_by"]) and not d["egress_problems"])
            self.assertEqual(d["key"], d["act_by"] or "unassigned")

    def test_payload_is_stored_and_deleted_with_the_run(self):
        self.assertEqual(db.get_prevention(self.rid)["report"]["tickets"], 100)
        key = self.p["notices"][0]["key"]
        db.set_prevention_state(self.rid, "notice", key, "approved")
        rid2 = finished_run(self.c)
        prevention.build(rid2, server.get_manager())
        db.set_prevention_state(rid2, "notice", key, "approved")
        server.get_manager().delete_run(rid2)
        self.assertIsNone(db.get_prevention(rid2))
        self.assertEqual(db.prevention_states(rid2), {})
        self.assertEqual(db.prevention_states(self.rid)[("notice", key)]["state"], "approved")

    def test_find(self):
        n = self.p["notices"][0]
        self.assertEqual(prevention.find(self.p, "notice", n["key"]), n)
        self.assertIsNone(prevention.find(self.p, "notice", "no-such-vendor"))
        self.assertIsNone(prevention.find(self.p, "other", n["key"]))

    def test_imported_run_without_dataset_is_unavailable(self):
        db.create_run("nodata01", None, "import", False, None, 0, status="done")
        with self.assertRaises(prevention.Unavailable):
            prevention.build("nodata01", server.get_manager())


if __name__ == "__main__":
    unittest.main()
