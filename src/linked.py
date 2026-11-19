"""Linked tickets and copied executives (Zendesk-side facts).

`read_linked` turns an earlier ticket into the small dict the rules use:
  {id, found, status, solved, answered, refs, last_note}
`executives_copied` maps cc user ids to employee records and keeps C-level / Executive staff.
"""
import re

from data_layer import norm_ref
from extract_regex import BARE, PREFIXED, YEARLIKE


def _refs_in(text, lk):
    refs = set()
    for rx in (PREFIXED, YEARLIKE, BARE):
        for m in rx.finditer(text):
            tok = m.group(1) if rx is YEARLIKE or rx is BARE else m.group(0)
            for c in lk.canonical_refs(tok):
                refs.add(c.upper())
    return refs


def read_linked(lk, tid):
    t = lk.get_linked_ticket(tid)
    if not t:
        return {"id": tid, "found": False, "status": None, "solved": False, "answered": False, "refs": set(), "last_note": None}
    comments = t.get("comments") or []
    text = " ".join([t.get("subject") or ""] + [c.get("body") or "" for c in comments])
    answered, last_note = False, None
    for c in comments:
        u = lk.b.user(c["author_id"]) if c.get("author_id") is not None else None
        if (u or {}).get("role") == "agent":
            if c.get("public"):
                answered = True
            else:
                last_note = c.get("body")
    status = t.get("status")
    return {"id": tid, "found": True, "status": status, "solved": status in ("solved", "closed"),
            "answered": answered, "refs": _refs_in(text, lk), "last_note": last_note}


def executives_copied(view, lk):
    out = []
    for uid in view.cc_user_ids:
        u = lk.get_user(uid)
        emp = lk.find_employee_by_email((u or {}).get("email")) if u else None
        if emp and (emp.get("department") == "Executive" or re.match(r"(chief|vp|vice president|president)\b", emp.get("title") or "", re.I)):
            out.append(f"{emp['firstName']} {emp['lastName']} ({emp['title']})")
    return out
