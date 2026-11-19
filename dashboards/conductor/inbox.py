"""Inbox sync: the hidden inbox run, held-back arrivals, threads, queues, write-back, Advanced.

Phase 3 seam stub. Owner: p3/inbox-sync. Contract: docs/phase3/CONTRACTS.md section 5.
"""
from fastapi import APIRouter

router = APIRouter()


def init_schema():
    pass


def inbox_run_id():
    raise NotImplementedError


def ingest(ticket, user, source="zendesk"):
    raise NotImplementedError


def new_ticket_id():
    raise NotImplementedError
