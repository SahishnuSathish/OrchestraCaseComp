"""Inbox sync: the hidden inbox run, held-back arrivals, threads, queues, write-back, Advanced.

Owner: p3/inbox-sync. Contract: docs/phase3/CONTRACTS.md section 5 (and 7, 8, 11).

The inbox sits on ONE persistent run (`runs.source = 'inbox'`, id in settings `inbox.run_id`). It reads every ticket in
`data/tickets.json` except the last 8 by `created_at`, with no model, through the same storage path a run uses, so every
existing `/api/runs/{id}/...` route works on it. The 8 held-back tickets arrive later through `ingest`. A user overlay
(table `inbox_users`) lets new requesters exist for the pipeline without writing `data/`.
"""
import json
import random
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import appclock
import connectors
import db
import delivery
import documents
import identity
import live
import mailer
import reply_checks
import runner
import scheduler
import workflow

router = APIRouter()
STAFF = ("ap_specialist", "cfo")
staff_only = [Depends(identity.require_role(*STAFF))]
cfo_only = [Depends(identity.require_role("cfo"))]

RUN_KEY = "inbox.run_id"
CONNECTED_KEY = "inbox.connected_at"
CADENCE_KEY = "inbox.cadence"
DEFAULT_CADENCE = [30, 90]
HELD_BACK = 8
READING_SECONDS = 1.0       # how long a new arrival shows "Reading..." before its outcome appears
AUTOSYNC = True             # tests turn the background arrivals off
SIGNED_OFF = {"approved", "sent", "acknowledged", "closed"}

QUEUES = [("needs_reply", "Needs reply"), ("needs_action", "Needs action"), ("escalated", "Escalated"),
          ("returned", "Returned to me"), ("waiting_approver", "Waiting on approver"), ("waiting_vendor", "Waiting on vendor"),
          ("scheduled", "Scheduled"), ("sent", "Sent"), ("closed", "Closed")]
OUTCOME = {"draft_reply": "draft_ready", "internal_action_note": "action_needed", "no_draft": "no_reply"}

_BUILD_LOCK = threading.RLock()     # building / resetting the inbox run
_LOCK = threading.RLock()           # store, caches, reservations
_INGEST_LOCK = threading.RLock()    # one ticket through the pipeline at a time (the Store is shared)
_ARRIVE_LOCK = threading.RLock()    # one arrival at a time
_STORE = None
_META = {"run": None, "rows": {}}   # tid -> derived facts for the current inbox run
_GROUPS = {"key": None, "map": {}}
_READING = set()
_reserved = 0


# ---------------------------------------------------------------------------- schema
def init_schema():
    db._exec("CREATE TABLE IF NOT EXISTS inbox_users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, role TEXT)")
    db._exec("CREATE TABLE IF NOT EXISTS inbox_state (ticket_id INTEGER PRIMARY KEY, zendesk_status TEXT, sent_folder INTEGER DEFAULT 0,"
             " arrived_at REAL, source TEXT)")
    have = {r["name"] for r in db._all("PRAGMA table_info(inbox_state)")}
    for col, typ in (("ticket_json", "TEXT"), ("internal_note", "TEXT"), ("sent_by", "TEXT"), ("sent_at", "REAL")):
        if col not in have:
            db._exec(f"ALTER TABLE inbox_state ADD COLUMN {col} {typ}")
    # Hooks (CONTRACTS 7 and 11). Re-registering after a second db.init() must not double them.
    delivery.ON_SENT[:] = [h for h in delivery.ON_SENT if getattr(h, "__name__", "") != "inbox_write_back"] + [inbox_write_back]
    delivery.ON_NOTICE_SENT[:] = [h for h in delivery.ON_NOTICE_SENT if getattr(h, "__name__", "") != "inbox_ahead_sent"] + [inbox_ahead_sent]


# ---------------------------------------------------------------------------- the data store (read-only) with the user overlay
def _overlay_users():
    return [dict(r) for r in db._all("SELECT id, name, email, role FROM inbox_users")]


def _fresh_store():
    return runner.make_store(users=_overlay_users())


def _get_store():
    global _STORE
    with _LOCK:
        if _STORE is None:
            _STORE = _fresh_store()
            for r in db._all("SELECT ticket_id, ticket_json FROM inbox_state WHERE ticket_json IS NOT NULL"):
                t = json.loads(r["ticket_json"])
                _STORE.backend.tickets[t["id"]] = t
        return _STORE


def _drop_caches():
    global _STORE, _reserved
    with _LOCK:
        _STORE = None
        _reserved = 0
        _META.update(run=None, rows={})
        _GROUPS.update(key=None, map={})
        _READING.clear()


def held_back_ids(store=None):
    """The last 8 tickets of data/tickets.json by created_at, oldest first (ties keep file order)."""
    ts = (store or _get_store()).backend.list_tickets()
    order = sorted(range(len(ts)), key=lambda i: (ts[i].get("created_at") or "", i))
    return [ts[i]["id"] for i in order[-HELD_BACK:]]


def new_ticket_id():
    """The next free ticket id above every id in tickets.json, linked_tickets.json and the overlay. Never repeats in a process."""
    global _reserved
    with _LOCK:
        store = _get_store()
        top = max([t for t in store.backend.tickets] + [r["ticket_id"] for r in db._all("SELECT ticket_id FROM inbox_state")] + [0])
        _reserved = max(_reserved, top) + 1
        return _reserved


def new_user_id():
    """A free requester id for a user that is not in the data (for Direct questions)."""
    with _LOCK:
        store = _get_store()
        return max([u for u in store.backend.users] + [r["id"] for r in db._all("SELECT id FROM inbox_users")] + [900000]) + 1


