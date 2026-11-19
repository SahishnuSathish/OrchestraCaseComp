"""Conductor: Direct, the vendor API.

Owner: p3/direct-w9. Contract: docs/phase3/CONTRACTS.md section 9.

Every route needs a vendor session. The vendor always comes from the session, never from the request.
Wording for an invoice comes from the same path as status_service.lookup_status (rules.classify_bill, the drafts
snippets, egress_guard); this module never writes its own status sentence. Vendors never get totals or counts
across their invoices, internal names, ticket ids or approval dates.
"""
import datetime as dt
import json
import re
import sys
import zlib
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

import appclock
import db
import delivery
import identity

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
for _p in (ROOT / "src", HERE):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import drafts  # noqa: E402
import egress_guard  # noqa: E402
import rules  # noqa: E402
import status_service  # noqa: E402
from data_layer import FileBackend, Store, norm_ref  # noqa: E402
from trace import Trace  # noqa: E402

router = APIRouter()

AP_EMAIL = status_service.AP_EMAIL
NOT_FOUND = "We couldn't find that invoice."
THANKS = "Thanks. Our team will reply here and by email."
MAX_QUESTION = 2000
NOTICE_TYPES = ("payment_updates", "approval_delays", "document_requests")
APPROVED_TIMING = "typically paid within 5 to 10 business days"

SCHEMA = """
CREATE TABLE IF NOT EXISTS direct_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id TEXT, ticket_id INTEGER, invoice TEXT, subject TEXT, body TEXT,
  at REAL, read INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS direct_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id TEXT, title TEXT, body TEXT, at REAL, read INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS direct_prefs (
  vendor_id TEXT, contact TEXT, email_updates INTEGER DEFAULT 1, notice_types TEXT, PRIMARY KEY (vendor_id, contact)
);
CREATE TABLE IF NOT EXISTS direct_lookups (at REAL, vendor_id TEXT, invoice TEXT);
CREATE TABLE IF NOT EXISTS direct_questions (
  ticket_id INTEGER PRIMARY KEY, vendor_id TEXT, invoice TEXT, contact TEXT
);
"""


def init_schema():
    with db._LOCK, db._connect() as con:
        con.executescript(SCHEMA)


# ------------------------------------------------------------------ records
_STORE = None


def _store():
    """The read-only record store (data/ is never written). Tests patch this."""
    global _STORE
    if _STORE is None:
        _STORE = Store(FileBackend(ROOT / "data"))
    return _STORE


def _lk():
    return _store().session(Trace())


def _vendor_row(vendor_id):
    v = _lk().get_vendor(vendor_id)
    return v if v and v.get("isInactive", "F") != "T" else None


def _name_from_email(email):
    local = (email or "").split("@", 1)[0]
    words = [w for w in re.split(r"[._\-+]+", local) if w and not w.isdigit()]
    return " ".join(w.capitalize() for w in words) or "Contact"


# ------------------------------------------------------------------ session
def vendor_session(s=Depends(identity.require_role("vendor"))):
    """The signed-in vendor contact. Tests replace this with app.dependency_overrides."""
    if s is None or not getattr(s, "vendor_id", None):
        raise HTTPException(401, "Please sign in.")
    return s


def _ctx(s):
    if s is None or not getattr(s, "vendor_id", None):
        raise HTTPException(401, "Please sign in.")
    vendor = _vendor_row(s.vendor_id)
    contact = (s.subject or "").strip().lower()
    if vendor is None or contact not in [c.strip().lower() for c in vendor["authorizedContacts"].split(";")]:
        raise HTTPException(403, "This account can't use Conductor: Direct.")
    return vendor, contact


# ------------------------------------------------------------------ dates and chips
def fmt_short(iso):
    d = dt.date.fromisoformat(iso)
    return f"{d:%b} {d.day}, {d.year}"


def _updated():
    return fmt_short(appclock.today().isoformat())


def _source():
    return f"Orchestra accounts payable records, updated {_updated()}"


LABELS = {
    "received": "Received",
    "pending_approval": "Awaiting internal approval",
    "approved": "Approved, " + APPROVED_TIMING,
    "scheduled": "Scheduled for payment on",
    "payment_sent": "Payment sent",
    "paid": "Paid",
    "under_review": "Under review: our team will follow up",
}
DATED = ("scheduled", "payment_sent", "paid")


