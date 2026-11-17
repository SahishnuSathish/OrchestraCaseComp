"""Vendor self-service status lookup: a pure, read-only function over the Store.

Input is structured only (contact email, invoice reference), so there is no free text to inject into, no fraud
surface and no way to change bank details. Authorization comes from records only. A missing bill, another
vendor's bill and an unauthorized sender all get the same answer, so the lookup cannot be used to enumerate
invoice numbers. Wording comes from the same snippets the staff drafts use, and every answer passes egress_guard.
"""
import re

import drafts
import egress_guard
import rules
from trace import Trace

AP_EMAIL = "ap@orchestra-mock.example"
REF_OK = re.compile(r"^[A-Za-z0-9#\- ]{1,20}$")
NOT_MATCHED = f"We couldn't match that invoice to your account. Please email {AP_EMAIL} with the invoice PDF."
NEEDS_REVIEW = f"Our team needs to review this invoice. Please contact {AP_EMAIL} and we'll follow up."

SNIPPET_FOR = {"paid": "paid", "released": "released", "scheduled": "scheduled", "approved_no_run": "approved_no_run",
               "pending": "pending"}


def _result(ok, message, state, trace):
    return {"ok": ok, "message": message, "state": state, "trace": trace.events}


def lookup_status(contact_email, invoice_ref, store):
    trace = Trace()
    lk = store.session(trace)
    email = (contact_email or "").strip().lower()
    if not REF_OK.match(invoice_ref or ""):
        return _result(False, NOT_MATCHED, None, trace)

    # who is asking: records only
    vendors = lk.find_vendor_by_contact(email)
    vendor_id, any_vendor = None, False
    if len(vendors) == 1 and vendors[0].get("isInactive", "F") != "T":
        vendor_id = vendors[0]["internalId"]
    elif not vendors:
        emp = lk.find_employee_by_email(email)
        any_vendor = bool(emp) and emp.get("isInactive") != "T"
    if vendor_id is None and not any_vendor:
        return _result(False, NOT_MATCHED, None, trace)

    # which bill: keep only the requester's own (employees may see any vendor's)
    bills = []
    for canon in lk.canonical_refs(invoice_ref.strip()):
        bills += lk.find_bills_by_tranid(canon)
    if vendor_id is not None:
        bills = [b for b in bills if b["entity"] == vendor_id]
    if len(bills) != 1:
        return _result(False, NOT_MATCHED, None, trace)

    o = rules.classify_bill(bills[0], lk)
    key = SNIPPET_FOR.get(o["outcome"])
    if key is None:
        return _result(True, NEEDS_REVIEW, o["outcome"], trace)
    fields = drafts.outcome_fields(o)
    fields.setdefault("settled", "")
    fields["for_vendor"] = ""
    msg = drafts.SNIPPETS[key].format(**fields)
    if egress_guard.check_outbound(msg, [o], [o["ref"]]):
        return _result(True, NEEDS_REVIEW, o["outcome"], trace)
    return _result(True, msg, o["outcome"], trace)