# ---------------------------------------------------------------------------- the inbox run
def _run_ready(rid):
    r = db.get_run(rid) if rid else None
    return bool(r and r["status"] == "done")


def inbox_run_id():
    """The inbox run's id. Created on first call (safe from many threads at once); rebuilt if it was lost or half built."""
    rid = db.get_setting(RUN_KEY)
    if _run_ready(rid):
        return rid
    with _BUILD_LOCK:
        rid = db.get_setting(RUN_KEY)
        if _run_ready(rid):
            return rid
        if rid:  # half built (the server stopped mid-build) or deleted from Runs: start again
            documents.clear_run(rid)
            db.delete_run(rid)
        return _build()


def _build():
    store = _fresh_store()
    held = set(held_back_ids(store))
    tickets = [t for t in store.backend.list_tickets() if t["id"] not in held]
    run_id = uuid.uuid4().hex[:8]
    db.create_run(run_id, runner.DEFAULT_DATASET, "inbox", False, None, len(tickets), label="Inbox", status="running")
    db.set_setting(RUN_KEY, run_id)  # set first: a build that dies is found, deleted and redone on the next call
    try:
        runner.process_tickets(run_id, tickets, store, batch=True)
        db.update_run(run_id, status="done", done=len(tickets), finished_at=time.time())
    except Exception:
        db.delete_run(run_id)
        db.delete_setting(RUN_KEY)
        raise
    _drop_caches()
    db.set_setting(CONNECTED_KEY, appclock.now())
    connectors.log(f"Zendesk ({connectors.ZENDESK_HOST}) connected: read {len(tickets)} tickets", "zendesk")
    connectors.log(f"Outlook ({connectors.OUTLOOK_ADDRESS}) connected", "outlook")
    connectors.log("NetSuite connected (read-only)", "netsuite")
    connectors.log(f"Conductor read {len(tickets)} emails; {len(held)} more will arrive", "zendesk")
    return run_id


def reset():
    """Delete the inbox run and everything keyed to it, then rebuild it from the data. Held-back tickets wait again."""
    stop_sync()
    with _BUILD_LOCK:
        rid = db.get_setting(RUN_KEY)
        if rid:
            documents.clear_run(rid)
            db.delete_run(rid)
        db.delete_setting(RUN_KEY)
        db._exec("DELETE FROM inbox_state")
        db._exec("DELETE FROM inbox_users")
        _drop_caches()
        connectors.log("Inbox reset: tickets read again from the data", "zendesk")
        new = _build()
    _publish_counts()
    _publish_sync_status()
    return {"run_id": new, "old_run_id": rid, "read": db.count_tickets(new), "held_back": len(_pending_ids(new))}


def _pending_ids(run_id=None):
    run_id = run_id or inbox_run_id()
    have = {r["ticket_id"] for r in db._all("SELECT ticket_id FROM tickets WHERE run_id=?", (run_id,))}
    return [t for t in held_back_ids() if t not in have]


# ---------------------------------------------------------------------------- ingest
def _outcome_of(output_type):
    return OUTCOME.get(output_type, "action_needed")


def ingest(ticket, user=None, source="zendesk", reading_seconds=0.0):
    """Bring one ticket into the inbox: store its requester in the overlay, run the pipeline on it, save it like a run does,
    and publish ticket.arrived, then ticket.outcome and queue.counts. Returns the ticket id.
    `ticket` has the tickets.json shape, `user` the users shape. data/ is never written."""
    run_id = inbox_run_id()
    ticket = dict(ticket)
    if ticket.get("id") is None:
        ticket["id"] = new_ticket_id()
    tid = int(ticket["id"])
    ticket["id"] = tid
    with _INGEST_LOCK:
        store = _get_store()
        if db.get_ticket(run_id, tid):  # already here: arriving twice must not read it twice
            return tid
        if user:
            u = {"id": int(user["id"]), "name": user.get("name"), "email": user.get("email"), "role": user.get("role") or "end-user"}
            db._exec("INSERT OR REPLACE INTO inbox_users (id, name, email, role) VALUES (?,?,?,?)", (u["id"], u["name"], u["email"], u["role"]))
            store.backend.users[u["id"]] = u
        now = appclock.now()
        ticket.setdefault("created_at", appclock.iso(now))
        ticket.setdefault("updated_at", ticket["created_at"])
        ticket.setdefault("status", "open")
        in_file = any(t["id"] == tid for t in store.backend.list_tickets())
        store.backend.tickets.setdefault(tid, ticket)
        seq = db.count_tickets(run_id) + 1
        _READING.add(tid)
        db._exec("INSERT OR REPLACE INTO inbox_state (ticket_id, zendesk_status, sent_folder, arrived_at, source, ticket_json)"
                 " VALUES (?,?,0,?,?,?)", (tid, ticket.get("status") or "open", now, source, None if in_file else json.dumps(ticket)))
        try:
            rows = runner.process_tickets(run_id, [ticket], store, start_seq=seq)
        except Exception:
            _READING.discard(tid)
            db._exec("DELETE FROM inbox_state WHERE ticket_id=?", (tid,))
            raise
        db.update_run(run_id, total=seq, done=seq)
        with _LOCK:
            _META["rows"].pop(tid, None)
            _GROUPS["key"] = None
    row = rows[0]
    m = _meta(run_id).get(tid)
    queue = _primary_queue(m, "pending") if m else "needs_action"
    who = row.get("sender_name") or row.get("sender_email") or "a sender"
    connectors.log(f"Zendesk: ticket #{tid} arrived from {who}", "zendesk")
    live.publish("ticket.arrived", {"ticket_id": tid, "queue": queue, "from_name": row.get("sender_name"), "subject": row.get("subject"),
                                    "source": source, "summary": f"New email from {who}"})

    def finish():
        _READING.discard(tid)
        live.publish("ticket.outcome", {"ticket_id": tid, "outcome": _outcome_of(row.get("output_type")), "queue": queue,
                                        "summary": f"Ticket #{tid} read"})
        _publish_counts()

    if reading_seconds and reading_seconds > 0:
        timer = threading.Timer(reading_seconds, finish)
        timer.daemon = True
        timer.start()
    else:
        finish()
    return tid