def _chip(o):
    """(code, date) for a classified bill. Dates come from records only. Pending and approved carry no date."""
    out = o["outcome"]
    p, r = o.get("payment") or {}, o.get("run") or {}
    if out == "paid" and p.get("tranDate"):
        return "paid", p["tranDate"]
    if out == "released":
        return "payment_sent", p.get("custbody_released_date") or p.get("tranDate")
    if out == "scheduled" and r.get("run_date"):
        return "scheduled", r["run_date"]
    if out == "approved_no_run":
        return "approved", None
    if out == "pending":
        if (o["bill"].get("status") or "") in ("Pending Approval", "Pending PO"):
            return "pending_approval", None
        return "received", None
    return "under_review", None


def status_chip(o):
    code, date = _chip(o)
    if code in DATED and date:
        return {"code": code, "label": f"{LABELS[code]} {fmt_short(date)}", "date": date}
    return {"code": "under_review" if code in DATED else code,
            "label": LABELS["under_review" if code in DATED else code]}


def answer_for(o):
    """The vendor-facing sentence for one classified bill, built exactly as status_service.lookup_status builds it.
    Returns (message, state). Anything it cannot say safely becomes the standard needs-review line."""
    key = status_service.SNIPPET_FOR.get(o["outcome"])
    if key is None:
        return status_service.NEEDS_REVIEW, o["outcome"]
    fields = drafts.outcome_fields(o)
    fields.setdefault("settled", "")
    fields["for_vendor"] = ""
    msg = drafts.SNIPPETS[key].format(**fields)
    bal = status_service.balance_line(o)
    msg = f"{msg} {bal}" if bal else msg
    if egress_guard.check_outbound(msg, [o], [o["ref"]]) or not status_service._amounts_ok(msg, o):
        return status_service.NEEDS_REVIEW, o["outcome"]
    return msg, o["outcome"]


def _balance(o, code):
    """Open balance from the bill record (the status_service.balance_line rule). Nothing is said for review bills."""
    b = o["bill"]
    if code == "under_review" or not b.get("userTotal"):
        return None
    return 0.0 if o["outcome"] in status_service.ZERO_BALANCE else float(b["userTotal"])


def timeline(o):
    """Public steps only: no approver, no approval date, no reason for a review."""
    code, date = _chip(o)
    out = o["outcome"]
    if code == "under_review":
        return [{"label": "Received", "done": True}, {"label": "Under review", "done": False}]
    run = (o.get("run") or {}).get("run_date")
    steps = [{"label": "Received", "done": True},
             {"label": "Approved", "done": out in ("approved_no_run", "scheduled", "released", "paid")}]
    sched = {"label": "Scheduled for payment", "done": out in ("scheduled", "released", "paid")}
    if out == "scheduled" and run:
        sched["date"] = run
    steps.append(sched)
    sent = {"label": "Payment sent", "done": out in ("released", "paid")}
    if code == "payment_sent" and date:
        sent["date"] = date
    steps.append(sent)
    paid = {"label": "Paid", "done": out == "paid"}
    if code == "paid" and date:
        paid["date"] = date
    steps.append(paid)
    return steps


# ------------------------------------------------------------------ bills for a vendor
def _classified(vendor_id):
    """[classified bill] for the vendor's showable bills. A reference shared by two of its bills is not showable."""
    st = _store()
    lk = st.session(Trace())
    groups = {}
    for b in st.backend.all("vendorBill"):
        if b["entity"] == vendor_id:
            groups.setdefault(norm_ref(b["tranId"]), []).append(b)
    return [rules.classify_bill(g[0], lk) for g in groups.values()
            if len(g) == 1 and status_service.REF_OK.match(g[0]["tranId"])]


def resolve_bill(vendor_id, invoice):
    """The classified bill of this vendor for `invoice`, or None. Same matching and ambiguity rule as lookup_status."""
    if not status_service.REF_OK.match(invoice or ""):
        return None
    lk = _lk()
    bills = []
    for canon in lk.canonical_refs(invoice.strip()):
        bills += lk.find_bills_by_tranid(canon)
    bills = [b for b in bills if b["entity"] == vendor_id]
    if len(bills) != 1:
        return None
    return rules.classify_bill(bills[0], lk)


def _not_found():
    return HTTPException(404, NOT_FOUND)


