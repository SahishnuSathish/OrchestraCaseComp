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


# ---------------------------------------------------------------------------------------------- prevention demo
DEMO_SUBJECT = "Your invoice with Orchestra: current status"
DEMO_RULE = ("The pending-approval bill that has waited longest (oldest tranDate, then internalId) and has at least one ticket "
             "in the batch, with an active vendor that has an email on record, a unique invoice number, and no returned or "
             "conflicting bill.")


def _ticket_index(store):
    import batch_groups
    return batch_groups.ticket_index([{"ticket_id": t} for t in sorted(t["id"] if isinstance(t, dict) else t
                                                                         for t in store.backend.list_tickets())], store)


def pick_demo_bill(store, index=None):
    """Choose the demo invoice by rule: a bill still waiting for approval that already produced a ticket."""
    import status_service  # noqa: F401  (same module the vendor lookup uses)
    index = _ticket_index(store) if index is None else index
    lk = store.session(NullTrace())
    vendors = {v["internalId"]: v for v in store.vendors}
    bills = store.backend.all("vendorBill")
    by_vendor = {}
    for b in bills:
        by_vendor.setdefault(b["entity"], []).append(b)
    asked = {(x["vendor_id"], r) for x in index.values() if x["vendor_id"] for r in x["refs"]}
    clean = {}
    found = []
    for b in bills:
        v = vendors.get(b["entity"])
        if not v or v.get("isInactive") == "T" or not v.get("email") or not b.get("userTotal"):
            continue
        if (b["entity"], b["tranId"]) not in asked or len(lk.find_bills_by_tranid(b["tranId"])) != 1:
            continue
        o = rules.classify_bill(b, lk)
        if o["outcome"] != "pending":
            continue
        if b["entity"] not in clean:
            clean[b["entity"]] = not any(rules.classify_bill(x, lk)["outcome"] in ("returned", "conflict")
                                         for x in by_vendor[b["entity"]])
        if clean[b["entity"]]:
            found.append((b["tranDate"], int(b["internalId"]), b, o, v))
    if not found:
        return None
    _, _, bill, o, vendor = min(found, key=lambda x: x[:2])
    return {"bill": bill, "outcome": o, "vendor": vendor}


def draft_demo_notice(pick):
    """One notice for the picked invoice, from its records only: status line plus invoice amount and open balance."""
    import status_service
    o, v = pick["outcome"], pick["vendor"]
    line = drafts.SNIPPETS["line_" + o["outcome"]].format(**drafts.outcome_fields(o))
    text = "\n\n".join(["Hello,", "Here is where your invoice stands with Orchestra Accounts Payable:", line,
                        status_service.balance_line(o),
                        "You don't need to reply. If anything here looks wrong, reply to this message.", drafts.SIGNATURE])
    problems = egress_guard.check_outbound(text, [o], [o["ref"]], recipient=v["email"])
    return {"vendor_id": v["internalId"], "vendor": v["companyName"], "to": v["email"], "bills": [o["ref"]], "text": text,
            "status": "draft_pending_approval", "egress_problems": problems}


def build_demo(store, index=None):
    """The demo chain's first step. None when no bill qualifies. A notice that fails egress is not returned."""
    index = _ticket_index(store) if index is None else index
    pick = pick_demo_bill(store, index)
    if pick is None:
        return None
    n = draft_demo_notice(pick)
    if n["egress_problems"]:
        return None
    b, o = pick["bill"], pick["outcome"]
    return {"invoice": {"internal_id": b["internalId"], "ref": o["ref"], "vendor_id": b["entity"], "vendor": n["vendor"],
                        "vendor_email": n["to"], "amount": float(b["userTotal"]), "currency": b.get("currency") or "USD",
                        "status": o["outcome"], "tran_date": b["tranDate"]},
            "notice": n, "covered_tickets": coverage([n], index), "rule": DEMO_RULE}


def demo_lookup(demo, store):
    """The vendor's own status lookup for the invoice, and whether it agrees with the notice."""
    import status_service
    inv = demo["invoice"]
    r = status_service.lookup_status(inv["vendor_email"], inv["ref"], store)
    bal = f"Invoice amount: {inv['currency']} {inv['amount']:,.2f}."
    return {"ok": r["ok"], "message": r["message"], "state": r["state"],
            "same_answer": bool(r["ok"] and r["state"] == inv["status"] and bal in r["message"] and bal in demo["notice"]["text"])}
