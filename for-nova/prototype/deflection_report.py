"""The business-case numbers: how many tickets code could remove, and what the model costs.

Reads the bundles plus the outputs of notices, approver_digest and batch_groups. Everything here is an estimate
from the 100 practice tickets, scaled to the case's monthly volume; the report says so.
"""
import json
from collections import Counter
from pathlib import Path

SELF_SERVE_RULES = {"paid", "released", "scheduled_run", "approved_no_run", "pending_approval", "pending_inactive_approver",
                    "not_on_file", "multi_invoice"}
MONTHLY_TICKETS = (2000, 2300)
PAYMENT_STATUS_SHARE = 0.20  # "about 1 in 5" of the case's tickets


def self_servable(x):
    b = x["bundle"]
    s = x["sender"]
    return (s["kind"] in ("vendor_contact", "employee") and s["authorized"] and b["decision"]["rule"] in SELF_SERVE_RULES
            and not x["risk_cues"] and "fraud" not in (b["result"].get("flags") or []))


def build(index, notices, digests, groups, orch_stats=None):
    n = len(index)
    ss = [tid for tid, x in index.items() if self_servable(x)]
    by_rule = Counter(index[t]["bundle"]["decision"]["rule"] for t in ss)
    covered = notices["covered_tickets"]
    share = len(ss) / n if n else 0
    lo, hi = (round(m * PAYMENT_STATUS_SHARE * share) for m in MONTHLY_TICKETS)
    out = {
        "tickets": n,
        "self_servable": {"count": len(ss), "pct": round(100 * share, 1), "by_rule": dict(by_rule.most_common()),
                          "ticket_ids": sorted(ss)},
        "preventable_by_notice": {"count": len(covered), "pct": round(100 * len(covered) / n, 1) if n else 0,
                                  "notices_drafted": len(notices["notices"]), "ticket_ids": covered,
                                  "vendors_skipped": notices["vendors_skipped"]},
        "approver_consolidation": {"notes": digests["pending_notes"], "digests": digests["digest_count"]},
        "same_invoice_groups": {"groups": len(groups["groups"]), "tickets_in_groups": groups["tickets_in_groups"],
                                "answers_saved": groups["answers_saved"]},
        "model_cost": orch_stats or None,
        "monthly_estimate": {"tickets_per_month": list(MONTHLY_TICKETS), "payment_status_share": PAYMENT_STATUS_SHARE,
                             "self_servable_tickets_per_month": [lo, hi]},
    }
    return out


def to_markdown(d):
    ss, nt, ap, gr, me, mc = (d["self_servable"], d["preventable_by_notice"], d["approver_consolidation"],
                              d["same_invoice_groups"], d["monthly_estimate"], d["model_cost"])
    lines = ["# Deflection report", "",
             "**Estimate from the 100 practice tickets, scaled to the case's volume. Not a measured result on live data.**", "",
             f"- **Self-servable:** {ss['count']} of {d['tickets']} tickets ({ss['pct']}%). A verified vendor contact could get the same "
             "status answer from a read-only lookup without opening a ticket.",
             f"- **Preventable by a proactive notice:** {nt['count']} tickets ({nt['pct']}%) concern an invoice a drafted notice already covers "
             f"({nt['notices_drafted']} notices drafted, all awaiting approval).",
             f"- **Approver consolidation:** {ap['notes']} pending-approval notes become {ap['digests']} digests.",
             f"- **Same-invoice duplicates in this batch:** {gr['groups']} groups, {gr['tickets_in_groups']} tickets, "
             f"{gr['answers_saved']} answers saved.", "",
             f"At {me['tickets_per_month'][0]:,} to {me['tickets_per_month'][1]:,} tickets a month and about "
             f"{int(me['payment_status_share'] * 100)}% payment-status requests, the self-servable share is roughly "
             f"{me['self_servable_tickets_per_month'][0]} to {me['self_servable_tickets_per_month'][1]} tickets a month (estimate).", "",
             "## Self-servable tickets by rule", ""]
    lines += [f"- {r}: {c}" for r, c in ss["by_rule"].items()]
    if mc:
        lines += ["", "## Model cost (this run)", "",
                  f"- Model calls per ticket: {mc.get('model_calls_per_ticket')}",
                  f"- Gate skip rate: {mc.get('gate_skip_rate')}; cache hit rate: {mc.get('cache_hit_rate')}",
                  f"- Mean ticket time: {mc.get('mean_ms')} ms; mean model call: {mc.get('mean_model_ms')} ms"]
    return "\n".join(lines) + "\n"


def write(d, out_dir):
    out = Path(out_dir)
    (out / "deflection.json").write_text(json.dumps(d, indent=1), encoding="utf-8")
    (out / "DEFLECTION_REPORT.md").write_text(to_markdown(d), encoding="utf-8")
