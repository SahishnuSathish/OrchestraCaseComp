"""Proactive status notices: one draft per vendor contact, listing bills vendors typically ask about.

States: scheduled on a run within the next 10 days, released but not settled, paid in the last 3 days.
A vendor is skipped if it is inactive or any of its bills is returned or in conflict. Drafts only: a person
approves anything that goes out, and every notice passes egress_guard.
"""
import datetime as dt

import drafts
import egress_guard
import rules
from trace import NullTrace

WINDOW_AHEAD, PAID_RECENT = 10, 3
LINE_FOR = {"scheduled": "line_scheduled", "released": "line_released", "paid": "line_paid"}


def _qualifies(o):
    p, r = o.get("payment") or {}, o.get("run") or {}
    if o["outcome"] == "scheduled" and r.get("run_date"):
        d = (dt.date.fromisoformat(r["run_date"]) - rules.SNAPSHOT).days
        return 0 <= d <= WINDOW_AHEAD
    if o["outcome"] == "released":
        return True
    if o["outcome"] == "paid" and p.get("tranDate"):
        return 0 <= (rules.SNAPSHOT - dt.date.fromisoformat(p["tranDate"])).days <= PAID_RECENT
    return False


def build(store):
    lk = store.session(NullTrace())
    bills_by_vendor = {}
    for b in store.backend.all("vendorBill"):
        bills_by_vendor.setdefault(b["entity"], []).append(b)
    notices, skipped = [], {"inactive": 0, "returned_or_conflict": 0}
    for v in store.vendors:
        if v.get("isInactive") == "T":
            skipped["inactive"] += 1
            continue
        outcomes = [rules.classify_bill(b, lk) for b in bills_by_vendor.get(v["internalId"], [])]
        if any(o["outcome"] in ("returned", "conflict") for o in outcomes):
            skipped["returned_or_conflict"] += 1
            continue
        picked = [o for o in outcomes if _qualifies(o)]
        if not picked:
            continue
        lines = [drafts.SNIPPETS[LINE_FOR[o["outcome"]]].format(**drafts.outcome_fields(o)) for o in picked]
        text = "\n\n".join(["Hello,", "Here is where your invoices stand with Orchestra Accounts Payable:", "\n".join(lines),
                            "You don't need to reply. If anything here looks wrong, reply to this message.", drafts.SIGNATURE])
        problems = egress_guard.check_outbound(text, picked, [o["ref"] for o in picked], recipient=v["email"])
        if problems:
            continue  # never emit a notice that fails the egress check
        notices.append({"vendor_id": v["internalId"], "vendor": v["companyName"], "to": v["email"],
                        "bills": [o["ref"] for o in picked], "text": text, "status": "draft_pending_approval"})
    return {"notices": notices, "vendors_skipped": skipped}


def coverage(notices, index):
    """Tickets in the batch whose vendor and invoice a notice already covered: 'would have been prevented'."""
    covered = {(n["vendor_id"], b) for n in notices for b in n["bills"]}
    ids = [tid for tid, x in index.items() if x["vendor_id"] and x["refs"] and all((x["vendor_id"], r) in covered for r in x["refs"])]
    return sorted(ids)
