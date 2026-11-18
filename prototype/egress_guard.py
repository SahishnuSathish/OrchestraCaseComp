"""One gate for every new outward channel: portal answers, notices, digests, summaries.

check_outbound  text a vendor or requester could see (wraps draft_check.check_reply, adds leak checks)
check_internal  text only staff see (no bank-like content, no unlisted long numbers, no links)
mask_email      z***@vendor.example, for logs
"""
import re

from draft_check import BANKISH, LONG_NUMBER, check_reply

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
URL = re.compile(r"https?://|www\.", re.I)


def mask_email(e):
    local, _, domain = (e or "").partition("@")
    return f"{local[:1]}***@{domain}" if domain else "***"


def check_outbound(text, outcomes=(), refs=(), recipient=None, allow_emails=()):
    """Problems with text that may leave the building. Empty list = fine."""
    problems = list(check_reply(text, list(outcomes), list(refs)))
    ok = {e.lower() for e in (allow_emails or ())} | ({recipient.lower()} if recipient else set())
    for m in EMAIL.findall(text):
        if m.lower() not in ok:
            problems.append("email address that is not the recipient")
            break
    for o in outcomes:
        p = o.get("payment") or {}
        reason = p.get("custbody_failure_reason")
        if reason and reason.lower() in text.lower():
            problems.append("returned-payment failure reason")
        if o.get("outcome") == "returned":
            for ref in (p.get("referenceNumber"), p.get("tranId")):
                if ref and ref in text:
                    problems.append("reference of a returned payment")
    if URL.search(text):
        problems.append("link")
    return problems


def check_internal(text, allowed_numbers=()):
    """Problems with staff-only text: bank wording, unlisted long numbers, links."""
    problems = []
    scan = text
    for a in sorted((str(a) for a in allowed_numbers if a), key=len, reverse=True):
        scan = scan.replace(a, "[ok]")
    if BANKISH.search(scan):
        problems.append("bank wording")
    if LONG_NUMBER.search(scan):
        problems.append("long number that is not an allowed reference")
    if URL.search(text):
        problems.append("link")
    return problems
