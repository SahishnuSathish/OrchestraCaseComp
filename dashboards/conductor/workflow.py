"""Escalation state machine, sign-off, assignment, chase, forward, outbound items, approver actions, audit.

Owner: p3/identity-live. Contract: docs/phase3/CONTRACTS.md section 6. Product rules: phase3-spec decision 6 and section 3.4.

Every id here is an inbox ticket id (the ticket in the inbox run, settings key `inbox.run_id`). The states are
open -> escalated -> returned | signoff_requested | signed_off | decided -> sent | closed, and every move writes an
audit row.

Sign-off categories (`signoff_category`):
  priority            a holding reply exists; the CFO signs off its exact text (the hash of recipient, subject and body is stored)
  fraud               internal note; nobody can approve a reply; the CFO decides the note
  returned            internal note; the CFO decides it
  early_or_late_fee   internal note; the CFO decides it
Conductor never writes a vendor reply on a note ticket.
"""
import datetime as dt
import json
import re
import threading

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

import appclock
import db
import delivery
import identity
import live
import reply_checks

router = APIRouter()
_LOCK = threading.RLock()

STATES = ("open", "escalated", "returned", "signoff_requested", "signed_off", "decided", "sent", "closed")
REASONS = ("legal", "exec", "fraud", "bank_change", "returned", "early_payment", "late_fee", "conflict", "other")
NOTE_CATEGORIES = ("fraud", "returned", "early_or_late_fee")

staff_guard = identity.require_role("ap_specialist", "cfo")
cfo_guard = identity.require_role("cfo")


# ------------------------------------------------------------------------------------------------ schema
def init_schema():
    for sql in (
        "CREATE TABLE IF NOT EXISTS workflow_state (ticket_id INTEGER PRIMARY KEY, state TEXT, category TEXT, assignee TEXT,"
        " signoff_hash TEXT, signoff_by TEXT, signoff_at REAL, decided TEXT, updated_at REAL)",
        "CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL, actor TEXT, ticket_id INTEGER,"
        " action TEXT, from_state TEXT, to_state TEXT, detail TEXT)",
        "CREATE TABLE IF NOT EXISTS expertise (email TEXT PRIMARY KEY, name TEXT, replies INTEGER, exceptions INTEGER, categories TEXT)",
        "CREATE TABLE IF NOT EXISTS outbound (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, ticket_id INTEGER, vendor_id TEXT,"
        " to_email TEXT, subject TEXT, body TEXT, state TEXT, created_by TEXT, created_at REAL, approved_by TEXT, sent_at REAL,"
        " message_id TEXT, meta TEXT)",
        "CREATE TABLE IF NOT EXISTS approver_actions (bill_id TEXT, approver TEXT, kind TEXT, date TEXT, at REAL)",
    ):
        db._exec(sql)
    _seed_expertise()


# ------------------------------------------------------------------------------------------------ the inbox run and bundles
def inbox_run():
    """The inbox run id, or None until the inbox exists. Never creates it."""
    rid = db.get_setting("inbox.run_id")
    return rid if rid and db.get_run(rid) else None


def _need_inbox_run():
    rid = inbox_run()
    if not rid:
        try:
            import inbox
            rid = inbox.inbox_run_id()
        except NotImplementedError:
            rid = None
    if not rid:
        raise HTTPException(409, "The inbox is not connected yet.")
    return rid


def _need_ticket(ticket_id):
    run_id = _need_inbox_run()
    rec = db.get_ticket(run_id, ticket_id)
    if not rec:
        raise HTTPException(404, "ticket not found")
    return run_id, rec


def signoff_category(bundle):
    """None | "priority" | "fraud" | "returned" | "early_or_late_fee", from the pipeline's own decision."""
    bundle = bundle or {}
    res = bundle.get("result") or {}
    dec = bundle.get("decision") or {}
    flags = set(res.get("flags") or [])
    rule = dec.get("rule")
    if "fraud" in flags or rule == "fraud":
        return "fraud"
    if res.get("priority"):
        return "priority"
    if rule == "returned_payment":
        return "returned"
    if rule in ("late_fee", "expedite_request"):
        return "early_or_late_fee"
    return None


def reply_parts(run_id, ticket_id, text=None, subject=None):
    """(recipient, subject, body) exactly as delivery.prepare would send it, or None when there is no reply."""
    rec = db.get_ticket(run_id, ticket_id)
    if not rec:
        return None
    res = rec["bundle"].get("result") or {}
    if res.get("output_type") != "draft_reply" or not res.get("recipient"):
        return None
    rv = db.get_review(run_id, ticket_id)
    original = res.get("text") or ""
    if text is not None:
        body = original if text == original else text
    else:
        body = rv["edited_text"] if rv.get("edited_text") is not None else original
    default_subject = reply_checks.default_subject(rec["ticket"].get("subject"))
    subj = subject if subject is not None else (rv.get("edited_subject") or default_subject)
    return res["recipient"], subj, body


def current_reply_hash(run_id, ticket_id, text=None):
    parts = reply_parts(run_id, ticket_id, text=text)
    return delivery.reply_hash(*parts) if parts else None


# ------------------------------------------------------------------------------------------------ state rows and audit
_CATEGORY_CACHE = {}


def _category_for(ticket_id):
    run_id = inbox_run()
    if not run_id:
        return None
    key = (run_id, ticket_id)
    if key not in _CATEGORY_CACHE:
        rec = db.get_ticket(run_id, ticket_id)
        _CATEGORY_CACHE[key] = signoff_category(rec["bundle"]) if rec else None
    return _CATEGORY_CACHE[key]


def _row(ticket_id):
    return db._one("SELECT * FROM workflow_state WHERE ticket_id=?", (ticket_id,))


def _ensure_row(ticket_id):
    row = _row(ticket_id)
    if row:
        return row
    db._exec("INSERT OR IGNORE INTO workflow_state (ticket_id, state, category, assignee, updated_at) VALUES (?,?,?,?,?)",
             (ticket_id, "open", _category_for(ticket_id), None, appclock.now()))
    return _row(ticket_id)


