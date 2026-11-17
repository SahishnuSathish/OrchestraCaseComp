"""Draft check: last gate before anything is shown to staff.

A reply may only contain facts that came from records. If the check fails the
output is downgraded to an internal note (a person looks at it).
"""
import re

from drafts import fmt_date
from rules import HOLDING_UPDATE_DATE

DATE_TEXT = re.compile(r"\b(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}\b")
LONG_NUMBER = re.compile(r"\d[\d\s-]{6,}\d")
BANKISH = re.compile(r"\b(routing|iban|swift|sort code|account (number|no))\b", re.I)


def allowed_dates(outcomes):
    ok = {fmt_date(HOLDING_UPDATE_DATE)}
    for o in outcomes:
        for rec in (o.get("payment") or {}, o.get("run") or {}):
            for k, v in rec.items():
                if isinstance(v, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
                    ok.add(fmt_date(v))
    return ok


def check_reply(text, outcomes, refs=()):
    """Return a list of problems (empty = fine). `refs` are invoice numbers the sender named."""
    problems = []
    scan = text
    allowed = set(refs) | {o["ref"] for o in outcomes}
    for o in outcomes:
        p = o.get("payment") or {}
        allowed |= {p.get("referenceNumber"), p.get("tranId")}
    for a in sorted((a for a in allowed if a), key=len, reverse=True):
        scan = scan.replace(a, "[record ref]")
    if LONG_NUMBER.search(scan) or BANKISH.search(scan):
        problems.append("bank-like number or wording")
    ok = allowed_dates(outcomes)
    for m in DATE_TEXT.finditer(text):
        if m.group(0) not in ok:
            problems.append(f"date {m.group(0)} not from a record")
    if outcomes and any(o["outcome"] != "paid" for o in outcomes) and re.search(r"\bwas paid\b|\bhas been paid\b", text):
        problems.append("says paid where a record does not")
    return problems
