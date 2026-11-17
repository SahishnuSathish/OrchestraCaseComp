"""--summaries post-reader: attaches the staff-brief facts to each finished bundle (no model, no comment text).

The free-text summary of linked-ticket comments is out of scope (plan 3.3); this stores the structured facts
(records in words, retrieval status, code-chosen next action, linked-ticket status) the staff pane is built from.
"""
import brief_facts


class NoteSummaryReader:
    name = "staff_brief_facts"

    def apply(self, bundle, ticket, store):
        f = brief_facts.structured_facts(bundle, ticket, store)
        bundle.setdefault("readers", {})["staff_brief_facts"] = {k: f[k] for k in ("records", "retrieval", "next_action", "history") if k in f}
