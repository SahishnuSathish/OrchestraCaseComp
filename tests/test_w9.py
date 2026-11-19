"""W-9: seed, sample PDFs, chunked upload, extraction and checks, masking, staff endpoints.
Other workers' functions (workflow.create_outbound, live.publish) are mocked against the contract signatures."""
import hashlib
import importlib.util
import json
import re
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
import w9  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

SEED = ROOT / "dashboards" / "conductor" / "seed" / "w9"
SAMPLES = SEED / "samples"
spec = importlib.util.spec_from_file_location("make_w9_samples", ROOT / "scripts" / "make_w9_samples.py")
maker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maker)


class Sess:
    def __init__(self, vendor_id, subject, role="vendor", name="Tester"):
        self.id, self.role, self.subject, self.name, self.vendor_id, self.title = "s", role, subject, name, vendor_id, None


CUR = {"vendor": Sess("3023", "billing@dovetaillaneprinti.example"), "staff": Sess(None, "ulla.abernathy@orchestra-mock.example", "ap_specialist")}
app = FastAPI()
app.include_router(direct.router)
app.include_router(w9.router)
app.dependency_overrides[direct.vendor_session] = lambda: CUR["vendor"]
app.dependency_overrides[w9.staff_session] = lambda: CUR["staff"]
client = TestClient(app)

FULL_TIN = re.compile(r"\b\d{9}\b|\b\d{3}-\d{2}-\d{4}\b|\b\d{2}-\d{7}\b")
ALL_TINS = ("99-9999033", "999999033", "99-9995354", "999995354", "99-9998457")


def reset():
    db._exec("DELETE FROM w9_uploads")
    db._exec("DELETE FROM w9_status")
    w9.init_schema()
    shutil.rmtree(w9._uploads_root(), ignore_errors=True)


def sample_bytes(name):
    return (SAMPLES / name).read_bytes()


def upload(data, filename="w9.pdf", mime="application/pdf", sha=None, chunk=None, vendor_sess=None):
    """Drive the whole three-step upload. Returns (upload_id, complete_response)."""
    if vendor_sess:
        CUR["vendor"] = vendor_sess
    r = client.post("/api/direct/w9/uploads", json={"filename": filename, "size": len(data), "mime": mime})
    assert r.status_code == 200, r.text
    uid, size = r.json()["upload_id"], chunk or r.json()["chunk_size"]
    for n, i in enumerate(range(0, len(data), size)):
        p = client.put(f"/api/direct/w9/uploads/{uid}/chunks/{n}", content=data[i:i + size])
        assert p.status_code == 200, p.text
    done = client.post(f"/api/direct/w9/uploads/{uid}/complete", json={"sha256": sha or hashlib.sha256(data).hexdigest()})
    return uid, done


