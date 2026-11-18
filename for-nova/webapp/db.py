"""SQLite persistence for the Conductor web app (runs, per-ticket bundles, briefs, review decisions).

One short-lived connection per call, guarded by a lock, so the pipeline thread, the brief worker
and the request threads never share a connection. Nothing in here touches the prototype.
"""
import json
import os
import sqlite3
import threading
import time
from pathlib import Path

STATE_DIR = Path(os.environ.get("CONDUCTOR_STATE_DIR") or os.environ.get("AP_DESK_STATE_DIR")
                 or (Path(__file__).resolve().parent / "state"))
DB_PATH = STATE_DIR / "app.db"
_LOCK = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, created_at REAL, dataset_path TEXT, source TEXT, use_model INTEGER,
  limit_n INTEGER, status TEXT, total INTEGER, done INTEGER, error TEXT, label TEXT, started_at REAL, finished_at REAL
);
CREATE TABLE IF NOT EXISTS tickets (
  run_id TEXT, ticket_id INTEGER, seq INTEGER, bundle TEXT, ticket TEXT, row TEXT,
  PRIMARY KEY (run_id, ticket_id)
);
CREATE TABLE IF NOT EXISTS briefs (
  run_id TEXT, ticket_id INTEGER, bundle_hash TEXT, body TEXT, source TEXT, info TEXT, updated_at REAL,
  PRIMARY KEY (run_id, ticket_id)
);
CREATE TABLE IF NOT EXISTS reviews (
  run_id TEXT, ticket_id INTEGER, state TEXT, edited_text TEXT, note TEXT, decided_at REAL,
  edited_subject TEXT, sent_at REAL, message_id TEXT, send_info TEXT,
  PRIMARY KEY (run_id, ticket_id)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
"""


def _connect():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


def init():
    with _LOCK, _connect() as con:
        con.executescript(SCHEMA)
        # Databases created before editing/sending existed: add the new review columns.
        have = {r["name"] for r in con.execute("PRAGMA table_info(reviews)")}
        for col, typ in (("edited_subject", "TEXT"), ("sent_at", "REAL"), ("message_id", "TEXT"), ("send_info", "TEXT")):
            if col not in have:
                con.execute(f"ALTER TABLE reviews ADD COLUMN {col} {typ}")
        have = {r["name"] for r in con.execute("PRAGMA table_info(runs)")}
        for col, typ in (("model", "TEXT"), ("warnings", "TEXT"), ("model_free", "INTEGER DEFAULT 0")):
            if col not in have:
                con.execute(f"ALTER TABLE runs ADD COLUMN {col} {typ}")
        # A run that was mid-flight when the server stopped can never finish: mark it interrupted.
        con.execute("UPDATE runs SET status='interrupted' WHERE status IN ('running','starting')")


def _exec(sql, args=()):
    with _LOCK:
        con = _connect()
        try:
            with con:
                con.execute(sql, args)
        finally:
            con.close()


def _all(sql, args=()):
    with _LOCK:
        con = _connect()
        try:
            return [dict(r) for r in con.execute(sql, args).fetchall()]
        finally:
            con.close()


def _one(sql, args=()):
    rows = _all(sql, args)
    return rows[0] if rows else None


# ------------------------------------------------------------------ runs
def create_run(run_id, dataset_path, source, use_model, limit_n, total, label=None, status="starting", model=None, warnings=None,
               model_free=False):
    _exec("INSERT INTO runs (id, created_at, dataset_path, source, use_model, limit_n, status, total, done, label, started_at,"
          " model, warnings, model_free) VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?)",
          (run_id, time.time(), str(dataset_path), source, int(bool(use_model)), limit_n, status, total, label, time.time(),
           model, json.dumps(list(warnings or [])), int(bool(model_free))))


def update_run(run_id, **fields):
    if not fields:
        return
    if "warnings" in fields and not isinstance(fields["warnings"], (str, type(None))):
        fields["warnings"] = json.dumps(list(fields["warnings"]))
    cols = ", ".join(f"{k}=?" for k in fields)
    _exec(f"UPDATE runs SET {cols} WHERE id=?", (*fields.values(), run_id))


def _run_out(r):
    if r is not None:
        try:
            w = json.loads(r.get("warnings") or "[]")
        except ValueError:
            w = []
        r["warnings"] = [str(x) for x in w] if isinstance(w, list) else []
    return r


def get_run(run_id):
    return _run_out(_one("SELECT * FROM runs WHERE id=?", (run_id,)))


def list_runs(limit=50):
    return [_run_out(r) for r in _all("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?", (limit,))]


def add_run_warning(run_id, message):
    with _LOCK:
        r = get_run(run_id)
        if r is not None and message not in r["warnings"]:
            update_run(run_id, warnings=r["warnings"] + [message])


def delete_run(run_id):
    """Remove a run and everything stored for it, in one transaction."""
    with _LOCK:
        con = _connect()
        try:
            with con:
                for table in ("reviews", "briefs", "tickets", "runs"):
                    col = "id" if table == "runs" else "run_id"
                    con.execute(f"DELETE FROM {table} WHERE {col}=?", (run_id,))
        finally:
            con.close()


# ------------------------------------------------------------------ settings
def get_setting(key, default=None):
    r = _one("SELECT value FROM settings WHERE key=?", (key,))
    if not r:
        return default
    try:
        return json.loads(r["value"])
    except (TypeError, ValueError):
        return default


def set_setting(key, value):
    _exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          (key, json.dumps(value)))


def delete_setting(key):
    _exec("DELETE FROM settings WHERE key=?", (key,))


# ------------------------------------------------------------------ tickets
def save_ticket(run_id, ticket_id, seq, bundle, ticket, row):
    _exec("INSERT OR REPLACE INTO tickets (run_id, ticket_id, seq, bundle, ticket, row) VALUES (?,?,?,?,?,?)",
          (run_id, ticket_id, seq, json.dumps(bundle, ensure_ascii=True, default=sorted),
           json.dumps(ticket, ensure_ascii=True), json.dumps(row, ensure_ascii=True)))


def list_rows(run_id):
    out = []
    for r in _all("SELECT row FROM tickets WHERE run_id=? ORDER BY seq", (run_id,)):
        out.append(json.loads(r["row"]))
    return out


def get_ticket(run_id, ticket_id):
    r = _one("SELECT bundle, ticket, row FROM tickets WHERE run_id=? AND ticket_id=?", (run_id, ticket_id))
    if not r:
        return None
    return {"bundle": json.loads(r["bundle"]), "ticket": json.loads(r["ticket"]), "row": json.loads(r["row"])}


def count_tickets(run_id):
    return _one("SELECT COUNT(*) AS n FROM tickets WHERE run_id=?", (run_id,))["n"]


# ------------------------------------------------------------------ briefs
def save_brief(run_id, ticket_id, bundle_hash, body, source, info):
    _exec("INSERT OR REPLACE INTO briefs (run_id, ticket_id, bundle_hash, body, source, info, updated_at) VALUES (?,?,?,?,?,?,?)",
          (run_id, ticket_id, bundle_hash, json.dumps(body), source, json.dumps(info or {}), time.time()))


def get_brief(run_id, ticket_id):
    r = _one("SELECT * FROM briefs WHERE run_id=? AND ticket_id=?", (run_id, ticket_id))
    if not r:
        return None
    return {"bundle_hash": r["bundle_hash"], "bullets": json.loads(r["body"]), "source": r["source"],
            "info": json.loads(r["info"] or "{}"), "updated_at": r["updated_at"]}


def brief_sources(run_id):
    return {r["ticket_id"]: r["source"] for r in _all("SELECT ticket_id, source FROM briefs WHERE run_id=?", (run_id,))}


# ------------------------------------------------------------------ reviews
def get_review(run_id, ticket_id):
    r = _one("SELECT * FROM reviews WHERE run_id=? AND ticket_id=?", (run_id, ticket_id))
    return r or {"run_id": run_id, "ticket_id": ticket_id, "state": "pending", "edited_text": None, "note": None,
                 "decided_at": None, "edited_subject": None, "sent_at": None, "message_id": None, "send_info": None}


def save_review(run_id, ticket_id, state, edited_text=None, note=None):
    """Record a decision. Leaves the edited subject and any send record untouched."""
    _exec("INSERT INTO reviews (run_id, ticket_id, state, edited_text, note, decided_at) VALUES (?,?,?,?,?,?) "
          "ON CONFLICT(run_id, ticket_id) DO UPDATE SET state=excluded.state, edited_text=excluded.edited_text, "
          "note=excluded.note, decided_at=excluded.decided_at",
          (run_id, ticket_id, state, edited_text, note, time.time()))


def save_draft(run_id, ticket_id, edited_text, edited_subject):
    """Autosave an employee's edits without touching the review state (a new row starts as pending)."""
    _exec("INSERT INTO reviews (run_id, ticket_id, state, edited_text, edited_subject) VALUES (?,?, 'pending', ?, ?) "
          "ON CONFLICT(run_id, ticket_id) DO UPDATE SET edited_text=excluded.edited_text, edited_subject=excluded.edited_subject",
          (run_id, ticket_id, edited_text, edited_subject))


def save_sent(run_id, ticket_id, message_id, info):
    _exec("UPDATE reviews SET state='sent', sent_at=?, message_id=?, send_info=? WHERE run_id=? AND ticket_id=?",
          (time.time(), message_id, json.dumps(info or {}), run_id, ticket_id))


def review_states(run_id):
    return {r["ticket_id"]: r for r in _all(
        "SELECT ticket_id, state, edited_text, edited_subject, note, decided_at, sent_at, message_id FROM reviews WHERE run_id=?", (run_id,))}
