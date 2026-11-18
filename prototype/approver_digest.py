"""One digest per approver instead of one note per ticket. Internal only (amounts are fine, bank fields never).

Default: bundles whose rule is pending_approval / pending_inactive_approver and that name an approver.
`all_pending=True` adds every Pending Approval or Pending PO bill in the Store.
"""
import drafts
import egress_guard
import rules
from trace import NullTrace

PENDING_RULES = {"pending_approval", "pending_inactive_approver"}


def _entry(bill, approver, tickets):
    import datetime as dt
    days = (rules.SNAPSHOT - dt.date.fromisoformat(bill["tranDate"])).days if bill.get("tranDate") else None
    return {"tranId": bill["tranId"], "vendor": bill["entityName"], "amount": bill.get("userTotal"), "status": bill["status"],
            "bill_date": bill.get("tranDate"), "days_pending": days, "stuck_over_14_days": rules.approval_stuck(bill),
            "ticket_ids": sorted(tickets)}


def _text(d):
    lines = [f"Approvals waiting on {d['approver_name'] or d['act_by']} ({len(d['bills'])})"]
    if d.get("delegate_note"):
        lines.append(d["delegate_note"])
    for b in d["bills"]:
        when = drafts.fmt_date(b["bill_date"]) if b["bill_date"] else "unknown date"
        lines.append(f"- {b['tranId']} {b['vendor']}: {b['status']}, entered {when}, {b['days_pending']} days"
                     + (" (stuck over 14 days)" if b["stuck_over_14_days"] else "")
                     + (f", tickets {', '.join(str(t) for t in b['ticket_ids'])}" if b["ticket_ids"] else ""))
    return "\n".join(lines)


def build(index, store, all_pending=False):
    lk = store.session(NullTrace())
    by_approver = {}

    def add(bill, tickets):
        ap = rules.resolve_approver((bill.get("nextApprover") or "").lower(), lk)
        key = ap["act_by"] or "(no approver on record)"
        d = by_approver.setdefault(key, {"act_by": ap["act_by"], "approver_name": ap["name"], "bills": [], "delegate_note":
                                         ap["detail"] if ap["inactive_approver"] else None})
        e = next((x for x in d["bills"] if x["tranId"] == bill["tranId"] and x["vendor"] == bill["entityName"]), None)
        if e:
            e["ticket_ids"] = sorted(set(e["ticket_ids"]) | set(tickets))
        else:
            d["bills"].append(_entry(bill, ap, tickets))

    notes = 0
    for tid, x in index.items():
        if x["bundle"]["decision"]["rule"] in PENDING_RULES and x["bundle"]["decision"].get("act_by"):
            notes += 1
            for i in x["items"]:
                if i["status"] == "found" and (i["bill"]["status"] in ("Pending Approval", "Pending PO")):
                    add(i["bill"], [tid])
    if all_pending:
        for b in store.backend.all("vendorBill"):
            if b["status"] in ("Pending Approval", "Pending PO"):
                add(b, [])
    digests = []
    for d in by_approver.values():
        d["bills"].sort(key=lambda b: -(b["days_pending"] or 0))
        d["text"] = _text(d)
        allowed = [b["tranId"] for b in d["bills"]] + [str(t) for b in d["bills"] for t in b["ticket_ids"]]
        d["egress_problems"] = egress_guard.check_internal(d["text"], allowed)
        digests.append(d)
    return {"digests": digests, "pending_notes": notes, "digest_count": len(digests),
            "summary": f"{notes} pending-approval notes become {len(digests)} digests."}
