"""Validator: an extracted reference survives only if it literally appears in
the ticket subject, body or an attachment file name (case-insensitive, with
separators normalized). This guards against a model inventing references and
against prompt-injected text that is not actually in the ticket.
"""
import re


def searchable_parts(view):
    """(where, text) pairs. Attachment names get '_' -> ' ' and the extension dropped."""
    parts = [("subject", view.subject or ""), ("body", view.body or "")]
    for fn in view.attachments:
        stem = re.sub(r"\.[A-Za-z0-9]{2,5}$", "", fn)
        parts.append(("attachment", stem.replace("_", " ")))
    return parts


def _pattern(ref):
    chunks = re.findall(r"[A-Za-z]+|\d+", ref or "")
    if not chunks:
        return None
    body = r"[\s\-_#]{0,2}".join(re.escape(c) for c in chunks)
    return re.compile(r"(?<![A-Za-z0-9])" + body + r"(?![A-Za-z0-9])", re.I)


def literal_present(ref, view):
    p = _pattern(ref)
    if p is None:
        return False
    return any(p.search(t) for _, t in searchable_parts(view))


def where_present(ref, view):
    p = _pattern(ref)
    if p is None:
        return None
    for where, t in searchable_parts(view):
        if p.search(t):
            return where
    return None
