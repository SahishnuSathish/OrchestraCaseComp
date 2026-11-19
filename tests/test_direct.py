"""Conductor: Direct (vendor API). The vendor session is injected with a dependency override, and the other
workers' functions (inbox.ingest, documents.render, live.publish) are mocked against the contract signatures."""
import csv
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "dashboards" / "conductor"), str(ROOT / "src"), str(ROOT)]

import db  # noqa: E402

_TMP = tempfile.TemporaryDirectory()
_MINE = (Path(_TMP.name), Path(_TMP.name) / "app.db")  # never touch the real state folder
_OTHERS = (db.STATE_DIR, db.DB_PATH)
db.STATE_DIR, db.DB_PATH = _MINE
db.init()


def setUpModule():
    # Other test modules also repoint db at import time; take it back for these tests and give it back afterwards.
    global _OTHERS
    _OTHERS = (db.STATE_DIR, db.DB_PATH)
    db.STATE_DIR, db.DB_PATH = _MINE
    db.init()


def tearDownModule():
    db.STATE_DIR, db.DB_PATH = _OTHERS

import direct  # noqa: E402
import status_service  # noqa: E402
from data_layer import FileBackend, Store  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

DATA = ROOT / "data"
STORE = Store(FileBackend(DATA))


class FakeSession:
    def __init__(self, vendor_id, subject, name="Test Contact", role="vendor"):
        self.id, self.role, self.subject, self.name, self.vendor_id, self.title = "s", role, subject, name, vendor_id, None


CURRENT = {"s": None}
app = FastAPI()
app.include_router(direct.router)
app.include_router(__import__("w9").router)
app.dependency_overrides[direct.vendor_session] = lambda: CURRENT["s"]
client = TestClient(app)

VENDORS = {v["internalId"]: v for v in STORE.vendors}


def as_vendor(vid, idx=0):
    CURRENT["s"] = FakeSession(vid, VENDORS[vid]["authorizedContacts"].split(";")[idx])
    return CURRENT["s"].subject


def walk(x, path=""):
    """Yield (path, key, value) for every dict key in a JSON value."""
    if isinstance(x, dict):
        for k, v in x.items():
            yield path, k, v
            yield from walk(v, f"{path}/{k}")
    elif isinstance(x, list):
        for i in x:
            yield from walk(i, path)


class ReadSideTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vid = "3023"  # Dovetail Lane Printing: has paid, pending, scheduled, approved and released bills
        as_vendor(cls.vid)
        cls.rows = client.get("/api/direct/invoices").json()["rows"]

    def setUp(self):
        as_vendor(self.vid)

    def test_no_session_is_refused(self):
        CURRENT["s"] = None
        self.assertEqual(client.get("/api/direct/invoices").status_code, 401)
        CURRENT["s"] = FakeSession(None, "x@y.example")
        self.assertEqual(client.get("/api/direct/me").status_code, 401)

    def test_a_contact_who_is_not_listed_is_refused(self):
        CURRENT["s"] = FakeSession(self.vid, "stranger@elsewhere.example")
        self.assertEqual(client.get("/api/direct/invoices").status_code, 403)

    def test_me_shape(self):
        r = client.get("/api/direct/me").json()
        self.assertEqual(r["vendor"], {"name": "Dovetail Lane Printing", "subsidiary": "Mock Agency Studio Inc"})
        self.assertEqual(r["contact"]["email"], "billing@dovetaillaneprinti.example")
        self.assertEqual(set(r), {"contact", "vendor", "w9", "unread_messages", "unread_updates"})

    def test_list_shape_and_every_chip(self):
        body = client.get("/api/direct/invoices").json()
        self.assertEqual(set(body), {"rows", "updated"})
        self.assertEqual(body["updated"], "Nov 13, 2026")
        codes = {r["status"]["code"] for r in body["rows"]}
        self.assertEqual(codes, {"paid", "scheduled", "approved", "pending_approval", "payment_sent"})
        for r in body["rows"]:
            self.assertEqual(set(r), {"invoice", "date", "amount", "currency", "balance", "status"})
            st = r["status"]
            if st["code"] in ("pending_approval", "approved"):
                self.assertNotIn("date", st)
            if st["code"] in ("scheduled", "payment_sent", "paid"):
                self.assertRegex(st["date"], r"^\d{4}-\d{2}-\d{2}$")
            if st["code"] == "approved":
                self.assertIn("typically paid within 5 to 10 business days", st["label"])
            if st["code"] in ("paid", "payment_sent"):
                self.assertEqual(r["balance"], 0.0)
            if st["code"] in ("pending_approval", "approved", "scheduled"):
                self.assertEqual(r["balance"], r["amount"])

    def test_under_review_has_no_reason_and_no_balance(self):
        as_vendor("3010")
        rows = client.get("/api/direct/invoices", params={"status": "under_review"}).json()["rows"]
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r["status"], {"code": "under_review", "label": "Under review: our team will follow up"})
        self.assertIsNone(r["balance"])
        d = client.get(f"/api/direct/invoices/{r['invoice']}").json()
        self.assertEqual(d["message"], status_service.NEEDS_REVIEW)
        text = json.dumps(d).lower()
        for word in ("return", "conflict", "fail", "dispute", "reason"):
            self.assertNotIn(word, text)

    def test_search_and_filter(self):
        one = self.rows[0]["invoice"]
        got = client.get("/api/direct/invoices", params={"q": one.lower()}).json()["rows"]
        self.assertTrue(got and all(one.lower() in r["invoice"].lower() for r in got))
        paid = client.get("/api/direct/invoices", params={"status": "paid"}).json()["rows"]
        self.assertTrue(paid and all(r["status"]["code"] == "paid" for r in paid))

    def test_detail_shape_and_public_timeline(self):
        by = {r["status"]["code"]: r["invoice"] for r in self.rows}
        d = client.get(f"/api/direct/invoices/{by['paid']}").json()
        self.assertEqual(set(d), {"invoice", "date", "due", "amount", "currency", "balance", "status", "timeline",
                                  "message", "documents", "source"})
        self.assertEqual(d["source"], "Orchestra accounts payable records, updated Nov 13, 2026")
        self.assertEqual([s["label"] for s in d["timeline"]],
                         ["Received", "Approved", "Scheduled for payment", "Payment sent", "Paid"])
        self.assertTrue(all(s["done"] for s in d["timeline"]))
        self.assertEqual([x["kind"] for x in d["documents"]], ["invoice", "remittance"])
        p = client.get(f"/api/direct/invoices/{by['pending_approval']}").json()
        self.assertEqual([s["done"] for s in p["timeline"]], [True, False, False, False, False])
        for s in p["timeline"]:
            self.assertNotIn("date", s)  # no approval or any other date while pending
        self.assertEqual([x["kind"] for x in p["documents"]], ["invoice"])
        a = client.get(f"/api/direct/invoices/{by['approved']}").json()
        self.assertIn("5 to 10 business days", a["message"])
        self.assertNotRegex(a["message"], r"\b(January|February|March|April|May|June|July|August|September|October|November|December) \d")

    def test_vendor_never_sees_internal_names_or_ticket_ids(self):
        blob = json.dumps(client.get("/api/direct/invoices").json())
        for row in self.rows[:6]:
            blob += json.dumps(client.get(f"/api/direct/invoices/{row['invoice']}").json())
        low = blob.lower()
        for word in ("nextapprover", "approver", "ticket", "delegate", "employee", "@orchestra-mock"):
            self.assertNotIn(word, low.replace("ap@orchestra-mock.example", ""))

    def test_wording_matches_status_service_for_every_invoice(self):
        """Same contact and invoice: Direct says what lookup_status says, with USD amounts in the $ style."""
        checked = 0
        for vid in ("3023", "3010", "3013", "3019", "3027"):
            contact = as_vendor(vid)
            for r in client.get("/api/direct/invoices").json()["rows"]:
                want = status_service.lookup_status(contact, r["invoice"], STORE)
                self.assertTrue(want["ok"], r["invoice"])
                got = client.get(f"/api/direct/invoices/{r['invoice']}").json()
                self.assertEqual(got["message"], direct.dollar_style(want["message"]), (vid, r["invoice"]))
                self.assertNotIn("USD ", got["message"])
                checked += 1
        self.assertGreater(checked, 300)


