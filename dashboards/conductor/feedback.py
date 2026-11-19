""""What was off?" feedback on edited drafts.

Owner: p3/identity-live. Contract: docs/phase3/CONTRACTS.md section 6.

When a person edits a drafted reply, server.py calls `workflow.draft_changed`, which calls `mark_edited` here. The page then
asks "What was off?" (`should_ask`) and posts the answer to `POST /api/feedback`. The CFO reads the trends.
"""
from collections import Counter

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import appclock
import db
import identity

router = APIRouter()

CATEGORIES = ("tone", "facts", "missing_info", "other")
SOURCE = "Records as of Nov 13"


def init_schema():
    db._exec("CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ticket_id INTEGER, by TEXT,"
             " category TEXT, note TEXT, at REAL)")
    db._exec("CREATE TABLE IF NOT EXISTS feedback_edits (run_id TEXT, ticket_id INTEGER, by TEXT, edited_at REAL,"
             " PRIMARY KEY (run_id, ticket_id))")


def mark_edited(run_id, ticket_id, by="system"):
    db._exec("INSERT INTO feedback_edits (run_id, ticket_id, by, edited_at) VALUES (?,?,?,?) "
             "ON CONFLICT(run_id, ticket_id) DO UPDATE SET by=excluded.by, edited_at=excluded.edited_at",
             (run_id, ticket_id, by, appclock.now()))


def should_ask(run_id, ticket_id):
    """True when the draft was edited and nobody has said what was off since the last edit."""
    e = db._one("SELECT edited_at FROM feedback_edits WHERE run_id=? AND ticket_id=?", (run_id, ticket_id))
    if not e:
        return False
    f = db._one("SELECT MAX(at) AS at FROM feedback WHERE run_id=? AND ticket_id=?", (run_id, ticket_id))
    return not (f and f["at"] is not None and f["at"] >= e["edited_at"])


class FeedbackBody(BaseModel):
    run_id: str = Field(max_length=80)
    ticket_id: int
    category: str = Field(max_length=20)
    note: str = Field(default="", max_length=2000)


@router.post("/api/feedback")
def api_feedback(body: FeedbackBody, s=Depends(identity.require_role("ap_specialist", "cfo"))):
    if body.category not in CATEGORIES:
        raise HTTPException(400, "Pick one of: " + ", ".join(CATEGORIES) + ".")
    if not db.get_ticket(body.run_id, body.ticket_id):
        raise HTTPException(404, "ticket not found")
    db._exec("INSERT INTO feedback (run_id, ticket_id, by, category, note, at) VALUES (?,?,?,?,?,?)",
             (body.run_id, body.ticket_id, s.subject, body.category, body.note.strip(), appclock.now()))
    return {"ok": True}


@router.get("/api/feedback/prompt")
def api_prompt(run_id: str, ticket_id: int, s=Depends(identity.require_role("ap_specialist", "cfo"))):
    return {"ask": should_ask(run_id, ticket_id), "categories": list(CATEGORIES)}


def trends():
    rows = db._all("SELECT * FROM feedback ORDER BY id DESC")
    edited = db._one("SELECT COUNT(*) AS n FROM feedback_edits")["n"]
    by_cat = Counter(r["category"] for r in rows)
    by_person = Counter(r["by"] for r in rows)
    return {
        "total": len(rows),
        "edited_drafts": edited,
        "answer_rate": round(len(rows) / edited, 2) if edited else None,
        "by_category": [{"category": c, "count": by_cat.get(c, 0)} for c in CATEGORIES],
        "by_person": [{"email": p, "count": n} for p, n in by_person.most_common()],
        "recent": [{"at": appclock.iso(r["at"]), "by": r["by"], "category": r["category"], "note": r["note"],
                    "ticket_id": r["ticket_id"]} for r in rows[:10]],
        "source": SOURCE,
    }


@router.get("/api/feedback/trends")
def api_trends(s=Depends(identity.require_role("cfo"))):
    return trends()
