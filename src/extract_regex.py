"""Phase A extractor: invoice references, vendor hints, intent and risk cues.

Output shape (shared with extract_model.py):
  {
    "invoice_refs": [{"ref": "INV-21529", "where": "subject"}],
    "vendor_hints": [{"vendor_id": "3021", "name": "Saltmarsh Creative", "strength": "full"}],
    "intent": "status_request",
    "risk_cues": ["threat"],
    "asks_about_multiple_invoices": false,
    "method": "regex",
    "cues": {family: [snippets]},
    "ignored_tokens": [...]
  }
A reference is only kept if it matches a known invoice number shape in the
records (via the store's normalized index) AND literally appears in the ticket.
"""
import re

from cues import scan
from validator import literal_present, searchable_parts

PREFIXED = re.compile(r"(?<![A-Za-z0-9])([A-Za-z]{1,4})[\s\-#]{0,2}(\d{3,6})(?![A-Za-z0-9])")
YEARLIKE = re.compile(r"(?<![A-Za-z0-9\-])(\d{4}-\d{3,6})(?![A-Za-z0-9])")
BARE = re.compile(r"(?<![A-Za-z0-9\-,.$/])(\d{3,6})(?![A-Za-z0-9\-/]|[.,]\d)")
CONTEXT_BEFORE = re.compile(r"(invoice|inv|bill|#|no\.?|number|ref(erence)?|nr)\W{0,3}$", re.I)

GENERIC_FIRST_WORDS = {"cobalt", "juniper", "moss", "tin", "plumb", "halcyon", "amber", "copper", "harbor"}
SUFFIXES = {"llc", "co", "group", "inc", "service", "services", "ltd", "studio"}

INTENT_ORDER = [
    ("bank_change", "bank_change"),
    ("threat", "legal_or_collections_threat"),
    ("hr_or_payroll", "hr_or_payroll"),
    ("receivable_from_client", "receivable_from_client"),
    ("machine_notice", "machine_notice"),
    ("not_received", "not_received"),
    ("late_fee", "late_fee"),
    ("expedite", "expedite_request"),
]
RISK_FAMILIES = ["bank_change", "login_language", "threat", "late_fee", "expedite", "not_received",
                 "receivable_from_client", "hr_or_payroll"]


def _vendor_names(v):
    name = v["companyName"]
    words = [w for w in re.split(r"\s+", name) if w]
    out = [(name, "full")]
    core = [w for w in words if w.lower().strip(".,") not in SUFFIXES]
    if len(core) >= 2 and " ".join(core) != name:
        out.append((" ".join(core), "full"))
    if v.get("isPerson") == "T":
        return out
    if len(core) >= 2:
        out.append((" ".join(core[:2]), "full"))
    first = core[0] if core else words[0]
    if len(first) >= 5 and first.lower() not in GENERIC_FIRST_WORDS:
        out.append((first, "weak"))
    return out


def vendor_hints(text, vendors):
    hints = {}
    low = (text or "").lower()
    for v in vendors:
        for nm, strength in _vendor_names(v):
            if re.search(r"(?<![a-z])" + re.escape(nm.lower()) + r"(?![a-z])", low):
                prev = hints.get(v["internalId"])
                if not prev or (prev["strength"] == "weak" and strength == "full"):
                    hints[v["internalId"]] = {"vendor_id": v["internalId"], "name": v["companyName"], "strength": strength}
    return list(hints.values())


def find_refs(view, lookups):
    """Return (refs, ignored). refs: [{"ref": canonical tranId, "where": ..., "token": raw}]"""
    found, ignored, unknown = [], [], []
    seen = set()
    prefixes = set(lookups.s.ref_prefixes)
    dash_prefixes = set(lookups.s.dash_prefixes)
    for where, text in searchable_parts(view):
        spans = []
        cands = []
        for m in PREFIXED.finditer(text):
            letters, digits = m.group(1), m.group(2)
            sep = m.group(0)[len(letters):-len(digits)]
            # "of 12345" must not become OF12345: a spaced prefix must be written in capitals.
            if any(ch.isspace() for ch in sep) and not letters.isupper():
                continue
            canon = lookups.canonical_refs(letters + digits)
            if canon:
                cands.append((m.span(), m.group(0), canon, "high"))
                spans.append(m.span())
            elif letters.upper() in prefixes and 4 <= len(digits) <= 5:
                unknown.append({"ref": letters.upper() + ("-" if "-" in sep or letters.upper() in dash_prefixes else "") + digits,
                                "where": where, "token": m.group(0)})
                spans.append(m.span())
        for m in YEARLIKE.finditer(text):
            canon = lookups.canonical_refs(m.group(1))
            if canon:
                cands.append((m.span(), m.group(1), canon, "high"))
            elif re.fullmatch(r"20\d\d-\d{4,5}", m.group(1)):
                unknown.append({"ref": m.group(1), "where": where, "token": m.group(1)})
            spans.append(m.span())
        for m in BARE.finditer(text):
            s, e = m.span()
            if any(a <= s and e <= b for a, b in spans):
                continue
            canon = lookups.canonical_refs(m.group(1))
            ctx = text[max(0, s - 30):s]
            conf = "high" if where in ("subject", "attachment") or CONTEXT_BEFORE.search(ctx.rstrip()) else "low"
            if not canon:
                if conf == "high" and 4 <= len(m.group(1)) <= 5 and CONTEXT_BEFORE.search(ctx.rstrip()) or (
                        where == "attachment" and 4 <= len(m.group(1)) <= 5):
                    unknown.append({"ref": m.group(1), "where": where, "token": m.group(1)})
                continue
            cands.append(((s, e), m.group(1), canon, conf))
        for span, raw, canon, conf in sorted(cands, key=lambda c: c[0]):
            for c in canon:
                if conf == "low":
                    ignored.append({"token": raw, "where": where, "why": "bare number without invoice context"})
                    continue
                if c in seen:
                    continue
                seen.add(c)
                found.append({"ref": c, "where": where, "token": raw, "on_file": True})
    for u in unknown:
        key = u["ref"].upper()
        if key not in seen:
            seen.add(key)
            found.append(dict(u, on_file=False))
    return found, ignored


def intent_from_cues(cues, view):
    for fam, label in INTENT_ORDER:
        if cues.get(fam):
            return label
    if cues.get("request"):
        return "status_request"
    if cues.get("gratitude"):
        return "no_request"
    return "other"


def extract(view, lookups, vendors):
    text = view.all_text()
    cues = scan(text)
    refs, ignored = find_refs(view, lookups)
    refs = [r for r in refs if literal_present(r["token"], view)]
    return {
        "invoice_refs": [{"ref": r["ref"], "where": r["where"], "on_file": r["on_file"]} for r in refs],
        "vendor_hints": vendor_hints(text, vendors),
        "intent": intent_from_cues(cues, view),
        "risk_cues": [f for f in RISK_FAMILIES if cues.get(f)],
        "asks_about_multiple_invoices": len(refs) > 1,
        "method": "regex",
        "cues": cues,
        "ignored_tokens": ignored,
    }
