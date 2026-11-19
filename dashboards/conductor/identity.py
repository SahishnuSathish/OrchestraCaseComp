"""Sessions, the sign-in directory and role guards.

Phase 3 seam stub. Owner: p3/identity-live. Contract: docs/phase3/CONTRACTS.md sections 1-2.
"""
from fastapi import APIRouter

router = APIRouter()


def init_schema():
    pass


class Session:
    def __init__(self, id, role, subject, name, vendor_id=None, title=None):
        self.id, self.role, self.subject, self.name, self.vendor_id, self.title = id, role, subject, name, vendor_id, title


STAFF = {"ap_specialist", "cfo"}
ROLES = {"ap_specialist", "cfo", "approver", "vendor"}


def current(request):
    """The Session for this request, or None. Stub: no sessions yet."""
    return None


def create_session(role, subject, name, vendor_id=None, title=None):
    """Make a session directly (tests use this). Stub."""
    raise NotImplementedError


def require_role(*roles):
    """FastAPI dependency factory. Stub: allows everything until identity-live lands."""
    def dep():
        return None
    return dep


def staff_directory():
    return []


def vendor_for_contact(email):
    return None
