"""Documents (dashboards/conductor/documents.py): invoice copy and remittance advice from records, HTML and PDF.

Run from the repo root:  python -m unittest discover -s tests -p "test_documents.py" -v
"""
import io
import re
import sys
import tempfile
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

import documents  # noqa: E402
import server  # noqa: E402
import signin  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pypdf import PdfReader  # noqa: E402

# Account and routing numbers as they might appear on a payment record (fictional).
ACCOUNT, ROUTING = "123456789012", "021000021"


def pdf_text(data):
    return "\n".join(p.extract_text() for p in PdfReader(io.BytesIO(data)).pages)


def long_digit_runs(text, n=9):
    return re.findall(rf"\d{{{n},}}", text)


class MaskingTests(unittest.TestCase):
    def setUp(self):
        self._load = documents._load
        real = self._load("50000")
        pay = dict(real["payment"], bankAccount=ACCOUNT, routingNumber=ROUTING)
        documents._load = lambda bill_id: dict(real, payment=pay)

    def tearDown(self):
        documents._load = self._load

    def test_mask_helper(self):
        self.assertEqual(documents.mask_account(ACCOUNT), "••••9012")
        self.assertEqual(documents.mask_account("12"), "••••")
        self.assertEqual(documents.mask_account(None), "••••")

    def test_no_full_account_or_routing_number_in_html_or_pdf(self):
        for kind in ("remittance", "invoice"):
            html = documents.render(kind, "50000", "html")[0].decode("utf-8")
            pdf = pdf_text(documents.render(kind, "50000", "pdf")[0])
            for name, text in (("html", html), ("pdf", pdf)):
                self.assertNotIn(ACCOUNT, text, f"{kind} {name}")
                self.assertNotIn(ROUTING, text, f"{kind} {name}")
                self.assertEqual(long_digit_runs(text), [], f"{kind} {name}: a long number appeared")
        self.assertIn("••••9012", documents.render("remittance", "50000", "html")[0].decode("utf-8"))
        self.assertRegex(pdf_text(documents.render("remittance", "50000", "pdf")[0]), r"Paid to bank account\n.{4}9012")

    def test_documents_carry_nothing_internal(self):
        html = documents.render("invoice", "50000", "html")[0].decode("utf-8").lower()
        for word in ("approver", "nextapprover", "approval", "failure"):
            self.assertNotIn(word, html)


class RemittanceRulesTests(unittest.TestCase):
    def test_no_account_on_record_says_bank_account_on_file(self):
        html = documents.render("remittance", "50000", "html")[0].decode("utf-8")
        pdf = pdf_text(documents.render("remittance", "50000", "pdf")[0])
        for text in (html, pdf):
            self.assertRegex(text, r"Paid by \w+ to the bank account on file")
            self.assertNotIn("last 4", text)
            self.assertNotIn("****", text)
            self.assertNotIn("masked", text)

    def test_remittance_for_settled_and_released(self):
        data, mime, name = documents.render("remittance", "50000", "pdf")  # Settled
        self.assertEqual(mime, "application/pdf")
        self.assertTrue(data.startswith(b"%PDF"))
        self.assertTrue(name.startswith("Remittance-") and name.endswith(".pdf"))
        released = next(r for r in documents._backend().tables["vendorPayment"] if r["custbody_release_status"] == "Released")
        html = documents.render("remittance", released["appliedBills"].split(";")[0], "html")[0].decode("utf-8")
        self.assertIn("Released on", html)

    def test_remittance_refused_for_returned_payment_and_never_shows_its_reference(self):
        returned = next(r for r in documents._backend().tables["vendorPayment"] if r["custbody_release_status"] == "Returned")
        bill = returned["appliedBills"].split(";")[0]
        with self.assertRaises(documents.NotAvailable):
            documents.render("remittance", bill, "html")
        with self.assertRaises(documents.NotAvailable):
            documents.render("remittance", bill, "pdf")
        # the invoice copy for the same bill does not carry the returned payment's reference either
        for fmt in ("html", "pdf"):
            data = documents.render("invoice", bill, fmt)[0]
            text = data.decode("utf-8") if fmt == "html" else pdf_text(data)
            self.assertNotIn(returned["referenceNumber"], text)
            self.assertNotIn(returned["tranId"], text)

    def test_remittance_refused_when_there_is_no_payment(self):
        b = documents._backend()
        paid = {bid for p in b.tables["vendorPayment"] for bid in p["appliedBills"].split(";")}
        unpaid = next(r for r in b.tables["vendorBill"] if r["internalId"] not in paid)
        with self.assertRaises(documents.NotAvailable) as cm:
            documents.render("remittance", unpaid["internalId"], "pdf")
        self.assertEqual(cm.exception.code, "unavailable")
        self.assertIn("Invoice copy", documents.render("invoice", unpaid["internalId"], "html")[0].decode("utf-8"))

    def test_unknown_bill_kind_and_format(self):
        for args in (("invoice", "99999999", "html"), ("receipt", "50000", "html"), ("invoice", "50000", "docx")):
            with self.assertRaises(documents.NotAvailable):
                documents.render(*args)


class DocumentRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(server.app, base_url="http://localhost")
        cls.h = signin.headers()

    def test_document_route_sets_frame_self_and_marker_is_removed(self):
        for ext, mime in (("html", "text/html"), ("pdf", "application/pdf")):
            r = self.c.get(f"/api/documents/invoice/50000.{ext}", headers=self.h)
            self.assertEqual(r.status_code, 200)
            self.assertTrue(r.headers["content-type"].startswith(mime))
            self.assertIn("frame-ancestors 'self'", r.headers["content-security-policy"])
            self.assertNotIn("x-conductor-frame", r.headers)
            self.assertIn("img-src 'self' data: blob:", r.headers["content-security-policy"])
        self.assertTrue(self.c.get("/api/documents/remittance/50000.pdf", headers=self.h).content.startswith(b"%PDF"))

    def test_other_routes_keep_frame_ancestors_none(self):
        for path in ("/api/health", "/api/inbox/summary"):
            r = self.c.get(path, headers=self.h)
            self.assertIn("frame-ancestors 'none'", r.headers["content-security-policy"], path)
        self.assertIn("frame-ancestors 'none'", self.c.get("/").headers["content-security-policy"])

    def test_missing_and_unavailable_documents(self):
        self.assertEqual(self.c.get("/api/documents/invoice/99999999.pdf", headers=self.h).status_code, 404)
        self.assertEqual(self.c.get("/api/documents/receipt/50000.pdf", headers=self.h).status_code, 404)
        returned = next(r for r in documents._backend().tables["vendorPayment"] if r["custbody_release_status"] == "Returned")
        r = self.c.get(f"/api/documents/remittance/{returned['appliedBills'].split(';')[0]}.pdf", headers=self.h)
        self.assertEqual(r.status_code, 409)
        self.assertNotIn("frame-ancestors 'self'", r.headers["content-security-policy"])
        self.assertEqual(self.c.get("/api/documents/invoice/50000.pdf").status_code, 401)  # no token


class W9RequestTests(unittest.TestCase):
    def test_w9_request_asks_for_the_form_and_never_for_bank_details(self):
        html = documents.render("w9_request", "50000", "html")[0].decode("utf-8")
        self.assertIn("Form W-9", html)
        self.assertIn("Never send bank account details", html)
        self.assertNotIn("Mock Agency", html)
        data, mime, name = documents.render("w9_request", "50000", "pdf")
        self.assertEqual(mime, "application/pdf")
        self.assertTrue(name.startswith("W-9-request-"))


if __name__ == "__main__":
    unittest.main()
