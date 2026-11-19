"""Sessions, the sign-in directory, vendor SSO, the email-code flow and the role guards on every route."""
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "dashboards" / "conductor"), str(ROOT / "src"), str(ROOT)]

import db  # noqa: E402

_TMP = tempfile.TemporaryDirectory()
db.STATE_DIR = Path(_TMP.name)
db.DB_PATH = db.STATE_DIR / "app.db"
db.init()

import identity  # noqa: E402
import server  # noqa: E402
import signin  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

TOKEN = {"x-ap-token": server.TOKEN}
NEUTRAL = {"detail": "We couldn't sign you in with that account."}
VENDOR_A = "billing@quillfernstudio.example"
ULLA = "ulla.abernathy@orchestra-mock.example"


def vendor_sso(c, email, provider="microsoft"):
    return c.post("/api/session/sso", json={"kind": "vendor", "provider": provider, "email": email}, headers=TOKEN)


class Directory(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(server.app, base_url="http://localhost")

    def test_the_directory_is_exactly_the_people_the_spec_names(self):
        r = self.c.get("/api/session/directory", headers=TOKEN)   # public: no session yet
        self.assertEqual(r.status_code, 200)
        accts = {a["email"]: a for a in r.json()["accounts"]}
        self.assertEqual(accts[ULLA]["role"], "ap_specialist")
        self.assertEqual(accts["omar.calloway@orchestra-mock.example"]["role"], "ap_specialist")
        self.assertEqual(accts["elena.lockhart@orchestra-mock.example"]["role"], "cfo")
        self.assertEqual(accts[ULLA]["title"], "Accounts Payable Specialist")
        self.assertEqual({a["role"] for a in accts.values()}, {"ap_specialist", "cfo", "approver"})
        approvers = {e for e, a in accts.items() if a["role"] == "approver"}
        for who in ("ben.merriweather", "rosa.dunmore", "quinn.winslow", "ana.underhill", "ana.jessup"):
            self.assertIn(f"{who}@orchestra-mock.example", approvers)
        # Liam is the delegate for the inactive Tessa, who has pending bills. Wendy and Nadia have none.
        self.assertIn("liam.pemberton@orchestra-mock.example", approvers)
        for gone in ("tessa.holloway", "wendy.quimby", "nadia.winslow", "farid.abernathy", "quinn.ellsworth"):
            self.assertNotIn(f"{gone}@orchestra-mock.example", accts)
        self.assertEqual(set(accts[ULLA]), {"email", "name", "title", "department", "role"})

    def test_there_is_no_vendor_directory(self):
        body = self.c.get("/api/session/directory", headers=TOKEN).text
        self.assertNotIn("quillfern", body)
        self.assertEqual(identity.staff_directory(), self.c.get("/api/session/directory", headers=TOKEN).json()["accounts"])


class StaffSignIn(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(server.app, base_url="http://localhost")

    def test_staff_sso_gives_a_session_and_a_home(self):
        homes = {ULLA: ("ap_specialist", "/app#/inbox"), "elena.lockhart@orchestra-mock.example": ("cfo", "/app#/escalations"),
                 "liam.pemberton@orchestra-mock.example": ("approver", "/app#/approver")}
        for email, (role, home) in homes.items():
            r = self.c.post("/api/session/sso", json={"kind": "staff", "email": email.upper()}, headers=TOKEN)
            self.assertEqual(r.status_code, 200, email)
            a = r.json()
            self.assertEqual((a["role"], a["home"], a["email"]), (role, home, email))
            self.assertTrue(a["session"])
            who = self.c.get("/api/session", headers={**TOKEN, "x-conductor-session": a["session"]})
            self.assertEqual(who.json()["email"], email)

    def test_only_the_directory_can_sign_in(self):
        for email in ("farid.abernathy@orchestra-mock.example", "quinn.ellsworth@orchestra-mock.example",
                      "tessa.holloway@orchestra-mock.example", "nobody@example.com", ""):
            r = self.c.post("/api/session/sso", json={"kind": "staff", "email": email}, headers=TOKEN)
            self.assertEqual((r.status_code, r.json()), (401, NEUTRAL), email)
        self.assertEqual(self.c.post("/api/session/sso", json={"kind": "other", "email": ULLA}, headers=TOKEN).status_code, 401)

    def test_sign_out_ends_the_session(self):
        a = self.c.post("/api/session/sso", json={"kind": "staff", "email": ULLA}, headers=TOKEN).json()
        h = {**TOKEN, "x-conductor-session": a["session"]}
        self.assertEqual(self.c.delete("/api/session", headers=h).json(), {"ok": True})
        self.assertEqual(self.c.get("/api/session", headers=h).status_code, 401)
        self.assertEqual(self.c.get("/api/runs/x/tickets", headers=h).status_code, 401)

    def test_an_idle_session_ends(self):
        s = signin.session_for("ap_specialist")
        old = identity._now
        try:
            identity._now = lambda: old() + identity.SESSION_IDLE + 5
            self.assertIsNone(identity.get_session(s.id))
        finally:
            identity._now = old

    def test_the_token_is_still_needed(self):
        a = signin.headers("cfo")
        no_token = {k: v for k, v in a.items() if k != "x-ap-token"}
        self.assertEqual(self.c.get("/api/session", headers=no_token).status_code, 401)
        self.assertEqual(self.c.post("/api/session/sso", json={"kind": "staff", "email": ULLA}).status_code, 401)


class VendorSso(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(server.app, base_url="http://localhost")

    def test_an_authorized_contact_signs_in_to_their_vendor(self):
        for provider in ("microsoft", "google"):
            r = vendor_sso(self.c, VENDOR_A.upper(), provider)
            self.assertEqual(r.status_code, 200, r.text)
            a = r.json()
            self.assertEqual((a["role"], a["home"], a["email"]), ("vendor", "/direct", VENDOR_A))
            self.assertEqual(a["vendor"], {"id": "3000", "name": "Quillfern Studio"})
        # a second contact of the same vendor
        self.assertEqual(vendor_sso(self.c, "finance@quillfernstudio.example").json()["vendor"]["id"], "3000")

    def test_unknown_inactive_ambiguous_and_staff_addresses_get_the_same_answer(self):
        real = identity.vendor_rows
        rows = [dict(r) for r in real()]
        inactive = next(r for r in rows if r["entityId"] == "V3001")
        inactive["isInactive"] = "T"
        twin = next(r for r in rows if r["entityId"] == "V3002")
        twin["authorizedContacts"] += ";billing@quillfernstudio.example"   # now two vendors list Quillfern's address
        identity.vendor_rows = lambda: rows
        try:
            answers = []
            for email in ("who@nowhere.example", "accounts@bramblewickprintco.example", "billing@quillfernstudio.example",
                          ULLA, "", "  "):
                r = vendor_sso(self.c, email)
                answers.append((email, r.status_code, r.json()))
            for email, status, body in answers:
                self.assertEqual((status, body), (401, NEUTRAL), email)
            # the unaffected contact of the first vendor still works (it lists only one vendor)
            self.assertEqual(vendor_sso(self.c, "finance@quillfernstudio.example").status_code, 200)
        finally:
            identity.vendor_rows = real

    def test_a_bad_provider_is_the_same_neutral_answer(self):
        r = self.c.post("/api/session/sso", json={"kind": "vendor", "provider": "yahoo", "email": VENDOR_A}, headers=TOKEN)
        self.assertEqual((r.status_code, r.json()), (401, NEUTRAL))

    def test_vendor_for_contact(self):
        self.assertEqual(identity.vendor_for_contact(VENDOR_A)["internalId"], "3000")
        self.assertIsNone(identity.vendor_for_contact("x@y.example"))
        self.assertIsNone(identity.vendor_for_contact(ULLA))


class CodeFlow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(server.app, base_url="http://localhost")

    def setUp(self):
        identity._logic = None   # fresh rate-limit counters for each test

    def request(self, email, invoice="INV-1"):
        return self.c.post("/api/session/code/request", json={"email": email, "invoice": invoice}, headers=TOKEN)

    def verify(self, email, code, invoice="INV-1"):
        return self.c.post("/api/session/code/verify", json={"email": email, "invoice": invoice, "code": code}, headers=TOKEN)

    def test_a_code_signs_the_contact_in_to_their_vendor(self):
        r = self.request(VENDOR_A)
        self.assertEqual(r.status_code, 200)
        box = r.json()["inbox"]
        self.assertTrue(r.json()["ok"])
        self.assertEqual(box["to"], VENDOR_A)
        self.assertRegex(box["code"], r"^\d{6}$")
        bad = self.verify(VENDOR_A, "000000" if box["code"] != "000000" else "111111")
        self.assertEqual((bad.status_code, bad.json()), (401, {"detail": "That code is not valid or has expired."}))
        ok = self.verify(VENDOR_A, box["code"])
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual((ok.json()["role"], ok.json()["vendor"]["id"], ok.json()["home"]), ("vendor", "3000", "/direct"))
        self.assertEqual(self.verify(VENDOR_A, box["code"]).status_code, 401)   # a code works once

    def test_the_code_is_for_that_address_and_invoice(self):
        box = self.request(VENDOR_A, "INV-1").json()["inbox"]
        self.assertEqual(self.verify("finance@quillfernstudio.example", box["code"]).status_code, 401)
        self.assertEqual(self.verify(VENDOR_A, box["code"], invoice="INV-2").status_code, 401)

    def test_an_unknown_address_gets_the_same_message_and_no_code(self):
        known, unknown = self.request(VENDOR_A).json(), self.request("who@nowhere.example").json()
        self.assertEqual(known["message"], unknown["message"])
        self.assertTrue(unknown["ok"])
        self.assertIsNone(unknown["inbox"])
        self.assertEqual(self.request(ULLA).json()["inbox"], None)   # an employee address is not a vendor contact
        self.assertEqual(self.verify("who@nowhere.example", "123456").status_code, 401)

    def test_a_code_expires(self):
        box = self.request(VENDOR_A).json()["inbox"]
        old = identity._now
        try:
            identity._now = lambda: old() + 601
            self.assertEqual(self.verify(VENDOR_A, box["code"]).status_code, 401)
        finally:
            identity._now = old

    def test_requests_are_rate_limited(self):
        last = None
        for _ in range(7):
            last = self.request(VENDOR_A).json()
        self.assertFalse(last["ok"])
        self.assertIn("Too many", last["message"])
        self.assertIsNone(last["inbox"])
        for _ in range(7):
            last = self.request("who@nowhere.example").json()
        self.assertFalse(last["ok"])   # an unknown address is limited the same way

    def test_the_log_never_holds_a_whole_address(self):
        box = self.request(VENDOR_A).json()["inbox"]
        self.verify(VENDOR_A, box["code"])
        log = (Path(db.STATE_DIR) / "portal_log.jsonl")
        text = log.read_text(encoding="utf-8") if log.exists() else ""
        self.assertNotIn(VENDOR_A, text)


class RoleGuards(unittest.TestCase):
    """Roles are checked on every route (docs/phase3/ROUTES.md)."""

    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(server.app, base_url="http://localhost")
        cls.h = {r: signin.headers(r) for r in ("ap_specialist", "cfo", "approver")}
        cls.h["vendor"] = signin.headers("vendor", VENDOR_A)

    def call(self, method, path, who, body=None):
        if who is None:
            headers = dict(TOKEN)
        else:
            headers = self.h[who]
        kw = {"json": body} if body is not None else {}
        return self.c.request(method, path, headers=headers, **kw)

    STAFF_ROUTES = [
        ("GET", "/api/runs/r1"), ("GET", "/api/runs/r1/tickets"), ("GET", "/api/runs/r1/tickets/1"),
        ("PUT", "/api/runs/r1/review/1", {"state": "approved"}), ("POST", "/api/runs/r1/review/bulk", {"ids": []}),
        ("PUT", "/api/runs/r1/review/1/draft", {"text": "x"}), ("POST", "/api/runs/r1/tickets/1/send"),
        ("GET", "/api/runs/r1/tickets/1/schedule"), ("GET", "/api/runs/r1/tickets/1/chat"), ("GET", "/api/runs/r1/prevention"),
        ("GET", "/api/runs/r1/export"), ("GET", "/api/mail/status"), ("GET", "/api/settings"), ("GET", "/api/model/status"),
        ("GET", "/api/workflow/1"), ("POST", "/api/workflow/1/escalate", {"reason": "legal", "note": "x"}),
        ("POST", "/api/workflow/1/request-signoff", {"note": "x"}), ("POST", "/api/feedback", {"run_id": "r1", "ticket_id": 1, "category": "tone"}),
        ("GET", "/api/runs/r1/events"),
    ]
    CFO_ROUTES = [
        ("GET", "/api/runs"), ("POST", "/api/runs", {"path": "x"}), ("POST", "/api/runs/import", {"path": "x"}),
        ("DELETE", "/api/runs/r1"), ("PUT", "/api/settings/model", {}), ("GET", "/api/fs/list"), ("POST", "/api/fs/pick", {}),
        ("POST", "/api/dataset/validate", {"path": "x"}), ("POST", "/api/workflow/1/return", {"guidance": "x"}),
        ("POST", "/api/workflow/1/signoff", {"reply_hash": "x"}), ("POST", "/api/workflow/1/decide", {"decision": "closed"}),
        ("GET", "/api/workflow/audit"), ("GET", "/api/workflow/escalations"), ("GET", "/api/feedback/trends"),
    ]

    def test_no_session_is_401_everywhere(self):
        for method, path, *body in self.STAFF_ROUTES + self.CFO_ROUTES + [("POST", "/api/live/ticket"), ("GET", "/api/session")]:
            r = self.call(method, path, None, body[0] if body else None)
            self.assertEqual(r.status_code, 401, f"{method} {path}")

    def test_a_vendor_session_is_403_on_staff_routes_and_on_runs(self):
        for method, path, *body in self.STAFF_ROUTES + self.CFO_ROUTES:
            r = self.call(method, path, "vendor", body[0] if body else None)
            self.assertEqual(r.status_code, 403, f"{method} {path}")
        for path in ("/api/runs", "/api/runs/r1", "/api/runs/r1/events"):
            self.assertEqual(self.call("GET", path, "vendor").status_code, 403, path)

    def test_a_vendor_session_may_use_session_live_health_and_direct_only(self):
        self.assertEqual(self.call("GET", "/api/health", "vendor").status_code, 200)
        self.assertEqual(self.call("GET", "/api/session", "vendor").json()["role"], "vendor")
        self.assertEqual(self.call("POST", "/api/live/ticket", "vendor").status_code, 200)
        # Direct is not built yet in this worktree: the guard lets the vendor through, so it is a 404, never a 401 or 403.
        self.assertNotIn(self.call("GET", "/api/direct/me", "vendor").status_code, (401, 403))
        for who in ("ap_specialist", "cfo", "approver"):  # staff and approvers are kept out of Direct by its own guard
            self.assertNotEqual(self.call("GET", "/api/health", who).status_code, 403)

    def test_an_approver_is_403_on_the_inbox_and_runs_routes(self):
        for method, path, *body in self.STAFF_ROUTES + self.CFO_ROUTES:
            r = self.call(method, path, "approver", body[0] if body else None)
            self.assertEqual(r.status_code, 403, f"{method} {path}")

    def test_cfo_routes_are_403_for_a_specialist(self):
        for method, path, *body in self.CFO_ROUTES:
            r = self.call(method, path, "ap_specialist", body[0] if body else None)
            self.assertEqual(r.status_code, 403, f"{method} {path}")

    def test_the_cfo_passes_the_staff_routes(self):
        for method, path, *body in self.STAFF_ROUTES:
            if path.endswith("/events"):
                continue
            r = self.call(method, path, "cfo", body[0] if body else None)
            self.assertNotIn(r.status_code, (401, 403), f"{method} {path}")

    def test_every_api_route_declares_a_guard(self):
        """No /api route may be reachable without the session baseline or its own role guard."""
        public = ("/api/health", "/api/session")
        for route in server.app.routes:
            path = getattr(route, "path", "")
            if not path.startswith("/api/") or any(path == p or path.startswith(p + "/") for p in public):
                continue
            deps = [d.call for d in route.dependant.dependencies]
            self.assertIn(server.auth, deps, path)


if __name__ == "__main__":
    unittest.main()
