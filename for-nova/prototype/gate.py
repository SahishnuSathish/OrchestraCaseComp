"""Deterministic gate: skip the 9B model when regex is already confident.

When the model is skipped the result equals the no-model result (the scored baseline). The gate only removes
calls on tickets with a known sender, a known invoice, no risky wording of any kind and a short thread, where
the model could at most have added a cue. Anything unusual, long, from an unknown sender, without an invoice
number, or flagged novel by the embedding check goes to the model.
"""
import re

import extract_regex
from trace import NullTrace

UNUSUAL = re.compile(r"\b(clause|terms?|rights?|agency|solicitor|statutory|accru\w*|surcharge|queue|exception|one-off|recover\w*|receivables?)\b", re.I)
LONG_BODY = 1200
BENIGN = {"request", "gratitude"}  # ordinary politeness is not a risk signal


class GatedExtractor:
    def __init__(self, inner, store, mode="auto", novelty_fn=None):
        if mode not in ("auto", "always", "never"):
            raise ValueError(mode)
        self.inner, self.store, self.mode, self.novelty_fn = inner, store, mode, novelty_fn

    @property
    def model(self):
        return getattr(self.inner, "model", "unknown")

    def signals(self, view):
        lk = self.store.session(NullTrace())
        ext = extract_regex.extract(view, lk, self.store.vendors)
        refs = ext["invoice_refs"]
        sender_known = bool(lk.find_vendor_by_contact(view.sender_email)) or bool(lk.find_employee_by_email(view.sender_email))
        s = {"refs_ok": bool(refs) and all(r.get("on_file") for r in refs), "sender_known": sender_known,
             "cue_families": sorted(f for f in ext["cues"] if f not in BENIGN), "unusual": bool(UNUSUAL.search(view.all_text())),
             "long_body": len(view.body or "") > LONG_BODY, "comment_count": view.comment_count,
             "has_attachments_without_ref": bool(view.attachments) and not bool(refs)}
        s["novel"] = bool(self.novelty_fn(view)) if self.novelty_fn else False
        return s

    def would_skip(self, view):
        """True when the model call would be skipped for this ticket."""
        if self.mode == "always":
            return False
        if self.mode == "never":
            return True
        s = self.signals(view)
        return (s["refs_ok"] and s["sender_known"] and not s["cue_families"] and not s["unusual"] and not s["long_body"]
                and view.comment_count <= 2 and not s["has_attachments_without_ref"] and not s["novel"])

    def read(self, view):
        sig = self.signals(view) if self.mode == "auto" else {}
        if self.would_skip(view):
            return None, {"model": self.model, "error": "gated: regex confident", "gated": True, "ms": 0, "attempts": 0,
                          "local": True, "signals": sig}
        reading, info = self.inner.read(view)
        info = dict(info, gated=False, signals=sig)
        return reading, info