# ---------------------------------------------------------------------------- derived facts per ticket (cached in memory)
_REF_RX = re.compile(r"refs=\[(.*?)\]")


def _stage(bundle, name):
    for s in bundle.get("stages") or []:
        if s.get("name") == name:
            return s.get("summary") or ""
    return ""


def _derive(tid, bundle, ctx, row):
    res, dec = bundle.get("result") or {}, bundle.get("decision") or {}
    ot = res.get("output_type") or row.get("output_type")
    why = dec.get("why") or ""
    rule = dec.get("rule")
    flags = []
    if "fraud" in (res.get("flags") or []):
        flags.append("fraud")
    if rule == "holding_reply" and "threat" in why:
        flags.append("legal")
    if rule == "holding_reply" and "executive copied" in why:
        flags.append("exec_cc")
    if rule == "injection_suspected" or "injection" in (res.get("flags") or []):
        flags.append("injection")
    text = (res.get("text") or "").lower()
    refs_m = _REF_RX.search(_stage(bundle, "extract_regex"))
    body = re.sub(r"\s+", " ", (ctx.get("body") or "")).strip()
    return {
        "tid": tid, "ctx": ctx, "row": row, "bundle": bundle, "output_type": ot, "outcome": _outcome_of(ot),
        "rule": rule, "why": why, "act_by": dec.get("act_by"), "flags": flags, "priority": bool(res.get("priority")),
        "sender_verified": "authorized=True" in _stage(bundle, "sender"),
        "refs": re.findall(r"'([^']+)'", refs_m.group(1)) if refs_m else [],
        "ask_vendor": ot == "draft_reply" and (rule == "not_on_file" or "pdf copy" in text),
        "waiting_approver": ot == "internal_action_note" and bool(dec.get("act_by")) and str(rule or "").startswith("pending"),
        "snippet": body[:160] + ("..." if len(body) > 160 else ""),
        "company": row.get("vendor"),
    }


def _meta(run_id):
    """tid -> derived facts for every ticket of the inbox run. Loaded in one query, kept until the run changes."""
    with _LOCK:
        have = _META["rows"] if _META["run"] == run_id else {}
        if _META["run"] == run_id and len(have) == db.count_tickets(run_id):
            return have
        out = dict(have)
        for r in db._all("SELECT ticket_id, seq, bundle, ticket, row FROM tickets WHERE run_id=? ORDER BY seq", (run_id,)):
            if r["ticket_id"] in out:
                continue
            row = json.loads(r["row"])
            out[r["ticket_id"]] = _derive(r["ticket_id"], json.loads(r["bundle"]), json.loads(r["ticket"]), row)
        _META.update(run=run_id, rows=out)
        return out


def _inbox_state():
    return {r["ticket_id"]: r for r in db._all("SELECT * FROM inbox_state")}


def _scheduled(run_id):
    try:
        return {r["ticket_id"] for r in db._all("SELECT ticket_id FROM scheduled_send WHERE run_id=? AND status='scheduled'", (run_id,))}
    except Exception:
        return set()


# ---------------------------------------------------------------------------- queues
def _wf(tid):
    try:
        return workflow.get_state(tid) or {}
    except Exception:
        return {}


def _queues_for(m, review_state, wf, scheduled, viewer=None):
    """The queues a thread is in. A thread can be in more than one (a scheduled reply is also one that still needs sending)."""
    ot = m["output_type"]
    st = wf.get("state") or "open"
    sent = review_state == "sent" or st == "sent"
    decided = st in ("decided", "closed") or review_state in ("acknowledged", "closed")
    q = []
    if ot == "draft_reply" and not sent and not decided and st in ("open", "returned", "signed_off"):
        q.append("needs_reply")
    if ot == "internal_action_note" and not decided and not sent:
        q.append("needs_action")
    if st in ("escalated", "signoff_requested") and not sent:
        q.append("escalated")
    if st == "returned" and not sent and (viewer is None or (wf.get("assignee") or "").lower() == viewer.lower()):
        q.append("returned")
    if m["waiting_approver"] and not decided and not sent:
        q.append("waiting_approver")
    if sent and m["ask_vendor"]:
        q.append("waiting_vendor")
    if scheduled and not sent:
        q.append("scheduled")
    if sent:
        q.append("sent")
    if ot == "no_draft" or decided:
        q.append("closed")
    return q or ["needs_action"]


def _primary_queue(m, review_state):
    return _queues_for(m, review_state, {}, False)[0]


def _viewer(request):
    s = identity.current(request) if request is not None else None
    return (getattr(s, "subject", None) or None) if s else None


