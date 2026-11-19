"""Helper process for native_dialog.py: show Tk's folder window and print the chosen path as UTF-8 (nothing if the person
closed it without choosing). Python's own tkinter, no other tools. Not imported by the app; it runs as its own process
because Tk wants the main thread of its process, and a request handler is not that.

    python folder_dialog_tk.py        # title and start folder come from CONDUCTOR_PICK_TITLE / CONDUCTOR_PICK_START
"""
import os
import sys


def choose(title, initial):
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)  # so the window opens in front of the browser
    except tk.TclError:
        pass
    try:
        return filedialog.askdirectory(parent=root, title=title or "Choose a folder", initialdir=initial or None, mustexist=True) or ""
    finally:
        root.destroy()


def main():
    chosen = choose(os.environ.get("CONDUCTOR_PICK_TITLE", ""), os.environ.get("CONDUCTOR_PICK_START", ""))
    sys.stdout.buffer.write(chosen.encode("utf-8"))


if __name__ == "__main__":
    main()
