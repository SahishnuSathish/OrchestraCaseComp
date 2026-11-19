"""The app clock. Conductor's date is the data snapshot, Friday Nov 13, 2026. The time of day is real.

Use this (never time.time()) for anything a person sees: arrival times, "Sent at", aging, scheduled send.
"""
import datetime as _dt
import time as _time

SNAPSHOT = _dt.date(2026, 11, 13)


def _offset(real=None):
    """Seconds to add to the real clock so that today's local date becomes the snapshot date."""
    real = _time.time() if real is None else real
    today = _dt.datetime.fromtimestamp(real).date()
    return (_dt.datetime.combine(SNAPSHOT, _dt.time()) - _dt.datetime.combine(today, _dt.time())).total_seconds()


def now():
    """Epoch seconds on the app clock."""
    real = _time.time()
    return real + _offset(real)


def today():
    return SNAPSHOT


def iso(ts=None):
    """Local ISO 8601 with offset, for an app-clock timestamp (default: now)."""
    ts = now() if ts is None else ts
    return _dt.datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")
