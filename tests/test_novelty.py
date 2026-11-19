"""Novelty reader with a fake embedder (no Ollama)."""
import copy
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "src"), str(ROOT)]

from data_layer import FileBackend, Store  # noqa: E402
from novelty import NoveltyReader, cosine, percentile  # noqa: E402
import orchestrator  # noqa: E402

STORE = Store(FileBackend(ROOT / "data"))
TICKETS = {t["id"]: t for t in STORE.backend.list_tickets()}


class FakeClient:
    """'weird' texts point one way, everything else the other."""
    calls = 0

    def embed(self, texts, model=None):
        FakeClient.calls += len(texts)
        return [[0.0, 1.0] if "weirdword" in t else [1.0, 0.0] for t in texts]


def reader(mode, tmp):
    r = NoveltyReader(STORE, mode=mode, client=FakeClient(), cache_dir=tmp)
    r._corpus = {"ids": [999], "vectors": [[1.0, 0.0]], "threshold": 0.1, "loo_max": 0.0}
    return r


def bundle_for(tid, mutate=None):
    [b] = orchestrator.Orchestrator(STORE).run([TICKETS[tid]])
    return copy.deepcopy(b)


def with_text(t, extra):
    t = copy.deepcopy(t)
    t["comments"][0]["body"] += "\n" + extra
    return t


def first_with_rule(rule):
    return next(b for b in orchestrator.Orchestrator(STORE).run(list(TICKETS.values())) if b["decision"]["rule"] == rule)


class Novelty(unittest.TestCase):
    def test_math_helpers(self):
        self.assertAlmostEqual(cosine([1, 0], [1, 0]), 1.0)
        self.assertAlmostEqual(cosine([1, 0], [0, 1]), 0.0)
        self.assertEqual(percentile(list(range(1, 101)), 0.95), 95)

    def test_annotate_changes_nothing_but_adds_the_score(self):
        with tempfile.TemporaryDirectory() as d:
            b = first_with_rule("paid")
            before = copy.deepcopy(b["result"])
            reader("annotate", d).apply(b, with_text(TICKETS[b["ticket_id"]], "weirdword"), STORE)
            self.assertEqual(b["result"], before)
            self.assertTrue(b["readers"]["novelty"]["novel"])
            self.assertEqual(b["readers"]["novelty"]["nearest_ticket_id"], 999)

    def test_guard_turns_a_reply_into_a_note_and_keeps_the_proposed_text(self):
        with tempfile.TemporaryDirectory() as d:
            b = first_with_rule("paid")
            original = b["result"]["text"]
            reader("guard", d).apply(b, with_text(TICKETS[b["ticket_id"]], "weirdword"), STORE)
            self.assertEqual(b["result"]["output_type"], "internal_action_note")
            self.assertIsNone(b["result"]["recipient"])
            self.assertIn(original, b["result"]["text"])
            self.assertEqual(b["decision"]["rule"], "novelty_guard")

    def test_guard_leaves_everything_else_alone(self):
        with tempfile.TemporaryDirectory() as d:
            for rule in ("holding_reply", "no_reply_sender", "pending_approval"):
                b = first_with_rule(rule)
                before = copy.deepcopy(b["result"])
                reader("guard", d).apply(b, with_text(TICKETS[b["ticket_id"]], "weirdword"), STORE)
                self.assertEqual(b["result"], before, rule)
                self.assertNotEqual(b["decision"]["rule"], "novelty_guard")

    def test_guard_keeps_flags_and_priority(self):
        with tempfile.TemporaryDirectory() as d:
            b = first_with_rule("paid")
            b["result"]["flags"], b["result"]["priority"] = ["x"], True
            reader("guard", d).apply(b, with_text(TICKETS[b["ticket_id"]], "weirdword"), STORE)
            self.assertEqual((b["result"]["flags"], b["result"]["priority"]), (["x"], True))

    def test_ordinary_text_is_not_novel(self):
        with tempfile.TemporaryDirectory() as d:
            b = first_with_rule("paid")
            reader("guard", d).apply(b, TICKETS[b["ticket_id"]], STORE)
            self.assertFalse(b["readers"]["novelty"]["novel"])
            self.assertEqual(b["result"]["output_type"], "draft_reply")

    def test_unavailable_embedder_changes_nothing(self):
        class Down:
            def embed(self, *a, **k):
                raise ConnectionError("down")
        with tempfile.TemporaryDirectory() as d:
            r = NoveltyReader(STORE, mode="guard", client=Down(), cache_dir=d)
            r._corpus = {"ids": [1], "vectors": [[1.0, 0.0]], "threshold": 0.1}
            b = first_with_rule("paid")
            before = copy.deepcopy(b["result"])
            r.apply(b, TICKETS[b["ticket_id"]], STORE)
            self.assertEqual(b["result"], before)
            self.assertIn("skipped", b["readers"]["novelty"])

    def test_corpus_threshold_is_leave_one_out_and_cached(self):
        with tempfile.TemporaryDirectory() as d:
            r = NoveltyReader(STORE, client=FakeClient(), cache_dir=d)
            c = r.corpus()
            self.assertEqual(len(c["ids"]), 100)
            before = FakeClient.calls
            r2 = NoveltyReader(STORE, client=FakeClient(), cache_dir=d)
            self.assertEqual(r2.corpus()["threshold"], c["threshold"])
            self.assertEqual(FakeClient.calls, before)  # second load came from the cache


if __name__ == "__main__":
    unittest.main()
