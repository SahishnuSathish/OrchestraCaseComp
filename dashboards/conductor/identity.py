"""Sessions, the sign-in directory and role guards.

Owner: p3/identity-live. Contract: docs/phase3/CONTRACTS.md sections 1-2.

A session is a row in `sessions`; the browser keeps its id in sessionStorage and sends it as `x-conductor-session`.
Staff and approvers are chosen from the directory built from data/employees.csv. A vendor signs in through simulated
SSO (the address must be an authorized contact of exactly one active vendor) or through the email-code fallback, which
reuses the vendor portal's PortalLogic for its rate limits and code lifetime.

A vendor session's `vendor_id` is the vendor's NetSuite internalId (the `entity` column on vendor_bills.csv).
"""
import csv
import importlib.util
import secrets
import sys
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import appclock
import db

router = APIRouter()

REPO = Path(__file__).resolve().parents[2]
DATA = REPO / "data"
HEADER = "x-conductor-session"

STAFF = {"ap_specialist", "cfo"}
ROLES = {"ap_specialist", "cfo", "approver", "vendor"}
SPECIALISTS = ("ulla.abernathy@orchestra-mock.example", "omar.calloway@orchestra-mock.example")
CFO_EMAIL = "elena.lockhart@orchestra-mock.example"
PENDING_STATUSES = ("Pending Approval", "Pending PO")
SESSION_IDLE = 12 * 3600          # a session unused for 12 hours (app clock) ends
HOMES = {"ap_specialist": "/app#/inbox", "cfo": "/app#/escalations", "approver": "/app#/approver", "vendor": "/direct"}

NEUTRAL_SIGNIN = "We couldn't sign you in with that account."
BAD_CODE = "That code is not valid or has expired."
SIGNED_OUT = "Sign in to continue."
NOT_ALLOWED = "You don't have access to that."

_now = appclock.now  # tests may replace this to move time


def _clock():
    return _now()


# ------------------------------------------------------------------------------------------------ schema
def init_schema():
    db._exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, role TEXT, subject TEXT, name TEXT, vendor_id TEXT,"
             " created_at REAL, last_seen REAL, title TEXT)")


class Session:
    def __init__(self, id, role, subject, name, vendor_id=None, title=None):
        self.id, self.role, self.subject, self.name, self.vendor_id, self.title = id, role, subject, name, vendor_id, title

    @property
    def actor(self):
        return {"name": self.name, "email": self.subject}

    def __repr__(self):
        return f"Session({self.role}, {self.subject})"


def _from_row(r):
    return Session(r["id"], r["role"], r["subject"], r["name"], r["vendor_id"], r.get("title"))


def create_session(role, subject, name, vendor_id=None, title=None):
    """Make a session directly (sign-in endpoints and tests use this)."""
    if role not in ROLES:
        raise ValueError(f"unknown role {role!r}")
    sid = secrets.token_urlsafe(24)
    now = _clock()
    email = (subject or "").lower()
    db._exec("INSERT INTO sessions (id, role, subject, name, vendor_id, created_at, last_seen, title) VALUES (?,?,?,?,?,?,?,?)",
             (sid, role, email, name, vendor_id, now, now, title))
    return Session(sid, role, email, name, vendor_id, title)


def get_session(sid):
    """The Session with this id, or None (unknown, or idle for too long). Touches last_seen."""
    if not sid:
        return None
    r = db._one("SELECT * FROM sessions WHERE id=?", (sid,))
    if not r:
        return None
    now = _clock()
    if now - (r["last_seen"] or r["created_at"] or 0) > SESSION_IDLE:
        db._exec("DELETE FROM sessions WHERE id=?", (sid,))
        return None
    db._exec("UPDATE sessions SET last_seen=? WHERE id=?", (now, sid))
    return _from_row(r)


def current(request):
    """The Session for this request, or None. Looked up once per request."""
    state = getattr(request, "state", None)
    if state is not None and hasattr(state, "conductor_session"):
        return state.conductor_session
    s = get_session(request.headers.get(HEADER))
    if state is not None:
        state.conductor_session = s
    return s


def end_session(sid):
    db._exec("DELETE FROM sessions WHERE id=?", (sid,))