def _audit(ticket_id, actor, action, from_state, to_state, detail=None):
    db._exec("INSERT INTO audit_log (at, actor, ticket_id, action, from_state, to_state, detail) VALUES (?,?,?,?,?,?,?)",
             (appclock.now(), actor, ticket_id, action, from_state, to_state, json.dumps(detail or {}, ensure_ascii=True)))


def _audit_out(r):
    try:
        detail = json.loads(r["detail"] or "{}")
    except ValueError:
        detail = {}
    return {"id": r["id"], "at": appclock.iso(r["at"]), "actor": r["actor"], "ticket_id": r["ticket_id"], "action": r["action"],
            "from_state": r["from_state"], "to_state": r["to_state"], "detail": detail}


def _who(session):
    return session.subject if session else "system"


def _transition(ticket_id, to_state, actor, action, allowed_from, detail=None, **cols):
    """Move a ticket to `to_state` if its current state is in `allowed_from`; write the audit row. 409 otherwise."""
    with _LOCK:
        row = _ensure_row(ticket_id)
        cur = row["state"]
        if cur not in allowed_from:
            raise HTTPException(409, f"That can't be done while the ticket is {cur.replace('_', ' ')}.")
        sets = {"state": to_state, "updated_at": appclock.now(), **cols}
        db._exec(f"UPDATE workflow_state SET {', '.join(f'{k}=?' for k in sets)} WHERE ticket_id=?", (*sets.values(), ticket_id))
        _audit(ticket_id, actor, action, cur, to_state, detail)
    return cur


def get_state(ticket_id):
    """{state, category, assignee, chased} for an inbox ticket. The inbox queues read this."""
    row = _row(ticket_id)
    if row:
        return {"state": row["state"], "category": row["category"] or _category_for(ticket_id),
                "assignee": row["assignee"] or route(ticket_id), "chased": _chased(ticket_id)}
    return {"state": "open", "category": _category_for(ticket_id), "assignee": route(ticket_id), "chased": _chased(ticket_id)}


def _chased(ticket_id):
    r = db._one("SELECT 1 AS n FROM outbound WHERE kind='approver_nudge' AND ticket_id=? AND state='sent' LIMIT 1", (ticket_id,))
    return bool(r)


# ------------------------------------------------------------------------------------------------ rules used by the review and send paths
def can_approve(session, run_id, ticket_id, state="approved", text=None):
    """A reason string blocks the decision. `state` is the review state being set; `text` the edited reply that comes with it."""
    rec = db.get_ticket(run_id, ticket_id)
    if not rec:
        return None
    cat = signoff_category(rec["bundle"])
    if cat is None:
        return None
    role = getattr(session, "role", None)
    if cat == "fraud":
        if state == "approved":
            return "Possible fraud. A person must handle this outside Conductor; it can't be approved here."
        if state == "acknowledged" and role != "cfo":
            return "The CFO decides fraud notes. Escalate this ticket."
        return None
    if cat == "priority":
        if state != "approved":
            return None
        st = _row(ticket_id)
        want = current_reply_hash(run_id, ticket_id, text=text)
        if st and st["state"] == "signed_off" and st["signoff_hash"] and st["signoff_hash"] == want:
            return None
        if st and st["state"] == "signed_off":
            return "The reply changed after the CFO signed off. Ask for sign-off again."
        return "Sign off on this reply first." if role == "cfo" else "This reply needs the CFO's sign-off. Request sign-off instead."
    if state == "acknowledged" and role != "cfo":
        return "The CFO decides this note. Escalate this ticket."
    return None


def can_send(run_id, ticket_id, reply_hash):
    """A reason string blocks sending. A priority reply goes out only when signed off with a matching hash."""
    rec = db.get_ticket(run_id, ticket_id)
    if not rec:
        return None
    cat = signoff_category(rec["bundle"])
    if cat == "fraud":
        return "Possible fraud. This can't be sent from Conductor."
    if cat != "priority":
        return None
    st = _row(ticket_id)
    if not st or st["state"] != "signed_off" or not st["signoff_hash"]:
        return "This reply needs the CFO's sign-off before it can be sent."
    if st["signoff_hash"] != reply_hash:
        return "The reply changed after the CFO signed off. Ask for sign-off again."
    return None


def draft_changed(run_id, ticket_id, session=None):
    """Called when a draft is saved or edited. Remembers the edit for the feedback prompt and voids a stale sign-off."""
    import feedback
    feedback.mark_edited(run_id, ticket_id, _who(session))
    if run_id != inbox_run():
        return
    with _LOCK:
        st = _row(ticket_id)
        if st and st["state"] == "signed_off" and st["signoff_hash"] != current_reply_hash(run_id, ticket_id):
            db._exec("UPDATE workflow_state SET state='open', signoff_hash=NULL, signoff_by=NULL, signoff_at=NULL, updated_at=? "
                     "WHERE ticket_id=?", (appclock.now(), ticket_id))
            _audit(ticket_id, _who(session), "signoff_voided", "signed_off", "open", {"why": "the reply was edited"})


def _on_sent(run_id, ticket_id, actor, info):
    if run_id != inbox_run():
        return
    by = (actor or {}).get("email") or "scheduled send"
    with _LOCK:
        row = _ensure_row(ticket_id)
        db._exec("UPDATE workflow_state SET state='sent', updated_at=? WHERE ticket_id=?", (appclock.now(), ticket_id))
        _audit(ticket_id, by, "sent", row["state"], "sent", {"message_id": (info or {}).get("id")})
    live.publish("ticket.sent", {"ticket_id": ticket_id, "by": by})


if _on_sent not in delivery.ON_SENT:
    delivery.ON_SENT.append(_on_sent)


# ------------------------------------------------------------------------------------------------ events
def _requesters(ticket_id):
    """People to tell about a CFO move: whoever escalated or asked, and the assignee."""
    out = set()
    for r in db._all("SELECT actor FROM audit_log WHERE ticket_id=? AND action IN ('escalate','request-signoff','assign')", (ticket_id,)):
        out.add((r["actor"] or "").lower())
    row = _row(ticket_id)
    if row and row["assignee"]:
        out.add(row["assignee"].lower())
    out.discard("system")
    return out