class NoAggregatesTests(unittest.TestCase):
    """The client's rule: vendors never see totals, counts or sums across their invoices."""
    FORBIDDEN = {"total", "totals", "count", "counts", "sum", "aggregate", "average", "avg", "portfolio", "outstanding",
                 "open_total", "total_open", "grand_total", "n", "num", "number_of_invoices"}

    def test_no_aggregate_in_any_invoice_json(self):
        as_vendor("3023")
        lst = client.get("/api/direct/invoices").json()
        self.assertEqual(set(lst), {"rows", "updated"})
        docs = [lst]
        for r in lst["rows"][:10]:
            docs.append(client.get(f"/api/direct/invoices/{r['invoice']}").json())
        for doc in docs:
            for path, key, _ in walk(doc):
                self.assertNotIn(key.lower(), self.FORBIDDEN, f"{path}/{key}")
        # a list row carries only its own bill's figures; no invoice's balance equals a sum of others
        amounts = {r["invoice"]: r["amount"] for r in lst["rows"]}
        text = json.dumps(lst)
        total_all = round(sum(a for a in amounts.values() if a), 2)
        self.assertNotIn(str(total_all), text)
        self.assertNotIn(f"{total_all:,.2f}", text)

    def test_filter_does_not_add_a_count(self):
        as_vendor("3023")
        got = client.get("/api/direct/invoices", params={"status": "paid"}).json()
        self.assertEqual(set(got), {"rows", "updated"})


