"""Drafter: renders a reply, an internal action note or a no-draft reason from
the decision and the record outcomes. Every date, amount and reference in the
text comes from a record (or the fixed holding-reply update date). Nothing from
the sender's email is repeated as fact.

SNIPPETS is the reply-snippet library keyed by outcome. Staff can edit the
wording here without touching the rules.
"""
import datetime as dt

from rules import HOLDING_UPDATE_DATE

SIGNATURE = "Best regards,\nOrchestra Accounts Payable"

METHOD_WORDS = {"ACH": "ACH transfer", "Wire": "wire transfer", "Check": "check", "Card": "card"}

SNIPPETS = {
    "paid": "Invoice {ref}{for_vendor} was paid on {pay_date} by {method}, reference {pay_ref}.{settled}",
    "released": ("Payment for invoice {ref}{for_vendor} was released on {release_date} by {method} (reference {pay_ref}), "
                 "so the funds have left our bank. Depending on the receiving bank it can take a few business days "
                 "to show in the account."),
    "scheduled": ("Invoice {ref}{for_vendor} is approved and included in our payment run on {run_date}. "
                  "We will confirm the payment details once that run completes."),
    "approved_no_run": ("Invoice {ref}{for_vendor} is approved and in the queue for payment. Approved invoices are "
                        "normally paid within 5 to 10 business days."),
    "pending": "Invoice {ref}{for_vendor} is pending internal approval, so we can't give a payment timeline yet. We will follow up once it is approved.",
    "not_on_file": ("We could not find invoice {ref}{for_vendor} in our system. Could you please send a PDF copy of "
                    "the invoice to this address so we can get it entered?"),
    "not_on_file_noref": ("We could not match this message to an invoice in our system. Could you please reply with the "
                          "invoice number and a PDF copy of the invoice so we can look into it?"),
    "holding": ("Thank you for your message{about}. We have escalated it to our Accounts Payable lead, who is reviewing "
                "it now. We will send you an update by {update_date}."),
    # multi-invoice lines
    "line_paid": "- {ref}: paid on {pay_date} by {method}, reference {pay_ref}.",
    "line_released": "- {ref}: payment released on {release_date} by {method} (reference {pay_ref}); the funds have left our bank.",
    "line_scheduled": "- {ref}: approved and included in our payment run on {run_date}.",
    "line_approved_no_run": "- {ref}: approved; approved invoices are normally paid within 5 to 10 business days.",
    "line_pending": "- {ref}: pending internal approval. We can't give a payment timeline yet and will follow up once it is approved.",
    "line_not_on_file": "- {ref}: we could not find this invoice in our system. Please send a PDF copy so we can enter it.",
}


def fmt_date(iso, weekday=False):
    d = dt.date.fromisoformat(iso)
    s = f"{d:%B} {d.day}, {d.year}"
    return f"{d:%A}, {s}" if weekday else s


def _method(p):
    return METHOD_WORDS.get(p.get("paymentMethod"), (p.get("paymentMethod") or "payment").lower())


def outcome_fields(o):
    p, r = o.get("payment") or {}, o.get("run") or {}
    f = {"ref": o["ref"]}
    if p:
        f.update(pay_date=fmt_date(p["tranDate"]) if p.get("tranDate") else "",
                 method=_method(p), pay_ref=p.get("referenceNumber") or p.get("tranId"),
                 release_date=fmt_date(p.get("custbody_released_date") or p["tranDate"]))
        sd = p.get("custbody_settled_date")
        f["settled"] = (f" The payment settled on {fmt_date(sd)}." if sd and sd != p.get("tranDate") else "")
    if r:
        f["run_date"] = fmt_date(r["run_date"], weekday=True)
    return f


def _greeting(view, sender):
    n = view.first_name
    return f"Hi {n}," if n else "Hello,"


def _for_vendor(sender, vendor_name):
    return f" from {vendor_name}" if sender["kind"] == "employee" and vendor_name else ""


