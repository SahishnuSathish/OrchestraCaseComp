"""Folder paths a person pastes into Conductor: Explorer's "Copy as path" quotes, file:// addresses, stray spaces."""
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "dashboards" / "conductor"))

import runner  # noqa: E402

DATA = HERE.parent / "data"


class CleanPathTests(unittest.TestCase):
    def test_plain_path_is_unchanged(self):
        self.assertEqual(runner.clean_path(r"C:\Users\me\data"), r"C:\Users\me\data")

    def test_quotes_from_copy_as_path_are_removed(self):
        self.assertEqual(runner.clean_path('"C:\\Users\\me\\data"'), r"C:\Users\me\data")
        self.assertEqual(runner.clean_path("'/home/me/data'"), "/home/me/data")
        self.assertEqual(runner.clean_path("\u201cC:\\Users\\me\\data\u201d"), r"C:\Users\me\data")

    def test_whitespace_and_nested_quotes(self):
        self.assertEqual(runner.clean_path('  "  C:\\data  "  \n'), "C:\\data")

    def test_mismatched_quote_is_left_alone(self):
        self.assertEqual(runner.clean_path('"C:\\data'), '"C:\\data')

    def test_file_urls(self):
        self.assertEqual(runner.clean_path("file:///C:/Users/me/My%20Data"), "C:/Users/me/My Data")
        self.assertEqual(runner.clean_path("file:///home/me/data"), "/home/me/data")
        self.assertEqual(runner.clean_path("file://server/share/data"), "\\\\server\\share\\data")

    def test_empty_values(self):
        self.assertEqual(runner.clean_path(None), "")
        self.assertEqual(runner.clean_path("   "), "")


@unittest.skipUnless((DATA / "tickets.json").is_file(), "practice dataset not present")
class ValidatePastedPathTests(unittest.TestCase):
    def test_quoted_and_url_forms_validate_like_the_plain_path(self):
        plain = runner.validate_dataset(str(DATA))
        self.assertTrue(plain["ok"])
        for pasted in (f'"{DATA}"', f"'{DATA}'", f"  {DATA}  ", DATA.as_uri()):
            with self.subTest(pasted=pasted):
                v = runner.validate_dataset(pasted)
                self.assertTrue(v["ok"], v.get("error"))
                self.assertEqual(Path(v["path"]), Path(plain["path"]))

    def test_empty_path_is_not_the_current_folder(self):
        v = runner.validate_dataset("")
        self.assertFalse(v["ok"])
        self.assertFalse(v["exists"])


if __name__ == "__main__":
    unittest.main()