class EnumerationTests(unittest.TestCase):
    ANSWER = {"detail": "We couldn't find that invoice."}

    def test_missing_foreign_malformed_and_unavailable_all_look_the_same(self):
        as_vendor("3023")
        mine = client.get("/api/direct/invoices").json()["rows"][0]["invoice"]
        theirs = next(b["tranId"] for b in STORE.backend.all("vendorBill") if b["entity"] == "3010")
        pending = next(r["invoice"] for r in client.get("/api/direct/invoices").json()["rows"]
                       if r["status"]["code"] == "pending_approval")
        cases = [
            f"/api/direct/invoices/INV-00000",                       # missing
            f"/api/direct/invoices/{theirs}",                        # another vendor's
            "/api/direct/invoices/%3Cscript%3E",                     # malformed reference
            "/api/direct/invoices/" + "A" * 40,                      # too long
            f"/api/direct/invoices/{theirs}/documents/invoice.pdf",  # another vendor's document
            f"/api/direct/invoices/{pending}/documents/remittance.pdf",  # not available for this bill
            f"/api/direct/invoices/{mine}/documents/other.pdf",      # unknown kind
        ]
        for url in cases:
            r = client.get(url)
            self.assertEqual((r.status_code, r.json()), (404, self.ANSWER), url)

    def test_an_ambiguous_reference_is_not_showable(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        shutil.copytree(DATA, tmp / "data")
        rows = list(csv.DictReader((DATA / "vendor_bills.csv").read_text(encoding="utf-8").splitlines()))
        dup = dict(next(r for r in rows if r["entity"] == "3023"))
        ref = dup["tranId"]
        dup["internalId"] = "59999"
        with open(tmp / "data" / "vendor_bills.csv", "a", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=list(rows[0])).writerow(dup)
        store = Store(FileBackend(tmp / "data"))
        as_vendor("3023")
        with mock.patch.object(direct, "_store", lambda: store):
            r = client.get(f"/api/direct/invoices/{ref}")
            self.assertEqual((r.status_code, r.json()), (404, self.ANSWER))
            self.assertNotIn(ref, [x["invoice"] for x in client.get("/api/direct/invoices").json()["rows"]])
            self.assertEqual(client.get(f"/api/direct/invoices/{ref}/documents/invoice.pdf").status_code, 404)


class IsolationTests(unittest.TestCase):
    def test_vendor_a_never_sees_vendor_b(self):
        a, b = "3023", "3010"
        as_vendor(b)
        b_rows = client.get("/api/direct/invoices").json()["rows"]
        b_ref = b_rows[0]["invoice"]
        as_vendor(a)
        a_refs = {r["invoice"] for r in client.get("/api/direct/invoices").json()["rows"]}
        self.assertFalse(a_refs & {r["invoice"] for r in b_rows})
        self.assertEqual(client.get(f"/api/direct/invoices/{b_ref}").status_code, 404)
        with mock.patch("documents.render", return_value=(b"x", "application/pdf", "x.pdf")) as rend:
            self.assertEqual(client.get(f"/api/direct/invoices/{b_ref}/documents/invoice.pdf").status_code, 404)
            rend.assert_not_called()

    def test_document_is_scoped_and_framed(self):
        as_vendor("3023")
        ref = next(r["invoice"] for r in client.get("/api/direct/invoices").json()["rows"] if r["status"]["code"] == "paid")
        bill = next(b for b in STORE.backend.all("vendorBill") if b["tranId"] == ref and b["entity"] == "3023")
        with mock.patch("documents.render", return_value=(b"%PDF-fake", "application/pdf", "invoice-x.pdf")) as rend:
            r = client.get(f"/api/direct/invoices/{ref}/documents/remittance.pdf")
        self.assertEqual(r.status_code, 200)
        rend.assert_called_once_with("remittance", bill["internalId"], "pdf")
        self.assertEqual(r.headers["X-Conductor-Frame"], "self")
        self.assertEqual(r.content, b"%PDF-fake")

    def test_document_not_available_is_the_same_404(self):
        import documents
        as_vendor("3023")
        ref = client.get("/api/direct/invoices").json()["rows"][0]["invoice"]
        with mock.patch("documents.render", side_effect=documents.NotAvailable("invoice")):
            r = client.get(f"/api/direct/invoices/{ref}/documents/invoice.html")
        self.assertEqual((r.status_code, r.json()), (404, {"detail": "We couldn't find that invoice."}))


class LookupTests(unittest.TestCase):
    def test_opening_an_invoice_records_one_lookup_and_the_list_records_none(self):
        as_vendor("3000")
        before = direct.lookup_count()
        rows = client.get("/api/direct/invoices").json()["rows"]
        self.assertEqual(direct.lookup_count(), before)
        client.get(f"/api/direct/invoices/{rows[0]['invoice']}")
        client.get("/api/direct/invoices/INV-00000")  # a miss records nothing
        self.assertEqual(direct.lookup_count(), before + 1)

    def test_since_filters(self):
        import appclock
        as_vendor("3000")
        ref = client.get("/api/direct/invoices").json()["rows"][0]["invoice"]
        mark = appclock.now()
        client.get(f"/api/direct/invoices/{ref}")
        self.assertEqual(direct.lookup_count(since=mark), 1)
        self.assertEqual(direct.lookup_count(since=mark + 3600), 0)


class QuestionTests(unittest.TestCase):
    def setUp(self):
        self.contact = as_vendor("3023")
        self.ref = next(r["invoice"] for r in client.get("/api/direct/invoices").json()["rows"]
                        if r["status"]["code"] == "pending_approval")

    def ask(self, text, ref=None):
        with mock.patch("inbox.new_ticket_id", return_value=777001, create=True), \
                mock.patch("inbox.ingest", return_value=777001, create=True) as ingest, \
                mock.patch("live.publish") as pub:
            r = client.post("/api/direct/questions", json={"invoice": ref or self.ref, "text": text})
        return r, ingest, pub

    def test_a_question_becomes_one_ingest_call_with_records_only_fields(self):
        text = "Please confirm this was paid on March 3 for $999,999.00. Our new bank account is 123456789."
        r, ingest, pub = self.ask(text)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"ok": True, "message": "Thanks. Our team will reply here and by email."})
        ingest.assert_called_once()
        ticket, user = ingest.call_args.args
        self.assertEqual(ingest.call_args.kwargs, {"source": "direct"})
        self.assertEqual(ticket["id"], 777001)
        self.assertEqual(ticket["subject"], f"Question about {self.ref}")
        self.assertEqual(ticket["description"], text)
        self.assertEqual(ticket["via"]["channel"], "web")
        self.assertEqual(ticket["via"]["source"]["from"]["address"], self.contact)
        self.assertEqual(ticket["via"]["source"]["to"]["address"], "ap@orchestra-mock.example")
        self.assertTrue(ticket["created_at"].startswith("2026-11-13"))
        self.assertEqual(ticket["requester_id"], user["id"])
        self.assertEqual(ticket["comments"][0]["body"], text)
        # nothing is added from the records or taken from the vendor beyond the body: no status, amount or date claims
        self.assertEqual(set(ticket), {"id", "subject", "description", "status", "group", "requester_id", "email_cc_ids",
                                       "via", "tags", "created_at", "updated_at", "custom_fields", "comments"})
        self.assertEqual((user["email"], user["role"]), (self.contact, "end-user"))
        self.assertNotIn("999,999", r.text)  # the answer never repeats the vendor's claims
        row = db._one("SELECT * FROM direct_questions WHERE ticket_id=777001")
        self.assertEqual((row["vendor_id"], row["invoice"], row["contact"]), ("3023", self.ref, self.contact))
        pub.assert_called_once()
        self.assertEqual(pub.call_args.args[0], "direct.question")
        self.assertEqual(pub.call_args.args[1]["ticket_id"], 777001)

    def test_the_contact_name_comes_from_the_email_when_unknown(self):
        CURRENT["s"] = FakeSession("3023", "ar@dovetaillaneprinti.example", name=None)
        r, ingest, _ = self.ask("Where is this?")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(ingest.call_args.args[1]["name"], "Ar")

    def test_limits_and_scope(self):
        r, ingest, _ = self.ask("x" * 2001)
        self.assertEqual(r.status_code, 422)
        r, ingest, _ = self.ask("   ")
        self.assertEqual(r.status_code, 422)
        r, ingest, _ = self.ask("x" * 2000)
        self.assertEqual(r.status_code, 200)
        theirs = next(b["tranId"] for b in STORE.backend.all("vendorBill") if b["entity"] == "3010")
        for ref in (theirs, "INV-00000"):
            r, ingest, pub = self.ask("hello", ref=ref)
            self.assertEqual((r.status_code, r.json()), (404, {"detail": "We couldn't find that invoice."}))
            ingest.assert_not_called()
            pub.assert_not_called()

    def test_a_failed_ingest_leaves_no_question_row(self):
        with mock.patch("inbox.new_ticket_id", return_value=777002, create=True), \
                mock.patch("inbox.ingest", side_effect=RuntimeError("boom"), create=True):
            c = TestClient(app, raise_server_exceptions=False)
            r = c.post("/api/direct/questions", json={"invoice": self.ref, "text": "hi"})
        self.assertEqual(r.status_code, 500)
        self.assertIsNone(db._one("SELECT 1 AS x FROM direct_questions WHERE ticket_id=777002"))


