"""Scheduled send of approved replies.

A person approves a reply, then picks a time. A background thread sends it when the time comes. Before every send
the same checks run again (delivery.prepare), plus a hash of recipient, subject and body taken when it was scheduled.
If anything changed, the row is cancelled or failed and nothing is sent. Times are stored in UTC.

The router is mounted by server.py behind the per-launch token. init_schema() is called from db.init().
server.main() calls start(emit=...). server._apply_review() calls on_review_change(), and server._reply_for_edit()
refuses an edit while edit_block_reason() returns a reason. This module never imports server.py.
"""
import datetime as dt
import threading
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import db
import delivery
import mailer

router = APIRouter()

POLL_SECONDS = 15
MIN_AHEAD = 60                      # send_at must be at least 1 minute ahead
MAX_AHEAD = 30 * 24 * 3600          # and at most 30 days ahead
GRACE = 24 * 3600                   # a row more than 24 h overdue is "missed", never sent silently
MAX_RETRIES = 3
BACKOFF = (30, 120, 480)            # seconds before retry 1, 2, 3
STATUSES = ("scheduled", "sent", "cancelled", "failed", "missed")

_clock = time.time
_emit = None
_thread = None
_stop = threading.Event()


def set_clock(fn=None):
    """Replace the clock (seconds since the epoch). Tests use this; None restores the real one."""
    global _clock
    _clock = fn or time.time


def _now():
    return float(_clock())


def init_schema():
    db._exec(
        "CREATE TABLE IF NOT EXISTS scheduled_send ("
        " run_id TEXT, ticket_id INTEGER, send_at TEXT, status TEXT, attempts INTEGER DEFAULT 0, last_error TEXT,"
        " approved_hash TEXT, created_at TEXT, next_attempt_at REAL,"
        " PRIMARY KEY (run_id, ticket_id))")


# ------------------------------------------------------------------ time
def to_iso(epoch):
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(text):
    """An ISO 8601 time with a zone (Z or +hh:mm) as epoch seconds. Raises ValueError otherwise."""
    s = (text or "").strip()
    if s.endswith(("Z", "z")):
        s = s[:-1] + "+00:00"
    d = dt.datetime.fromisoformat(s)
    if d.tzinfo is None:
        raise ValueError("send_at needs a time zone")
    return d.timestamp()


# ------------------------------------------------------------------ rows
def _row(run_id, ticket_id):
    return db._one("SELECT * FROM scheduled_send WHERE run_id=? AND ticket_id=?", (run_id, ticket_id))


def _set(run_id, ticket_id, status, error=None, **extra):
    cols = {"status": status, "last_error": error, **extra}
    sets = ", ".join(f"{k}=?" for k in cols)
    db._exec(f"UPDATE scheduled_send SET {sets} WHERE run_id=? AND ticket_id=?", (*cols.values(), run_id, ticket_id))


def _public(r):
    if not r:
        return None
    return {"status": r["status"], "send_at": r["send_at"], "attempts": r["attempts"], "last_error": r["last_error"]}


def _cancel_active(run_id, ticket_id, reason):
    r = _row(run_id, ticket_id)
    if r and r["status"] == "scheduled":
        _set(run_id, ticket_id, "cancelled", reason)
        return True
    return False


# ------------------------------------------------------------------ hooks used by server.py and delivery.py
def on_review_change(run_id, ticket_id, state):
    """Called after a review decision is saved. Any new decision ends an active schedule."""
    reasons = {"pending": "The reply was reopened.", "returned": "The reply was returned.",
               "approved": "The reply was approved again."}
    _cancel_active(run_id, ticket_id, reasons.get(state, "The review changed."))


def on_sent(run_id, ticket_id):
    _cancel_active(run_id, ticket_id, "The reply was sent manually.")


def edit_block_reason(run_id, ticket_id):
    r = _row(run_id, ticket_id)
    if r and r["status"] == "scheduled":
        return "This reply is scheduled to send. Cancel the schedule to edit it."
    return None


# ------------------------------------------------------------------ sending
def tick(now=None):
    """Handle every due row once. Returns the number of replies sent. Called by the thread and by tests."""
    now = _now() if now is None else float(now)
    sent = 0
    for r in db._all("SELECT * FROM scheduled_send WHERE status='scheduled'"):
        try:
            due = parse_iso(r["send_at"])
        except ValueError:
            _set(r["run_id"], r["ticket_id"], "failed", "The saved time is not valid.")
            continue
        if due > now:
            continue
        if r["attempts"] == 0 and now - due > GRACE:
            _set(r["run_id"], r["ticket_id"], "missed",
                 "The server was not running at the scheduled time. Schedule it again.")
            continue
        if r["next_attempt_at"] and r["next_attempt_at"] > now:
            continue
        sent += _send_one(r, now)
    return sent


