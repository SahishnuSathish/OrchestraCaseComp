"""Orchestrator: runs pipeline.process_ticket as a black box over many tickets.

Adds only plumbing: an optional worker pool, a safe bundle when a ticket crashes, and post-readers that
annotate a finished bundle (they never change the result unless a reader documents that it does).
The pipeline itself is untouched; the only thing handed in is an extractor with the usual .read(view) API.
"""
import statistics
from concurrent.futures import ThreadPoolExecutor

import pipeline

CRASH_TEXT = ("The assistant could not process this ticket automatically (internal error). "
              "A person should review it from the original email.")


def crash_bundle(ticket_id, exc):
    """A crashed ticket becomes a note for a person, never a silent no_draft. The exception text stays out of
    `result.text` (it could echo ticket content) and lives only in the staff-only `error` and `decision.why`."""
    return {"ticket_id": ticket_id, "stages": [], "model": None, "trace": [], "api_calls": 0, "ms": 0,
            "plan": {"skipped": False, "why": []}, "error": f"{type(exc).__name__}: {str(exc)[:160]}",
            "result": {"ticket_id": ticket_id, "output_type": "internal_action_note", "recipient": None,
                       "reason_tag": None, "priority": False, "flags": [], "text": CRASH_TEXT},
            "decision": {"rule": "pipeline_error", "why": f"{type(exc).__name__}: {str(exc)[:160]}", "act_by": None}}


class Orchestrator:
    def __init__(self, store, extractor=None, workers=1, post_readers=()):
        self.store, self.extractor, self.workers = store, extractor, max(1, int(workers))
        self.post_readers = list(post_readers)

    def _one(self, ticket):
        try:
            b = pipeline.process_ticket(ticket, self.store, self.extractor)
        except Exception as e:  # one bad ticket must not stop the batch
            b = crash_bundle(ticket.get("id"), e)
        for pr in self.post_readers:
            try:
                pr.apply(b, ticket, self.store)
            except Exception as e:
                b.setdefault("post_errors", []).append(f"{getattr(pr, 'name', 'reader')}: {e!r}"[:200])
        return b

    def run(self, tickets):
        """Bundles in input order."""
        if self.workers == 1:
            return [self._one(t) for t in tickets]
        with ThreadPoolExecutor(max_workers=self.workers) as ex:
            return list(ex.map(self._one, tickets))


def collect_stats(bundles):
    """Gate, cache and timing numbers for orchestrator.json."""
    infos = [(b.get("model") or {}).get("info") for b in bundles]
    infos = [i for i in infos if i]
    gated = sum(1 for i in infos if i.get("gated"))
    hits = sum(1 for i in infos if i.get("cache") == "hit")
    calls = sum(1 for i in infos if not i.get("gated") and i.get("cache") != "hit")
    ms = sorted(b.get("ms") or 0 for b in bundles)
    model_ms = [i.get("ms") or 0 for i in infos if not i.get("gated") and i.get("cache") != "hit"]
    n = len(bundles)
    return {"tickets": n, "model_enabled": bool(infos), "gated": gated, "cache_hits": hits, "model_calls": calls,
            "gate_skip_rate": round(gated / n, 3) if n and infos else None,
            "cache_hit_rate": round(hits / max(1, n - gated), 3) if infos else None,
            "model_calls_per_ticket": round(calls / n, 3) if n else None,
            "mean_ms": round(statistics.mean(ms)) if ms else 0, "p95_ms": ms[int(0.95 * (len(ms) - 1))] if ms else 0,
            "mean_model_ms": round(statistics.mean(model_ms)) if model_ms else 0,
            "crashes": sum(1 for b in bundles if (b.get("decision") or {}).get("rule") == "pipeline_error")}
