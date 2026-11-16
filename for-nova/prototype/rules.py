"""Rules engine: the README's order of checks and record-state table, in code.

Order of checks (first that fits wins):
  1 possible fraud
  2 no-reply sender, machine notice, no request, misrouted
  3 unresolved account
  4 sender not authorized
  5 threat or copied executive          -> holding reply, priority
  6 early payment or late fee           -> internal note
  (duplicate of an answered linked ticket -> no_draft duplicate)
  7 records table

No model output can change a decision here except to add caution: the model
can contribute extra risk cues (making tiers 1, 5, 6 fire) but never remove one.
"""
import datetime as dt

SNAPSHOT = dt.date(2026, 11, 13)


def add_business_days(d, n):
    while n > 0:
        d += dt.timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d


HOLDING_UPDATE_DATE = add_business_days(SNAPSHOT, 2).isoformat()  # 2026-11-17
STUCK_APPROVAL_DAYS = 14

REPLY_OK = {"paid", "released", "scheduled", "approved_no_run", "pending", "not_on_file"}


# ---------------------------------------------------------------- approver
def resolve_approver(email, lk):
    """Next approver, or the delegate when the approver is inactive."""
    if not email:
        return {"act_by": None, "name": None, "inactive_approver": None, "detail": "no next approver on the bill",
                "status": "missing"}
    emp = lk.find_employee_by_email(email)
    if not emp:
        return {"act_by": email, "name": None, "inactive_approver": None,
                "detail": f"next approver {email} not found in employees", "status": "missing"}
    name = f"{emp['firstName']} {emp['lastName']}"
    if emp.get("isInactive") == "T":
        de = (emp.get("delegateEmail") or "").lower()
        d = lk.find_employee_by_email(de) if de else None
        if d and d.get("isInactive") != "T":
            return {"act_by": d["email"], "name": f"{d['firstName']} {d['lastName']}",
                    "inactive_approver": {"email": emp["email"], "name": name},
                    "detail": f"next approver {emp['email']} is inactive; delegate {d['email']}", "status": "blocked"}
        return {"act_by": None, "name": None, "inactive_approver": {"email": emp["email"], "name": name},
                "detail": f"next approver {emp['email']} is inactive and has no active delegate", "status": "blocked"}
    return {"act_by": emp["email"], "name": name, "inactive_approver": None,
            "detail": f"next approver {emp['email']} (active)", "status": "blocked"}


# ---------------------------------------------------------------- records table
def classify_bill(bill, lk):
    """Apply the record-state table to one bill. Payment record is checked first."""
    bid = bill["internalId"]
    pays = lk.find_payments_for_bill(bid)
    runs = lk.find_runs_for_bill(bid)
    out = {"ref": bill["tranId"], "bill": bill, "payment": None, "run": None, "approver": None,
           "vendor_id": bill["entity"], "vendor_name": bill["entityName"], "checks": {}}
    ch = out["checks"]
    status, appr = bill.get("status"), bill.get("approvalStatus")
    ch["invoice_found"] = ("pass", f"tranId {bill['tranId']} ({bill['entityName']}), status {status}", f"bill:{bid}")

    pay = sorted(pays, key=lambda p: (p.get("tranDate") or "", p["internalId"]))[-1] if pays else None
    run = None
    if runs:
        sched = [r for r in runs if r.get("run_status") == "Scheduled"]
        run = sorted(sched or runs, key=lambda r: r.get("run_date") or "")[-1]
    out["payment"], out["run"] = pay, run
    ch["payment_run"] = (("pass", f"{run['run_id']} {run['run_status']} {run['run_date']}", f"run:{run['run_id']}")
                         if run else ("missing", "not on any run", "payment_runs"))

    if pay:
        rs = pay.get("custbody_release_status")
        if pay.get("entity") and pay["entity"] != bill["entity"]:
            out["outcome"] = "conflict"
            out["conflict"] = f"payment {pay['tranId']} is for vendor {pay['entity']}, bill is for vendor {bill['entity']}"
        elif rs == "Settled":
            if status in ("Pending Approval", "Pending PO"):
                out["outcome"] = "conflict"
                out["conflict"] = f"payment {pay['tranId']} settled but bill still shows {status}"
            else:
                out["outcome"] = "paid"
        elif rs == "Released":
            out["outcome"] = "released"
        elif rs == "Returned":
            out["outcome"] = "returned"
        else:
            out["outcome"] = "conflict"
            out["conflict"] = f"payment {pay['tranId']} has unknown release status {rs!r}"
        ch["payment_record"] = ({"Settled": "pass", "Released": "pass", "Returned": "fail"}.get(rs, "fail"),
                                f"{pay['tranId']} {rs}, {pay.get('paymentMethod')} on {pay.get('tranDate')}",
                                f"payment:{pay['internalId']}")
        ch["approval"] = ("pass" if appr == "Approved" else "blocked", f"{status} / {appr}", f"bill:{bid}")
        return out

    ch["payment_record"] = ("missing", "no payment applied", "bill_payments")
    if status == "Paid In Full":
        out["outcome"] = "conflict"
        out["conflict"] = "bill shows Paid In Full but no payment record is applied to it"
        ch["approval"] = ("pass", f"{status} / {appr}", f"bill:{bid}")
    elif status in ("Pending Approval", "Pending PO") or appr != "Approved":
        out["outcome"] = "pending"
        out["approver"] = resolve_approver((bill.get("nextApprover") or "").lower(), lk)
        ch["approval"] = (out["approver"]["status"], f"{status}; " + out["approver"]["detail"], f"bill:{bid}")
    elif run and run.get("run_status") == "Scheduled":
        out["outcome"] = "scheduled"
        ch["approval"] = ("pass", f"{status} / {appr}", f"bill:{bid}")
    elif run:
        out["outcome"] = "conflict"
        out["conflict"] = f"bill was on completed run {run['run_id']} but no payment record is applied"
        ch["approval"] = ("pass", f"{status} / {appr}", f"bill:{bid}")
    else:
        out["outcome"] = "approved_no_run"
        ch["approval"] = ("pass", f"{status} / {appr}", f"bill:{bid}")
    return out