def _rows(run_id, viewer=None, only=None, with_groups=True):
    """[(ThreadRow, queues)] for every thread (or just `only`)."""
    metas = _meta(run_id)
    reviews = db.review_states(run_id)
    sched = _scheduled(run_id)
    states = _inbox_state()
    groups = _groups(run_id) if with_groups else {}
    out = []
    for tid, m in metas.items():
        if only is not None and tid != only:
            continue
        rv = (reviews.get(tid) or {}).get("state", "pending")
        wf = _wf(tid)
        st = states.get(tid) or {}
        ctx = m["ctx"]
        gid, gsize = groups.get(tid, (None, 1))
        row = {
            "ticket_id": tid, "from_name": ctx.get("sender_name"), "from_email": ctx.get("sender_email"), "company": m["company"],
            "subject": ctx.get("subject"), "snippet": m["snippet"],
            "received_at": appclock.iso(st["arrived_at"]) if st.get("arrived_at") else ctx.get("received_at"), "source": "Outlook",
            "zendesk_status": st.get("zendesk_status") or ctx.get("status") or "open", "outcome": m["outcome"],
            "intent": m["row"].get("intent"), "invoice_refs": list(m["refs"]), "flags": list(m["flags"]),
            "sender_verified": m["sender_verified"], "assignee": wf.get("assignee"), "workflow_state": wf.get("state") or "open",
            "review_state": rv, "group_id": gid, "group_size": gsize, "reading": tid in _READING,
        }
        out.append((row, _queues_for(m, rv, wf, tid in sched, viewer)))
    return out


def _groups(run_id):
    """{ticket_id: (group_id, size)} for same-invoice and follow-up threads, from src/batch_groups.py. Cached until a ticket arrives."""
    import batch_groups
    with _LOCK:
        key = (run_id, db.count_tickets(run_id))
        if _GROUPS["key"] == key:
            return _GROUPS["map"]
        runner._proto_on_path()
        bundles = [m["bundle"] for m in _meta(run_id).values() if (m["bundle"].get("decision") or {}).get("rule")]
        try:
            groups = batch_groups.build(batch_groups.ticket_index(bundles, _get_store()))["groups"]
        except Exception as e:
            print(f"[inbox] grouping failed: {type(e).__name__}: {e}", flush=True)
            groups = []
        # Same invoice (batch_groups) and follow-ups (a ticket linked to another thread of the inbox) form one group.
        metas = _meta(run_id)
        parent = {}

        def find(x):
            parent.setdefault(x, x)
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for g in groups:
            for t in g["ticket_ids"][1:]:
                parent[find(t)] = find(g["ticket_ids"][0])
        for tid, m in metas.items():
            for link in m["ctx"].get("linked_ticket_ids") or []:
                if link in metas and link != tid:
                    parent[find(tid)] = find(link)
        comps = {}
        for tid in list(parent):
            comps.setdefault(find(tid), []).append(tid)
        mp = {}
        for members in comps.values():
            if len(members) >= 2:
                gid = "g" + str(min(members))
                for t in members:
                    mp[t] = (gid, len(members))
        _GROUPS.update(key=key, map=mp)
        return mp


def counts(viewer=None, run_id=None):
    run_id = run_id or inbox_run_id()
    c = {qid: 0 for qid, _ in QUEUES}
    for _, qs in _rows(run_id, viewer, with_groups=False):
        for q in qs:
            c[q] += 1
    return c


def _publish_counts():
    try:
        live.publish("queue.counts", {"counts": counts(), "summary": "Queue counts changed"})
    except Exception as e:
        print(f"[inbox] queue.counts not published: {type(e).__name__}: {e}", flush=True)


# ---------------------------------------------------------------------------- summary
def _prevented_tickets(run_id, metas):
    """Tickets a SENT Ahead notice covers (same invoice), plus the demo notice's covered tickets once it is sent."""
    sent = {k: v for k, v in db.prevention_states(run_id).items() if v.get("state") == "sent"}
    if not sent:
        return set()
    p = db.get_prevention(run_id) or {}
    out = set()
    for n in p.get("notices") or []:
        if ("notice", n.get("key")) in sent:
            bills = set(n.get("bills") or [])
            out |= {tid for tid, m in metas.items() if bills & set(m["refs"])}
    if any(k[0] == "demo" for k in sent):
        out |= {int(t) for t in (p.get("demo") or {}).get("covered_tickets") or []}
    return out


def summary():
    run_id = inbox_run_id()
    metas = _meta(run_id)
    arrived = set(_inbox_state())
    backlog = [m for t, m in metas.items() if t not in arrived]
    c = {k: sum(1 for m in backlog if m["outcome"] == k) for k in ("draft_ready", "action_needed", "no_reply")}
    connected = db.get_setting(CONNECTED_KEY)
    return {"run_id": run_id, "read": len(backlog), "drafts_ready": c["draft_ready"], "action_needed": c["action_needed"],
            "no_reply": c["no_reply"], "held_back": len(_pending_ids(run_id)),
            "prevented_this_week": len(_prevented_tickets(run_id, metas)),
            "connected_at": appclock.iso(connected) if connected else None}


# ---------------------------------------------------------------------------- evidence and thread detail
def _raw_ticket(tid):
    return _get_store().backend.ticket(tid)


_BILL_FIELDS = ("internalId", "tranId", "tranDate", "dueDate", "userTotal", "currency", "status", "approvalStatus", "nextApprover",
                "poNumber", "memo", "subsidiary")


def _w9_status(vendor_id):
    try:
        p = Path(__file__).resolve().parent / "seed" / "w9" / "status.json"
        return (json.loads(p.read_text(encoding="utf-8")).get(str(vendor_id)) or {}).get("status")
    except (OSError, ValueError):
        return None


def _payment_view(p):
    status = p.get("custbody_release_status")
    return {"internalId": p["internalId"], "tranId": p["tranId"], "tranDate": p.get("tranDate"), "paymentMethod": p.get("paymentMethod"),
            "total": p.get("total"), "release_status": status, "released_date": p.get("custbody_released_date"),
            "settled_date": p.get("custbody_settled_date"),
            "referenceNumber": None if status == "Returned" else p.get("referenceNumber"),  # a returned payment's reference is never shown
            "account": documents.account_masked(p)}


