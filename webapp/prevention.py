"""Prevention for one run: proactive vendor notices, approver digests and the deflection numbers.

Built on request from the run's dataset with the existing prototype modules (notices, approver_digest,
batch_groups, deflection_report). Nothing here changes a ticket's result. Everything it drafts waits for a
person: a notice goes to the vendor's address on record, a digest to the approver on record, and both are
checked again when they are sent (server.py).
"""
import time

from fastapi import APIRouter

import db
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
    db.save_prevention(run_id, payload)
    return payload


def find(payload, kind, key):
    if not payload or kind not in KINDS:
        return None
    return next((x for x in payload["notices" if kind == "notice" else "digests"] if x["key"] == key), None)
