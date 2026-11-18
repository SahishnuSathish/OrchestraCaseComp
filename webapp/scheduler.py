"""Scheduled send of approved replies (seam: feature B fills this in).

The router is mounted by server.py behind the per-launch token. init_schema() is called from db.init().
server.main() calls start(emit=...) before uvicorn runs. server._apply_review() calls on_review_change() after
every saved decision, and server._reply_for_edit() refuses an edit while edit_block_reason() returns a reason.
"""
from fastapi import APIRouter

router = APIRouter()


def init_schema():
    pass


def start(emit=None):
    """Start the background sender. `emit(run_id, kind, data)` pushes a live event to open browsers."""
    pass


def on_review_change(run_id, ticket_id, state):
    """Called after a review decision is saved (approve, return, reopen, close)."""
    pass


def edit_block_reason(run_id, ticket_id):
    """A reason the draft may not be edited right now, or None."""
    return None