def _evidence(tid, m, run_id):
    """What the records say about this ticket, with a source label on every fact. Re-reads the ticket on an untraced session."""
    runner._proto_on_path()
    import extract_regex
    import resolve
    import rules
    from ticket_view import build_view
    from trace import NullTrace
    store = _get_store()
    ctx = m["ctx"]
    raw = _raw_ticket(tid) or {"id": tid, "subject": ctx.get("subject"), "description": ctx.get("body"),
                               "via": {"source": {"from": {"address": ctx.get("sender_email"), "name": ctx.get("sender_name")}}}}
    view = build_view(raw, store.backend.user)
    lk = store.session(NullTrace())
    skipped = bool((m["bundle"].get("plan") or {}).get("skipped"))
    sender = resolve.resolve_sender(view, lk)
    ext = extract_regex.extract(view, lk, store.vendors)
    items = [] if skipped else resolve.resolve_items(ext, sender, lk)
    vid = sender.get("vendor_id") if skipped else resolve.ticket_vendor(sender, items, ext, lk)[0]
    ev_items = []
    for it in items:
        entry = {"ref": it["ref"], "status": it["status"], "bill": None, "payment": None, "run": None, "sources": []}
        if it["status"] == "found":
            o = rules.classify_bill(it["bill"], lk)
            b = it["bill"]
            entry["bill"] = {k: b.get(k) for k in _BILL_FIELDS}
            entry["outcome"] = o.get("outcome")
            entry["sources"].append({"label": f"NetSuite · bill {b['internalId']}", "ref": b["tranId"]})
            if o.get("payment"):
                entry["payment"] = _payment_view(o["payment"])
                entry["sources"].append({"label": f"NetSuite · payment {o['payment']['tranId']}", "ref": o["payment"]["tranId"]})
            if o.get("run"):
                r = o["run"]
                entry["run"] = {"run_id": r["run_id"], "run_date": r.get("run_date"), "run_status": r.get("run_status")}
                entry["sources"].append({"label": f"Payment run {r['run_id']}", "ref": r["run_id"]})
        ev_items.append(entry)
    vendor = None
    v = next(iter(store.backend.query("vendor", internalId=str(vid))), None) if vid else None
    if v:
        contacts = [c.strip() for c in v["authorizedContacts"].split(";") if c.strip()]
        vendor = {"id": v["internalId"], "name": v["companyName"], "subsidiary": v["subsidiary"], "terms": v["terms"],
                  "contacts": [{"email": c, "is_requester": c.lower() == (view.sender_email or "").lower()} for c in contacts],
                  "w9_status": _w9_status(v["internalId"])}
    planned = [int(x) for x in ((m["bundle"].get("plan") or {}).get("zendesk_ticket_ids") or [])]
    linked = []
    for lid in dict.fromkeys(list(view.linked_ticket_ids) + planned):
        lt = store.backend.ticket(lid)
        if lt:
            linked.append({"id": lid, "status": lt.get("status"), "subject": lt.get("subject"),
                           "sources": [{"label": f"Zendesk #{lid}", "ref": str(lid)}]})
    return {"requester": {"name": view.sender_name, "email": view.sender_email, "kind": sender["kind"], "authorized": bool(sender["authorized"])},
            "vendor": vendor, "items": ev_items, "linked": linked, "brief": db.get_brief(run_id, tid),
            "rule_trail": [{"name": s.get("name"), "summary": s.get("summary")} for s in m["bundle"].get("stages") or []]}


def _matched_bill_ids(tid, m, run_id):
    return {str(i["bill"]["internalId"]) for i in _evidence(tid, m, run_id)["items"] if i.get("bill")}


_INTENT = {
    "status_request": "wants to know where {refs} stands", "not_received": "says a payment for {refs} did not arrive",
    "bank_change": "asked to change bank or payment details", "legal_or_collections_threat": "sent a legal or collections threat about {refs}",
    "hr_or_payroll": "wrote about their own pay or HR matters", "receivable_from_client": "says they paid Orchestra",
    "machine_notice": "sent an automated notice", "no_request": "sent a thank-you with no request",
    "expedite_request": "asks for early or off-cycle payment of {refs}", "late_fee": "claims a late fee or interest on {refs}",
    "other": "wrote to Accounts Payable about {refs}",
}
_STATUS_WORDS = {"paid": "Paid: the payment has settled", "released": "Payment released, not yet settled",
                 "scheduled": "Approved and on a scheduled payment run", "approved_no_run": "Approved, not yet on a payment run",
                 "pending": "Waiting on approval", "returned": "The payment was returned", "conflict": "The records disagree"}


def _insight(m, ev):
    """What they want, the invoice matched, the status from records, and why. Words from records and rules, never from the email."""
    refs = ", ".join(m["refs"]) or "an invoice"
    wants = _INTENT.get(m["row"].get("intent") or "other", _INTENT["other"]).format(refs=refs)
    found = [i for i in ev["items"] if i.get("bill")]
    invoice = None
    if found:
        invoice = ", ".join(f"{i['bill']['tranId']} (matched in NetSuite)" for i in found)
    elif ev["items"]:
        invoice = ", ".join(f"{i['ref']} ({i['status'].replace('_', ' ')})" for i in ev["items"])
    status_line = "; ".join(f"{i['bill']['tranId']}: {_STATUS_WORDS.get(i.get('outcome'), 'see the records')}" for i in found) or None
    return {"wants": wants, "invoice": invoice, "status_line": status_line, "why": m["why"]}


