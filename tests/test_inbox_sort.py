"""Inbox sort rules (dashboards/conductor/sortfacts.py): amount, due date, urgency tier, destination.

Run from the repo root:  python -m unittest discover -s tests -p "test_inbox_sort.py" -v
Pure functions: no database, no model.
"""
import datetime as dt
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "dashboards" / "conductor"))

import sortfacts  # noqa: E402

TODAY = dt.date(2026, 11, 13)


def tier(**kw):
    base = dict(flags=[], intent=None, category=None, wf_state="open", priority=False, finished=False, due_date=None, today=TODAY)
    base.update(kw)
    return sortfacts.urgency_tier(**base)


def dest(**kw):
    base = dict(finished=False, forwarded=None, wf_state="open", priority=False, waiting_approver=False, act_by=None, rule=None,
                output_type="draft_reply")
    base.update(kw)
    return sortfacts.destination_of(**base)


class InvoiceFactsCase(unittest.TestCase):
    def test_invoice_facts_sums_and_takes_earliest_unpaid_due(self):
        bills = [{"userTotal": "100.50", "dueDate": "2026-11-20", "status": "Open"},
                 {"userTotal": "200", "dueDate": "2026-11-15", "status": "Open"}]
        self.assertEqual(sortfacts.invoice_facts(bills), {"amount": 300.5, "currency": "USD", "due_date": "2026-11-15"})

    def test_paid_invoice_has_no_due_date_but_keeps_amount(self):
        f = sortfacts.invoice_facts([{"userTotal": "50", "dueDate": "2026-10-01", "status": "Paid In Full"}])
        self.assertIsNone(f["due_date"])
        self.assertEqual(f["amount"], 50.0)

    def test_no_bills_gives_none(self):
        self.assertEqual(sortfacts.invoice_facts([]), {"amount": None, "currency": None, "due_date": None})

    def test_unparseable_total_is_skipped(self):
        f = sortfacts.invoice_facts([{"userTotal": "n/a", "dueDate": "2026-11-20", "status": "Open"},
                                     {"userTotal": "10", "dueDate": "2026-11-21", "status": "Open"}])
        self.assertEqual(f["amount"], 10.0)


class PickBillsCase(unittest.TestCase):
    def test_pick_bills_prefers_company_on_ambiguity(self):
        a = {"internalId": "1", "entityName": "A"}
        b = {"internalId": "2", "entityName": "B"}
        find = lambda ref: [a, b]  # noqa: E731
        self.assertEqual(sortfacts.pick_bills(find, ["INV-1"], "B"), [b])
        self.assertEqual(sortfacts.pick_bills(find, ["INV-1"], None), [])
        only = {"internalId": "3", "entityName": "C"}
        self.assertEqual(sortfacts.pick_bills(lambda ref: [only], ["INV-2"], "Z"), [only])

    def test_pick_bills_does_not_double_count(self):
        a = {"internalId": "1", "entityName": "A"}
        self.assertEqual(sortfacts.pick_bills(lambda ref: [a], ["INV-1", "INV-1B"], "A"), [a])


class UrgencyCase(unittest.TestCase):
    def test_urgency_tiers(self):
        self.assertEqual(tier(flags=["fraud"], finished=True), 1)
        self.assertEqual(tier(intent="not_received"), 2)
        self.assertEqual(tier(due_date="2026-11-16"), 2)
        self.assertEqual(tier(due_date="2026-11-17"), 4)
        self.assertEqual(tier(wf_state="escalated"), 3)
        self.assertEqual(tier(finished=True), 5)
        self.assertEqual(tier(), 4)

    def test_overdue_unpaid_is_time_sensitive(self):
        self.assertEqual(tier(due_date="2026-11-01"), 2)

    def test_category_and_priority(self):
        self.assertEqual(tier(category="early_or_late_fee"), 2)
        self.assertEqual(tier(priority=True), 3)


class DestinationCase(unittest.TestCase):
    def test_destination_order_and_names(self):
        self.assertEqual(dest(forwarded="AR queue", finished=True), ("forwarded", "AR queue"))
        self.assertEqual(dest(finished=True), ("closed", None))
        self.assertEqual(dest(wf_state="escalated"), ("cfo", "Elena Lockhart"))
        self.assertEqual(dest(priority=True), ("cfo", "Elena Lockhart"))
        self.assertEqual(dest(priority=True, wf_state="signed_off"), ("vendor", None))
        self.assertEqual(dest(waiting_approver=True, act_by="a@b.example"), ("approver", "a@b.example"))
        self.assertEqual(dest(rule="scheduled_run"), ("payment_run", None))
        self.assertEqual(dest(rule="approved_no_run"), ("payment_run", None))
        self.assertEqual(dest(), ("vendor", None))
        self.assertEqual(dest(output_type="internal_action_note"), ("desk", None))


if __name__ == "__main__":
    unittest.main()