def _publish(type, ticket_id, payload, session, roles=None, subjects=None):
    data = {"ticket_id": ticket_id, **payload}
    if session is not None:
        data["actor"] = session.actor
    live.publish(type, data, roles=roles, subjects=subjects)


# ------------------------------------------------------------------------------------------------ endpoints
class EscalateBody(BaseModel):
    reason: str = Field(max_length=30)
    note: str = Field(default="", max_length=2000)


class NoteBody(BaseModel):
    note: str = Field(default="", max_length=2000)


class ReturnBody(BaseModel):
    guidance: str = Field(max_length=2000)


class SignoffBody(BaseModel):
    reply_hash: str = Field(max_length=100)


class DecideBody(BaseModel):
    decision: str = Field(max_length=20)
    action_taken: str = Field(default="", max_length=2000)
    note: str = Field(default="", max_length=2000)


def _detail_payload(ticket_id):
    st = get_state(ticket_id)
    row = _row(ticket_id)
    hist = [_audit_out(r) for r in db._all("SELECT * FROM audit_log WHERE ticket_id=? ORDER BY id", (ticket_id,))]
    sig = None
    if row and row["signoff_hash"]:
        sig = {"hash": row["signoff_hash"], "by": row["signoff_by"], "at": appclock.iso(row["signoff_at"])}
    return {"ticket_id": ticket_id, **st, "history": hist, "chases": chases_for(ticket_id), "signoff": sig}


def chases_for(ticket_id):
    out = []
    for r in db._all("SELECT * FROM outbound WHERE kind='approver_nudge' AND ticket_id=? ORDER BY id", (ticket_id,)):
        when = r["sent_at"] or r["created_at"]
        replied = db._one("SELECT 1 AS n FROM approver_actions WHERE approver=? AND at>=?", (r["to_email"], r["created_at"]))
        out.append({"outbound_id": r["id"], "to": r["to_email"], "name": _person_name(r["to_email"]), "state": r["state"],
                    "at": appclock.iso(when), "responded": bool(replied),
                    "label": f"Chased {_person_name(r['to_email'])}" + (" · no response yet" if not replied else " · responded")})
    return out


@router.get("/api/workflow/escalations")
def api_escalations(s=Depends(cfo_guard)):
    return {"rows": escalation_rows()}


