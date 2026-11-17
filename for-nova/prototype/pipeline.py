"""process_ticket: the whole flow for one ticket, stage by stage.

Stages (names are stable; the dashboard and the brief use them):
  intake -> sender -> extract_regex -> extract_model -> prechecks -> plan
  -> lookups -> linked -> rules -> draft -> draft_check

Returns a bundle: the result row for score.py, the lookup trace, and one entry
per stage saying what it saw and which module did the work.
"""
import time

import cues as cues_mod
import drafts
import extract_model
import extract_regex
import linked as linked_mod
import planner
import prechecks
import resolve
import rules
from draft_check import check_reply
from ticket_view import build_view
from trace import Trace


def _stage(bundle, name, module, summary, **extra):
    bundle["stages"].append({"name": name, "module": module, "summary": summary, **extra})


def process_ticket(ticket, store, extractor=None):
    t0 = time.perf_counter()
    trace = Trace()
    lk = store.session(trace)
    bundle = {"ticket_id": ticket["id"], "stages": [], "model": None}

    # intake: end-user text only
    view = build_view(ticket, lambda uid: store.backend.user(uid))
    _stage(bundle, "intake", "ticket_view.py", f"{view.sender_email}; {len(view.attachments)} attachment name(s)")

    # sender
    sender = resolve.resolve_sender(view, lk)
    _stage(bundle, "sender", "resolve.py", f"{sender['kind']}, authorized={sender['authorized']}: {sender['detail']}")

    # regex read
    ext = extract_regex.extract(view, lk, store.vendors)
    _stage(bundle, "extract_regex", "extract_regex.py + cues.py",
           f"intent={ext['intent']}; refs={[r['ref'] for r in ext['invoice_refs']]}; cues={ext['risk_cues']}")

    # model read (optional)
    notes = {"used": False, "mentioned_tickets": [], "safety": None}
    if extractor is not None:
        reading, info = extractor.read(view)
        ext, notes = extract_model.combine(ext, reading, view, lk, extract_regex.vendor_hints, store.vendors)
        bundle["model"] = {"info": info, "notes": notes}
        _stage(bundle, "extract_model", "extract_model.py",
               (f"safety={notes['safety']}; +refs={notes['added_refs']}; +cues={notes['added_cues']}; {info['ms']} ms"
                if notes["used"] else f"model unavailable ({info['error']}); regex result stands"))
    else:
        _stage(bundle, "extract_model", "extract_model.py", "skipped (--no-model)")

    # prechecks: fraud, no-reply / machine / misrouted, injection
    fraud = prechecks.fraud_screen(view, store.known_domains, ext["cues"])
    if notes.get("used") and "bank_change" in ext.get("model_cues", []) and not any("bank-detail" in r for r in fraud):
        fraud.append("model read bank-detail change language in the message")
    if (notes.get("used") and "login_language" in ext.get("model_cues", []) and notes.get("safety") == "suspicious"
            and cues_mod.urls(view.all_text())):
        fraud.append("model read a sign-in request with a link in a payment email and judged it suspicious")
    tier2 = prechecks.tier2(view, ext["cues"], sender["kind"])
    model_flag = None
    if ext["cues"].get("injection"):
        model_flag = {"rule": "injection_suspected",
                      "why": "wording such as " + repr(ext["cues"]["injection"][0][:60])}
    elif notes.get("safety") == "instruction_injection":
        model_flag = {"rule": "injection_suspected", "why": notes.get("safety_reason") or "model judged the text to be instructions to an AI"}
    # A model "suspicious" verdict alone never changes the outcome (a false flag would withhold a valid answer).
    # It acts only with a deterministic corroboration (bank-change cue, or sign-in cue plus a link) or as an advisory.
    advisory = None
    if notes.get("safety") == "suspicious" and not fraud:
        advisory = notes.get("safety_reason") or "model judged the message suspicious"
    bundle["advisory"] = advisory
    _stage(bundle, "prechecks", "prechecks.py + cues.py",
           f"fraud={'yes' if fraud else 'no'}; tier2={tier2[0]}; flag={(model_flag or {}).get('rule')}")

    # plan the lookups
    stop_early = tier2[0] if (tier2[0] and not fraud) else None
    plan = planner.plan_lookups(view, ext, stop_early, notes)
    _stage(bundle, "plan", "planner.py", "; ".join(plan["why"]) + (f" (model added {plan['added_by_model']})" if plan["added_by_model"] else ""))

    # lookups
    if plan["skipped"]:
        items, vendor, linked_list, exec_cc = [], (None, None, "skipped"), [], []
    else:
        items = resolve.resolve_items(ext, sender, lk)
        vendor = resolve.ticket_vendor(sender, items, ext, lk)
        exec_cc = linked_mod.executives_copied(view, lk)
        linked_list = []
        for tid in plan["zendesk_ticket_ids"]:
            lt = linked_mod.read_linked(lk, tid)
            if lt["found"] or tid in view.linked_ticket_ids:
                linked_list.append(lt)
    _stage(bundle, "lookups", "resolve.py + data_layer.py",
           f"{len(items)} item(s): {[(i['ref'], i['status']) for i in items]}; vendor={vendor[1]}")
    _stage(bundle, "linked", "linked.py",
           f"linked={[(l['id'], l['status']) for l in linked_list]}; executives copied={exec_cc}")

    # rules
    ctx = {"view": view, "ext": ext, "sender": sender, "items": items, "linked": linked_list, "fraud_reasons": fraud,
           "tier2": tier2, "exec_cc": exec_cc, "vendor": vendor, "lk": lk, "model_flag": model_flag}
    dec, outcomes = rules.decide(ctx)
    _stage(bundle, "rules", "rules.py", f"{dec['output_type']} by rule '{dec['rule']}': {dec['why']}")

    # draft
    if dec["output_type"] == "draft_reply":
        text = drafts.render_reply(dec, outcomes, items, view, sender, vendor[1])
    elif dec["output_type"] == "internal_action_note":
        text = drafts.render_note(dec, outcomes, items, view, sender, vendor, linked_list)
    else:
        text = drafts.render_no_draft(dec)
    _stage(bundle, "draft", "drafts.py", f"{len(text)} chars")

    # draft check
    problems = check_reply(text, outcomes, [i["ref"] for i in items]) if dec["output_type"] == "draft_reply" else []
    if problems:
        dec = dict(dec, output_type="internal_action_note", rule="draft_check_failed", recipient=None,
                   why="draft failed its check: " + "; ".join(problems))
        text = drafts.render_note(dec, outcomes, items, view, sender, vendor, linked_list)
    _stage(bundle, "draft_check", "draft_check.py", "; ".join(problems) if problems else "passed")

    bundle["result"] = {
        "ticket_id": view.id, "output_type": dec["output_type"],
        "recipient": dec["recipient"] if dec["output_type"] == "draft_reply" else None,
        "reason_tag": dec["reason_tag"], "priority": bool(dec["priority"]), "flags": dec["flags"], "text": text,
    }
    bundle["decision"] = {k: dec[k] for k in ("rule", "why", "act_by")}
    bundle["plan"] = plan
    bundle["trace"] = trace.events
    bundle["api_calls"] = len(trace.events)
    bundle["ms"] = round((time.perf_counter() - t0) * 1000)
    return bundle
