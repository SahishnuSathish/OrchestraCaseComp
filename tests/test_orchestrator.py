"""Orchestrator, gate and cache tests. No Ollama needed.  python -m unittest discover -s tests -v   (from the repo root)"""
import copy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "prototype"), str(ROOT)]

import orchestrator  # noqa: E402
import pipeline  # noqa: E402
import run_all  # noqa: E402
from cache import CachedExtractor  # noqa: E402
from data_layer import FileBackend, Store  # noqa: E402
from extract_model import ModelReading  # noqa: E402
from gate import GatedExtractor  # noqa: E402
from ticket_view import build_view  # noqa: E402

STORE = Store(FileBackend(ROOT / "data"))
TICKETS = STORE.backend.list_tickets()
BASE = next(t for t in TICKETS if t["id"] == 41249)  # known sender, one invoice on file, plain status request


def ticket(body, subject="Checking in on INV-21529"):
    t = copy.deepcopy(BASE)
    t["subject"], t["description"] = subject, body
    t["comments"] = [dict(t["comments"][0], body=body)]  # a one-comment thread
    return t


class FakeExtractor:
    model = "fake"

    def __init__(self, reading=None):
        self.calls, self.reading = 0, reading or ModelReading(intent="status_request", safety="safe")

    def read(self, view):
        self.calls += 1
        return self.reading, {"model": "fake", "host": "local", "local": True, "attempts": 1, "error": None, "ms": 1}


class Invariants(unittest.TestCase):
    def test_features_off_equals_run_all(self):
        base = [b["result"] for b in run_all.run(None, str(ROOT / "data"), None, False)]
        orch = [b["result"] for b in orchestrator.Orchestrator(STORE).run(TICKETS)]
        self.assertEqual(base, orch)

    def test_workers_match_serial(self):
        a = orchestrator.Orchestrator(STORE, workers=1).run(TICKETS[:40])
        b = orchestrator.Orchestrator(STORE, workers=4).run(TICKETS[:40])
        self.assertEqual([x["result"] for x in a], [x["result"] for x in b])
        self.assertEqual([x["ticket_id"] for x in a], [x["ticket_id"] for x in b])

    def test_crash_becomes_an_internal_note_without_the_exception_text(self):
        with mock.patch.object(pipeline, "process_ticket", side_effect=RuntimeError("SECRET-ticket-text-123")):
            [b] = orchestrator.Orchestrator(STORE).run(TICKETS[:1])
        self.assertEqual(b["result"]["output_type"], "internal_action_note")
        self.assertNotIn("SECRET", b["result"]["text"])
        self.assertEqual(b["decision"]["rule"], "pipeline_error")
        self.assertIn("SECRET", b["error"])  # staff-only field

    def test_a_failing_post_reader_is_contained(self):
        class Boom:
            name = "boom"

            def apply(self, *a):
                raise ValueError("x")
        [b] = orchestrator.Orchestrator(STORE, post_readers=[Boom()]).run(TICKETS[:1])
        self.assertTrue(b["post_errors"])
        self.assertIn(b["result"]["output_type"], ("draft_reply", "internal_action_note", "no_draft"))


class Gate(unittest.TestCase):
    def view(self, t):
        return build_view(t, STORE.backend.user)

    def test_skips_a_plain_known_request(self):
        inner = FakeExtractor()
        reading, info = GatedExtractor(inner, STORE).read(self.view(ticket("Hi, has INV-21529 been paid? Thanks.")))
        self.assertIsNone(reading)
        self.assertTrue(info["gated"])
        self.assertEqual(inner.calls, 0)

    def test_calls_the_model_for_unusual_words(self):
        for word in ("clause", "solicitor", "queue"):
            inner = FakeExtractor()
            reading, info = GatedExtractor(inner, STORE).read(self.view(ticket(f"Has INV-21529 been paid? Under the {word} of our terms.")))
            self.assertEqual(inner.calls, 1, word)
            self.assertFalse(info["gated"])

    def test_calls_the_model_for_unknown_sender_or_no_ref(self):
        t = ticket("Has INV-21529 been paid?")
        t["via"]["source"]["from"]["address"] = "someone@unknown-company.example"
        inner = FakeExtractor()
        GatedExtractor(inner, STORE).read(self.view(t))
        self.assertEqual(inner.calls, 1)
        inner2 = FakeExtractor()
        GatedExtractor(inner2, STORE).read(self.view(ticket("Hi, where does my payment stand?", subject="Payment question")))
        self.assertEqual(inner2.calls, 1)

    def test_modes(self):
        v = self.view(ticket("Hi, has INV-21529 been paid? Thanks."))
        always, never = FakeExtractor(), FakeExtractor()
        GatedExtractor(always, STORE, mode="always").read(v)
        GatedExtractor(never, STORE, mode="never").read(v)
        self.assertEqual(always.calls, 1)
        self.assertEqual(never.calls, 0)

    def test_novel_ticket_is_never_gated(self):
        inner = FakeExtractor()
        GatedExtractor(inner, STORE, novelty_fn=lambda view: True).read(self.view(ticket("Hi, has INV-21529 been paid? Thanks.")))
        self.assertEqual(inner.calls, 1)

    def test_gated_run_equals_no_model_run_for_gated_tickets(self):
        gated = GatedExtractor(FakeExtractor(), STORE)
        with_gate = orchestrator.Orchestrator(STORE, gated).run(TICKETS)
        without = orchestrator.Orchestrator(STORE).run(TICKETS)
        for a, b in zip(with_gate, without):
            if (a.get("model") or {}).get("info", {}).get("gated"):
                self.assertEqual(a["result"], b["result"], a["ticket_id"])


class Cache(unittest.TestCase):
    def test_second_read_is_a_hit_and_none_is_not_cached(self):
        v = build_view(ticket("Has INV-21529 been paid?"), STORE.backend.user)
        with tempfile.TemporaryDirectory() as d:
            inner = FakeExtractor()
            c = CachedExtractor(inner, cache_dir=d)
            r1, i1 = c.read(v)
            r2, i2 = c.read(v)
            self.assertEqual(inner.calls, 1)
            self.assertEqual(i2["cache"], "hit")
            self.assertEqual(r1, r2)

            class Down:
                model, calls = "fake", 0

                def read(self, view):
                    Down.calls += 1
                    return None, {"error": "unreachable", "ms": 1}
            c2 = CachedExtractor(Down(), cache_dir=d + "/other")
            c2.read(v)
            c2.read(v)
            self.assertEqual(Down.calls, 2)


if __name__ == "__main__":
    unittest.main()
