"""Server-sent event bus, scoped by role.

Owner: p3/identity-live. Contract: docs/phase3/CONTRACTS.md section 3.

`publish` may be called from any thread. Each open stream has its own queue; an event is put on a stream's queue only
when the audience rules say so (see `_wanted`). A browser cannot send headers on an EventSource, so it first asks
`POST /api/live/ticket` (a normal call with its session header) and opens `GET /api/live?ticket=...` with the answer.
A ticket works once, for 60 seconds, and stands for the session that asked.
"""
import asyncio
import itertools
import json
import queue
import secrets
import threading
import time
from collections import deque

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

import appclock
import identity

router = APIRouter()

TICKET_TTL = 60
PING_SECONDS = 15
RECENT_MAX = 200

_mono = time.monotonic  # tests replace this to move time
_lock = threading.Lock()
_streams = []
_tickets = {}      # ticket -> (session id, expires at)
_recent = deque(maxlen=RECENT_MAX)
_ids = itertools.count(1)


def init_schema():
    pass


# ------------------------------------------------------------------------------------------------ tickets
def issue_ticket(session):
    now = _mono()
    ticket = secrets.token_urlsafe(24)
    with _lock:
        for t in [t for t, (_, exp) in _tickets.items() if exp <= now]:
            del _tickets[t]
        _tickets[ticket] = (session.id, now + TICKET_TTL)
    return ticket


def consume_ticket(ticket):
    """The Session a ticket stands for, or None. The ticket is spent either way."""
    if not ticket:
        return None
    with _lock:
        entry = _tickets.pop(ticket, None)
    if not entry or entry[1] <= _mono():
        return None
    return identity.get_session(entry[0])


# ------------------------------------------------------------------------------------------------ bus
class Stream:
    def __init__(self, session):
        self.role, self.subject, self.vendor_id, self.session_id = session.role, session.subject, session.vendor_id, session.id
        self.q = queue.Queue(maxsize=1000)

    def get(self, timeout=0):
        """The next event dict, or None."""
        try:
            return self.q.get(timeout=timeout) if timeout else self.q.get_nowait()
        except queue.Empty:
            return None


def _wanted(role, subject, vendor_id, roles, subjects, event_vendor):
    if role == "vendor":  # vendor streams receive only events that carry their vendor id
        return event_vendor is not None and vendor_id == event_vendor
    return role in roles or subject in subjects


def open_stream(session):
    s = Stream(session)
    with _lock:
        _streams.append(s)
    return s


def close_stream(stream):
    with _lock:
        if stream in _streams:
            _streams.remove(stream)


def _summary(type, payload):
    p = payload
    tid = p.get("ticket_id")
    t = f"#{tid}" if tid else "a ticket"
    return {
        "ticket.arrived": f"New message from {p.get('from_name') or 'a requester'}: {p.get('subject') or t}",
        "ticket.outcome": f"Ticket {t} is ready ({str(p.get('outcome') or '').replace('_', ' ')})",
        "queue.counts": "Queue counts changed",
        "ticket.assigned": f"Ticket {t} was assigned to {p.get('assignee')}",
        "ticket.escalated": f"Ticket {t} was escalated to the CFO",
        "signoff.requested": f"Sign-off requested for ticket {t}",
        "ticket.returned": f"Ticket {t} was returned with guidance",
        "ticket.signed_off": f"Ticket {t} was signed off",
        "ticket.decided": f"Ticket {t} was decided",
        "ticket.sent": f"Reply to ticket {t} was sent",
        "ticket.scheduled": f"Reply to ticket {t} is scheduled",
        "outbound.created": "A message is waiting for review",
        "outbound.sent": "A message was sent",
        "ahead.sent": "An Ahead notice was sent",
        "approver.committed": f"{p.get('approver')} committed to an approval date",
        "w9.received": "A W-9 was received",
        "direct.question": f"A vendor asked a question about ticket {t}",
        "direct.message": "You have a new message from Orchestra",
        "direct.update": "Your invoice status was updated",
        "sync.status": "Sync status changed",
    }.get(type, type.replace(".", " "))


def publish(type, payload, *, roles=None, subjects=None, vendor_id=None):
    """Publish one event. `roles=None` means the staff roles; pass `roles=set()` with `subjects` to address people only."""
    from identity import STAFF
    payload = dict(payload or {})
    roles = set(STAFF) if roles is None else set(roles)
    subjects = {s.lower() for s in (subjects or ()) if s}
    data = {"id": next(_ids), "at": appclock.iso(), "type": type, "summary": payload.pop("summary", None) or _summary(type, payload)}
    data.update(payload)
    with _lock:
        _recent.append((data, roles, subjects, vendor_id))
        targets = [s for s in _streams if _wanted(s.role, s.subject, s.vendor_id, roles, subjects, vendor_id)]
    for s in targets:
        out = data
        if s.role == "vendor":  # a vendor sees what happened, never who inside Orchestra did it or who else was told
            out = {k: v for k, v in data.items() if k not in ("actor", "to")}
        try:
            s.q.put_nowait(out)
        except queue.Full:  # a stuck client must never block a state change
            pass


def recent(session=None, limit=50):
    """The latest events a session may see, newest first (the CFO activity feed uses this)."""
    with _lock:
        rows = list(_recent)
    out = []
    for data, roles, subjects, vendor_id in reversed(rows):
        if session is None or _wanted(session.role, session.subject, session.vendor_id, roles, subjects, vendor_id):
            out.append(data)
        if len(out) >= limit:
            break
    return out


# ------------------------------------------------------------------------------------------------ endpoints
@router.post("/api/live/ticket")
def api_live_ticket(s=Depends(identity.require_session)):
    return {"ticket": issue_ticket(s), "expires_in": TICKET_TTL}


def _frame(data):
    return f"event: {data['type']}\ndata: {json.dumps(data, ensure_ascii=True)}\n\n"


@router.get("/api/live")
async def api_live(request: Request, ticket: str = ""):
    s = consume_ticket(ticket)
    if s is None:
        raise HTTPException(401, "Sign in to continue.")
    stream = open_stream(s)

    async def gen():
        idle = 0.0
        try:
            yield "retry: 3000\n\n"
            while not await request.is_disconnected():
                ev = stream.get()
                if ev is not None:
                    yield _frame(ev)
                    idle = 0.0
                    continue
                idle += 0.25
                if idle >= PING_SECONDS:
                    yield ": ping\n\n"
                    idle = 0.0
                await asyncio.sleep(0.25)
        finally:
            close_stream(stream)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})