def _messages(tid, m, store):
    raw = _raw_ticket(tid) or {}
    ctx = m["ctx"]
    out = []
    for c in raw.get("comments") or []:
        u = store.backend.user(c["author_id"]) if c.get("author_id") is not None else None
        u = u or {}
        out.append({"author": u.get("name") or ctx.get("sender_name") or "Unknown", "email": u.get("email"), "at": c.get("created_at"),
                    "body": c.get("body") or "", "public": bool(c.get("public", True)),
                    "attachments": [a.get("file_name") for a in c.get("attachments") or [] if a.get("file_name")]})
    if not out:
        out.append({"author": ctx.get("sender_name") or "Unknown", "email": ctx.get("sender_email"), "at": ctx.get("received_at"),
                    "body": ctx.get("body") or raw.get("description") or "", "public": True, "attachments": list(ctx.get("attachments") or [])})
    return out


def _review_detail(run_id, rec, rv, brief):
    """The same payload as GET /api/runs/{id}/tickets/{tid} (server._detail), so the review UI can use either."""
    b, res = rec["bundle"], rec["bundle"].get("result") or {}
    is_reply = res.get("output_type") == "draft_reply"
    default_subject = reply_checks.default_subject(rec["ticket"].get("subject")) if is_reply else None
    original = res.get("text") or ""
    blocked = reply_checks.BLOCK_APPROVE_FLAGS & set(res.get("flags") or [])
    mm = mailer.get_mailer()
    return {
        "run_id": run_id, "row": rec["row"], "ticket": rec["ticket"],
        "draft": {"output_type": res.get("output_type"), "to": res.get("recipient"),
                  "subject": (rv.get("edited_subject") or default_subject) if is_reply else None, "default_subject": default_subject,
                  "subject_edited": bool(rv.get("edited_subject")) and rv.get("edited_subject") != default_subject,
                  "original_text": original, "text": rv["edited_text"] if rv.get("edited_text") is not None else original,
                  "edited": rv.get("edited_text") is not None and rv["edited_text"] != original},
        "brief": brief,
        "review": {"state": rv["state"], "note": rv.get("note"), "decided_at": rv.get("decided_at"), "can_approve": not blocked,
                   "can_send": bool(is_reply and res.get("recipient") and rv["state"] == "approved" and not blocked),
                   "sent_at": rv.get("sent_at"), "message_id": rv.get("message_id"),
                   "send_info": json.loads(rv["send_info"]) if rv.get("send_info") else None},
        "mail": {"mode": mm.mode, "label": mm.label, "from": mailer.default_sender((rec["ticket"] or {}).get("to"))},
        "bundle": {k: b.get(k) for k in ("stages", "trace", "decision", "plan", "model", "advisory", "ms", "api_calls", "error")},
    }


def _sched_payload(run_id, tid):
    try:
        p = scheduler._payload(run_id, tid)
        return p if p.get("schedule") else None
    except Exception:
        return None


def _workflow_payload(tid):
    st = _wf(tid)
    return {"state": st.get("state") or "open", "category": st.get("category"), "assignee": st.get("assignee"), "chased": bool(st.get("chased"))}


def thread(tid, viewer=None):
    run_id = inbox_run_id()
    m = _meta(run_id).get(tid)
    if not m:
        return None
    row = _rows(run_id, viewer, only=tid)[0][0]
    rec = db.get_ticket(run_id, tid)
    rv = db.get_review(run_id, tid)
    store = _get_store()
    ev = _evidence(tid, m, run_id)
    ctx = m["ctx"]
    raw = _raw_ticket(tid) or {}
    src = (raw.get("via") or {}).get("source") or {}
    frm = src.get("from") or {}
    cc = []
    for u in raw.get("email_cc_ids") or []:
        uu = store.backend.user(u) or {}
        if uu.get("name") or uu.get("email"):
            cc.append(uu.get("name") or uu.get("email"))
    headers = {"from": (f"{frm.get('name')} <{frm.get('address')}>" if frm.get("name") and frm.get("address") else frm.get("address"))
               or ctx.get("sender_email"),
               "to": (src.get("to") or {}).get("address") or ctx.get("to"), "cc": cc, "date": row["received_at"], "subject": ctx.get("subject")}
    messages = _messages(tid, m, store)
    st = _inbox_state().get(tid) or {}
    if rv.get("state") == "sent":
        res = m["bundle"].get("result") or {}
        body = rv["edited_text"] if rv.get("edited_text") is not None else (res.get("text") or "")
        messages.append({"author": st.get("sent_by") or "Orchestra Accounts Payable", "email": mailer.default_sender(ctx.get("to")),
                         "at": appclock.iso(st["sent_at"]) if st.get("sent_at") else None, "body": body, "public": True,
                         "attachments": [a["filename"] for a in documents.list_attachments(run_id, tid)]})
    write_back = None
    if st.get("sent_by") or st.get("sent_folder") or st.get("internal_note"):
        write_back = {"zendesk_status": st.get("zendesk_status"), "sent_by": st.get("sent_by"), "sent_folder": bool(st.get("sent_folder")),
                      "sent_at": appclock.iso(st["sent_at"]) if st.get("sent_at") else None, "internal_note": st.get("internal_note")}
    out = dict(row)
    out.update(headers=headers, messages=messages, insight=_insight(m, ev), result=m["bundle"].get("result"), decision=m["bundle"].get("decision"),
               review=_review_detail(run_id, rec, rv, ev["brief"]), workflow=_workflow_payload(tid), evidence=ev,
               attachments=documents.list_attachments(run_id, tid), schedule=_sched_payload(run_id, tid), run_id=run_id,
               write_back=write_back)
    return out


# ---------------------------------------------------------------------------- write-back (delivery hooks)
def _state_set(tid, **fields):
    db._exec("INSERT OR IGNORE INTO inbox_state (ticket_id, zendesk_status, sent_folder) VALUES (?, NULL, 0)", (int(tid),))
    cols = ", ".join(f"{k}=?" for k in fields)
    db._exec(f"UPDATE inbox_state SET {cols} WHERE ticket_id=?", (*fields.values(), int(tid)))