@router.get("/api/workflow/audit")
def api_audit(limit: int = 100, s=Depends(cfo_guard)):
    rows = db._all("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (max(1, min(limit, 500)),))
    return {"rows": [_audit_out(r) for r in rows]}


def escalation_rows():
    run_id = inbox_run()
    if not run_id:
        return []
    out, seen = [], set()
    for row in db._all("SELECT * FROM workflow_state WHERE state IN ('escalated','signoff_requested') ORDER BY updated_at DESC"):
        out.append(_escalation_row(run_id, row["ticket_id"], row))
        seen.add(row["ticket_id"])
    for r in db.list_rows(run_id):  # priority tickets are visible to the CFO before anyone asks
        tid = r["ticket_id"]
        if tid in seen or not r.get("priority"):
            continue
        row = _row(tid)
        if row and row["state"] not in ("open", "returned"):
            continue
        out.append(_escalation_row(run_id, tid, row))
    return [x for x in out if x]


def _escalation_row(run_id, ticket_id, row):
    rec = db.get_ticket(run_id, ticket_id)
    if not rec:
        return None
    last = db._one("SELECT * FROM audit_log WHERE ticket_id=? AND action IN ('escalate','request-signoff') ORDER BY id DESC LIMIT 1",
                   (ticket_id,))
    detail = _audit_out(last)["detail"] if last else {}
    cat = signoff_category(rec["bundle"])
    state = row["state"] if row else "open"
    return {"ticket_id": ticket_id, "state": state, "category": cat, "needs": "signoff" if cat == "priority" else "decision",
            "reason": detail.get("reason"), "note": detail.get("note"), "from": last["actor"] if last else None,
            "at": appclock.iso(last["at"]) if last else None, "subject": rec["ticket"].get("subject"),
            "from_name": (rec["row"] or {}).get("sender_name"),
            "assignee": get_state(ticket_id)["assignee"]}


@router.get("/api/workflow/{ticket_id}")
def api_workflow(ticket_id: int, s=Depends(staff_guard)):
    return _detail_payload(ticket_id)


@router.post("/api/workflow/{ticket_id}/escalate")
def api_escalate(ticket_id: int, body: EscalateBody, s=Depends(staff_guard)):
    _need_ticket(ticket_id)
    if body.reason not in REASONS:
        raise HTTPException(400, "Pick a reason from the list.")
    note = body.note.strip()
    if body.reason == "other" and not note:
        raise HTTPException(400, "Add a note when the reason is other.")
    _transition(ticket_id, "escalated", _who(s), "escalate", ("open", "returned"), {"reason": body.reason, "note": note})
    _publish("ticket.escalated", ticket_id, {"reason": body.reason, "note": note}, s, roles={"cfo"}, subjects={s.subject})
    return _detail_payload(ticket_id)


@router.post("/api/workflow/{ticket_id}/request-signoff")
def api_request_signoff(ticket_id: int, body: NoteBody, s=Depends(staff_guard)):
    run_id, rec = _need_ticket(ticket_id)
    if signoff_category(rec["bundle"]) != "priority" or not reply_parts(run_id, ticket_id):
        raise HTTPException(409, "This ticket has no reply to sign off. Escalate it instead.")
    note = body.note.strip()
    _transition(ticket_id, "signoff_requested", _who(s), "request-signoff", ("open", "returned", "escalated"),
                {"reason": "signoff", "note": note, "reply_hash": current_reply_hash(run_id, ticket_id)})
    _publish("signoff.requested", ticket_id, {"reason": "signoff", "note": note}, s, roles={"cfo"}, subjects={s.subject})
    return _detail_payload(ticket_id)


@router.post("/api/workflow/{ticket_id}/return")
def api_return(ticket_id: int, body: ReturnBody, s=Depends(cfo_guard)):
    _need_ticket(ticket_id)
    guidance = body.guidance.strip()
    if not guidance:
        raise HTTPException(400, "Write guidance for the specialist.")
    to = _requesters(ticket_id)
    _transition(ticket_id, "returned", _who(s), "return", ("escalated", "signoff_requested", "signed_off"), {"guidance": guidance},
                signoff_hash=None, signoff_by=None, signoff_at=None)
    _publish("ticket.returned", ticket_id, {"guidance": guidance, "to": sorted(to)}, s, roles=set(), subjects=to)
    return _detail_payload(ticket_id)


@router.post("/api/workflow/{ticket_id}/signoff")
def api_signoff(ticket_id: int, body: SignoffBody, s=Depends(cfo_guard)):
    run_id, rec = _need_ticket(ticket_id)
    if signoff_category(rec["bundle"]) != "priority":
        raise HTTPException(409, "Only priority replies are signed off. Decide this ticket instead.")
    want = current_reply_hash(run_id, ticket_id)
    if not want:
        raise HTTPException(409, "This ticket has no reply to sign off.")
    if body.reply_hash != want:
        raise HTTPException(409, "The reply changed. Read the current text and sign off again.")
    _transition(ticket_id, "signed_off", _who(s), "signoff", ("open", "escalated", "signoff_requested", "returned", "signed_off"),
                {"reply_hash": want}, signoff_hash=want, signoff_by=s.subject, signoff_at=appclock.now())
    _publish("ticket.signed_off", ticket_id, {}, s, subjects=_requesters(ticket_id))
    return _detail_payload(ticket_id)


@router.post("/api/workflow/{ticket_id}/decide")
def api_decide(ticket_id: int, body: DecideBody, s=Depends(cfo_guard)):
    run_id, rec = _need_ticket(ticket_id)
    if body.decision not in ("acknowledged", "closed"):
        raise HTTPException(400, "Decide: acknowledged or closed.")
    if signoff_category(rec["bundle"]) == "priority":
        raise HTTPException(409, "Sign off on the reply or return it with guidance.")
    action, note = body.action_taken.strip(), body.note.strip()
    if body.decision == "acknowledged" and not action:
        raise HTTPException(400, "Say what action was taken.")
    to_state = "decided" if body.decision == "acknowledged" else "closed"
    _transition(ticket_id, to_state, _who(s), "decide", ("open", "escalated", "returned", "signoff_requested"),
                {"decision": body.decision, "action_taken": action, "note": note}, decided=body.decision)
    otype = (rec["bundle"].get("result") or {}).get("output_type")
    if otype in ("internal_action_note", "no_draft") and db.get_review(run_id, ticket_id)["state"] != "sent":
        db.save_review(run_id, ticket_id, "acknowledged" if otype == "internal_action_note" else "closed", None, action or note or None)
        try:
            import scheduler
            scheduler.on_review_change(run_id, ticket_id, "acknowledged")
        except Exception:
            pass
    _publish("ticket.decided", ticket_id, {"decision": body.decision}, s, subjects=_requesters(ticket_id))
    return _detail_payload(ticket_id)




# ================================================================================================ tier 2
def _person_name(email):
    e = identity._employees_by_email().get((email or "").lower())
    return identity._full(e) if e else email


# ------------------------------------------------------------------------------------------------ expertise and routing
EXPERTISE_CATEGORIES = ("status", "documents", "fraud", "bank_change", "returns", "conflicts", "priority")
EXCEPTION_RULES = {"fraud", "returned_payment", "records_conflict", "unauthorized_sender", "foreign_reference",
                   "not_on_file_linked", "linked_ticket_unavailable", "paid_not_received", "multi_needs_human", "injection_suspected"}
SEED_EXCEPTIONS = ("ulla.abernathy@orchestra-mock.example",)   # the specialist with the most replies handles exceptions


def _count_agent_replies():
    """Agent replies per email, counted across data/tickets.json and data/linked_tickets.json."""
    counts = {}
    try:
        main = json.loads((identity.DATA / "tickets.json").read_text(encoding="utf-8"))
        linked = json.loads((identity.DATA / "linked_tickets.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return counts
    agents = {u["id"]: u["email"].lower() for u in main.get("users", []) if u.get("role") == "agent"}
    for doc in (main, linked):
        for t in doc.get("tickets", []):
            for c in t.get("comments", []):
                who = agents.get(c.get("author_id"))
                if who:
                    counts[who] = counts.get(who, 0) + 1
    return counts


def _seed_expertise():
    if db._one("SELECT 1 AS n FROM expertise LIMIT 1"):
        return
    counts = _count_agent_replies()
    emps = identity._employees_by_email()
    for email in identity.SPECIALISTS:
        e = emps.get(email)
        exc = email in SEED_EXCEPTIONS
        cats = ["status", "documents"] + (["fraud", "bank_change", "returns", "conflicts"] if exc else [])
        db._exec("INSERT OR IGNORE INTO expertise (email, name, replies, exceptions, categories) VALUES (?,?,?,?,?)",
                 (email, identity._full(e) if e else email, counts.get(email, 0), int(exc), json.dumps(cats)))


def _people():
    return [{"email": r["email"], "name": r["name"], "replies": r["replies"], "exceptions": bool(r["exceptions"]),
             "categories": json.loads(r["categories"] or "[]")}
            for r in db._all("SELECT * FROM expertise ORDER BY email")]


def route_kind(bundle):
    """exception (fraud, bank change, returns, conflicts) | priority | round_robin (status and documents)."""
    cat = signoff_category(bundle)
    if cat == "priority":
        return "priority"
    rule = (bundle.get("decision") or {}).get("rule")
    if cat in ("fraud", "returned") or rule in EXCEPTION_RULES:
        return "exception"
    return "round_robin"


def route(ticket_id):
    """Who an unassigned ticket belongs to: the exceptions specialist for exceptions, otherwise round-robin by ticket id."""
    run_id = inbox_run()
    rec = db.get_ticket(run_id, ticket_id) if run_id else None
    people = _people()
    if not rec or not people:
        return None
    pool = people
    if route_kind(rec["bundle"]) == "exception":
        pool = [p for p in people if p["exceptions"]] or people
    return pool[ticket_id % len(pool)]["email"]


def assign_auto(ticket_id):
    """Persist the routed assignee for an unassigned ticket and tell them. The inbox may call this when a ticket arrives."""
    with _LOCK:
        row = _ensure_row(ticket_id)
        if row["assignee"]:
            return row["assignee"]
        who = route(ticket_id)
        if not who:
            return None
        db._exec("UPDATE workflow_state SET assignee=?, updated_at=? WHERE ticket_id=?", (who, appclock.now(), ticket_id))
        _audit(ticket_id, "system", "assign", row["state"], row["state"], {"to": who, "by": "routing"})
    run_id = inbox_run()
    rec = db.get_ticket(run_id, ticket_id) if run_id else None
    cfo = {"cfo"} if rec and route_kind(rec["bundle"]) == "priority" else set()   # priority is also visible to the CFO
    live.publish("ticket.assigned", {"ticket_id": ticket_id, "assignee": who, "assignee_name": _person_name(who)},
                 roles=cfo, subjects={who})
    return who


class ExpertiseEntry(BaseModel):
    email: str = Field(max_length=320)
    exceptions: bool = False
    categories: list = Field(default_factory=list, max_length=20)


class ExpertiseBody(BaseModel):
    people: list = Field(max_length=20)


@router.get("/api/workflow/expertise")
def api_expertise(s=Depends(staff_guard)):
    return {"people": _people(), "source": "agent replies in data/tickets.json and data/linked_tickets.json"}


@router.put("/api/workflow/expertise")
def api_set_expertise(body: ExpertiseBody, s=Depends(cfo_guard)):
    known = {p["email"] for p in _people()}
    updates = []
    for raw in body.people:
        try:
            e = ExpertiseEntry(**raw)
        except Exception:
            raise HTTPException(400, "Each person needs an email, exceptions (true or false) and a list of categories.")
        if e.email.lower() not in known:
            raise HTTPException(400, f"{e.email} is not one of the specialists.")
        bad = [c for c in e.categories if c not in EXPERTISE_CATEGORIES]
        if bad:
            raise HTTPException(400, "Unknown category: " + ", ".join(str(b) for b in bad))
        updates.append((e.email.lower(), int(e.exceptions), json.dumps(sorted(set(e.categories)))))
    for email, exc, cats in updates:
        db._exec("UPDATE expertise SET exceptions=?, categories=? WHERE email=?", (exc, cats, email))
    _audit(0, s.subject, "expertise", None, None, {"people": [u[0] for u in updates]})
    return {"people": _people()}


class AssignBody(BaseModel):
    to: str = Field(max_length=320)


@router.post("/api/workflow/{ticket_id}/assign")
def api_assign(ticket_id: int, body: AssignBody, s=Depends(staff_guard)):
    _need_ticket(ticket_id)
    to = body.to.strip().lower()
    if to not in {p["email"] for p in _people()} | {identity.CFO_EMAIL}:
        raise HTTPException(400, "Assign to a specialist or the CFO.")
    with _LOCK:
        row = _ensure_row(ticket_id)
        if row["state"] in ("sent", "closed", "decided"):
            raise HTTPException(409, f"That can't be done while the ticket is {row['state']}.")
        db._exec("UPDATE workflow_state SET assignee=?, updated_at=? WHERE ticket_id=?", (to, appclock.now(), ticket_id))
        _audit(ticket_id, s.subject, "assign", row["state"], row["state"], {"to": to, "from": row["assignee"]})
    _publish("ticket.assigned", ticket_id, {"assignee": to, "assignee_name": _person_name(to)}, s, roles=set(), subjects={to, s.subject})
    return _detail_payload(ticket_id)


# ------------------------------------------------------------------------------------------------ outbound items (chase, W-9 request)
OUTBOUND_KINDS = ("approver_nudge", "w9_request")
_EMAIL_OK = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$")


def _egress():
    import runner
    runner._proto_on_path()
    import egress_guard
    return egress_guard


def _problems_for(subject, body, to, meta):
    """Problems per the shared outbound gate. Fails closed: a gate that cannot load is itself a problem."""
    try:
        eg = _egress()
    except Exception as e:
        return [f"the safety check is unavailable ({type(e).__name__})"]
    meta = meta or {}
    refs = [str(r) for r in meta.get("refs", [])]
    dates = meta.get("dates", [])
    # Record dates and numbers the text may carry (a bill's entry date, its number, the ticket ids) are passed as record facts.
    outcomes = [{"ref": r, "outcome": "pending", "payment": {f"d{i}": d for i, d in enumerate(dates)}, "run": None}
                for r in meta.get("tran_ids", [])]
    found = list(eg.check_outbound(body or "", outcomes=outcomes, refs=refs, recipient=to))
    found += ["subject: " + p for p in eg.check_outbound(subject or "", recipient=to)]
    return found


def create_outbound(kind, to_email, subject, body, *, created_by, ticket_id=None, vendor_id=None, meta=None):
    """Queue a message for review. The text comes from records; nothing is sent until a person approves and sends it."""
    if kind not in OUTBOUND_KINDS:
        raise ValueError(f"unknown outbound kind {kind!r}")
    to = (to_email or "").strip()
    if not _EMAIL_OK.match(to):
        raise ValueError("the recipient address is not valid")
    if not (body or "").strip() or not (subject or "").strip():
        raise ValueError("the message is empty")
    with _LOCK:
        db._exec("INSERT INTO outbound (kind, ticket_id, vendor_id, to_email, subject, body, state, created_by, created_at, meta)"
                 " VALUES (?,?,?,?,?,?,?,?,?,?)",
                 (kind, ticket_id, vendor_id, to, subject.strip(), body, "pending", created_by, appclock.now(), json.dumps(meta or {})))
        oid = db._one("SELECT MAX(id) AS id FROM outbound")["id"]
        if ticket_id:
            _audit(ticket_id, created_by, kind, None, None, {"outbound_id": oid, "to": to})
    payload = {"outbound_id": oid, "kind": kind}
    if ticket_id:
        payload["ticket_id"] = ticket_id
    live.publish("outbound.created", payload)
    return oid


def _outbound_out(r, with_problems=True):
    meta = json.loads(r["meta"] or "{}")
    return {"id": r["id"], "kind": r["kind"], "ticket_id": r["ticket_id"], "vendor_id": r["vendor_id"], "to": r["to_email"],
            "to_name": _person_name(r["to_email"]) if r["kind"] == "approver_nudge" else None,
            "subject": r["subject"], "body": r["body"], "state": r["state"], "created_by": r["created_by"],
            "created_at": appclock.iso(r["created_at"]), "approved_by": r["approved_by"],
            "sent_at": appclock.iso(r["sent_at"]) if r["sent_at"] else None, "message_id": r["message_id"],
            "problems": _problems_for(r["subject"], r["body"], r["to_email"], meta) if with_problems and r["state"] != "sent" else []}


def _outbound_row(oid):
    r = db._one("SELECT * FROM outbound WHERE id=?", (oid,))
    if not r:
        raise HTTPException(404, "message not found")
    return r


class OutboundState(BaseModel):
    state: str = Field(max_length=20)


@router.get("/api/outbound")
def api_outbound(kind: str = "", s=Depends(staff_guard)):
    rows = db._all("SELECT * FROM outbound " + ("WHERE kind=? " if kind else "") + "ORDER BY id DESC LIMIT 200", (kind,) if kind else ())
    return {"rows": [_outbound_out(r) for r in rows]}


@router.put("/api/outbound/{oid}")
def api_outbound_state(oid: int, body: OutboundState, s=Depends(staff_guard)):
    if body.state not in ("approved", "pending"):
        raise HTTPException(422, "state must be approved or pending")
    with _LOCK:
        r = _outbound_row(oid)
        if r["state"] == "sent":
            raise HTTPException(409, "This was already sent.")
        if body.state == "approved":
            problems = _problems_for(r["subject"], r["body"], r["to_email"], json.loads(r["meta"] or "{}"))
            if problems:
                raise HTTPException(422, "This can't be approved: it has " + "; ".join(problems) + ".")
        db._exec("UPDATE outbound SET state=?, approved_by=? WHERE id=?",
                 (body.state, s.subject if body.state == "approved" else None, oid))
    return _outbound_out(_outbound_row(oid))


@router.post("/api/outbound/{oid}/send")
def api_outbound_send(oid: int, s=Depends(staff_guard)):
    """Recipient, subject and body come from the stored row, never from the request, and are checked again here."""
    import mailer
    with _LOCK:
        r = _outbound_row(oid)
        if r["state"] == "sent":
            raise HTTPException(409, "This was already sent.")
        if r["state"] != "approved":
            raise HTTPException(409, "Approve it before sending.")
        problems = _problems_for(r["subject"], r["body"], r["to_email"], json.loads(r["meta"] or "{}"))
        if problems:
            raise HTTPException(422, "This can't be sent: it has " + "; ".join(problems) + ".")
        msg = mailer.Message(sender=mailer.default_sender(None), to=r["to_email"], subject=r["subject"], body=r["body"],
                             ticket_id=r["ticket_id"] or 0, headers={"X-Conductor-Outbound": f"{r['kind']}:{oid}"})
        try:
            info = mailer.get_mailer().send(msg)
        except mailer.MailError as e:
            raise HTTPException(502, str(e))
        db._exec("UPDATE outbound SET state='sent', sent_at=?, message_id=? WHERE id=?", (appclock.now(), info.get("id"), oid))
        if r["ticket_id"]:
            _audit(r["ticket_id"], s.subject, "outbound-sent", None, None, {"outbound_id": oid, "kind": r["kind"], "to": r["to_email"]})
    live.publish("outbound.sent", {"outbound_id": oid, "kind": r["kind"], "ticket_id": r["ticket_id"], "actor": s.actor})
    return _outbound_out(_outbound_row(oid))


# ------------------------------------------------------------------------------------------------ chase, forward, no-reply
_INDEX_CACHE = {}


def _run_store(request, run_id):
    run = db.get_run(run_id)
    path = (run or {}).get("dataset_path")
    store = request.app.state.get_manager().store_for(path) if path and path != "None" else None
    if store is None:
        raise HTTPException(409, "This ticket's records are not available.")
    import runner
    runner._proto_on_path()
    return store


def _ticket_index(request, run_id):
    """(batch_groups.ticket_index over every ticket in the inbox run, store). Cached until the ticket count changes."""
    key = (run_id, db.count_tickets(run_id))
    if key not in _INDEX_CACHE:
        _INDEX_CACHE.clear()
        store = _run_store(request, run_id)
        import batch_groups
        bundles = []
        for row in db.list_rows(run_id):
            rec = db.get_ticket(run_id, row["ticket_id"])
            if rec and (rec["bundle"].get("decision") or {}).get("rule"):
                bundles.append(rec["bundle"])
        _INDEX_CACHE[key] = (batch_groups.ticket_index(bundles, store), store)
    return _INDEX_CACHE[key]


@router.post("/api/workflow/{ticket_id}/chase")
def api_chase(ticket_id: int, request: Request, s=Depends(staff_guard)):
    run_id, rec = _need_ticket(ticket_id)
    dec = rec["bundle"].get("decision") or {}
    if dec.get("rule") not in ("pending_approval", "pending_inactive_approver"):
        raise HTTPException(409, "This ticket is not waiting on an approver.")
    if db._one("SELECT id FROM outbound WHERE kind='approver_nudge' AND ticket_id=? AND state IN ('pending','approved')", (ticket_id,)):
        raise HTTPException(409, "A nudge for this ticket is already waiting for review.")
    store = _run_store(request, run_id)
    import approver_digest
    import batch_groups
    idx = batch_groups.ticket_index([rec["bundle"]], store)
    d = next((x for x in approver_digest.build(idx, store)["digests"] if x["act_by"]), None)
    if d is None:
        raise HTTPException(409, "No approver is on record for this bill.")
    if d["egress_problems"]:
        raise HTTPException(422, "The nudge failed the internal check: " + "; ".join(d["egress_problems"]) + ".")
    subject = f"Approvals waiting on you ({len(d['bills'])})"
    meta = {"tran_ids": [b["tranId"] for b in d["bills"]],
            "refs": [b["tranId"] for b in d["bills"]] + [str(t) for b in d["bills"] for t in b["ticket_ids"]],
            "dates": [b["bill_date"] for b in d["bills"] if b.get("bill_date")]}
    problems = _problems_for(subject, d["text"], d["act_by"], meta)
    if problems:
        raise HTTPException(422, "The nudge can't be queued: it has " + "; ".join(problems) + ".")
    oid = create_outbound("approver_nudge", d["act_by"], subject, d["text"], created_by=s.subject, ticket_id=ticket_id, meta=meta)
    _audit(ticket_id, s.subject, "chase", None, None, {"outbound_id": oid, "approver": d["act_by"]})
    return {"outbound_id": oid, **_detail_payload(ticket_id)}


class ForwardBody(BaseModel):
    to: str = Field(max_length=10)
    note: str = Field(default="", max_length=2000)


def _forward_target(to):
    if to == "hr":
        e = identity._employees_by_email().get("quinn.ellsworth@orchestra-mock.example")
        return {"id": "hr", "name": identity._full(e) if e else "HR", "title": (e or {}).get("title"), "email": (e or {}).get("email")}
    return {"id": "ar", "name": "AR queue", "title": None, "email": None}


def _close_review(run_id, ticket_id, rec):
    otype = (rec["bundle"].get("result") or {}).get("output_type")
    if otype == "no_draft" and db.get_review(run_id, ticket_id)["state"] != "sent":
        db.save_review(run_id, ticket_id, "closed", None, None)


@router.post("/api/workflow/{ticket_id}/forward")
def api_forward(ticket_id: int, body: ForwardBody, s=Depends(staff_guard)):
    """Records that misrouted mail was handed to HR or the AR queue. Conductor sends nothing."""
    run_id, rec = _need_ticket(ticket_id)
    if body.to not in ("hr", "ar"):
        raise HTTPException(400, "Forward to hr or ar.")
    if signoff_category(rec["bundle"]):
        raise HTTPException(409, "The CFO decides this ticket. Escalate it instead.")
    target = _forward_target(body.to)
    _transition(ticket_id, "closed", s.subject, "forward", ("open", "returned"), {"to": target, "note": body.note.strip()})
    _close_review(run_id, ticket_id, rec)
    _publish("ticket.decided", ticket_id, {"decision": "forwarded", "forwarded_to": target["name"]}, s)
    return {"forwarded_to": target, **_detail_payload(ticket_id)}


@router.post("/api/workflow/{ticket_id}/no-reply")
def api_no_reply(ticket_id: int, body: NoteBody, s=Depends(staff_guard)):
    run_id, rec = _need_ticket(ticket_id)
    if signoff_category(rec["bundle"]):
        raise HTTPException(409, "The CFO decides this ticket. Escalate it instead.")
    _transition(ticket_id, "closed", s.subject, "no-reply", ("open", "returned"), {"note": body.note.strip()})
    _close_review(run_id, ticket_id, rec)
    _publish("ticket.decided", ticket_id, {"decision": "no_reply"}, s)
    return _detail_payload(ticket_id)


# ------------------------------------------------------------------------------------------------ approver
class CommitBody(BaseModel):
    date: str = Field(max_length=10)


def _bill_rows_for(email):
    return [b for b in identity.pending_bills() if identity.approver_for(b.get("nextApprover")) == email]


def _approver_action(bill_id, approver, kind):
    return db._one("SELECT * FROM approver_actions WHERE bill_id=? AND approver=? AND kind=? ORDER BY at DESC LIMIT 1",
                   (bill_id, approver, kind))


@router.get("/api/approver/queue")
def api_approver_queue(request: Request, approver: str = "", s=Depends(identity.require_role("approver", "cfo"))):
    if s.role == "approver":
        who = s.subject
    else:   # the CFO reads: one approver with ?approver=, otherwise everyone
        who = approver.strip().lower() or None
    emails = [who] if who else sorted(identity.approver_emails())
    blocked, digest_text = {}, None
    run_id = inbox_run()
    index = store = None
    if run_id:
        try:
            index, store = _ticket_index(request, run_id)
        except HTTPException:
            index = None
    if index:
        for tid, x in index.items():
            rec = db.get_ticket(run_id, tid)
            for bid in {i["bill"]["internalId"] for i in x["items"] if i["status"] == "found"}:
                blocked.setdefault(bid, []).append({"ticket_id": tid, "subject": (rec or {}).get("ticket", {}).get("subject"),
                                                    "from_name": ((rec or {}).get("row") or {}).get("sender_name")})
        if who:
            import approver_digest
            digest_text = next((d["text"] for d in approver_digest.build(index, store)["digests"] if d["act_by"] == who), None)
    bills = []
    for em in emails:
        for b in _bill_rows_for(em):
            commit, ack = _approver_action(b["internalId"], em, "commit"), _approver_action(b["internalId"], em, "ack")
            bills.append({"bill_id": b["internalId"], "tranId": b["tranId"], "vendor": b["entityName"],
                          "amount": float(b["userTotal"] or 0), "status": b["status"], "since": b["tranDate"], "approver": em,
                          "blocked_tickets": blocked.get(b["internalId"], []),
                          "commitment": {"date": commit["date"], "at": appclock.iso(commit["at"])} if commit else None,
                          "acknowledged": {"at": appclock.iso(ack["at"])} if ack else None})
    bills.sort(key=lambda b: (-len(b["blocked_tickets"]), b["since"] or ""))
    return {"bills": bills, "digest": digest_text}


def _own_bill(bill_id, s):
    b = next((x for x in _bill_rows_for(s.subject) if x["internalId"] == bill_id), None)
    if not b:
        raise HTTPException(404, "That bill isn't waiting on you.")
    return b


@router.post("/api/approver/bills/{bill_id}/ack")
def api_approver_ack(bill_id: str, s=Depends(identity.require_role("approver"))):
    _own_bill(bill_id, s)
    db._exec("INSERT INTO approver_actions (bill_id, approver, kind, date, at) VALUES (?,?,?,?,?)",
             (bill_id, s.subject, "ack", None, appclock.now()))
    return {"ok": True}


@router.post("/api/approver/bills/{bill_id}/commit")
def api_approver_commit(bill_id: str, body: CommitBody, s=Depends(identity.require_role("approver"))):
    """Internal only. The date is for the AP team; no vendor route reads it."""
    _own_bill(bill_id, s)
    try:
        day = dt.date.fromisoformat(body.date)
    except ValueError:
        raise HTTPException(400, "Use a date like 2026-11-20.")
    today = appclock.today()
    if day < today or day > today + dt.timedelta(days=365):
        raise HTTPException(400, "Pick a date from today to one year ahead.")
    db._exec("INSERT INTO approver_actions (bill_id, approver, kind, date, at) VALUES (?,?,?,?,?)",
             (bill_id, s.subject, "commit", day.isoformat(), appclock.now()))
    live.publish("approver.committed", {"bill_id": bill_id, "approver": s.subject, "date": day.isoformat(), "actor": s.actor})
    return {"ok": True, "date": day.isoformat()}


# ------------------------------------------------------------------------------------------------ team overview
SOURCE = "practice data, snapshot Nov 13"
BASELINE_DAYS = 1.5


def _ts(text):
    try:
        return dt.datetime.fromisoformat((text or "").replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _median(xs):
    xs = sorted(xs)
    if not xs:
        return None
    mid = len(xs) // 2
    return xs[mid] if len(xs) % 2 else (xs[mid - 1] + xs[mid]) / 2


@router.get("/api/team/overview")
def api_team_overview(request: Request, s=Depends(cfo_guard)):
    import feedback
    out = {"as_of": appclock.iso(), "source": SOURCE, "available": False, "feedback": feedback.trends(),
           "activity": {"rows": live.recent(s, 50), "source": "live events since the server started"}}
    run_id = inbox_run()
    if not run_id:
        return out
    out["available"] = True
    reviews = db.review_states(run_id)
    people = {p["email"]: p for p in _people()}
    by_state, by_person, ages, replies, follow = {}, {}, [], [], 0
    rows = db.list_rows(run_id)
    now = appclock.now()
    for r in rows:
        tid = r["ticket_id"]
        st = get_state(tid)
        rv = reviews.get(tid) or {}
        rec = db.get_ticket(run_id, tid)
        ticket = rec["ticket"] if rec else {}
        created = _ts(ticket.get("created_at"))
        linked = next((f.get("value") for f in (ticket.get("custom_fields") or []) if f.get("id") == "linked_ticket_ids"), None)
        follow += bool(linked)
        done = rv.get("state") in ("sent", "acknowledged", "closed") or st["state"] in ("sent", "closed", "decided")
        state = "sent" if rv.get("state") == "sent" else st["state"]
        by_state[state] = by_state.get(state, 0) + 1
        if not done and r["output_type"] != "no_draft":
            row = by_person.setdefault(st["assignee"] or "unassigned", {"open": 0, "escalated": 0, "returned": 0})
            row["open"] += 1
            row["escalated"] += st["state"] in ("escalated", "signoff_requested")
            row["returned"] += st["state"] == "returned"
            if created:
                ages.append((now - created) / 86400)
        if rv.get("sent_at") and created:
            replies.append((rv["sent_at"] + appclock._offset(rv["sent_at"]) - created) / 86400)
    buckets = [("under 1 day", 0, 1), ("1 to 1.5 days", 1, 1.5), ("1.5 to 3 days", 1.5, 3), ("over 3 days", 3, 10 ** 6)]
    waiting = round(_median(ages), 2) if ages else None
    med = _median(replies)
    out["queues"] = {"by_state": [{"state": k, "count": v} for k, v in sorted(by_state.items())],
                     "by_specialist": [{"email": e, "name": (people.get(e) or {}).get("name") or e, **v} for e, v in sorted(by_person.items())],
                     "total": len(rows), "source": SOURCE}
    out["aging"] = {"buckets": [{"label": n, "count": sum(1 for a in ages if lo <= a < hi)} for n, lo, hi in buckets],
                    "median_open_days": waiting, "basis": "tickets still waiting on a person, by age since received", "source": SOURCE}
    out["first_reply"] = {"median_days": round(med, 2) if med is not None else None, "replies_sent": len(replies),
                          "baseline_days": BASELINE_DAYS, "baseline_note": "In the case, a first reply takes more than 1.5 days.",
                          "waiting_now_median_days": waiting,
                          "beats_baseline": (med <= BASELINE_DAYS) if med is not None else None, "source": SOURCE}
    out["follow_up_rate"] = {"pct": round(100 * follow / len(rows), 1) if rows else None, "follow_ups": follow, "tickets": len(rows),
                             "basis": "tickets that point to an earlier ticket", "source": SOURCE}
    out["bottlenecks"] = _bottlenecks(request, run_id)
    out["ahead"] = _ahead(run_id)
    return out


def _bottlenecks(request, run_id):
    try:
        index, store = _ticket_index(request, run_id)
        import approver_digest
        digests = approver_digest.build(index, store)["digests"]
    except Exception:
        return {"rows": [], "source": SOURCE}
    rows = []
    for d in digests:
        blocked = sorted({t for b in d["bills"] for t in b["ticket_ids"]})
        rows.append({"approver": d["act_by"], "name": d["approver_name"], "blocked_tickets": blocked, "blocked_count": len(blocked),
                     "bills": len(d["bills"]), "delegate_note": d.get("delegate_note")})
    rows.sort(key=lambda r: -r["blocked_count"])
    return {"rows": rows, "source": SOURCE}


def _ahead(run_id):
    try:
        import direct
        lookups = direct.lookup_count()
    except Exception:
        lookups = 0
    p = db.get_prevention(run_id) or {}
    rep = (p.get("report") or {}).get("preventable_by_notice")
    return {"self_serve_lookups": {"value": lookups, "label": "Vendor self-serve lookups (not counted as tickets prevented)", "source": SOURCE},
            "prevented": {"value": rep["count"] if rep else None,
                          "label": "Tickets a drafted notice would have prevented (estimate)", "source": SOURCE}}


# `GET /api/workflow/{ticket_id}` would swallow the fixed paths below it (expertise), so list the fixed paths first.
router.routes.sort(key=lambda r: 0 if getattr(r, "path", "").rsplit("/", 1)[-1] in ("expertise", "escalations", "audit") else 1)
