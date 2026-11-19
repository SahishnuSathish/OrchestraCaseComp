"""Headers for tests that call the Conductor API: the per-launch token plus a signed-in session.

docs/phase3/CONTRACTS.md section 13. `headers(role, email)` makes a real session with identity.create_session(...)
(no HTTP) and returns the token and session headers. Import this after `server`, so the dashboard modules are on the path.

Test modules point db at their own temporary folder when they are imported, and unittest imports every module before it
runs any, so the folder a module was imported against may not be the one in use when its tests run. The returned mapping
therefore puts its session back into the current database whenever it is read.
"""
import server
import db
import identity

DEFAULT_EMAILS = {
    "ap_specialist": "ulla.abernathy@orchestra-mock.example",
    "cfo": "elena.lockhart@orchestra-mock.example",
    "approver": "ben.merriweather@orchestra-mock.example",
}


class _SessionHeaders(dict):
    """A plain dict of headers that makes sure its session exists in the database now in use."""

    def __init__(self, session, extra):
        super().__init__({"x-ap-token": server.TOKEN, identity.HEADER: session.id, **extra})
        self.session = session

    def _ensure(self):
        s = self.session
        db._exec("INSERT OR IGNORE INTO sessions (id, role, subject, name, vendor_id, created_at, last_seen, title) "
                 "VALUES (?,?,?,?,?,?,?,?)",
                 (s.id, s.role, s.subject, s.name, s.vendor_id, identity._clock(), identity._clock(), s.title))

    def items(self):
        self._ensure()
        return super().items()

    def copy(self):
        return dict(self.items())


def _person(role, email):
    email = (email or DEFAULT_EMAILS.get(role) or "").lower()
    for a in identity.staff_directory():
        if a["email"] == email:
            return a["name"], a["title"]
    return email.split("@")[0].replace(".", " ").title(), None


def session_for(role="ap_specialist", email=None, vendor_id=None):
    """A Session made directly with identity.create_session."""
    if role == "vendor":
        email = (email or "").lower()
        v = identity.vendor_for_contact(email)
        return identity.create_session("vendor", email, identity._contact_name(email), vendor_id=vendor_id or (v or {}).get("internalId"))
    email = (email or DEFAULT_EMAILS[role]).lower()
    name, title = _person(role, email)
    return identity.create_session(role, email, name, title=title)


def headers(role="ap_specialist", email=None, **extra):
    """The token plus a signed-in session for `role` (default person for the role unless `email` is given)."""
    return _SessionHeaders(session_for(role, email), extra)
