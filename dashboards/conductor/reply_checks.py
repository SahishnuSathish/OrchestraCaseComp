"""Checks shared by every path that sends a drafted reply (Send now, scheduled send).

Moved out of server.py so that modules other than the server can run the same checks without importing it.
Nothing here changes the pipeline's result for a ticket.
"""
from collections import Counter

import runner

BLOCK_APPROVE_FLAGS = {"fraud", "injection"}


class ChecksUnavailable(Exception):
    """The shared egress gate could not be loaded. Callers must fail closed."""


def default_subject(subject):
    s = (subject or "").strip()
    return s if s.lower().startswith("re:") else "Re: " + s


def edit_problems(original, edited, recipient):
    """Problems an employee's edit ADDS to a reply, per the shared egress gate (src/egress_guard.py).

    The original already passed the pipeline's draft check against its records, which the bundle does not carry,
    so only problems that appear in the edited text and not in the original count. Fails closed if the gate cannot load.
    """
    runner._proto_on_path()
    try:
        import egress_guard
    except Exception as e:  # the gate is owned elsewhere; never wave an edited reply through without it
        raise ChecksUnavailable(f"The safety check for edited replies is unavailable ({type(e).__name__}); try again shortly.")
    before = Counter(egress_guard.check_outbound(original, recipient=recipient))
    after = Counter(egress_guard.check_outbound(edited, recipient=recipient))
    return sorted((after - before).elements())
