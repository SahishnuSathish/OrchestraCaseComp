"""FileBackend indexes must return exactly what a full scan returns (same rows, same order)."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "prototype"), str(ROOT)]

from data_layer import FileBackend  # noqa: E402

B = FileBackend(ROOT / "data")


def scan(table, **f):
    return [r for r in B.tables[table] if all(r.get(k) == v for k, v in f.items())]


class IndexTests(unittest.TestCase):
    def test_single_key_queries_match_a_full_scan(self):
        for table, key in (("vendorBill", "tranId"), ("vendorBill", "entity"), ("vendorPayment", "appliedBills"),
                           ("paymentRun", "bill_internal_id"), ("vendor", "internalId")):
            values = {r.get(key) for r in B.tables[table]} | {"no-such-value"}
            for v in list(values)[:400]:
                self.assertEqual(B.query(table, **{key: v}), scan(table, **{key: v}), (table, key, v))

    def test_multi_key_query_still_scans(self):
        b = B.tables["vendorBill"][0]
        self.assertEqual(B.query("vendorBill", tranId=b["tranId"], entity=b["entity"]),
                         scan("vendorBill", tranId=b["tranId"], entity=b["entity"]))

    def test_payments_applying_matches_the_split_scan(self):
        bills = {b for p in B.tables["vendorPayment"] for b in p["appliedBills"].split(";")} | {"999999"}
        for bid in bills:
            expect = [p for p in B.tables["vendorPayment"] if bid in p["appliedBills"].split(";")]
            self.assertEqual(B.payments_applying(bid), expect, bid)

    def test_results_are_copies_of_the_index_list(self):
        v = B.tables["vendorBill"][0]["tranId"]
        B.query("vendorBill", tranId=v).append({"junk": 1})
        self.assertEqual(B.query("vendorBill", tranId=v), scan("vendorBill", tranId=v))


if __name__ == "__main__":
    unittest.main()
