"""Ticket index and same-invoice grouping for a batch. Read-only; annotation only (results.json never changes).

`ticket_index` re-reads each ticket with the regex reader and the resolver on an untraced session, because
bundles do not carry vendor and invoice references in structured form. The other batch tools reuse it.
"""
import extract_regex
import resolve
from ticket_view import build_view
from trace import NullTrace


def ticket_index(bundles, store):
    """{ticket_id: {vendor_id, vendor, refs (found tranIds), items, sender, risk_cues, bundle}}"""
    lk = store.session(NullTrace())
    out = {}
    for b in bundles:
        t = store.backend.ticket(b["ticket_id"])
        if not t:
            continue
        view = build_view(t, store.backend.user)
        ext = extract_regex.extract(view, lk, store.vendors)
        notes = (b.get("model") or {}).get("notes") or {}
        for r in notes.get("added_refs") or []:
            if all(x["ref"].upper() != r.upper() for x in ext["invoice_refs"]):
                ext["invoice_refs"].append({"ref": r, "where": "body", "on_file": True})
        sender = resolve.resolve_sender(view, lk)
        items = resolve.resolve_items(ext, sender, lk)
        vid, vname, _ = resolve.ticket_vendor(sender, items, ext, lk)
        cues = sorted(set(ext["risk_cues"]) | set(notes.get("added_cues") or []))
        out[b["ticket_id"]] = {"vendor_id": vid, "vendor": vname, "sender": sender, "items": items, "risk_cues": cues,
                               "refs": sorted(i["bill"]["tranId"] for i in items if i["status"] == "found"), "bundle": b}
    return out


def build(index):
    groups = {}
    for tid, x in index.items():
        if x["vendor_id"] and x["refs"]:
            groups.setdefault((x["vendor_id"], frozenset(x["refs"])), []).append(tid)
    out = [{"vendor_id": v, "vendor": index[ids[0]]["vendor"], "refs": sorted(refs), "ticket_ids": sorted(ids)}
           for (v, refs), ids in groups.items() if len(ids) >= 2]
    return {"groups": sorted(out, key=lambda g: g["ticket_ids"]),
            "tickets_in_groups": sum(len(g["ticket_ids"]) for g in out),
            "answers_saved": sum(len(g["ticket_ids"]) - 1 for g in out),
            "note": "Annotation only: staff answer once and link the rest. results.json is unchanged."}
