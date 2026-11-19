"""Open the operating system's own folder chooser on the computer Conductor runs on.

Conductor only listens on 127.0.0.1, so the screen this can draw on is the person's own. A web page cannot do this
itself: browsers hide the real folder path from pages, and a dataset has to be read from disk by the server.

The window is Python's own tkinter folder dialog (the system chooser on Windows, macOS and most Linux desktops), run by
folder_dialog_tk.py in a short-lived process. Nothing else is launched: no shell, no scripts passed on a command line.
If it cannot be shown (no display, no tkinter), or CONDUCTOR_NATIVE_PICKER=0 is set, the app uses its built-in folder
list instead.
"""
import os
import subprocess
import sys
import threading
from pathlib import Path

HELPER = Path(__file__).resolve().parent / "folder_dialog_tk.py"
TIMEOUT_S = 600  # someone can take their time choosing a folder, but not forever


class Unavailable(RuntimeError):
    """No native folder window can be shown here."""


class Busy(RuntimeError):
    """A folder window is already open."""


_lock = threading.Lock()


def enabled():
    return os.environ.get("CONDUCTOR_NATIVE_PICKER", "1").strip().lower() not in ("0", "false", "no", "off")


def _initial_dir(start):
    """Where the window opens: the nearest folder that exists on the way up from what is in the field."""
    if not start:
        return ""
    try:
        p = Path(start).expanduser()
        while True:
            if p.is_dir():
                return str(p)
            if p.parent == p:
                return ""
            p = p.parent
    except (OSError, ValueError):
        return ""


def _run(title, initial):
    env = {**os.environ, "CONDUCTOR_PICK_TITLE": title, "CONDUCTOR_PICK_START": initial, "PYTHONIOENCODING": "utf-8"}
    kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    try:
        done = subprocess.run([sys.executable, str(HELPER)], env=env, capture_output=True, timeout=TIMEOUT_S, **kwargs)
    except subprocess.TimeoutExpired:
        raise Unavailable("The folder window timed out.")
    except OSError as e:
        raise Unavailable(f"The folder window could not start: {e}")
    if done.returncode != 0:
        detail = done.stderr.decode("utf-8", "replace").strip().splitlines()
        raise Unavailable("The folder window could not be shown" + (f": {detail[-1][:160]}" if detail else "."))
    out = done.stdout.decode("utf-8", "replace").strip()
    return os.path.normpath(out) if out else ""


def pick_folder(start="", title="Choose dataset folder"):
    """Show the native folder window and return the chosen path, or "" if the person closed it without choosing.
    Raises Busy if one is already open and Unavailable if no window can be shown on this computer."""
    if not enabled():
        raise Unavailable("The folder window is turned off (CONDUCTOR_NATIVE_PICKER=0).")
    if not _lock.acquire(blocking=False):
        raise Busy("A folder window is already open. Choose a folder in it, or close it first.")
    try:
        return _run(title, _initial_dir(start))
    finally:
        _lock.release()
