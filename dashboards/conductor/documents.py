"""Invoice copies and remittance advice rendered from records, as HTML and PDF; draft attachments.

Phase 3 seam stub. Owner: p3/inbox-sync. Contract: docs/phase3/CONTRACTS.md section 8.
"""
from fastapi import APIRouter

router = APIRouter()


def init_schema():
    pass


class NotAvailable(Exception):
    pass


def render(kind, bill_internal_id, fmt):
    raise NotAvailable(kind)


def attachments_for(run_id, ticket_id):
    """[(filename, mime, bytes)] attached to this draft. Stub: none."""
    return []
