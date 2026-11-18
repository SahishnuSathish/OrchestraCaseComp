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


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(server.app, base_url="http://localhost")
        cls.rid = finished_run(cls.c)

    def setUp(self):
        self._outbox = tempfile.TemporaryDirectory()
        self._get = server.mailer.get_mailer
        server.mailer.get_mailer = lambda env=None: server.mailer.OutboxMailer(self._outbox.name)  # never the real outbox

    def tearDown(self):
        server.mailer.get_mailer = self._get
        self._outbox.cleanup()

    def url(self, tail="", rid=None):
        return f"/api/runs/{rid or self.rid}/prevention{tail}"

    def build(self):
        r = self.c.post(self.url("/build"), headers=H)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_not_built_then_built(self):
        rid = finished_run(self.c)
        self.assertEqual(self.c.get(self.url(rid=rid), headers=H).json(), {"built": False})
        r = self.c.post(self.url("/build", rid=rid), headers=H)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["built"])
        self.assertEqual(r.json()["report"]["tickets"], 100)
        self.assertEqual(r.json()["states"], {})

    def test_send_needs_approval_and_uses_the_servers_own_text(self):
        n = self.build()["notices"][0]
        k = f"/notice/{n['key']}"
        self.assertEqual(self.c.post(self.url(k + "/send"), headers=H).status_code, 409)  # not approved yet
        self.assertEqual(self.c.put(self.url(k), json={"state": "approved"}, headers=H).status_code, 200)
        r = self.c.post(self.url(k + "/send"), json={"to": "attacker@evil.example", "body": "x"}, headers=H)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["states"][f"notice:{n['key']}"]["state"], "sent")
        self.assertEqual(self.c.post(self.url(k + "/send"), headers=H).status_code, 409)  # already sent
        self.assertEqual(self.c.put(self.url(k), json={"state": "pending"}, headers=H).status_code, 409)
        emls = list(Path(self._outbox.name).glob("*.eml"))
        self.assertEqual(len(emls), 1)
        eml = emls[0].read_text(encoding="utf-8")
        self.assertIn(f"To: {n['to']}", eml)
        self.assertNotIn("attacker@evil.example", eml)

    def test_a_digest_goes_to_the_approver_on_record(self):
        d = next(x for x in self.build()["digests"] if x["sendable"])
        k = f"/digest/{d['key']}"
        self.c.put(self.url(k), json={"state": "approved"}, headers=H)
        r = self.c.post(self.url(k + "/send"), headers=H)
        self.assertEqual(r.status_code, 200, r.text)
        eml = next(Path(self._outbox.name).glob("*.eml")).read_text(encoding="utf-8")
        self.assertIn(f"To: {d['act_by']}", eml)

    def test_unsendable_digest_is_refused(self):
        bad = next((x for x in self.build()["digests"] if not x["sendable"]), None)
        if bad is None:
            self.skipTest("every digest in the pack has an approver")
        k = f"/digest/{bad['key']}"
        self.c.put(self.url(k), json={"state": "approved"}, headers=H)
        self.assertEqual(self.c.post(self.url(k + "/send"), headers=H).status_code, 409)
        self.assertEqual(list(Path(self._outbox.name).glob("*.eml")), [])

    def test_a_notice_whose_records_changed_is_refused(self):
        p = self.build()
        n = p["notices"][1]
        stale = dict(p)
        stale["notices"] = [dict(x, text=x["text"] + "\nOld line.") if x["key"] == n["key"] else x for x in p["notices"]]
        db.save_prevention(self.rid, stale)
        k = f"/notice/{n['key']}"
        self.c.put(self.url(k), json={"state": "approved"}, headers=H)
        r = self.c.post(self.url(k + "/send"), headers=H)
        self.assertEqual(r.status_code, 409)
        self.assertIn("records changed", r.json()["detail"])

    def test_bad_kind_state_and_key(self):
        p = self.build()
        self.assertEqual(self.c.put(self.url("/other/x"), json={"state": "approved"}, headers=H).status_code, 404)
        self.assertEqual(self.c.put(self.url("/notice/nope"), json={"state": "approved"}, headers=H).status_code, 404)
        k = f"/notice/{p['notices'][0]['key']}"
        self.assertEqual(self.c.put(self.url(k), json={"state": "sent"}, headers=H).status_code, 422)

    def test_unfinished_or_unknown_run(self):
        db.create_run("busy0001", str(DATA), "run", False, None, 100, status="running")
        self.assertEqual(self.c.post(self.url("/build", rid="busy0001"), headers=H).status_code, 409)
        self.assertEqual(self.c.get(self.url(rid="nosuch01"), headers=H).status_code, 404)

    def test_token_required(self):
        self.assertEqual(self.c.get(self.url()).status_code, 401)


if __name__ == "__main__":
    unittest.main()
