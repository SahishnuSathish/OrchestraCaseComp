"""Prevention for one run: proactive vendor notices, approver digests and the deflection numbers.

Built on request from the run's dataset with the existing prototype modules (notices, approver_digest,
batch_groups, deflection_report). Nothing here changes a ticket's result. Everything it drafts waits for a
person: a notice goes to the vendor's address on record, a digest to the approver on record, and both are
checked again when they are sent (server.py).
"""
import time

from fastapi import APIRouter, HTTPException, Request

import db
import mailer
import runner

router = APIRouter()  # mounted by server.py behind the per-launch token; use request.app.state.get_manager()

KINDS = ("notice", "digest")
STATES = ("pending", "approved", "skipped")


class Unavailable(Exception):
    pass


def build(run_id, mgr):
    run = db.get_run(run_id)
    if not run:
        raise KeyError(run_id)
    path = run.get("dataset_path")
    store = mgr.store_for(path) if path and path != "None" else None
    if store is None:
        raise Unavailable("This run has no readable dataset, so notices and digests can't be built for it.")
    runner._proto_on_path()
    import approver_digest
    import batch_groups
    import deflection_report
    import notices

    bundles = []
    for row in db.list_rows(run_id):
        rec = db.get_ticket(run_id, row["ticket_id"])
        if rec and (rec["bundle"].get("decision") or {}).get("rule"):  # error rows have no decision
            bundles.append(rec["bundle"])
    index = batch_groups.ticket_index(bundles, store)
    n = notices.build(store)
    n["covered_tickets"] = notices.coverage(n["notices"], index)
    d = approver_digest.build(index, store)
    g = batch_groups.build(index)
    payload = {
        "built_at": time.time(),
        "report": deflection_report.build(index, n, d, g),
        "notices": [{**x, "key": x["vendor_id"]} for x in n["notices"]],
        "digests": [{**x, "key": x["act_by"] or "unassigned", "sendable": bool(x["act_by"]) and not x["egress_problems"]}
                    for x in d["digests"]],
        "digest_summary": d["summary"],
        "groups": g["groups"],
    }
    old = db.get_prevention(run_id) or {}
    if old.get("demo"):
        payload["demo"] = old["demo"]  # a rebuild keeps the drafted demo notice
    db.save_prevention(run_id, payload)
    return payload


def find(payload, kind, key):
    if not payload or kind not in KINDS:
        return None
    return next((x for x in payload["notices" if kind == "notice" else "digests"] if x["key"] == key), None)


# ------------------------------------------------------------------------------------------------ demo on one invoice
# Chain: draft from records -> approve -> send (an .eml in the outbox) -> the vendor's own status lookup -> the ticket
# it would have prevented. State lives in the run's prevention payload ("demo") and prevention_reviews (kind "demo").
DEMO_KIND = "demo"
DEMO_SUBJECT = "Your invoice with Orchestra: current status"


def _run_store(request, run_id):
    run = db.get_run(run_id)
    if not run:
        raise HTTPException(404, "run not found")
    path = run.get("dataset_path")
    store = request.app.state.get_manager().store_for(path) if path and path != "None" else None
    if store is None:
        raise HTTPException(422, "This run has no readable dataset, so the demo can't be built for it.")
    runner._proto_on_path()
    return store


def _demo_state(run_id, demo):
    st = db.prevention_states(run_id).get((DEMO_KIND, demo["invoice"]["internal_id"])) if demo else None
    return (st or {}).get("state", "pending"), (st or {})


def _demo_view(run_id, store, lookup=None):
    import notices
    payload = db.get_prevention(run_id) or {}
    demo = payload.get("demo")
    if not demo:
        pick = notices.build_demo(store)
        if pick is None:
            return {"available": False, "drafted": False, "message": "No invoice in the records qualifies for the demo."}
        return {"available": True, "drafted": False, "invoice": pick["invoice"], "rule": pick["rule"]}
    state, row = _demo_state(run_id, demo)
    out = {"available": True, "drafted": True, "state": state, **demo, "sent_at": row.get("sent_at"), "message_id": row.get("message_id")}
    if state == "sent":
        out["lookup"] = lookup or notices.demo_lookup(demo, store)
    return out


@router.get("/api/runs/{run_id}/prevention/demo")
def api_demo(run_id: str, request: Request):
    return _demo_view(run_id, _run_store(request, run_id))


@router.post("/api/runs/{run_id}/prevention/demo/draft")
def api_demo_draft(run_id: str, request: Request):
    import notices
    store = _run_store(request, run_id)
    if _demo_view(run_id, store).get("state") == "sent":
        raise HTTPException(409, "This was already sent.")
    demo = notices.build_demo(store)
    if demo is None:
        raise HTTPException(422, "No invoice in the records qualifies for the demo.")
    payload = db.get_prevention(run_id)
    if payload is None:
        payload = build(run_id, request.app.state.get_manager())
    payload["demo"] = demo
    db.save_prevention(run_id, payload)
    db.set_prevention_state(run_id, DEMO_KIND, demo["invoice"]["internal_id"], "pending")
    return _demo_view(run_id, store)


@router.post("/api/runs/{run_id}/prevention/demo/approve")
def api_demo_approve(run_id: str, request: Request):
    store = _run_store(request, run_id)
    view = _demo_view(run_id, store)
    if not view.get("drafted"):
        raise HTTPException(409, "Draft the notice first.")
    if view["state"] == "sent":
        raise HTTPException(409, "This was already sent.")
    db.set_prevention_state(run_id, DEMO_KIND, view["invoice"]["internal_id"], "approved")
    return _demo_view(run_id, store)


@router.post("/api/runs/{run_id}/prevention/demo/send")
def api_demo_send(run_id: str, request: Request):
    """Recipient, subject and body come from the stored draft, never from the request. Records are checked again here."""
    import egress_guard
    import notices
    store = _run_store(request, run_id)
    view = _demo_view(run_id, store)
    if not view.get("drafted"):
        raise HTTPException(409, "Draft the notice first.")
    if view["state"] == "sent":
        raise HTTPException(409, "This was already sent.")
    if view["state"] != "approved":
        raise HTTPException(409, "Approve it before sending.")
    fresh = notices.build_demo(store)
    if fresh is None or fresh["notice"]["text"] != view["notice"]["text"] or fresh["notice"]["to"] != view["notice"]["to"]:
        raise HTTPException(409, "The records changed since this notice was drafted. Draft again, then review it.")
    n = view["notice"]
    pick = notices.pick_demo_bill(store)
    if egress_guard.check_outbound(n["text"], [pick["outcome"]], n["bills"], recipient=n["to"]):
        raise HTTPException(409, "This notice failed the outbound check, so it can't be sent.")
    msg = mailer.Message(sender=mailer.default_sender(None), to=n["to"], subject=DEMO_SUBJECT, body=n["text"],
                         headers={"X-Conductor-Prevention": f"{DEMO_KIND}:{view['invoice']['internal_id']}"})
    try:
        info = mailer.get_mailer().send(msg)
    except mailer.MailError as e:
        raise HTTPException(502, str(e))
    db.save_prevention_sent(run_id, DEMO_KIND, view["invoice"]["internal_id"], info.get("id"))
    import delivery
    delivery.notice_sent(run_id, DEMO_KIND, view["invoice"]["internal_id"], n, info)
    return _demo_view(run_id, store)
