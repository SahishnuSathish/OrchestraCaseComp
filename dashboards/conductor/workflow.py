"""Escalation state machine, sign-off, assignment, chase, forward, outbound items, approver actions, audit.

Phase 3 seam stub. Owner: p3/identity-live. Contract: docs/phase3/CONTRACTS.md section 6.
"""
from fastapi import APIRouter

router = APIRouter()


def init_schema():
    pass


def get_state(ticket_id):
    """{state, category, assignee, chased} for an inbox ticket. The inbox queues read this. Stub: everything open."""
    return {"state": "open", "category": None, "assignee": None, "chased": False}


def signoff_category(bundle):
    return None


def can_approve(session, run_id, ticket_id):
    """A reason string blocks approval. Stub: never blocks (today's fraud block stays in server.py)."""
    return None


def can_send(run_id, ticket_id, reply_hash):
    """A reason string blocks sending. Stub: never blocks."""
    return None


def create_outbound(kind, to_email, subject, body, *, created_by, ticket_id=None, vendor_id=None):
    raise NotImplementedError