def approval_stuck(bill):
    try:
        d = dt.date.fromisoformat(bill.get("tranDate") or "")
    except ValueError:
        return False
    return (SNAPSHOT - d).days > STUCK_APPROVAL_DAYS


# ---------------------------------------------------------------- decision
def _dec(output_type, rule, **kw):
    d = {"output_type": output_type, "rule": rule, "reason_tag": None, "priority": False, "flags": [],
         "act_by": None, "recipient": None, "why": ""}
    d.update(kw)
    return d


def decide(ctx):
    """ctx keys: view, ext, sender, items, linked, fraud_reasons, tier2, exec_cc, vendor, lk.

    Returns (decision, outcomes). outcomes: list of classify_bill results for found bills.
    """
    view, ext, sender, items, lk = ctx["view"], ctx["ext"], ctx["sender"], ctx["items"], ctx["lk"]
    cues = set(ext.get("risk_cues") or [])
    intent = ext.get("intent")
    reply_to = view.sender_email

    # 1 possible fraud
    if ctx["fraud_reasons"]:
        return _dec("internal_action_note", "fraud", flags=["fraud"], why="; ".join(ctx["fraud_reasons"])), []

    # 2 automated / nothing to answer / misrouted
    tag, why = ctx["tier2"]
    if tag:
        return _dec("no_draft", tag, reason_tag=tag, why=why), []

    # 3 unresolved account
    amb = [i for i in items if i["status"] == "ambiguous"]
    vid, vname, vhow = ctx["vendor"]
    if amb:
        return _dec("no_draft", "unresolved_account", reason_tag="unresolved_account",
                    why=f"Invoice {amb[0]['ref']} matches {len(amb[0]['candidates'])} vendors and the sender does not say which."), []
    if sender["kind"] == "unknown" and not vid:
        return _dec("no_draft", "unresolved_account", reason_tag="unresolved_account",
                    why=f"Cannot identify the account: sender {sender['email']} is not on file and no vendor or invoice in the message resolves."), []
    if sender["kind"] == "employee" and not vid and not items:
        return _dec("no_draft", "unresolved_account", reason_tag="unresolved_account",
                    why="Employee request names no vendor and no invoice number that resolves."), []

    # 4 sender not authorized
    if not sender["authorized"]:
        return _dec("internal_action_note", "unauthorized_sender",
                    why=f"{sender['email']} is not an authorized contact for {vname or 'the vendor'} and is not an active employee ({sender['detail']})."), []

    # 5 threat or copied executive
    if "threat" in cues or ctx["exec_cc"]:
        reasons = []
        if "threat" in cues:
            reasons.append("threat of collections, legal action or suspension")
        if ctx["exec_cc"]:
            reasons.append("executive copied: " + ", ".join(ctx["exec_cc"]))
        return _dec("draft_reply", "holding_reply", priority=True, recipient=reply_to, why="; ".join(reasons)), []

    # 6 early payment or late fee
    if "late_fee" in cues:
        return _dec("internal_action_note", "late_fee", why="sender raises a late fee"), _classify_found(items, lk)
    if "expedite" in cues:
        return _dec("internal_action_note", "expedite_request", why="sender asks for payment early or outside the run"), _classify_found(items, lk)

    # duplicate: a solved linked ticket already answered the same invoice
    for lt in ctx["linked"]:
        if lt["found"] and lt["solved"] and lt["answered"] and intent != "not_received":
            refs_now = {i["ref"].upper() for i in items}
            if not refs_now or refs_now & lt["refs"]:
                return _dec("no_draft", "duplicate", reason_tag="duplicate",
                            why=f"Linked ticket #{lt['id']} (solved) already answered this invoice."), []

    # 7 records table
    found = [i for i in items if i["status"] == "found"]
    outcomes = _classify_found(items, lk)
    foreign = [i for i in items if i["status"] == "foreign"]
    not_found = [i for i in items if i["status"] == "not_found"]

    if foreign and not found:
        return _dec("internal_action_note", "foreign_reference",
                    why=f"Invoice {foreign[0]['ref']} exists only for a different vendor than the sender's."), outcomes

    if not found:
        open_linked = [lt for lt in ctx["linked"] if lt["found"] and not lt["solved"]]
        missing_linked = [lt for lt in ctx["linked"] if not lt["found"]]
        if open_linked:
            return _dec("internal_action_note", "not_on_file_linked",
                        why=f"No bill on file; linked ticket #{open_linked[0]['id']} holds the invoice."), outcomes
        if missing_linked:
            return _dec("internal_action_note", "linked_ticket_unavailable",
                        why=f"No bill on file and linked ticket #{missing_linked[0]['id']} could not be read."), outcomes
        return _dec("draft_reply", "not_on_file", recipient=reply_to, why="No bill on file and no linked ticket."), outcomes

    kinds = [o["outcome"] for o in outcomes]
    if len(outcomes) + len(not_found) > 1:
        if intent == "not_received" and "paid" in kinds:
            return _dec("internal_action_note", "paid_not_received",
                        why="Vendor says payment not received; records show settled."), outcomes
        if all(k in REPLY_OK for k in kinds):
            act = next((o["approver"]["act_by"] for o in outcomes if o["outcome"] == "pending" and o["approver"]), None)
            return _dec("draft_reply", "multi_invoice", recipient=reply_to, act_by=act,
                        why="Several invoices; one line each."), outcomes
        return _dec("internal_action_note", "multi_needs_human",
                    why="Several invoices and at least one needs a person: " +
                        ", ".join(f"{o['ref']}={o['outcome']}" for o in outcomes if o["outcome"] not in REPLY_OK)), outcomes

    o = outcomes[0]
    k = o["outcome"]
    if k == "paid" and intent == "not_received":
        return _dec("internal_action_note", "paid_not_received",
                    why="Vendor says payment not received; records show the payment settled."), outcomes
    if k == "paid":
        return _dec("draft_reply", "paid", recipient=reply_to, why="Payment settled."), outcomes
    if k == "released":
        return _dec("draft_reply", "released", recipient=reply_to, why="Payment released, not yet settled."), outcomes
    if k == "scheduled":
        return _dec("draft_reply", "scheduled_run", recipient=reply_to, why="Bill is on a scheduled payment run."), outcomes
    if k == "approved_no_run":
        return _dec("draft_reply", "approved_no_run", recipient=reply_to, why="Approved, open, on no run, no payment."), outcomes
    if k == "pending":
        ap = o["approver"] or {}
        rule = "pending_inactive_approver" if ap.get("inactive_approver") else "pending_approval"
        return _dec("internal_action_note", rule, act_by=ap.get("act_by"),
                    why=f"Bill is {o['bill']['status']}; {ap.get('detail')}."), outcomes
    if k == "returned":
        return _dec("internal_action_note", "returned_payment",
                    why=f"Payment was returned ({o['payment'].get('custbody_failure_reason') or 'no reason given'})."), outcomes
    if k == "conflict":
        return _dec("internal_action_note", "records_conflict", why=o.get("conflict", "records disagree")), outcomes
    return _dec("internal_action_note", "uncertain", why=f"Unhandled record state {k!r}."), outcomes


def _classify_found(items, lk):
    return [classify_bill(i["bill"], lk) for i in items if i["status"] == "found"]