class SeedTests(unittest.TestCase):
    def test_every_vendor_has_a_status_and_the_mix_is_believable(self):
        import csv
        seed = json.loads((SEED / "status.json").read_text(encoding="utf-8"))
        vendors = list(csv.DictReader((ROOT / "data" / "vendors.csv").read_text(encoding="utf-8").splitlines()))
        self.assertEqual(set(seed), {v["internalId"] for v in vendors})
        counts = {}
        for r in seed.values():
            self.assertIn(r["status"], ("on_file", "missing", "expired", "name_mismatch", "tin_mismatch"))
            counts[r["status"]] = counts.get(r["status"], 0) + 1
        self.assertGreater(counts["on_file"], len(seed) // 2)
        for s in ("missing", "expired", "name_mismatch", "tin_mismatch"):
            self.assertGreaterEqual(counts[s], 3, s)

    def test_the_seed_holds_only_the_last_4_of_any_tin(self):
        text = (SEED / "status.json").read_text(encoding="utf-8")
        self.assertIsNone(FULL_TIN.search(text))
        for r in json.loads(text).values():
            self.assertRegex(r["tin_last4"], r"^\d{4}$")

    def test_the_demo_vendor_has_paid_and_pending_bills_and_a_missing_w9(self):
        reset()
        self.assertEqual(w9.status_row("3023")["status"], "missing")
        codes = {direct.status_chip(o)["code"] for o in direct._classified("3023")}
        self.assertTrue({"paid", "pending_approval"} <= codes)

    def test_the_four_sample_pdfs_exist_and_are_forms_or_flat(self):
        from pypdf import PdfReader
        names = sorted(p.name for p in SAMPLES.glob("*.pdf"))
        self.assertEqual(len(names), 4)
        self.assertTrue(PdfReader(str(SAMPLES / "w9_dovetail_lane_printing_ok.pdf")).get_fields())
        self.assertFalse(PdfReader(str(SAMPLES / "w9_quillfern_studio_text_only.pdf")).get_fields())


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        reset()
        self.vendor = direct._vendor_row("3023")

    def check(self, name, vid="3023"):
        found = w9.extract(SAMPLES / name)
        fields = w9.check_fields(found, direct._vendor_row(vid), w9.status_row(vid))
        return found, {f["name"]: f for f in fields}

    def test_a_clean_form_matches_every_field(self):
        found, f = self.check("w9_dovetail_lane_printing_ok.pdf")
        self.assertEqual([x["match"] for x in f.values()], [True, True, True, True])
        self.assertFalse(found["bank_flag"])

    def test_name_mismatch_is_found(self):
        _, f = self.check("w9_dovetail_lane_printing_name_mismatch.pdf")
        self.assertFalse(f["Legal name"]["match"])
        self.assertTrue(f["TIN"]["match"] and f["Address"]["match"] and f["Entity type"]["match"])

    def test_tin_mismatch_is_found_and_masked(self):
        found, f = self.check("w9_dovetail_lane_printing_tin_mismatch.pdf")
        self.assertFalse(f["TIN"]["match"])
        self.assertTrue(f["Legal name"]["match"])
        self.assertEqual(set(found), {"legal_name", "entity_type", "address", "tin_last4", "bank_flag"})
        self.assertEqual(f["TIN"]["value_masked"], "XXX-XX-5354")
        self.assertEqual(f["TIN"]["record"], "XXX-XX-9033")

    def test_text_fallback_reads_a_flat_pdf(self):
        _, f = self.check("w9_quillfern_studio_text_only.pdf", "3000")
        self.assertEqual([x["match"] for x in f.values()], [True, True, True, True])
        self.assertEqual(f["TIN"]["value_masked"], "XXX-XX-8457")

    def test_company_suffixes_and_punctuation_do_not_cause_a_mismatch(self):
        v = {"companyName": "Moss and Meridian LLC"}
        found = {"legal_name": "Moss & Meridian, L.L.C.", "entity_type": "Limited liability company", "address": "1 Main St.",
                 "tin_last4": "1234"}
        f = w9.check_fields(found, v, {"entity_type": "LLC", "address": "1 Main Street", "tin_last4": "1234"})
        self.assertEqual([x["match"] for x in f], [False, True, True, True])  # "L.L.C." is not the word LLC; names must agree
        found["legal_name"] = "Moss and Meridian"
        self.assertTrue(w9.check_fields(found, v, {})[0]["match"])

    def test_a_missing_record_value_is_not_a_match(self):
        f = w9.check_fields({"legal_name": "X", "entity_type": "LLC", "address": "1 A St", "tin_last4": "1111"},
                            {"companyName": "X"}, {})
        self.assertEqual([x["match"] for x in f], [True, None, None, None])

    def test_an_unreadable_file_is_reported_not_raised(self):
        p = Path(_TMP.name) / "junk.pdf"
        p.write_bytes(b"%PDF-1.4\nnot really a pdf")
        with self.assertRaises(w9.Unreadable):
            w9.extract(p)


class UploadTests(unittest.TestCase):
    def setUp(self):
        reset()
        CUR["vendor"] = Sess("3023", "billing@dovetaillaneprinti.example")
        self.pub = mock.patch("live.publish").start()
        self.addCleanup(mock.patch.stopall)

    def test_chunks_are_reassembled_hashed_and_stored_outside_the_repo(self):
        data = sample_bytes("w9_dovetail_lane_printing_ok.pdf")
        with mock.patch.object(w9, "CHUNK_SIZE", 4096):
            uid, done = upload(data, chunk=4096)
        self.assertEqual(done.status_code, 200, done.text)
        self.assertEqual(done.json()["ok"], True)
        row = db._one("SELECT * FROM w9_uploads WHERE id=?", (uid,))
        self.assertEqual(row["sha256"], hashlib.sha256(data).hexdigest())
        self.assertGreater(len(data), 8192)  # at least three parts
        stored = Path(row["path"])
        self.assertEqual(stored.read_bytes(), data)
        self.assertTrue(str(stored.resolve()).startswith(str((Path(db.STATE_DIR) / "uploads" / "w9").resolve())))
        self.assertNotIn(str(ROOT.resolve()), str(stored.resolve()))
        self.assertEqual(list((w9._uploads_root() / uid).glob("*")) if (w9._uploads_root() / uid).exists() else [], [])
        self.assertEqual(row["state"], "received")
        self.assertEqual(row["reason"], None)

    def test_a_clean_upload_publishes_w9_received_and_shows_under_review_to_the_vendor(self):
        uid, done = upload(sample_bytes("w9_dovetail_lane_printing_ok.pdf"))
        self.assertEqual(done.json()["status"], "received")
        self.pub.assert_called_once()
        self.assertEqual(self.pub.call_args.args[0], "w9.received")
        self.assertEqual(self.pub.call_args.args[1]["upload_id"], uid)
        self.assertEqual(self.pub.call_args.args[1]["vendor_id"], "3023")
        mine = client.get("/api/direct/w9").json()
        self.assertEqual(mine["status"], "under_review")
        self.assertEqual(set(mine["last_upload"]), {"at", "filename", "state"})
        self.assertEqual(client.get("/api/direct/me").json()["w9"], {"status": "under_review", "label": "Under review"})

    def test_size_cap_and_type_check_at_the_start(self):
        post = lambda **b: client.post("/api/direct/w9/uploads", json=b)  # noqa: E731
        self.assertEqual(post(filename="a.pdf", size=50 * 1024 * 1024 + 1, mime="application/pdf").status_code, 413)
        self.assertEqual(post(filename="a.pdf", size=50 * 1024 * 1024, mime="application/pdf").status_code, 200)
        self.assertEqual(post(filename="a.pdf", size=0, mime="application/pdf").status_code, 422)
        self.assertEqual(post(filename="a.txt", size=10, mime="application/pdf").status_code, 415)
        self.assertEqual(post(filename="a.pdf", size=10, mime="text/plain").status_code, 415)
        self.assertEqual(post(filename="a.exe", size=10, mime="application/x-msdownload").status_code, 415)
        self.assertEqual(client.post("/api/direct/w9/uploads", json={"nonsense": 1}).status_code, 422)

    def test_a_file_that_is_not_a_pdf_is_rejected_by_its_first_bytes(self):
        r = client.post("/api/direct/w9/uploads", json={"filename": "w9.pdf", "size": 12, "mime": "application/pdf"})
        uid = r.json()["upload_id"]
        p = client.put(f"/api/direct/w9/uploads/{uid}/chunks/0", content=b"MZ not a pdf")
        self.assertEqual(p.status_code, 415)
        self.assertEqual(db._one("SELECT state FROM w9_uploads WHERE id=?", (uid,))["state"], "rejected")
        self.assertEqual(client.put(f"/api/direct/w9/uploads/{uid}/chunks/0", content=b"%PDF-1.4 abc").status_code, 409)

    def test_a_hash_mismatch_is_rejected_and_the_file_is_removed(self):
        data = sample_bytes("w9_dovetail_lane_printing_ok.pdf")
        uid, done = upload(data, sha="0" * 64)
        self.assertEqual(done.status_code, 400)
        row = db._one("SELECT * FROM w9_uploads WHERE id=?", (uid,))
        self.assertEqual(row["state"], "rejected")
        self.assertFalse((w9._uploads_root() / f"{uid}.pdf").exists())
        self.assertFalse((w9._uploads_root() / uid).exists())
        self.assertEqual(client.get("/api/direct/w9").json()["last_upload"], None)
        uid, done = upload(data, sha="not-a-hash")
        self.assertEqual(done.status_code, 422)

    def test_chunk_sizes_and_numbers_are_checked_and_missing_parts_block_complete(self):
        data = sample_bytes("w9_dovetail_lane_printing_ok.pdf")
        with mock.patch.object(w9, "CHUNK_SIZE", 4096):
            r = client.post("/api/direct/w9/uploads", json={"filename": "w9.pdf", "size": len(data), "mime": "application/pdf"})
            uid = r.json()["upload_id"]
            put = lambda n, b: client.put(f"/api/direct/w9/uploads/{uid}/chunks/{n}", content=b)  # noqa: E731
            self.assertEqual(put(0, data[:100]).status_code, 422)           # too short
            self.assertEqual(put(0, data[:5000]).status_code, 413)          # too long
            self.assertEqual(put(99, data[:4096]).status_code, 422)         # no such part
            self.assertEqual(put(0, data[:4096]).json(), {"received": 4096})
            done = client.post(f"/api/direct/w9/uploads/{uid}/complete", json={"sha256": hashlib.sha256(data).hexdigest()})
            self.assertEqual(done.status_code, 409)

    def test_another_vendor_cannot_touch_an_upload(self):
        r = client.post("/api/direct/w9/uploads", json={"filename": "w9.pdf", "size": 8, "mime": "application/pdf"})
        uid = r.json()["upload_id"]
        CUR["vendor"] = Sess("3010", "accounts@fernhollowphoto.example")
        self.assertEqual(client.put(f"/api/direct/w9/uploads/{uid}/chunks/0", content=b"%PDF-1.4").status_code, 404)
        self.assertEqual(client.post(f"/api/direct/w9/uploads/{uid}/complete", json={"sha256": "a" * 64}).status_code, 404)

    def test_too_many_open_uploads_are_refused(self):
        for _ in range(w9.MAX_OPEN_UPLOADS):
            self.assertEqual(client.post("/api/direct/w9/uploads", json={"filename": "w.pdf", "size": 8, "mime": "application/pdf"}).status_code, 200)
        self.assertEqual(client.post("/api/direct/w9/uploads", json={"filename": "w.pdf", "size": 8, "mime": "application/pdf"}).status_code, 429)


class CheckOutcomeTests(unittest.TestCase):
    def setUp(self):
        reset()
        CUR["vendor"] = Sess("3023", "billing@dovetaillaneprinti.example")
        mock.patch("live.publish").start()
        self.addCleanup(mock.patch.stopall)

    def detail(self, uid):
        r = client.get(f"/api/w9/uploads/{uid}")
        self.assertEqual(r.status_code, 200)
        return r.json()

    def test_mismatches_hold_the_upload_for_review(self):
        for name, bad in (("w9_dovetail_lane_printing_name_mismatch.pdf", "legal name"),
                          ("w9_dovetail_lane_printing_tin_mismatch.pdf", "tin")):
            uid, done = upload(sample_bytes(name))
            self.assertEqual(done.status_code, 200)
            d = self.detail(uid)
            self.assertEqual(d["state"], "needs_review")
            self.assertIn(bad, d["reason"])
            self.assertEqual(d["flags"], [])
            self.assertEqual(done.json()["status"], "received")  # the vendor is never told why
            self.assertNotIn("mismatch", done.text.lower())

    def test_a_clean_upload_is_received_and_can_be_verified_once(self):
        uid, _ = upload(sample_bytes("w9_dovetail_lane_printing_ok.pdf"))
        d = self.detail(uid)
        self.assertEqual(d["state"], "received")
        self.assertEqual({f["name"] for f in d["fields"]}, {"Legal name", "Entity type", "Address", "TIN"})
        self.assertTrue(all(f["match"] for f in d["fields"]))
        self.assertEqual(d["sha256"], hashlib.sha256(sample_bytes("w9_dovetail_lane_printing_ok.pdf")).hexdigest())
        v = client.post(f"/api/w9/uploads/{uid}/verify")
        self.assertEqual(v.status_code, 200)
        self.assertEqual(v.json()["verified_by"], "ulla.abernathy@orchestra-mock.example")
        self.assertEqual(v.json()["next_step"], "Update NetSuite vendor record")
        self.assertEqual(self.detail(uid)["state"], "verified")
        self.assertEqual(w9.status_row("3023")["status"], "on_file")
        self.assertEqual(client.post(f"/api/w9/uploads/{uid}/verify").status_code, 409)
        self.assertEqual(client.get("/api/direct/w9").json()["status"], "on_file")

    def test_bank_details_in_an_upload_go_to_the_fraud_path_and_are_never_accepted(self):
        p = Path(_TMP.name) / "bank.pdf"
        r = maker.vendor_record({"internalId": "3023", "isPerson": "F"})
        maker.make_pdf(p, "Dovetail Lane Printing", "", r["entity_type"], r["street"], r["csz"],
                       maker.full_tin(r["tin_last4"], False),
                       extra_lines=["Please change our bank details.", "Routing number 021000021",
                                    "Account number 123456789012"])
        uid, done = upload(p.read_bytes())
        self.assertEqual(done.status_code, 200)
        self.assertEqual(done.json()["status"], "received")
        self.assertNotIn("bank", done.text.lower())
        d = self.detail(uid)
        self.assertEqual((d["state"], d["flags"]), ("needs_review", ["fraud"]))
        self.assertTrue(d["reason"].startswith("fraud"))
        blob = json.dumps(d) + json.dumps(db._one("SELECT * FROM w9_uploads WHERE id=?", (uid,)), default=str)
        for digits in ("021000021", "123456789012"):
            self.assertNotIn(digits, blob)
        self.assertEqual(client.post(f"/api/w9/uploads/{uid}/verify").status_code, 409)
        self.assertNotEqual(w9.status_row("3023")["status"], "on_file")

    def test_a_plain_form_does_not_trip_the_bank_check(self):
        found = w9.extract(SAMPLES / "w9_dovetail_lane_printing_ok.pdf")
        self.assertFalse(found["bank_flag"])

    def test_an_unreadable_pdf_is_held_for_review(self):
        data = b"%PDF-1.4\n" + b"garbage" * 20
        uid, done = upload(data)
        self.assertEqual(done.status_code, 200)
        self.assertEqual(self.detail(uid)["state"], "needs_review")
        self.assertEqual(self.detail(uid)["reason"], "unreadable")


class MaskingTests(unittest.TestCase):
    def test_no_response_and_no_stored_row_holds_more_than_4_tin_digits(self):
        reset()
        CUR["vendor"] = Sess("3023", "billing@dovetaillaneprinti.example")
        bodies = []
        with mock.patch("live.publish") as pub, mock.patch("workflow.create_outbound", return_value=5, create=True):
            for name in ("w9_dovetail_lane_printing_ok.pdf", "w9_dovetail_lane_printing_tin_mismatch.pdf",
                         "w9_dovetail_lane_printing_name_mismatch.pdf"):
                uid, done = upload(sample_bytes(name))
                bodies += [done.text, client.get(f"/api/w9/uploads/{uid}").text]
            bodies += [client.get("/api/direct/w9").text, client.get("/api/direct/me").text, client.get("/api/w9/queue").text,
                       client.get("/api/w9/3023").text, client.get("/api/w9/3002").text, client.post("/api/w9/3023/request").text]
            events = json.dumps(pub.call_args_list, default=str)
        rows = db._all("SELECT * FROM w9_uploads") + db._all("SELECT * FROM w9_status")
        blob = "\n".join(bodies) + events + json.dumps(rows, default=str)
        for t in ALL_TINS:
            self.assertNotIn(t, blob)
        self.assertIsNone(FULL_TIN.search(blob))
        self.assertIn("XXX-XX-9033", blob)
        # even a TIN-like value that reached the helper is cut to its last 4
        out = w9._public_fields([{"name": "TIN", "value_masked": "99-9999033", "record": "123456789", "match": True}])
        self.assertEqual((out[0]["value_masked"], out[0]["record"]), ("XXX-XX-9033", "XXX-XX-6789"))


class StaffTests(unittest.TestCase):
    def setUp(self):
        reset()

    def test_queue_lists_vendors_not_on_file_with_the_bills_they_hold_up(self):
        rows = client.get("/api/w9/queue").json()["rows"]
        by = {r["vendor_id"]: r for r in rows}
        self.assertEqual({r["status"] for r in rows}, {"missing", "expired", "name_mismatch", "tin_mismatch"})
        self.assertEqual(len(rows), 14)
        self.assertNotIn("3001", by)  # on file
        r = by["3023"]
        self.assertEqual((r["vendor"], r["status"]), ("Dovetail Lane Printing", "missing"))
        self.assertTrue(r["bills_held"])
        self.assertEqual(set(r["bills_held"][0]), {"tranId", "amount", "status"})
        paid = {o["ref"] for o in direct._classified("3023") if o["outcome"] in ("paid", "released")}
        self.assertFalse({b["tranId"] for b in r["bills_held"]} & paid)  # only bills that are still unpaid
        counts = [len(x["bills_held"]) for x in rows]
        self.assertEqual(counts, sorted(counts, reverse=True))

    def test_vendor_detail(self):
        d = client.get("/api/w9/3002").json()
        self.assertEqual((d["status"], d["label"], d["vendor"]), ("tin_mismatch", "TIN mismatch", "Tallowridge Media"))
        self.assertRegex(d["on_file"]["tin_masked"], r"^XXX-XX-\d{4}$")
        self.assertEqual(client.get("/api/w9/9999").status_code, 404)
        self.assertEqual(client.get("/api/w9/uploads/nope").status_code, 404)

    def test_request_w9_makes_a_pending_outbound_item_from_records(self):
        with mock.patch("workflow.create_outbound", return_value=41, create=True) as co:
            r = client.post("/api/w9/3023/request")
        self.assertEqual(r.status_code, 200, r.text)
        co.assert_called_once()
        a, kw = co.call_args.args, co.call_args.kwargs
        self.assertEqual(a[0], "w9_request")
        self.assertEqual(a[1], "billing@dovetaillaneprinti.example")
        self.assertIn("Upload it securely in Conductor: Direct", a[3])
        self.assertIn("Dovetail Lane Printing", a[3])
        self.assertEqual(kw["vendor_id"], "3023")
        self.assertEqual(kw["created_by"], "ulla.abernathy@orchestra-mock.example")
        self.assertEqual(r.json()["outbound_id"], 41)
        import egress_guard
        self.assertEqual(egress_guard.check_outbound(a[3], [], [], recipient=a[1]), [])
        self.assertNotRegex(a[3], r"\$|\d{3,}")  # no amounts, dates or numbers
        self.assertIsNotNone(client.get("/api/w9/3023").json()["requested_at"])

    def test_no_request_for_a_vendor_with_a_w9_on_file(self):
        with mock.patch("workflow.create_outbound", create=True) as co:
            self.assertEqual(client.post("/api/w9/3001/request").status_code, 409)
            self.assertEqual(client.post("/api/w9/9999/request").status_code, 404)
        co.assert_not_called()


if __name__ == "__main__":
    unittest.main()
