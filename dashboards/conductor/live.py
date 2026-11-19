"""Server-sent event bus, scoped by role.

Phase 3 seam stub. Owner: p3/identity-live. Contract: docs/phase3/CONTRACTS.md section 3.
"""
from fastapi import APIRouter

router = APIRouter()


def init_schema():
    pass


def publish(type, payload, *, roles=None, subjects=None, vendor_id=None):
    """Stub: drops the event."""
    return None