def put_ticket(run_id, ticket_id, subject, recipient, text, state, output_type="draft_reply", edited=None):
    bundle = {"result": {"output_type": output_type, "recipient": recipient, "text": text, "flags": []}}
    db.save_ticket(run_id, ticket_id, 0, bundle, {"id": ticket_id, "subject": subject}, {})
    db.save_review(run_id, ticket_id, state, edited_text=edited)
    if state == "sent":
        db.save_sent(run_id, ticket_id, "m1", {})


class MessagesHookTests(unittest.TestCase):
    def setUp(self):
        self.contact = as_vendor("3023")
        self.ref = client.get("/api/direct/invoices").json()["rows"][0]["invoice"]
        db._exec("DELETE FROM direct_messages")

    def ask_row(self, tid):
        db._exec("INSERT OR REPLACE INTO direct_questions (ticket_id, vendor_id, invoice, contact) VALUES (?,?,?,?)",
                 (tid, "3023", self.ref, self.contact))

    def test_hooks_are_registered_once(self):
        import delivery
        self.assertEqual(delivery.ON_SENT.count(direct._on_sent), 1)
        self.assertEqual(delivery.ON_NOTICE_SENT.count(direct._on_notice_sent), 1)

    def test_only_a_sent_reply_to_a_direct_ticket_becomes_a_message(self):
        self.ask_row(8001)
        for state in ("pending", "approved", "returned"):
            put_ticket("r1", 8001, f"Question about {self.ref}", self.contact, "Draft body", state)
            direct._on_sent("r1", 8001, None, {})
            self.assertEqual(client.get("/api/direct/messages").json()["rows"], [], state)
        # a ticket that did not come from Direct
        put_ticket("r1", 8002, "Checking in", self.contact, "Zendesk reply", "sent")
        direct._on_sent("r1", 8002, None, {})
        # a note, not a reply
        self.ask_row(8003)
        put_ticket("r1", 8003, "Question", self.contact, "note", "sent", output_type="internal_action_note")
        direct._on_sent("r1", 8003, None, {})
        # a reply that went to someone else
        self.ask_row(8004)
        put_ticket("r1", 8004, "Question", "someone@else.example", "to else", "sent")
        direct._on_sent("r1", 8004, None, {})
        self.assertEqual(client.get("/api/direct/messages").json()["rows"], [])
        # the real one
        put_ticket("r1", 8001, f"Question about {self.ref}", self.contact, "Original", "sent", edited="Edited and approved text")
        with mock.patch("live.publish") as pub:
            direct._on_sent("r1", 8001, {"name": "Ulla", "email": "u@x"}, {"id": "m1"})
            direct._on_sent("r1", 8001, None, {})  # a repeat does not duplicate
        rows = client.get("/api/direct/messages").json()["rows"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(set(rows[0]), {"at", "invoice", "subject", "body"})
        self.assertEqual(rows[0]["body"], "Edited and approved text")
        self.assertEqual(rows[0]["subject"], f"Re: Question about {self.ref}")
        self.assertEqual(rows[0]["invoice"], self.ref)
        self.assertNotIn("8001", json.dumps(rows))  # no ticket id
        pub.assert_called_once()
        self.assertEqual(pub.call_args.args[0], "direct.message")
        self.assertEqual(pub.call_args.kwargs["vendor_id"], "3023")
        self.assertEqual(pub.call_args.kwargs["roles"], set())  # vendor audience only

    def test_unread_count_drops_after_reading(self):
        self.ask_row(8010)
        put_ticket("r1", 8010, "Question", self.contact, "Hello", "sent")
        with mock.patch("live.publish"):
            direct._on_sent("r1", 8010, None, {})
        self.assertEqual(client.get("/api/direct/me").json()["unread_messages"], 1)
        client.get("/api/direct/messages")
        self.assertEqual(client.get("/api/direct/me").json()["unread_messages"], 0)

    def test_messages_are_per_vendor(self):
        self.ask_row(8020)
        put_ticket("r1", 8020, "Question", self.contact, "For Dovetail only", "sent")
        with mock.patch("live.publish"):
            direct._on_sent("r1", 8020, None, {})
        as_vendor("3010")
        self.assertNotIn("Dovetail", json.dumps(client.get("/api/direct/messages").json()))
        as_vendor("3023")
        self.assertIn("Dovetail", json.dumps(client.get("/api/direct/messages").json()))


class UpdatesAndPreferencesTests(unittest.TestCase):
    def setUp(self):
        self.contact = as_vendor("3023")
        db._exec("DELETE FROM direct_updates")

    def test_a_sent_notice_with_a_vendor_id_becomes_an_update(self):
        import delivery
        item = {"vendor_id": "3023", "to": "billing@dovetaillaneprinti.example", "text": "Invoice X is approved.", "bills": ["X"]}
        with mock.patch("live.publish") as pub:
            delivery.notice_sent("r1", "notice", "3023", item, {})
        rows = client.get("/api/direct/updates").json()["rows"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["body"], "Invoice X is approved.")
        self.assertEqual(set(rows[0]), {"at", "title", "body"})
        # Other ON_NOTICE_SENT hooks publish too (inbox: ahead.sent), so look for Direct's event among all calls.
        updates = [c for c in pub.call_args_list if c.args and c.args[0] == "direct.update"]
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0].kwargs["vendor_id"], "3023")
        as_vendor("3010")
        self.assertEqual(client.get("/api/direct/updates").json()["rows"], [])

    def test_the_one_invoice_demo_finds_the_vendor_by_contact(self):
        with mock.patch("live.publish"):
            direct._on_notice_sent("r1", "demo", "50000", {"to": self.contact, "text": "Demo notice text."}, {})
        self.assertEqual(client.get("/api/direct/me").json()["unread_updates"], 1)
        self.assertEqual([r["body"] for r in client.get("/api/direct/updates").json()["rows"]], ["Demo notice text."])
        self.assertEqual(client.get("/api/direct/me").json()["unread_updates"], 0)  # reading marked it

    def test_digests_and_unknown_addresses_make_no_update(self):
        with mock.patch("live.publish") as pub:
            direct._on_notice_sent("r1", "digest", "k", {"to": "ben.merriweather@orchestra-mock.example", "text": "Digest"}, {})
            direct._on_notice_sent("r1", "notice", "k", {"to": "nobody@nowhere.example", "text": "Hi"}, {})
            direct._on_notice_sent("r1", "notice", "k", {"vendor_id": "3023"}, {})  # no text
        pub.assert_not_called()
        self.assertEqual(client.get("/api/direct/updates").json()["rows"], [])

    def test_preferences(self):
        got = client.get("/api/direct/preferences").json()
        self.assertEqual(got, {"email_updates": True, "notice_types": list(direct.NOTICE_TYPES)})
        r = client.put("/api/direct/preferences", json={"email_updates": False, "notice_types": ["payment_updates"]})
        self.assertEqual(r.json(), {"email_updates": False, "notice_types": ["payment_updates"]})
        self.assertEqual(client.get("/api/direct/preferences").json(), r.json())
        self.assertEqual(client.put("/api/direct/preferences", json={"email_updates": True, "notice_types": ["x"]}).status_code, 422)
        CURRENT["s"] = FakeSession("3023", "ar@dovetaillaneprinti.example")  # another contact has its own
        self.assertTrue(client.get("/api/direct/preferences").json()["email_updates"])


if __name__ == "__main__":
    unittest.main()
