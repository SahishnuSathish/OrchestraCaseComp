"""Ticket chat with the local model (seam: feature A fills this in).

The router is mounted by server.py behind the per-launch token. init_schema() is called from db.init().
"""
from fastapi import APIRouter

router = APIRouter()


def init_schema():
    pass
