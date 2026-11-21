"""Facts the inbox list is sorted by: invoice amount, due date, urgency tier and where the work goes next.

Pure functions, no database and no I/O: inbox._rows feeds them what it already holds. Never call the traced evidence
lookup from here; the list must stay fast.
"""
import datetime as _dt

CRITICAL_FLAGS = {"fraud", "legal", "exec_cc", "injection"}
TIME_SENSITIVE_INTENTS = {"not_received", "bank_change", "expedite_request", "late_fee"}
TIME_SENSITIVE_CATEGORIES = {"returned", "early_or_late_fee"}
DUE_SOON_DAYS = 3
PAID = "Paid In Full"
CFO_NAME = "Elena Lockhart"


def pick_bills(find, refs, company):
    """The bills a thread is about. `find(ref)` returns the bills with that invoice number. An ambiguous number (the same
    number on two vendors) is kept only for the thread's own company; with no company it is dropped. Distinct by internalId."""
    out, seen = [], set()
    for ref in refs:
        found = list(find(ref) or [])
        if len(found) > 1:
            found = [b for b in found if company and b.get("entityName") == company]
        for b in found:
            if b["internalId"] not in seen:
                seen.add(b["internalId"])
                out.append(b)
    return out


def invoice_facts(bills):
    """{amount, currency, due_date}: the summed total of every bill, and the earliest due date among the unpaid ones.
    A paid invoice has no due date that matters to AP, so it never makes a thread overdue."""
    total, due = None, None
    for b in bills:
        try:
            amount = float(b["userTotal"])
        except (KeyError, TypeError, ValueError):
            continue
        total = (total or 0.0) + amount
        d = b.get("dueDate")
        if d and b.get("status") != PAID and (due is None or d < due):
            due = d
    return {"amount": total, "currency": "USD" if total is not None else None, "due_date": due}


def urgency_tier(*, flags, intent, category, wf_state, priority, finished, due_date, today):
    """1 critical, 2 time-sensitive, 3 needs a decision, 4 routine, 5 nothing left to do. The first rule that fits wins."""
    if CRITICAL_FLAGS & set(flags or ()):
        return 1
    if finished:
        return 5
    soon = False
    if due_date:
        try:
            soon = _dt.date.fromisoformat(due_date) <= today + _dt.timedelta(days=DUE_SOON_DAYS)
        except ValueError:
            soon = False
    if intent in TIME_SENSITIVE_INTENTS or category in TIME_SENSITIVE_CATEGORIES or soon:
        return 2
    if wf_state in ("escalated", "signoff_requested") or priority:
        return 3
    return 4


def destination_of(*, finished, forwarded, wf_state, priority, waiting_approver, act_by, rule, output_type):
    """(destination id, name or None): where the work goes next. Ids, in display order: cfo, approver, vendor,
    payment_run, forwarded, desk, closed."""
    if forwarded:
        return "forwarded", forwarded
    if finished:
        return "closed", None
    if wf_state in ("escalated", "signoff_requested") or (priority and wf_state != "signed_off"):
        return "cfo", CFO_NAME
    if waiting_approver:
        return "approver", act_by
    if rule in ("scheduled_run", "approved_no_run"):
        return "payment_run", None
    if output_type == "draft_reply":
        return "vendor", None
    return "desk", None
