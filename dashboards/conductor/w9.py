"""W-9 status, uploads, extraction and checks.

Owner: p3/direct-w9. Contract: docs/phase3/CONTRACTS.md section 10.
"""
from fastapi import APIRouter

router = APIRouter()


def init_schema():
    pass


def vendor_status(vendor_id):
    return {"status": "on_file", "label": "On file"}
