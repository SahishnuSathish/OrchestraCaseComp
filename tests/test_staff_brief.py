"""Staff brief pane: structured facts, code-chosen next action, retrieval status and the validator.
No Ollama needed. Uses out/regex/bundles.json (run `python src/run_all.py --out out/regex` first).
"""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "src"), str(ROOT / "dashboards" / "conductor"), str(ROOT)]

import brief_facts  # noqa: E402
import runner  # noqa: E402
import summarize  # noqa: E402
from data_layer import FileBackend, Store  # noqa: E402

STORE = Store(FileBackend(ROOT / "data"))
TICKETS = {t["id"]: t for t in STORE.backend.list_tickets()}
BUNDLES = json.loads((ROOT / "out" / "regex" / "bundles.json").read_text(encoding="utf-8"))
FACTS = {b["ticket_id"]: summarize.build_facts(b, {}, store=STORE, raw=TICKETS[b["ticket_id"]]) for b in BUNDLES}


def first(pred):
    return next(b for b in BUNDLES if pred(b))


def bullets_for(f, **over):
    base = {b["label"]: b["text"] for b in summarize.template_bullets(f)}
    base.update(over)
    return [{"label": k, "text": v} for k, v in base.items()]


class Structured(unittest.TestCase):
    def test_every_ticket_has_a_known_action_and_a_valid_template_brief(self):
        for b in BUNDLES:
            f = FACTS[b["ticket_id"]]
            self.assertIn(f["next_action"]["kind"], brief_facts.KINDS)
            self.assertTrue(f["structured"])
            problems = summarize.validate(summarize.template_bullets(f), f)
            self.assertEqual(problems, [], (b["ticket_id"], problems))
            labels = [x["label"] for x in summarize.template_bullets(f)]
            self.assertEqual(labels[:4], ["Issue", "Sources", "Reply", "Next"])

    def test_mapping_spot_checks(self):
        fraud = first(lambda b: "fraud" in b["result"]["flags"])
        self.assertEqual(FACTS[fraud["ticket_id"]]["next_action"]["kind"], "verify_fraud")
        pend = first(lambda b: b["decision"]["rule"] == "pending_approval")
        na = FACTS[pend["ticket_id"]]["next_action"]
        self.assertEqual((na["kind"], na["who"]), ("escalate_to", pend["decision"]["act_by"]))
        self.assertEqual(FACTS[first(lambda b: b["decision"]["rule"] == "no_reply_sender")["ticket_id"]]["next_action"]["kind"], "close")
        self.assertEqual(FACTS[first(lambda b: b["decision"]["rule"] == "holding_reply")["ticket_id"]]["next_action"]["kind"],
                         "send_holding_and_escalate")
        self.assertEqual(FACTS[first(lambda b: b["decision"]["rule"] == "paid")["ticket_id"]]["next_action"]["kind"], "review_and_send")

    def test_holding_label_date_comes_from_rules(self):
        import drafts
        import rules
        b = first(lambda b: b["decision"]["rule"] == "holding_reply")
        self.assertIn(drafts.fmt_date(rules.HOLDING_UPDATE_DATE), FACTS[b["ticket_id"]]["next_action"]["label"])

    def test_retrieval_status(self):
        skipped = first(lambda b: b["plan"]["skipped"])
        self.assertEqual(FACTS[skipped["ticket_id"]]["retrieval"]["status"], "skipped")
        pend = first(lambda b: b["decision"]["rule"] == "pending_approval")
        f = FACTS[pend["ticket_id"]]
        self.assertEqual(f["retrieval"]["status"], "complete")
        self.assertEqual(f["records"][0]["payment"], "none")
        nf = first(lambda b: b["decision"]["rule"] == "not_on_file")
        self.assertEqual(FACTS[nf["ticket_id"]]["retrieval"]["status"], "partial")
        err = runner.error_bundle(1, RuntimeError("boom"))
        f = summarize.build_facts(err, {})
        self.assertEqual(f["retrieval"]["status"], "failed")
        self.assertEqual(f["next_action"]["kind"], "manual_handle")

    def test_records_never_carry_money_or_returned_payment_details(self):
        blob = json.dumps([FACTS[i]["records"] for i in FACTS]) + json.dumps([summarize.model_packet(f) for f in FACTS.values()])
        for banned in ("userTotal", "referenceNumber", "custbody_failure_reason", "@"):
            self.assertNotIn(banned, blob, banned)
        returned = first(lambda b: b["decision"]["rule"] == "returned_payment")
        for r in FACTS[returned["ticket_id"]]["records"]:
            self.assertNotIn("payment_date", r)

    def test_error_bundle_is_a_note_without_the_exception_text(self):
        err = runner.error_bundle(7, RuntimeError("SECRET-body-text"))
        self.assertEqual(err["result"]["output_type"], "internal_action_note")
        self.assertNotIn("SECRET", err["result"]["text"])
        self.assertIn("SECRET", err["error"])


class Validator(unittest.TestCase):
    def test_accepts_the_template(self):
        f = FACTS[first(lambda b: b["decision"]["rule"] == "pending_approval")["ticket_id"]]
        self.assertEqual(summarize.validate(bullets_for(f), f), [])

    def test_rejects_send_on_an_internal_note(self):
        f = FACTS[first(lambda b: b["decision"]["rule"] == "pending_approval")["ticket_id"]]
        who = summarize._who_name(f["next_action"]["who"])
        bad = summarize.validate(bullets_for(f, Next=f"Send the draft to the vendor and tell {who}."), f)
        self.assertTrue(any("send" in p.lower() for p in bad), bad)

    def test_rejects_a_different_approver(self):
        f = FACTS[first(lambda b: b["decision"]["rule"] == "pending_approval")["ticket_id"]]
        bad = summarize.validate(bullets_for(f, Next="Escalate to Someone Else for approval."), f)
        self.assertTrue(any("who acts" in p for p in bad), bad)

    def test_sources_text_has_no_retrieval_sentence(self):
        for f in FACTS.values():
            self.assertNotIn("Retrieval:", summarize.template_bullets(f)[1]["text"])

    def test_rejects_an_amount(self):
        f = FACTS[first(lambda b: b["decision"]["rule"] == "paid")["ticket_id"]]
        bad = summarize.validate(bullets_for(f, Reply="Tell them the payment of 48250.17 went out."), f)
        self.assertTrue(bad)

    def test_rejects_payment_found_when_none(self):
        f = FACTS[first(lambda b: b["decision"]["rule"] == "pending_approval")["ticket_id"]]
        bad = summarize.validate(bullets_for(f, Sources="NetSuite bill found and the payment was found. Retrieval: complete."), f)
        self.assertTrue(any("payment" in p for p in bad), bad)

    def test_fallback_without_a_store_still_has_next_and_retrieval(self):
        b = first(lambda b: b["decision"]["rule"] == "paid")
        f = summarize.build_facts(b, {})
        self.assertFalse(f["structured"])
        self.assertEqual(f["next_action"]["kind"], "review_and_send")
        self.assertIn(f["retrieval"]["status"], ("complete", "partial"))


if __name__ == "__main__":
    unittest.main()
