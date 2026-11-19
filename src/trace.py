"""Lookup trace: every record lookup is logged so the dashboard can replay it.

Each event: {"seq", "platform", "action", "endpoint", "key", "result_count", "ms"}.
platform is one of "zendesk", "netsuite", "payment_system".
"""
import time


class Trace:
    def __init__(self):
        self.events = []

    def call(self, platform, action, endpoint, key, fn):
        """Run fn(), log one event, and return fn's result.

        result_count is len(result) for lists, 1/0 for a single record or None.
        """
        t0 = time.perf_counter()
        result = fn()
        ms = round((time.perf_counter() - t0) * 1000, 2)
        if isinstance(result, list):
            n = len(result)
        else:
            n = 0 if result is None else 1
        self.events.append({
            "seq": len(self.events) + 1,
            "platform": platform,
            "action": action,
            "endpoint": endpoint,
            "key": str(key),
            "result_count": n,
            "ms": ms,
        })
        return result


class NullTrace(Trace):
    """A trace that records nothing (used for one-off index building)."""

    def call(self, platform, action, endpoint, key, fn):
        return fn()
