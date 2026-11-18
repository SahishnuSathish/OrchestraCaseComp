"""Who is asking, which vendor, which bills.

Sender kinds:
  vendor_contact  address is in a vendor's authorizedContacts
  employee        address is an employee record (authorized only if active)
  unknown         anything else (may still sit on a vendor's domain)
"""

SHARED_DOMAIN_MIN_VENDORS = 2  # a domain used by 2+ vendors (e.g. a mailbox provider) says nothing


def resolve_sender(view, lk):
    email = view.sender_email
    out = {"email": email, "name": view.sender_name, "kind": "unknown", "authorized": False,
           "vendor_id": None, "vendor_name": None, "employee": None, "domain_vendor_id": None, "detail": ""}
    vendors = lk.find_vendor_by_contact(email)
    if vendors:
        v = vendors[0]
        out.update(kind="vendor_contact", vendor_id=v["internalId"], vendor_name=v["companyName"],
                   authorized=v.get("isInactive", "F") != "T",
                   detail=f"listed contact for {v['entityId']}" + (" (vendor inactive)" if v.get("isInactive") == "T" else ""))
        out["source"] = f"vendors.csv:{v['entityId']}"
        return out
    emp = lk.find_employee_by_email(email)
    if emp:
        active = emp.get("isInactive") != "T"
        out.update(kind="employee", authorized=active, employee=emp,
                   detail=f"employee {emp['firstName']} {emp['lastName']} ({emp['title']})" + ("" if active else ", INACTIVE"))
        out["source"] = f"employees.csv:{emp['entityId']}"
        return out
    domain = email.split("@")[-1] if "@" in email else ""
    dv = lk.find_vendors_by_domain(domain) if domain else []
    if len(dv) == 1:
        out["domain_vendor_id"] = dv[0]["internalId"]
        out["detail"] = f"address not listed; domain belongs to {dv[0]['companyName']}"
    else:
        out["detail"] = "not a vendor contact and not an employee"
    out["source"] = "vendors.csv, employees.csv"
    return out


def _pick_by_hints(bills, hints, sender):
    """Settle a tranId shared by several vendors using vendor names in the text."""
    for strength in ("full", "weak"):
        ids = {h["vendor_id"] for h in hints if h["strength"] == strength}
        m = [b for b in bills if b["entity"] in ids]
        if len(m) == 1:
            return m[0], f"settled by vendor named in text ({m[0]['entityName']})"
    if sender.get("domain_vendor_id"):
        m = [b for b in bills if b["entity"] == sender["domain_vendor_id"]]
        if len(m) == 1:
            return m[0], "settled by sender domain"
    return None, None


def resolve_items(extraction, sender, lk):
    """One item per extracted reference.

    status: found | ambiguous | foreign (bill exists only for another vendor) | not_found
    """
    items = []
    hints = extraction.get("vendor_hints") or []
    for r in extraction.get("invoice_refs") or []:
        item = {"ref": r["ref"], "where": r["where"], "status": "not_found", "bill": None, "candidates": [], "detail": ""}
        bills = lk.find_bills_by_tranid(r["ref"])  # traced even when the index says "not on file"
        item["candidates"] = [{"bill_id": b["internalId"], "vendor_id": b["entity"], "vendor": b["entityName"]} for b in bills]
        if not bills:
            item["detail"] = "no bill with this invoice number"
        elif sender["kind"] == "vendor_contact":
            own = [b for b in bills if b["entity"] == sender["vendor_id"]]
            if own:
                item.update(status="found", bill=own[0], detail=f"tranId {r['ref']}, sender's vendor")
            else:
                item.update(status="foreign", detail="invoice number exists only for a different vendor")
        elif len(bills) == 1:
            item.update(status="found", bill=bills[0], detail=f"tranId {r['ref']}, one vendor match")
        else:
            b, why = _pick_by_hints(bills, hints, sender)
            if b:
                item.update(status="found", bill=b, detail=f"tranId {r['ref']} on {len(bills)} vendors; {why}")
            else:
                item.update(status="ambiguous", detail=f"tranId {r['ref']} exists for {len(bills)} vendors; sender does not say which")
        items.append(item)
    return items


def ticket_vendor(sender, items, extraction, lk):
    """Best vendor for the ticket (id, name, how) or (None, None, why not)."""
    if sender["kind"] == "vendor_contact":
        return sender["vendor_id"], sender["vendor_name"], "sender is a listed contact"
    found = {i["bill"]["entity"]: i["bill"]["entityName"] for i in items if i["status"] == "found"}
    if len(found) == 1:
        vid, name = next(iter(found.items()))
        return vid, name, "from the invoice record"
    if len(found) > 1:
        return None, None, "invoices belong to several vendors"
    full = [h for h in extraction.get("vendor_hints") or [] if h["strength"] == "full"]
    if len(full) == 1:
        return full[0]["vendor_id"], full[0]["name"], "vendor named in the text"
    if sender.get("domain_vendor_id"):
        v = lk.get_vendor(sender["domain_vendor_id"])
        if v:
            return v["internalId"], v["companyName"], "sender domain"
    weak = [h for h in extraction.get("vendor_hints") or []]
    if len(weak) == 1:
        return weak[0]["vendor_id"], weak[0]["name"], "vendor name fragment in the text"
    return None, None, "no vendor identified"