def render_reply(dec, outcomes, items, view, sender, vendor_name):
    fv = _for_vendor(sender, vendor_name)
    rule = dec["rule"]
    body = []
    if rule == "holding_reply":
        refs = [i["ref"] for i in items if i["status"] == "found"] or [i["ref"] for i in items]
        about = f" about invoice {refs[0]}" if len(refs) == 1 else (" about your invoices" if refs else "")
        body.append(SNIPPETS["holding"].format(about=about, update_date=fmt_date(HOLDING_UPDATE_DATE)))
    elif rule == "not_on_file":
        nf = [i for i in items if i["status"] == "not_found"]
        if nf:
            body.append(SNIPPETS["not_on_file"].format(ref=nf[0]["ref"], for_vendor=fv))
        else:
            body.append(SNIPPETS["not_on_file_noref"])
        if sender["kind"] == "employee":
            body.append("If the vendor sends the PDF to you, please forward it to this inbox.")
    elif rule == "multi_invoice":
        intro = "Thank you for checking in. Here is where each invoice stands"
        intro += f" for {vendor_name}:" if fv else ":"
        body.append(intro)
        lines = []
        by_ref = {o["ref"]: o for o in outcomes}
        for i in items:
            if i["status"] == "found":
                o = by_ref[i["bill"]["tranId"]]
                lines.append(SNIPPETS["line_" + o["outcome"]].format(**outcome_fields(o)))
            elif i["status"] == "not_found":
                lines.append(SNIPPETS["line_not_on_file"].format(ref=i["ref"]))
        body.append("\n".join(lines))
    else:
        o = outcomes[0]
        key = {"paid": "paid", "released": "released", "scheduled_run": "scheduled", "approved_no_run": "approved_no_run"}[rule]
        f = outcome_fields(o)
        f["for_vendor"] = fv
        f.setdefault("settled", "")
        body.append("Thank you for checking in. " + SNIPPETS[key].format(**f))
        if sender["kind"] == "employee":
            body.append("You're welcome to pass this on to the vendor.")
    return "\n\n".join([_greeting(view, sender)] + body + [SIGNATURE])


# ---------------------------------------------------------------- internal notes
def _who(sender):
    k = {"vendor_contact": "listed vendor contact", "employee": "employee", "unknown": "unverified sender"}[sender["kind"]]
    return f"{sender['name'] or sender['email']} <{sender['email']}> ({k})"


def _records_line(outcomes, include_payment=True, include_dates=True):
    parts = []
    for o in outcomes:
        b = o["bill"]
        s = f"bill {b['internalId']} / invoice {b['tranId']} ({b['entityName']}): {b['status']}, {b['approvalStatus']}"
        p = o.get("payment")
        if p and include_payment:
            s += f"; payment {p['tranId']} {p.get('custbody_release_status')}"
            if include_dates and p.get("tranDate"):
                s += f" on {p['tranDate']}"
        r = o.get("run")
        if r:
            s += f"; run {r['run_status'].lower()}" + (f" {r['run_date']}" if include_dates else "")
        parts.append(s)
    return "; ".join(parts) if parts else "no bill matched"


