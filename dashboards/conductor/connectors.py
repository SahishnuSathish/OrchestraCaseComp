"""Simulated Zendesk, Outlook and NetSuite connection state, the local model's status, and the sync log.

Owner: p3/inbox-sync. Contract: docs/phase3/CONTRACTS.md section 5.

Nothing here talks to a real system. `data/tickets.json` is the Zendesk source, the thread history is the mailbox, and
NetSuite is the read-only record files. The log lines are what the simulated write-backs and syncs "did".
"""
from fastapi import APIRouter, Depends

import appclock
import db
import identity
import mailer
import runner

router = APIRouter()
STAFF = ("ap_specialist", "cfo")

ZENDESK_HOST = "orchestra-mock.zendesk.com"
OUTLOOK_ADDRESS = "ap@orchestra-mock.example"
LOG_KEEP = 200


def init_schema():
    db._exec("CREATE TABLE IF NOT EXISTS sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, text TEXT, source TEXT)")
    have = {r["name"] for r in db._all("PRAGMA table_info(sync_log)")}
    if "source" not in have:
        db._exec("ALTER TABLE sync_log ADD COLUMN source TEXT")


def log(text, source=None):
    """One line in the sync log, stamped with the app clock. `source` is zendesk, outlook, netsuite or None."""
    db._exec("INSERT INTO sync_log (at, text, source) VALUES (?,?,?)", (appclock.iso(), str(text)[:300], source))
    db._exec("DELETE FROM sync_log WHERE id <= (SELECT MAX(id) FROM sync_log) - ?", (LOG_KEEP,))


def recent(n=50):
    return [{"at": r["at"], "text": r["text"]} for r in
            db._all("SELECT at, text FROM sync_log ORDER BY id DESC LIMIT ?", (int(n),))]


def _last(source):
    r = db._one("SELECT at FROM sync_log WHERE source=? ORDER BY id DESC LIMIT 1", (source,))
    return r["at"] if r else None


def _model_connection():
    try:
        st = runner.model_status()
    except Exception as e:  # the model is optional; a failed probe is a status, not an error
        st = {"usable": False, "state": "unreachable", "model": None, "error": f"{type(e).__name__}"}
    if st.get("usable"):
        status, detail = "connected", f"{st.get('model')} on this computer"
    else:
        status = "unavailable"
        detail = st.get("error") or "The local model is not running. Conductor still reads every email with its rules."
    return {"id": "model", "name": "Local AI model", "status": status, "last_sync": None, "detail": detail,
            "scopes": ["Runs on this computer only", "Rewords briefs and drafts; never changes a decision"]}


def connections():
    connected = db.get_setting("inbox.connected_at")
    since = appclock.iso(connected) if connected else None
    m = mailer.get_mailer()
    return {"connections": [
        {"id": "zendesk", "name": "Zendesk", "status": "connected" if connected else "not_connected",
         "last_sync": _last("zendesk") or since, "detail": ZENDESK_HOST,
         "scopes": ["Read tickets", "Add internal notes", "Set status"]},
        {"id": "outlook", "name": "Outlook", "status": "connected" if connected else "not_connected",
         "last_sync": _last("outlook") or since, "detail": f"{OUTLOOK_ADDRESS} ({m.label})",
         "scopes": [f"Read and send from {OUTLOOK_ADDRESS}", "File sent replies in Sent items"]},
        {"id": "netsuite", "name": "NetSuite", "status": "connected" if connected else "not_connected",
         "last_sync": since, "detail": "Read-only",
         "scopes": ["Read vendors, bills, payments", "No write access"]},
        _model_connection(),
    ], "log": recent(50)}


@router.get("/api/connections", dependencies=[Depends(identity.require_role(*STAFF))])
def api_connections():
    import inbox
    inbox.inbox_run_id()  # first look at Connections is also the first connect
    return connections()
