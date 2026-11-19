"""Structured facts for the staff brief pane. Deterministic, no model, no traced calls.

`structured_facts(bundle, ticket, store)` re-derives what the pane needs (intent, references, vendor, what each
record said, whether retrieval was complete) from the ticket and the read-only store instead of regex-parsing
human-readable stage summaries. `next_action_for(bundle)` is the code-chosen action item; it needs no store.

Nothing here carries amounts, bank fields, emails, the reference of a returned payment, or a failure reason.
"""
import drafts
import extract_regex
import linked as linked_mod
import resolve
import rules
from extract_regex import INTENT_ORDER
from ticket_view import build_view
from trace import NullTrace

KINDS = ("verify_fraud", "manual_read", "manual_handle", "send_holding_and_escalate", "review_and_send",
         "escalate_to", "investigate", "close")
SEND_KINDS = ("review_and_send", "send_holding_and_escalate")


def next_action_for(bundle):
    """(kind, who, label) chosen from (output_type, rule, flags). A fixed table; no model."""
    res, dec = bundle.get("result") or {}, bundle.get("decision") or {}
    rule, flags, ot = dec.get("rule"), list(res.get("flags") or []), res.get("output_type")
    who = dec.get("act_by")
    due = drafts.fmt_date(rules.HOLDING_UPDATE_DATE)
    if "fraud" in flags:
        return "verify_fraud", who, "Do not reply. Verify with the vendor through a known contact; escalate to the AP lead."
    if rule in ("injection_suspected", "model_flagged"):
        return "manual_read", who, "Read the original email before doing anything."
    if rule == "pipeline_error" or bundle.get("error"):
        return "manual_handle", None, "The assistant failed on this ticket: handle it manually."
    if ot == "draft_reply" and rule == "holding_reply":
        return ("send_holding_and_escalate", who,
                f"Review and send the holding reply, then escalate to the AP lead (update due {due}).")
    if ot == "draft_reply":
        also = f" {who} also needs to act on a pending approval." if who else ""
        return "review_and_send", who, "Review the draft and send it if correct." + also
    if ot == "internal_action_note" and who:
        return "escalate_to", who, f"Escalate to {who}."
    if ot == "internal_action_note":
        return "investigate", None, "A person must investigate before anyone replies."
    return "close", None, f"No reply needed: close the ticket ({res.get('reason_tag') or 'nothing to answer'})."


def _record(item, outcome):
    """One record line. Words and dates only: no amounts, references of returned payments, or failure reasons."""
    if outcome is None:
        return {"ref": item["ref"], "bill_status": None, "approval_status": None, "payment": "none", "run": "none",
                "outcome": item["status"]}
    b, p, r = outcome["bill"], outcome.get("payment"), outcome.get("run")
    rs = (p or {}).get("custbody_release_status")
    pay = {"Settled": "settled", "Released": "released", "Returned": "returned"}.get(rs, "none" if not p else "unknown")
    rec = {"ref": outcome["ref"], "bill_status": b.get("status"), "approval_status": b.get("approvalStatus"),
           "payment": pay, "run": "none", "outcome": outcome["outcome"]}
    if p and pay != "returned" and p.get("tranDate"):
        rec["payment_date"] = p["tranDate"]
    if r:
        rec["run"] = "scheduled" if r.get("run_status") == "Scheduled" else "completed"
        rec["run_date"] = r.get("run_date")
    return rec


def _retrieval(bundle, items):
    plan, trace, dec = bundle.get("plan") or {}, bundle.get("trace") or [], bundle.get("decision") or {}
    if plan.get("skipped"):
        return {"status": "skipped", "missing": [], "errors": []}
    if bundle.get("error") or (not trace and not plan.get("skipped")):
        return {"status": "failed", "missing": [], "errors": [str(bundle.get("error") or "no lookups were recorded")[:120]]}
    missing = [f"bill for {i['ref']}" for i in items if i["status"] == "not_found"]
    if dec.get("rule") == "linked_ticket_unavailable":
        missing.append("linked ticket")
    return {"status": "partial" if missing else "complete", "missing": missing, "errors": []}


def structured_facts(bundle, ticket, store):
    lk = store.session(NullTrace())
    view = build_view(ticket, store.backend.user)
    ext = extract_regex.extract(view, lk, store.vendors)
    notes = (bundle.get("model") or {}).get("notes") or {}
    for r in notes.get("added_refs") or []:
        if all(x["ref"].upper() != r.upper() for x in ext["invoice_refs"]):
            ext["invoice_refs"].append({"ref": r, "where": "body", "on_file": True})
    fams = set(ext["cues"]) | set(notes.get("added_cues") or [])
    intent = next((lab for fam, lab in INTENT_ORDER if fam in fams), ext["intent"])
    sender = resolve.resolve_sender(view, lk)
    items = resolve.resolve_items(ext, sender, lk)
    vid, vname, _ = resolve.ticket_vendor(sender, items, ext, lk)
    outcomes = {i["ref"]: rules.classify_bill(i["bill"], lk) for i in items if i["status"] == "found"}
    retrieval = _retrieval(bundle, items)
    # When the pipeline stopped at the pre-checks it pulled no bill or payment records, so the brief shows none.
    records = [] if retrieval["status"] == "skipped" else [_record(i, outcomes.get(i["ref"])) for i in items]
    kind, who, label = next_action_for(bundle)
    out = {
        "requested": {"intent": intent, "invoice_refs": [i["ref"] for i in items], "vendor": vname,
                      "sender_kind": sender["kind"], "sender_authorized": bool(sender["authorized"])},
        "records": records,
        "retrieval": retrieval,
        "next_action": {"kind": kind, "who": who, "label": label},
    }
    hist = []
    for tid in view.linked_ticket_ids:
        lt = linked_mod.read_linked(lk, tid)
        if lt["found"]:
            hist.append({"id": tid, "status": lt["status"], "answered": lt["answered"]})
    if hist:
        out["history"] = hist  # ids and status words only; no comment text ever reaches the model
    return out