def require_role(*roles):
    """FastAPI dependency factory. Returns the Session; 401 with no session, 403 for a wrong role."""
    allowed = set(roles)

    def dep(request: Request):
        s = current(request)
        if s is None:
            raise HTTPException(401, SIGNED_OUT)
        if s.role not in allowed:
            raise HTTPException(403, NOT_ALLOWED)
        return s
    dep.allowed_roles = allowed
    return dep


def require_session(request: Request):
    """Any signed-in role."""
    s = current(request)
    if s is None:
        raise HTTPException(401, SIGNED_OUT)
    return s


# ------------------------------------------------------------------------------------------------ records (data/ is read only)
_CSV_CACHE = {}


def _rows(name):
    path = DATA / name
    key = str(path)
    stamp = path.stat().st_mtime
    hit = _CSV_CACHE.get(key)
    if hit and hit[0] == stamp:
        return hit[1]
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    _CSV_CACHE[key] = (stamp, rows)
    return rows


def employee_rows():
    return _rows("employees.csv")


def vendor_rows():
    return _rows("vendors.csv")


def bill_rows():
    return _rows("vendor_bills.csv")


def _employees_by_email():
    return {(e["email"] or "").lower(): e for e in employee_rows()}


def _full(e):
    return f"{e['firstName']} {e['lastName']}".strip()


def pending_bills():
    return [b for b in bill_rows() if b.get("status") in PENDING_STATUSES]


def approver_for(next_approver):
    """The person who acts on a bill whose nextApprover is this address: the approver, or the delegate when inactive."""
    emps = _employees_by_email()
    e = emps.get((next_approver or "").lower())
    if not e:
        return None
    if e.get("isInactive") != "T":
        return e["email"].lower()
    d = emps.get((e.get("delegateEmail") or "").lower())
    if d and d.get("isInactive") != "T":
        return d["email"].lower()
    return None


def approver_emails():
    return {a for a in (approver_for(b.get("nextApprover")) for b in pending_bills()) if a}


def staff_directory():
    """Staff and approver sign-ins only, from employees.csv. Everyone else in the file cannot sign in."""
    emps = _employees_by_email()
    out = []

    def add(email, role):
        e = emps.get(email)
        if e and e.get("isInactive") != "T":
            out.append({"email": email, "name": _full(e), "title": e.get("title"), "department": e.get("department"), "role": role})
    for email in SPECIALISTS:
        add(email, "ap_specialist")
    add(CFO_EMAIL, "cfo")
    taken = {a["email"] for a in out}
    for email in sorted(approver_emails() - taken, key=lambda x: (_full(emps[x]).lower(), x)):
        add(email, "approver")
    return out


def vendors_for_contact(email):
    email = (email or "").strip().lower()
    if not email:
        return []
    return [v for v in vendor_rows()
            if v.get("isInactive") != "T" and email in [c.strip().lower() for c in (v.get("authorizedContacts") or "").split(";")]]


def vendor_for_contact(email):
    """The vendor row when exactly one active vendor lists the address, else None."""
    found = vendors_for_contact(email)
    return found[0] if len(found) == 1 else None


def _contact_name(email):
    local = (email or "").split("@")[0]
    return " ".join(p.capitalize() for p in local.replace(".", " ").replace("_", " ").split()) or email


# ------------------------------------------------------------------------------------------------ answers
def session_answer(s):
    out = {"session": s.id, "role": s.role, "name": s.name, "email": s.subject, "title": s.title, "home": HOMES[s.role]}
    if s.role == "vendor":
        v = next((x for x in vendor_rows() if x["internalId"] == s.vendor_id), None)
        out["vendor"] = {"id": s.vendor_id, "name": (v or {}).get("companyName")}
    return out


def _vendor_session(email):
    v = vendor_for_contact(email)
    if not v:
        return None
    return create_session("vendor", email, _contact_name(email), vendor_id=v["internalId"])


# ------------------------------------------------------------------------------------------------ email codes (PortalLogic)
_logic = None
_logic_state = None
_CODE_LOCK = threading.Lock()


def _load_portal():
    path = REPO / "dashboards" / "vendor_portal" / "server.py"
    import runner
    runner._proto_on_path()
    spec = importlib.util.spec_from_file_location("vendor_portal_logic", path)
    mod = importlib.util.module_from_spec(spec)
    before = list(sys.path)
    try:
        spec.loader.exec_module(mod)
    finally:  # the portal module puts its own folder first on sys.path; keep that out of the app
        portal_dir = str(path.parent)
        if portal_dir not in before:
            sys.path[:] = [p for p in sys.path if p != portal_dir]
    return mod