def _send_one(r, now):
    run_id, tid = r["run_id"], r["ticket_id"]
    try:
        delivery.deliver_reply(run_id, tid, expect_hash=r["approved_hash"])
    except delivery.DeliveryError as e:
        if e.status == 502:  # mail server trouble: retry with backoff, then give up
            attempts = r["attempts"] + 1
            if attempts > MAX_RETRIES:
                _set(run_id, tid, "failed", f"{e.message} Gave up after {attempts} attempts.", attempts=attempts)
            else:
                _set(run_id, tid, "scheduled", e.message, attempts=attempts, next_attempt_at=now + BACKOFF[attempts - 1])
        elif e.status in (422, 503):
            _set(run_id, tid, "failed", e.message)
        else:  # not approved, flagged, changed, already sent, gone: never send a stale draft
            _set(run_id, tid, "cancelled", e.message)
        return 0
    except Exception as e:  # never let one row stop the others
        _set(run_id, tid, "failed", f"Unexpected error ({type(e).__name__}).")
        return 0
    _set(run_id, tid, "sent", None, attempts=r["attempts"] + 1)
    if _emit:
        try:
            _emit(run_id, "review", {"ticket_id": tid, "state": "sent"})
        except Exception:
            pass
    return 1


def _loop():
    while not _stop.wait(POLL_SECONDS):
        try:
            tick()
        except Exception:
            pass


def start(emit=None):
    """Start the background sender. `emit(run_id, kind, data)` pushes a live event to open browsers."""
    global _thread, _emit
    _emit = emit
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    try:
        tick()  # catch up after a restart before the first wait
    except Exception:
        pass
    _thread = threading.Thread(target=_loop, name="scheduled-send", daemon=True)
    _thread.start()


# ------------------------------------------------------------------ API
class ScheduleBody(BaseModel):
    send_at: str


def _payload(run_id, ticket_id):
    return {"schedule": _public(_row(run_id, ticket_id)), "mail_mode": mailer.get_mailer().mode, "now": to_iso(_now())}


def _need_ticket(run_id, ticket_id):
    if not db.get_run(run_id):
        raise HTTPException(404, "run not found")
    if not db.get_ticket(run_id, ticket_id):
        raise HTTPException(404, "ticket not found in this run")


@router.get("/api/runs/{run_id}/tickets/{ticket_id}/schedule")
def api_get_schedule(run_id: str, ticket_id: int):
    _need_ticket(run_id, ticket_id)
    return _payload(run_id, ticket_id)


@router.post("/api/runs/{run_id}/tickets/{ticket_id}/schedule")
def api_set_schedule(run_id: str, ticket_id: int, body: ScheduleBody):
    _need_ticket(run_id, ticket_id)
    try:
        at = parse_iso(body.send_at)
    except ValueError:
        raise HTTPException(400, "Pick a valid date and time.")
    now = _now()
    if at < now + MIN_AHEAD:
        raise HTTPException(400, "Pick a time at least 1 minute from now.")
    if at > now + MAX_AHEAD:
        raise HTTPException(400, "Pick a time within the next 30 days.")
    cur = _row(run_id, ticket_id)
    if cur and cur["status"] == "scheduled":
        raise HTTPException(409, "This reply is already scheduled. Cancel the schedule first.")
    try:
        msg = delivery.prepare(run_id, ticket_id)  # same checks as Send now
    except delivery.DeliveryError as e:
        raise HTTPException(e.status, e.message)
    h = delivery.reply_hash(msg.to, msg.subject, msg.body)
    db._exec("INSERT OR REPLACE INTO scheduled_send (run_id, ticket_id, send_at, status, attempts, last_error, approved_hash,"
             " created_at, next_attempt_at) VALUES (?,?,?,?,0,NULL,?,?,NULL)",
             (run_id, ticket_id, to_iso(at), "scheduled", h, to_iso(now)))
    return _payload(run_id, ticket_id)


@router.delete("/api/runs/{run_id}/tickets/{ticket_id}/schedule")
def api_cancel_schedule(run_id: str, ticket_id: int):
    _need_ticket(run_id, ticket_id)
    _cancel_active(run_id, ticket_id, "Cancelled by a person.")
    return _payload(run_id, ticket_id)
