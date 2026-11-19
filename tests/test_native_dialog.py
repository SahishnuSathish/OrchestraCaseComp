"""The native folder window: helper behaviour with the operating system mocked out, and the /api/fs/pick endpoint.
No real window is ever opened here: a test must not pop a dialog on someone's screen (Tk and subprocess are mocked)."""
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "dashboards" / "conductor"))

from starlette.testclient import TestClient  # noqa: E402

import folder_dialog_tk  # noqa: E402
import native_dialog  # noqa: E402
import server  # noqa: E402
import signin  # noqa: E402  (Phase 3: token + a signed-in session)


class HelperTests(unittest.TestCase):
    def setUp(self):
        # whatever the machine running the tests has set, these tests decide for themselves
        env = mock.patch.dict(os.environ, {"CONDUCTOR_NATIVE_PICKER": "1"})
        env.start()
        self.addCleanup(env.stop)

    def test_can_be_turned_off(self):
        with mock.patch.dict(os.environ, {"CONDUCTOR_NATIVE_PICKER": "0"}):
            self.assertFalse(native_dialog.enabled())
            with mock.patch("subprocess.run") as run:
                with self.assertRaises(native_dialog.Unavailable):
                    native_dialog.pick_folder("")
                run.assert_not_called()
        self.assertTrue(native_dialog.enabled())

    def test_window_opens_at_the_nearest_existing_folder(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(native_dialog._initial_dir(d), d)
            self.assertEqual(native_dialog._initial_dir(os.path.join(d, "typo", "deeper")), d)
        self.assertEqual(native_dialog._initial_dir(""), "")

    def test_a_second_window_is_refused_while_one_is_open(self):
        self.assertTrue(native_dialog._lock.acquire(blocking=False))
        try:
            with mock.patch("subprocess.run") as run:
                with self.assertRaises(native_dialog.Busy):
                    native_dialog.pick_folder("")
                run.assert_not_called()
        finally:
            native_dialog._lock.release()
        self.assertTrue(native_dialog._lock.acquire(blocking=False), "the lock must be free again")
        native_dialog._lock.release()

    def test_only_the_helper_script_is_launched(self):
        """Nothing is passed on a command line except the path of our own helper file."""
        ok = subprocess.CompletedProcess([], 0, stdout=b"", stderr=b"")
        with mock.patch("subprocess.run", return_value=ok) as run:
            native_dialog.pick_folder("")
        cmd = run.call_args.args[0]
        self.assertEqual(cmd, [sys.executable, str(native_dialog.HELPER)])
        self.assertTrue(Path(cmd[1]).is_file())
        env = run.call_args.kwargs["env"]
        self.assertEqual(env["CONDUCTOR_PICK_TITLE"], "Choose dataset folder")

    def test_chosen_path_is_returned_and_cancel_is_empty(self):
        ok = subprocess.CompletedProcess([], 0, stdout="C:/Users/me/data\n".encode(), stderr=b"")
        with mock.patch("subprocess.run", return_value=ok):
            self.assertEqual(native_dialog._run("t", ""), os.path.normpath("C:/Users/me/data"))
        cancelled = subprocess.CompletedProcess([], 0, stdout=b"", stderr=b"")
        with mock.patch("subprocess.run", return_value=cancelled):
            self.assertEqual(native_dialog._run("t", ""), "")

    def test_non_ascii_paths_survive(self):
        ok = subprocess.CompletedProcess([], 0, stdout="/home/zo\u00eb/donn\u00e9es".encode("utf-8"), stderr=b"")
        with mock.patch("subprocess.run", return_value=ok):
            self.assertIn("donn\u00e9es", native_dialog._run("t", ""))

    def test_failures_become_unavailable(self):
        bad = subprocess.CompletedProcess([], 1, stdout=b"", stderr=b"_tkinter.TclError: no display name and no $DISPLAY")
        with mock.patch("subprocess.run", return_value=bad):
            with self.assertRaises(native_dialog.Unavailable) as cm:
                native_dialog._run("t", "")
        self.assertIn("no display", str(cm.exception))
        with mock.patch("subprocess.run", side_effect=FileNotFoundError("python")):
            with self.assertRaises(native_dialog.Unavailable):
                native_dialog._run("t", "")
        with mock.patch("subprocess.run", side_effect=subprocess.TimeoutExpired("x", 1)):
            with self.assertRaises(native_dialog.Unavailable):
                native_dialog._run("t", "")


class RealProcessWithStubTkTests(unittest.TestCase):
    """Runs the real helper script in a real child process, but with a fake `tkinter` first on its path, so the
    spawning, environment hand-over and UTF-8 output are exercised without any window appearing."""

    def run_with_stub(self, answer):
        with tempfile.TemporaryDirectory() as d:
            pkg = Path(d) / "tkinter"
            pkg.mkdir()
            (pkg / "__init__.py").write_text(
                "class TclError(Exception): pass\n"
                "class Tk:\n"
                "    def withdraw(self): pass\n"
                "    def attributes(self, *a): pass\n"
                "    def destroy(self): pass\n", encoding="utf-8")
            (pkg / "filedialog.py").write_text(
                "import os\n"
                "def askdirectory(**kw):\n"
                "    assert kw['mustexist'] is True\n"
                "    return os.environ['STUB_ANSWER'].replace('{title}', kw['title']).replace('{start}', str(kw['initialdir']))\n", encoding="utf-8")
            env = {"PYTHONPATH": d, "STUB_ANSWER": answer, "CONDUCTOR_NATIVE_PICKER": "1"}
            with mock.patch.dict(os.environ, env):
                return native_dialog._run("Pick {x}", "C:/start")

    def test_path_comes_back_through_a_real_process(self):
        self.assertEqual(self.run_with_stub("C:/picked/{start}"), os.path.normpath("C:/picked/C:/start"))

    def test_unicode_and_cancel(self):
        self.assertIn("donn\u00e9es", self.run_with_stub("/home/zo\u00eb/donn\u00e9es"))
        self.assertEqual(self.run_with_stub(""), "")


class TkHelperTests(unittest.TestCase):
    """folder_dialog_tk with tkinter replaced by mocks, so no window can appear."""

    def setUp(self):
        import tkinter
        from tkinter import filedialog
        self.root = mock.MagicMock()
        for target, new in (("Tk", mock.MagicMock(return_value=self.root)), ):
            p = mock.patch.object(tkinter, target, new)
            p.start()
            self.addCleanup(p.stop)
        self.ask = mock.MagicMock(return_value="C:/picked/folder")
        p = mock.patch.object(filedialog, "askdirectory", self.ask)
        p.start()
        self.addCleanup(p.stop)

    def test_window_is_hidden_root_in_front_and_closed_afterwards(self):
        self.assertEqual(folder_dialog_tk.choose("Pick me", "C:/start"), "C:/picked/folder")
        self.root.withdraw.assert_called_once()
        self.root.attributes.assert_called_with("-topmost", True)
        self.ask.assert_called_once_with(parent=self.root, title="Pick me", initialdir="C:/start", mustexist=True)
        self.root.destroy.assert_called_once()

    def test_cancel_returns_empty_and_no_start_folder_is_none(self):
        self.ask.return_value = ""
        self.assertEqual(folder_dialog_tk.choose("", ""), "")
        self.assertEqual(self.ask.call_args.kwargs["initialdir"], None)
        self.assertEqual(self.ask.call_args.kwargs["title"], "Choose a folder")

    def test_root_is_destroyed_even_if_the_dialog_fails(self):
        self.ask.side_effect = RuntimeError("boom")
        with self.assertRaises(RuntimeError):
            folder_dialog_tk.choose("t", "")
        self.root.destroy.assert_called_once()

    def test_main_prints_the_path_as_utf8(self):
        self.ask.return_value = "/home/zo\u00eb/donn\u00e9es"
        out = io.BytesIO()
        fake = mock.MagicMock()
        fake.buffer = out
        with mock.patch.object(sys, "stdout", fake), mock.patch.dict(os.environ, {"CONDUCTOR_PICK_TITLE": "t", "CONDUCTOR_PICK_START": ""}):
            folder_dialog_tk.main()
        self.assertEqual(out.getvalue().decode("utf-8"), "/home/zo\u00eb/donn\u00e9es")


class EndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(server.app, base_url="http://localhost")
        cls.h = signin.headers()

    def post(self, start=""):
        return self.c.post("/api/fs/pick", json={"start": start}, headers=self.h)

    def test_requires_the_token(self):
        self.assertEqual(self.c.post("/api/fs/pick", json={}).status_code, 401)

    def test_returns_the_chosen_folder(self):
        with mock.patch.object(native_dialog, "pick_folder", return_value="C:\\data") as pick:
            r = self.post('"C:\\somewhere"')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"path": "C:\\data", "cancelled": False})
        pick.assert_called_once_with("C:\\somewhere")  # the pasted quotes are tidied before it opens there

    def test_closing_the_window_is_a_cancel_not_an_error(self):
        with mock.patch.object(native_dialog, "pick_folder", return_value=""):
            r = self.post()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"path": "", "cancelled": True})

    def test_unavailable_is_501_and_busy_is_409(self):
        with mock.patch.object(native_dialog, "pick_folder", side_effect=native_dialog.Unavailable("no window here")):
            r = self.post()
        self.assertEqual((r.status_code, r.json()["detail"]), (501, "no window here"))
        with mock.patch.object(native_dialog, "pick_folder", side_effect=native_dialog.Busy("already open")):
            r = self.post()
        self.assertEqual((r.status_code, r.json()["detail"]), (409, "already open"))


if __name__ == "__main__":
    unittest.main()