def inbox_write_back(run_id, ticket_id, actor, info):
    """delivery.ON_SENT hook: mark the Zendesk ticket Solved (Pending for a note), add an internal note, file in Sent items."""
    if run_id != db.get_setting(RUN_KEY):
        return
    rec = db.get_ticket(run_id, ticket_id)
    is_note = ((rec or {}).get("bundle", {}).get("result") or {}).get("output_type") == "internal_action_note"
    status = "pending" if is_note else "solved"
    who = (actor or {}).get("name") or "Conductor"
    note = f"Internal note: reply sent from Conductor by {who}. Ticket set to {status.title()}. Filed in Outlook Sent items."
    _state_set(ticket_id, zendesk_status=status, sent_folder=1, internal_note=note, sent_by=who, sent_at=appclock.now())
    connectors.log(f"Zendesk: #{ticket_id} set to {status.title()}, internal note added ({who})", "zendesk")
    connectors.log(f"Outlook: reply to ticket #{ticket_id} filed in Sent items", "outlook")
    _publish_counts()


def on_decided(ticket_id, actor=None, decision=None):
    """For workflow: a CFO decision on an internal note sets the Zendesk ticket Pending and adds an internal note."""
    who = (actor or {}).get("name") or "the CFO"
    note = f"Decision recorded in Conductor by {who}" + (f": {decision}." if decision else ".") + " Ticket set to Pending."
    _state_set(ticket_id, zendesk_status="pending", internal_note=note)
    connectors.log(f"Zendesk: #{ticket_id} set to Pending, internal note added ({who})", "zendesk")


def inbox_ahead_sent(run_id, kind, key, item, info):
    """delivery.ON_NOTICE_SENT hook: tell open dashboards an Ahead notice or digest went out."""
    live.publish("ahead.sent", {"kind": kind, "key": key, "summary": "An Ahead message was sent"})


# ---------------------------------------------------------------------------- arrivals (held-back tickets)
_SYNC = {"thread": None, "stop": threading.Event(), "wake": threading.Event(), "next_at": None, "state": "idle"}
_SYNC_LOCK = threading.Lock()


def cadence():
    c = db.get_setting(CADENCE_KEY, DEFAULT_CADENCE)
    try:
        lo, hi = float(c[0]), float(c[1])
        return (lo, max(lo, hi)) if lo > 0 else tuple(DEFAULT_CADENCE)
    except (TypeError, ValueError, IndexError):
        return tuple(DEFAULT_CADENCE)


def sync_status():
    return {"state": _SYNC["state"], "held_back": len(_pending_ids()),
            "next_at": appclock.iso(_SYNC["next_at"]) if _SYNC["next_at"] else None}


def _publish_sync_status():
    try:
        live.publish("sync.status", {**sync_status(), "summary": "Sync status"})
    except Exception as e:
        print(f"[inbox] sync.status not published: {type(e).__name__}: {e}", flush=True)


def arrive_next(reading_seconds=READING_SECONDS):
    """Bring the next held-back ticket in now. Returns [ticket_id], or [] when none are left."""
    with _ARRIVE_LOCK:
        run_id = inbox_run_id()
        ids = _pending_ids(run_id)
        if not ids:
            return []
        tid = ingest(_get_store().backend.ticket(ids[0]), None, "zendesk", reading_seconds=reading_seconds)
    _publish_sync_status()
    return [tid]


def _sync_loop(stop, wake):
    while not stop.is_set():
        try:
            if not _pending_ids():
                _SYNC.update(state="idle", next_at=None)
                _publish_sync_status()
                return
            lo, hi = cadence()
            delay = random.uniform(lo, hi)
            _SYNC.update(state="waiting", next_at=appclock.now() + delay)
            _publish_sync_status()
            if wake.wait(delay):  # Sync now (or a stop): start the wait again
                wake.clear()
                continue
            _SYNC.update(state="reading", next_at=None)
            arrive_next()
        except Exception as e:
            print(f"[inbox] arrival failed: {type(e).__name__}: {e}", flush=True)
            stop.wait(5)
    _SYNC.update(state="idle", next_at=None)


def ensure_sync():
    """Start the background arrivals the first time the inbox is used."""
    if not AUTOSYNC:
        return
    with _SYNC_LOCK:
        t = _SYNC["thread"]
        if t and t.is_alive():
            return
        stop, wake = threading.Event(), threading.Event()
        _SYNC.update(stop=stop, wake=wake)
        _SYNC["thread"] = threading.Thread(target=_sync_loop, args=(stop, wake), daemon=True, name="inbox-sync")
        _SYNC["thread"].start()


def stop_sync():
    with _SYNC_LOCK:
        _SYNC["stop"].set()
        _SYNC["wake"].set()
        t = _SYNC["thread"]
    if t and t.is_alive() and t is not threading.current_thread():
        t.join(timeout=3)
    _SYNC.update(state="idle", next_at=None, thread=None)


def _touch():
    """Every inbox route starts here: the run exists, and arrivals are running."""
    rid = inbox_run_id()
    ensure_sync()
    return rid


# ---------------------------------------------------------------------------- routes
def _actor_name(request):
    s = identity.current(request)
    return getattr(s, "name", None) if s else None


@router.get("/api/inbox/summary", dependencies=staff_only)
def api_summary():
    _touch()
    return summary()


@router.get("/api/inbox/queues", dependencies=staff_only)
def api_queues(request: Request):
    run_id = _touch()
    c = counts(_viewer(request), run_id)
    return {"queues": [{"id": qid, "label": label, "count": c[qid]} for qid, label in QUEUES]}