def render_note(dec, outcomes, items, view, sender, vendor, linked):
    vid, vname, _ = vendor
    rule = dec["rule"]
    head = "INTERNAL ACTION NOTE (review only, nothing has been sent)"
    act_for, todo, extra = "Accounts Payable team", "", []
    refs = ", ".join(i["ref"] for i in items) or "none given"
    if rule == "fraud":
        act_for = "Accounts Payable lead"
        todo = ("Treat as possible fraud. Do not reply with payment details and do not change any vendor banking. "
                f"Verify by a callback to {vname or 'the vendor'} using the phone or contact details already on file "
                "in NetSuite, never details from this email.")
        extra.append("Fraud cues: " + dec["why"] + ".")
        extra.append("Any bank or account numbers in the email are withheld from this note on purpose.")
    elif rule == "unauthorized_sender":
        todo = ("Do not share payment details. Verify the requester through the vendor's contact on record "
                "before anyone replies.")
        extra.append(f"Sender is not listed as an authorized contact for {vname or 'any vendor'} and is not an active employee. "
                     f"Invoice mentioned: {refs}. Payment records were not shared in this note.")
    elif rule in ("injection_suspected", "model_flagged"):
        act_for = "Accounts Payable lead"
        todo = ("Review this ticket by hand before anyone replies. Do not share payment details. "
                "Treat the message text as untrusted.")
        extra.append(("The message contains text aimed at an automated assistant: " if rule == "injection_suspected"
                      else "The safety screen flagged this message: ") + dec["why"] + ".")
    elif rule == "expedite_request":
        act_for = "Accounts Payable lead"
        todo = ("Decide whether an early or off-cycle payment is justified. Do not promise a date to the vendor "
                "until that decision is made.")
        extra.append("Request: pay early or outside the normal payment run.")
        extra.append("Records: " + _records_line(outcomes, include_dates=False) + ".")
    elif rule == "late_fee":
        act_for = "Accounts Payable lead"
        todo = ("Review the late fee claim against the vendor's terms on file before anyone responds. "
                "Do not accept the fee or promise a payment date in the reply.")
        extra.append("Request: vendor says a late fee applies.")
        extra.append("Records: " + _records_line(outcomes, include_dates=False) + ".")
    elif rule in ("pending_approval", "pending_inactive_approver"):
        o = outcomes[0]
        ap = o["approver"] or {}
        if ap.get("act_by"):
            act_for = f"{ap['name']} ({ap['act_by']})" if ap.get("name") else ap["act_by"]
        if ap.get("inactive_approver"):
            ia = ap["inactive_approver"]
            extra.append(f"The next approver on the bill, {ia['name']} ({ia['email']}), is inactive, so this goes to their delegate.")
        todo = (f"Approve or reject invoice {o['ref']} ({o['vendor_name']}), currently {o['bill']['status']}. "
                "Once it is approved, AP can reply to the requester. No payment date should be given before then.")
        extra.append("Records: " + _records_line(outcomes, include_dates=False) + ".")
    elif rule == "returned_payment":
        o = outcomes[0]
        reason = o["payment"].get("custbody_failure_reason") or "no reason recorded"
        todo = (f"The payment for invoice {o['ref']} was returned ({reason}). Confirm the vendor's banking through "
                "contact details already on file, then arrange a new payment. Do not share the returned payment's reference.")
        extra.append(f"Records: bill {o['bill']['internalId']} {o['bill']['status']}; payment {o['payment']['tranId']} Returned.")
    elif rule == "paid_not_received":
        todo = ("The sender says the money has not arrived, but the payment record shows it settled. Verify with the bank "
                "(trace the payment) before replying.")
        extra.append("Records: " + _records_line(outcomes) + ".")
        for o in outcomes:
            p = o.get("payment")
            if p and o["outcome"] == "paid":
                extra.append(f"Payment to trace for {o['ref']}: {p.get('paymentMethod')} reference {p.get('referenceNumber')}, "
                             f"settled {p.get('custbody_settled_date') or p.get('tranDate')}.")
    elif rule == "records_conflict":
        todo = "Resolve the conflict in NetSuite before anyone replies: " + dec["why"] + "."
        extra.append("Records: " + _records_line(outcomes) + ".")
    elif rule == "not_on_file_linked":
        lt = next(lt for lt in linked if lt["found"] and not lt["solved"])
        todo = (f"Invoice {refs} is not entered yet. Linked ticket #{lt['id']} holds the invoice "
                f"({lt['status']}: {lt['last_note'] or 'no internal note'}). Finish coding and entry from ticket #{lt['id']}, "
                "then reply to the requester.")
    elif rule == "linked_ticket_unavailable":
        lt = next(lt for lt in linked if not lt["found"])
        todo = f"No bill matches; linked ticket #{lt['id']} could not be read. Check it by hand before replying."
    elif rule == "foreign_reference":
        todo = ("The invoice number matches a bill for a different vendor than the sender's. Verify which vendor "
                "issued it before sharing anything.")
    elif rule == "multi_needs_human":
        todo = "Several invoices; at least one needs a person before replying. " + dec["why"] + "."
        extra.append("Records: " + _records_line([o for o in outcomes if o["outcome"] != "returned"]) + ".")
    else:
        todo = "The pipeline was not sure how to answer this. Review by hand. " + dec.get("why", "")
    lines = [head, f"Action for: {act_for}", f"What to do: {todo}"]
    lines += extra
    lines.append(f"Ticket #{view.id} from {_who(sender)}. Invoice reference(s): {refs}.")
    return "\n".join(lines)


def render_no_draft(dec):
    return dec["why"]
