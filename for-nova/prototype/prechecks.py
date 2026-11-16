"""Pre-checks (README order of checks, tiers 1 and 2).

Tier 1: possible fraud (bank-detail change, lookalike domain, sign-in link).
Tier 2: no-reply sender, machine notice, no request, misrouted (HR / AR).

All functions are pure: ticket text and sender in, findings out.
"""
import re

from cues import scan, urls

NO_REPLY_LOCAL = re.compile(r"^(no[-_.]?reply|do[-_.]?not[-_.]?reply|noreply|donotreply)([-_.+].*)?$", re.I)
MACHINE_LOCAL = re.compile(r"^(notify|notifications?|alerts?|mailer[-_.]?daemon|postmaster|newsletter|news|marketing|"
                           r"bounce[s]?|automated|system|docusign|esign|echosign|calendar)([-_.+].*)?$", re.I)


def _lev(a, b):
    if a == b:
        return 0
    if abs(len(a) - len(b)) > 3:
        return 99
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def registrable(host):
    host = (host or "").lower().strip(".")
    host = re.sub(r"^[a-z]+://", "", host).split("/")[0].split(":")[0]
    parts = host.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def lookalike_of(domain, known_domains):
    """Return the known domain this one imitates, or None.

    A lookalike is not equal to a known domain but contains its name, is
    contained in it, differs by one or two characters, or swaps the TLD.
    """
    d = registrable(domain)
    if not d or d in known_domains:
        return None
    db, _, dt = d.rpartition(".")
    for k in sorted(known_domains):
        kb, _, kt = k.rpartition(".")
        if not kb or len(kb) < 6:
            continue
        if db == kb and dt != kt:
            return k
        if kb in db or (len(db) >= 8 and db in kb):
            return k
        if len(kb) >= 8 and _lev(db, kb) <= 2:
            return k
    return None


def fraud_screen(view, known_domains, cues=None):
    """Tier 1. Returns a list of reasons (empty = pass)."""
    text = view.all_text()
    cues = cues if cues is not None else scan(text)
    reasons = []
    if cues.get("bank_change"):
        reasons.append("bank-detail change language: " + "; ".join(repr(c[:60]) for c in cues["bank_change"][:2]))
    sender_domain = view.sender_email.split("@")[-1] if "@" in view.sender_email else ""
    la = lookalike_of(sender_domain, known_domains)
    if la:
        reasons.append(f"sender domain {sender_domain} imitates known domain {la}")
    found_urls = urls(text)
    for u in found_urls:
        la_u = lookalike_of(registrable(u), known_domains)
        if la_u:
            reasons.append(f"link host {registrable(u)} imitates known domain {la_u}")
    if found_urls and cues.get("login_language"):
        hosts = {registrable(u) for u in found_urls}
        automated = bool(NO_REPLY_LOCAL.match(view.sender_email.split("@")[0]) or MACHINE_LOCAL.match(view.sender_email.split("@")[0]))
        if not (automated and hosts <= set(known_domains)):
            reasons.append("sign-in link in a payment email (" + ", ".join(sorted(hosts)) + ")")
    return reasons


def tier2(view, cues, sender_kind):
    """Tier 2. Returns (reason_tag, why) or (None, None).

    sender_kind is "vendor_contact", "employee" or "unknown" (from resolve).
    """
    local = view.sender_email.split("@")[0] if "@" in view.sender_email else view.sender_email
    if NO_REPLY_LOCAL.match(local):
        return "no_reply_sender", f"Sender {view.sender_email} is a no-reply address."
    if cues.get("machine_notice") or MACHINE_LOCAL.match(local):
        what = (cues.get("machine_notice") or [local + "@ sender"])[0]
        return "machine_notice", f"Automated notice with no request ({what!r})."
    if cues.get("no_reply_text"):
        return "no_reply_sender", f"Sender mailbox is unmonitored ({cues['no_reply_text'][0]!r})."
    if cues.get("hr_or_payroll"):
        return "misrouted", f"HR or payroll request ({cues['hr_or_payroll'][0]!r}); belongs with HR/Payroll, not AP."
    if cues.get("receivable_from_client") and sender_kind != "vendor_contact":
        return "misrouted", ("Client telling us they paid an invoice Orchestra issued "
                             f"({cues['receivable_from_client'][0]!r}); this is Accounts Receivable mail.")
    if is_no_request(view, cues):
        return "no_request", "Message asks for nothing (thank-you or acknowledgement)."
    return None, None


def is_no_request(view, cues):
    text = (view.body or "").strip()
    if cues.get("request") and any(c != "?" for c in cues["request"]) or "?" in text:
        return False
    if cues.get("threat") or cues.get("not_received") or cues.get("expedite") or cues.get("late_fee"):
        return False
    # Short acknowledgement with gratitude and no ask.
    return bool(cues.get("gratitude")) and len(text) < 400