def _row(o):
    b = o["bill"]
    chip = status_chip(o)
    return {"invoice": b["tranId"], "date": b.get("tranDate"),
            "amount": float(b["userTotal"]) if b.get("userTotal") else None,
            "currency": b.get("currency") or "USD", "balance": _balance(o, chip["code"]), "status": chip}


# ------------------------------------------------------------------ routes: read side
@router.get("/api/direct/me")
def me(s=Depends(vendor_session)):
    vendor, contact = _ctx(s)
    import w9
    w = w9.vendor_status(vendor["internalId"])
    n = lambda t: db._one(f"SELECT COUNT(*) AS n FROM {t} WHERE vendor_id=? AND read=0", (vendor["internalId"],))["n"]  # noqa: E731
    return {"contact": {"email": contact, "name": getattr(s, "name", None) or _name_from_email(contact)},
            "vendor": {"name": vendor["companyName"], "subsidiary": vendor.get("subsidiary")},
            "w9": {"status": w["status"], "label": w["label"]},
            "unread_messages": n("direct_messages"), "unread_updates": n("direct_updates")}


@router.get("/api/direct/invoices")
def invoices(q: str = "", status: str = "", s=Depends(vendor_session)):
    vendor, _ = _ctx(s)
    rows = [_row(o) for o in _classified(vendor["internalId"])]
    q = (q or "").strip().lower()
    if q:
        rows = [r for r in rows if q in r["invoice"].lower()]
    if status:
        rows = [r for r in rows if r["status"]["code"] == status]
    rows.sort(key=lambda r: (r["date"] or "", r["invoice"]), reverse=True)
    return {"rows": rows, "updated": _updated()}


def _documents(o):
    docs = [{"kind": "invoice", "label": "Invoice copy"}]
    if o["outcome"] in ("paid", "released"):
        docs.append({"kind": "remittance", "label": "Remittance advice"})
    return docs


def record_lookup(vendor_id, invoice):
    db._exec("INSERT INTO direct_lookups (at, vendor_id, invoice) VALUES (?,?,?)", (appclock.now(), vendor_id, invoice))


@router.get("/api/direct/invoices/{invoice}")
def invoice_detail(invoice: str, s=Depends(vendor_session)):
    vendor, _ = _ctx(s)
    o = resolve_bill(vendor["internalId"], invoice)
    if o is None:
        raise _not_found()
    record_lookup(vendor["internalId"], o["ref"])
    row = _row(o)
    msg, _state = answer_for(o)
    return {"invoice": row["invoice"], "date": row["date"], "due": o["bill"].get("dueDate"), "amount": row["amount"],
            "currency": row["currency"], "balance": row["balance"], "status": row["status"], "timeline": timeline(o),
            "message": msg, "documents": _documents(o), "source": _source()}


@router.get("/api/direct/invoices/{invoice}/documents/{doc}")
def invoice_document(invoice: str, doc: str, s=Depends(vendor_session)):
    vendor, _ = _ctx(s)
    kind, _, fmt = doc.rpartition(".")
    if kind not in ("invoice", "remittance") or fmt not in ("html", "pdf"):
        raise _not_found()
    o = resolve_bill(vendor["internalId"], invoice)
    if o is None or kind not in [d["kind"] for d in _documents(o)]:
        raise _not_found()
    import documents
    try:
        data, mime, filename = documents.render(kind, o["bill"]["internalId"], fmt)
    except documents.NotAvailable:
        raise _not_found()
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", filename or f"{kind}.{fmt}")
    return Response(content=data, media_type=mime,
                    headers={"X-Conductor-Frame": "self", "Content-Disposition": f'inline; filename="{safe}"'})


# ------------------------------------------------------------------ self-serve lookups
def _since_ts(since):
    if since is None:
        return None
    if isinstance(since, (int, float)):
        return float(since)
    if isinstance(since, dt.datetime):
        return since.timestamp()
    if isinstance(since, dt.date):
        return dt.datetime.combine(since, dt.time()).timestamp()
    try:
        return dt.datetime.fromisoformat(str(since)).timestamp()
    except ValueError:
        return float(since)


def lookup_count(since=None):
    """Self-serve lookups (an invoice opened in Direct) since an app-clock time. Never a prevented-ticket figure."""
    ts = _since_ts(since)
    if ts is None:
        return db._one("SELECT COUNT(*) AS n FROM direct_lookups")["n"]
    return db._one("SELECT COUNT(*) AS n FROM direct_lookups WHERE at>=?", (ts,))["n"]
