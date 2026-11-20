"""display.py: record values shown on screen read as Orchestra's own entities; records are untouched."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dashboards" / "conductor"))

import display  # noqa: E402


class SubsidiaryTests(unittest.TestCase):
    def test_paying_entities_read_as_orchestra(self):
        self.assertEqual(display.subsidiary("Mock Agency Studio Inc"), "Orchestra Studio Inc")
        self.assertEqual(display.subsidiary("Mock Agency East LLC"), "Orchestra East LLC")

    def test_other_values_are_unchanged(self):
        for v in ("Orchestra West LLC", "", None, "Agency Mock Inc"):
            self.assertEqual(display.subsidiary(v), v)


if __name__ == "__main__":
    unittest.main()
