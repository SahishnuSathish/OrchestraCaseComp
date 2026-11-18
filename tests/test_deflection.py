"""Self-service lookup, portal logic, notices, digests, report. No Ollama."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "prototype"), str(ROOT)]

import approver_digest  # noqa: E402
import batch_groups  # noqa: E402
import deflection_report  # noqa: E402
import egress_guard  # noqa: E402
import notices as notices_mod  # noqa: E402
import portal_server  # noqa: E402
import rules  # noqa: E402
import status_service  # noqa: E402
from data_layer import FileBackend, Store  # noqa: E402
from draft_check import BANKISH, LONG_NUMBER  # noqa: E402
from trace import NullTrace  # noqa: E402

STORE = Store(FileBackend(ROOT / "data"))
LK = STORE.session(NullTrace())
BILLS = STORE.backend.all("vendorBill")
VENDORS = {v["internalId"]: v for v in STORE.vendors}


def contact(vendor_id):
    return VENDORS[vendor_id]["authorizedContacts"].split(";")[0]


def bill_with(outcome):
    for b in BILLS:
        if VENDORS.get(b["entity"], {}).get("isInactive") == "T":
            continue
        if len(LK.find_bills_by_tranid(b["tranId"])) != 1:
            continue
        if rules.classify_bill(b, LK)["outcome"] == outcome:
            return b
    raise AssertionError(outcome)


class Enumeration(unittest.TestCase):
    def test_same_answer_for_unknown_foreign_and_unauthorized(self):
        b = bill_with("paid")
        other = next(v for v in VENDORS.values() if v["internalId"] != b["entity"] and v.get("isInactive") != "T")
        unknown = status_service.lookup_status(contact(b["entity"]), "INV-00000", STORE)
        foreign = status_service.lookup_status(contact(other["internalId"]), b["tranId"], STORE)
        stranger = status_service.lookup_status("nobody@nowhere.example", b["tranId"], STORE)
        badref = status_service.lookup_status(contact(b["entity"]), "<script>", STORE)
        for r in (unknown, foreign, stranger, badref):
            self.assertEqual((r["ok"], r["message"], r["state"]), (False, status_service.NOT_MATCHED, None))

    def test_own_paid_bill_is_answered_and_only_paid_says_paid_on(self):
        for outcome in ("paid", "released", "scheduled", "approved_no_run", "pending", "returned", "conflict"):
            b = bill_with(outcome)
            r = status_service.lookup_status(contact(b["entity"]), b["tranId"], STORE)
            self.assertTrue(r["ok"], outcome)
            self.assertEqual("paid on" in r["message"], outcome == "paid", (outcome, r["message"]))

    def test_returned_and_conflict_get_the_generic_review_message_without_a_reference(self):
        for outcome in ("returned", "conflict"):
            b = bill_with(outcome)
            r = status_service.lookup_status(contact(b["entity"]), b["tranId"], STORE)
            self.assertEqual(r["message"], status_service.NEEDS_REVIEW)
            self.assertNotIn(b["tranId"], r["message"])

    def test_pending_names_no_date_or_approver(self):
        b = bill_with("pending")
        msg = status_service.lookup_status(contact(b["entity"]), b["tranId"], STORE)["message"]
        self.assertIn("pending internal approval", msg)
        self.assertNotIn("@", msg)

    def test_no_answer_has_bank_like_content(self):
        for b in BILLS[:400]:
            v = VENDORS.get(b["entity"])
            if not v:
                continue
            msg = status_service.lookup_status(contact(b["entity"]), b["tranId"], STORE)["message"]
            scan = msg.replace(b["tranId"], "")
            self.assertFalse(BANKISH.search(scan) or LONG_NUMBER.search(scan), msg)


class Portal(unittest.TestCase):
    def logic(self, now):
        printed = []
        d = tempfile.mkdtemp()
        return portal_server.PortalLogic(STORE, Path(d) / "log.jsonl", now=lambda: now[0], printer=printed.append), printed, Path(d) / "log.jsonl"

    def test_code_flow_and_identical_first_answer(self):
        now = [1000.0]
        lg, printed, log = self.logic(now)
        b = bill_with("scheduled")
        a1 = lg.request_code(contact(b["entity"]), b["tranId"], "1.1.1.1")
        a2 = lg.request_code("stranger@nowhere.example", b["tranId"], "1.1.1.2")
        self.assertEqual(a1["message"], a2["message"])
        self.assertEqual(len(printed), 1)  # only the real contact got a code
        code = printed[0].split(": ")[-1]
        self.assertFalse(lg.check(contact(b["entity"]), b["tranId"], "000000", "1.1.1.1")["ok"])
        res = lg.check(contact(b["entity"]), b["tranId"], code, "1.1.1.1")
        self.assertTrue(res["ok"])
        self.assertIn("payment run", res["message"])
        rec = json.loads(log.read_text().splitlines()[-1])
        self.assertNotIn("payment run", json.dumps(rec))
        self.assertIn("***", rec["email"])

    def test_code_expires_and_rate_limit_applies(self):
        now = [1000.0]
        lg, printed, _ = self.logic(now)
        b = bill_with("paid")
        lg.request_code(contact(b["entity"]), b["tranId"], "9.9.9.9")
        code = printed[0].split(": ")[-1]
        now[0] += portal_server.CODE_TTL + 1
        self.assertFalse(lg.check(contact(b["entity"]), b["tranId"], code, "9.9.9.9")["ok"])
        lg2, _, _ = self.logic([1000.0])
        results = [lg2.request_code("x@y.example", "INV-1", "5.5.5.5")["ok"] for _ in range(portal_server.PER_EMAIL + 1)]
        self.assertEqual(results, [True] * portal_server.PER_EMAIL + [False])

    def test_binds_to_localhost_only(self):
        self.assertEqual(portal_server.HOST, "127.0.0.1")


class Batch(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundles = json.loads((ROOT / "out" / "regex" / "bundles.json").read_text(encoding="utf-8"))
        cls.index = batch_groups.ticket_index(cls.bundles, STORE)

    def test_notices_pass_egress_and_are_drafts(self):
        n = notices_mod.build(STORE)
        self.assertTrue(n["notices"])
        for x in n["notices"]:
            self.assertEqual(x["status"], "draft_pending_approval")
            self.assertEqual(egress_guard.check_outbound(x["text"], [], x["bills"], recipient=x["to"], allow_emails=[]) and
                             [p for p in egress_guard.check_outbound(x["text"], [], x["bills"], recipient=x["to"])
                              if "date" not in p and "paid" not in p], [])
            scan = x["text"]
            for b in x["bills"]:
                scan = scan.replace(b, "")
            self.assertFalse(BANKISH.search(scan) or LONG_NUMBER.search(scan.replace("2026", "")), x["text"][:200])

    def test_notices_skip_vendors_with_returned_or_conflict_bills(self):
        n = notices_mod.build(STORE)
        bad = {b["entity"] for b in BILLS if rules.classify_bill(b, LK)["outcome"] in ("returned", "conflict")}
        self.assertFalse({x["vendor_id"] for x in n["notices"]} & bad)

    def test_digests_group_by_approver_and_pass_the_internal_check(self):
        d = approver_digest.build(self.index, STORE)
        self.assertLessEqual(d["digest_count"], d["pending_notes"])
        for x in d["digests"]:
            self.assertEqual(x["egress_problems"], [])

    def test_report_numbers_are_consistent(self):
        n = notices_mod.build(STORE)
        n["covered_tickets"] = notices_mod.coverage(n["notices"], self.index)
        rep = deflection_report.build(self.index, n, approver_digest.build(self.index, STORE), batch_groups.build(self.index))
        self.assertLessEqual(rep["self_servable"]["count"], rep["tickets"])
        self.assertEqual(sum(rep["self_servable"]["by_rule"].values()), rep["self_servable"]["count"])
        self.assertIn("estimate", deflection_report.to_markdown(rep).lower())


class Guard(unittest.TestCase):
    def test_outbound_rejects_foreign_emails_bank_words_and_links(self):
        self.assertTrue(egress_guard.check_outbound("Write to bob@evil.example", recipient="a@b.example"))
        self.assertTrue(egress_guard.check_outbound("Our routing number changed"))
        self.assertTrue(egress_guard.check_outbound("See https://x.example"))
        self.assertFalse(egress_guard.check_outbound("Hello, thanks for checking in.", recipient="a@b.example"))

    def test_internal_check_and_mask(self):
        self.assertTrue(egress_guard.check_internal("account number 12345678901"))
        self.assertFalse(egress_guard.check_internal("bill 2026-27681", ["2026-27681"]))
        self.assertEqual(egress_guard.mask_email("zane@vendor.example"), "z***@vendor.example")


def money(b, value=None):
    return f"{b['currency']} {float(b['userTotal'] if value is None else value):,.2f}"


class BalanceTests(unittest.TestCase):
    """Exec Q&A: vendors may see the balance and last status of their own invoice, nothing internal."""

    def answer(self, outcome):
        b = bill_with(outcome)
        return b, status_service.lookup_status(contact(b["entity"]), b["tranId"], STORE)

    def test_paid_invoice_shows_amount_and_zero_balance(self):
        b, r = self.answer("paid")
        self.assertIn(f"Invoice amount: {money(b)}.", r["message"])
        self.assertIn(f"Open balance: {money(b, 0)}.", r["message"])

    def test_released_invoice_has_zero_open_balance(self):
        b, r = self.answer("released")
        self.assertIn(f"Open balance: {money(b, 0)}.", r["message"])

    def test_pending_invoice_shows_full_open_balance_and_no_approver(self):
        b, r = self.answer("pending")
        self.assertIn(f"Open balance: {money(b)}.", r["message"])
        if b.get("nextApprover"):
            self.assertNotIn(b["nextApprover"], r["message"])

    def test_review_outcomes_get_no_amount(self):
        for outcome in ("returned", "conflict"):
            b, r = self.answer(outcome)
            self.assertEqual(r["message"], status_service.NEEDS_REVIEW, outcome)
            self.assertIsNone(status_service.AMOUNT.search(r["message"]), outcome)

    def test_every_amount_in_an_answer_is_the_bills_own(self):
        for outcome in ("paid", "released", "scheduled", "approved_no_run", "pending"):
            b, r = self.answer(outcome)
            amts = set(status_service.AMOUNT.findall(r["message"]))
            self.assertTrue(amts, outcome)
            self.assertLessEqual(amts, {money(b), money(b, 0)}, outcome)

    def test_portal_does_not_share_conductors_port(self):
        self.assertNotEqual(portal_server.PORT, 8790)


if __name__ == "__main__":
    unittest.main()
