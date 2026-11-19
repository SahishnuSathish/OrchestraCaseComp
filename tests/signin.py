"""Headers for tests that call the Conductor API: the per-launch token plus a signed-in session.

Phase 3 seam stub (docs/phase3/CONTRACTS.md section 13). Owner after the seam: p3/identity-live, which makes
headers() create a real session with identity.create_session(...) for the requested role.
Import this after `server`, so the dashboard modules are on the path.
"""
import server

DEFAULT_EMAILS = {
    "ap_specialist": "ulla.abernathy@orchestra-mock.example",
    "cfo": "elena.lockhart@orchestra-mock.example",
    "approver": "ben.merriweather@orchestra-mock.example",
}


def headers(role="ap_specialist", email=None):
    """Stub: token only, until sessions exist."""
    return {"x-ap-token": server.TOKEN}