@router.get("/api/inbox/threads", dependencies=staff_only)
def api_threads(request: Request, queue: str = "", q: str = "", assignee: str = ""):
    run_id = _touch()
    if queue and queue not in dict(QUEUES):
        raise HTTPException(400, "Unknown queue.")
    needle = q.strip().lower()
    rows = []
    for row, qs in _rows(run_id, _viewer(request)):
        if queue and queue not in qs:
            continue
        if assignee == "unassigned":
            if row["assignee"]:
                continue
        elif assignee and (row["assignee"] or "").lower() != assignee.lower():
            continue
        if needle:
            hay = " ".join(str(x) for x in (row["ticket_id"], row["subject"], row["from_name"], row["from_email"], row["company"],
                                            " ".join(row["invoice_refs"]))).lower()
            if needle not in hay:
                continue
        rows.append(row)
    rows.sort(key=lambda r: r["received_at"] or "", reverse=True)
    return {"rows": rows}


@router.get("/api/inbox/threads/{ticket_id}", dependencies=staff_only)
def api_thread(ticket_id: int, request: Request):
    _touch()
    t = thread(ticket_id, _viewer(request))
    if t is None:
        raise HTTPException(404, "Thread not found.")
    return t


@router.post("/api/inbox/sync", dependencies=staff_only)
def api_sync():
    _touch()
    arrived = arrive_next()
    if _SYNC["state"] == "waiting":
        _SYNC["wake"].set()  # restart the wait for the next automatic arrival
    return {"arrived": arrived}


class AttachBody(BaseModel):
    kind: Literal["invoice", "remittance"]
    bill_id: str


def _thread_for_attachment(ticket_id):
    run_id = _touch()
    m = _meta(run_id).get(ticket_id)
    if not m:
        raise HTTPException(404, "Thread not found.")
    return run_id, m


@router.post("/api/inbox/threads/{ticket_id}/attachments", dependencies=staff_only)
def api_attach(ticket_id: int, body: AttachBody, request: Request):
    run_id, m = _thread_for_attachment(ticket_id)
    if m["output_type"] != "draft_reply":
        raise HTTPException(409, "Documents can be attached only to a drafted reply.")
    if db.get_review(run_id, ticket_id)["state"] == "sent":
        raise HTTPException(409, "This reply was already sent.")
    if str(body.bill_id) not in _matched_bill_ids(ticket_id, m, run_id):
        raise HTTPException(404, "We couldn't find that invoice on this ticket.")
    try:
        atts = documents.add_attachment(run_id, ticket_id, body.kind, body.bill_id, _actor_name(request))
    except documents.NotAvailable as e:
        raise HTTPException(409 if e.code == "unavailable" else 404, e.message)
    return {"attachments": atts}


@router.delete("/api/inbox/threads/{ticket_id}/attachments/{attachment_id}", dependencies=staff_only)
def api_detach(ticket_id: int, attachment_id: int):
    run_id, _m = _thread_for_attachment(ticket_id)
    if db.get_review(run_id, ticket_id)["state"] == "sent":
        raise HTTPException(409, "This reply was already sent.")
    if not any(a["id"] == attachment_id for a in documents.list_attachments(run_id, ticket_id)):
        raise HTTPException(404, "Attachment not found.")
    return {"attachments": documents.remove_attachment(run_id, ticket_id, attachment_id)}


# ---------------------------------------------------------------------------- Advanced (CFO only)
class ImportBody(BaseModel):
    path: str


@router.post("/api/admin/reset", dependencies=cfo_only)
def api_reset(request: Request):
    old = db.get_setting(RUN_KEY)
    out = reset()
    try:
        request.app.state.get_manager().live.pop(old, None)
    except Exception:
        pass
    ensure_sync()
    return out


@router.post("/api/admin/import", dependencies=cfo_only)
def api_import_tickets(body: ImportBody, request: Request):
    """A tickets file (or a folder holding one) becomes a normal batch run. Records come from data/ unless the folder has its own."""
    p = Path(runner.clean_path(body.path))
    try:
        tickets_file = None
        dataset = str(runner.DEFAULT_DATASET)
        if p.is_dir():
            if runner.validate_dataset(str(p))["ok"]:
                dataset = str(p)
            elif (p / "tickets.json").is_file():
                tickets_file = str(p / "tickets.json")
            else:
                raise ValueError("That folder has no tickets file.")
        elif p.is_file():
            tickets_file = str(p)
        else:
            raise ValueError("That path is not a tickets file.")
        run_id = request.app.state.get_manager().start_run(dataset, False, None, model_free=True, tickets_file=tickets_file)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    connectors.log(f"Advanced: tickets file imported as run {run_id}", "zendesk")
    return {"run_id": run_id}


@router.get("/api/admin/export", dependencies=cfo_only)
def api_export(run_id: str = "", scope: str = "signed_off"):
    """Results in today's score.py format: {"team", "results": [...]}. scope=all exports every ticket, else only signed-off ones."""
    run_id = run_id or inbox_run_id()
    run = db.get_run(run_id)
    if not run:
        raise HTTPException(404, "run not found")
    reviews = db.review_states(run_id)
    results = []
    for row in db.list_rows(run_id):
        st = (reviews.get(row["ticket_id"]) or {}).get("state", "pending")
        if scope != "all" and st not in SIGNED_OFF:
            continue
        res = dict(db.get_ticket(run_id, row["ticket_id"])["bundle"]["result"])
        edited = (reviews.get(row["ticket_id"]) or {}).get("edited_text")
        if edited is not None and st in ("approved", "sent"):
            res["text"] = edited
        results.append(res)
    payload = json.dumps({"team": "orchestra-prototype", "results": results}, indent=1, ensure_ascii=True)
    name = f"results-{run['label'] or run_id}-{scope}.json".replace(" ", "_")
    return StreamingResponse(iter([payload]), media_type="application/json",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})
