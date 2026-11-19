"""Lookup planner: which platforms a ticket needs, decided BEFORE records are pulled.

The rules side proposes a plan from what the ticket looks like; the model may
add a Zendesk lookup (it noticed a reference to an earlier ticket) but can
never remove one. Tickets that stop at the pre-checks (automated mail, no
request, misrouted) skip every bill and payment call, which is where the
saved API round trips come from.
"""


def plan_lookups(view, ext, tier2_hit, model_notes=None):
    plan = {"netsuite": ["find_vendor_by_contact", "find_employee_by_email"], "payment_system": False,
            "zendesk_ticket_ids": [], "skipped": False, "why": [], "added_by_model": []}
    if tier2_hit:
        plan["skipped"] = True
        plan["why"].append(f"pre-check '{tier2_hit}' ends the ticket, so no bill, payment or linked-ticket lookups")
        return plan
    if ext["invoice_refs"]:
        plan["netsuite"].append("find_bills_by_tranId")
        plan["payment_system"] = True
        plan["why"].append(f"{len(ext['invoice_refs'])} invoice reference(s) found: bills, payments and runs")
    else:
        plan["netsuite"] += ["find_vendors_by_domain"]
        plan["why"].append("no invoice reference: identify the vendor only")
    plan["zendesk_ticket_ids"] = list(view.linked_ticket_ids)
    if view.linked_ticket_ids:
        plan["why"].append("ticket carries linked_ticket_ids")
    if view.cc_user_ids:
        plan["why"].append("cc users checked against employees for executives")
    for tid in (model_notes or {}).get("mentioned_tickets", []):
        if tid not in plan["zendesk_ticket_ids"]:
            plan["zendesk_ticket_ids"].append(tid)
            plan["added_by_model"].append(f"zendesk:{tid}")
    if (model_notes or {}).get("needs_platforms") and "payment_system" in model_notes["needs_platforms"] and not plan["payment_system"]:
        plan["added_by_model"].append("payment_system (no invoice found; nothing to look up until one is named)")
    return plan