def code_logic():
    """The shared PortalLogic (one per state folder). Its printer is silent: the code goes to the simulated mailbox panel."""
    global _logic, _logic_state
    key = str(db.STATE_DIR)
    if _logic is None or _logic_state != key:
        mod = _load_portal()
        from data_layer import FileBackend, Store
        store = Store(FileBackend(DATA))
        _logic = mod.PortalLogic(store, log_path=Path(db.STATE_DIR) / "portal_log.jsonl", now=lambda: _clock(),
                                 printer=lambda *a, **k: None)
        _logic_state = key
    return _logic


def _client_ip(request):
    return request.client.host if request.client else "local"


SENT_NOTE = "If that address is on file, a 6-digit code has been sent to it. Enter it below to continue."


def request_code(email, invoice, ip):
    email = (email or "").strip().lower()
    invoice = (invoice or "").strip()
    logic = code_logic()
    with _CODE_LOCK:
        if vendor_for_contact(email) is None:
            # Same answer as a real address, same rate limits, and no code is ever issued.
            if logic._limited(("ip", ip), 20) or logic._limited(("email", email), 5):
                return {"ok": False, "message": "Too many requests. Please try again later.", "inbox": None}
            return {"ok": True, "message": SENT_NOTE, "inbox": None}
        key = (email, invoice)
        before = logic.codes.get(key)
        res = logic.request_code(email, invoice, ip)
        after = logic.codes.get(key)
        issued = after is not None and after != before
    if not res.get("ok"):
        return {"ok": False, "message": res["message"], "inbox": None}
    inbox = {"to": email, "subject": "Your Orchestra sign-in code", "code": after[0]} if issued else None
    return {"ok": True, "message": SENT_NOTE, "inbox": inbox}


def verify_code(email, invoice, code, ip):
    """A vendor Session, or raises HTTPException (401 neutral, 429 when rate limited)."""
    email = (email or "").strip().lower()
    logic = code_logic()
    with _CODE_LOCK:
        res = logic.check(email, invoice, code, ip)
    if res.get("step") == "code":
        raise HTTPException(401, BAD_CODE)
    if not res.get("ok") and str(res.get("message", "")).startswith("Too many"):
        raise HTTPException(429, res["message"])
    s = _vendor_session(email)
    if s is None:
        raise HTTPException(401, BAD_CODE)
    return s


# ------------------------------------------------------------------------------------------------ endpoints
class SsoBody(BaseModel):
    kind: str = Field(default="", max_length=20)
    email: str = Field(default="", max_length=320)
    provider: str = Field(default="", max_length=20)


class CodeRequest(BaseModel):
    email: str = Field(default="", max_length=320)
    invoice: str = Field(default="", max_length=80)


class CodeVerify(CodeRequest):
    code: str = Field(default="", max_length=12)


@router.get("/api/session/directory")
def api_directory():
    return {"accounts": staff_directory()}


@router.post("/api/session/sso")
def api_sso(body: SsoBody):
    email = (body.email or "").strip().lower()
    if body.kind == "staff":
        acct = next((a for a in staff_directory() if a["email"] == email), None)
        if not acct:
            raise HTTPException(401, NEUTRAL_SIGNIN)
        return session_answer(create_session(acct["role"], acct["email"], acct["name"], title=acct["title"]))
    if body.kind == "vendor" and body.provider in ("microsoft", "google"):
        s = _vendor_session(email)
        if s:
            return session_answer(s)
    raise HTTPException(401, NEUTRAL_SIGNIN)


@router.post("/api/session/code/request")
def api_code_request(body: CodeRequest, request: Request):
    return request_code(body.email, body.invoice, _client_ip(request))


@router.post("/api/session/code/verify")
def api_code_verify(body: CodeVerify, request: Request):
    return session_answer(verify_code(body.email, body.invoice, body.code, _client_ip(request)))


@router.get("/api/session")
def api_session(request: Request):
    return session_answer(require_session(request))


@router.delete("/api/session")
def api_sign_out(request: Request):
    s = current(request)
    if s:
        end_session(s.id)
    return {"ok": True}
