"""Conductor: local web app for running the AP ticket pipeline on a dataset and approving the drafted replies.

    python dashboards/conductor/server.py            # http://127.0.0.1:8790
    python dashboards/conductor/server.py --open     # also opens the browser

Local only: binds to 127.0.0.1, rejects any Host header that is not localhost, and requires a per-launch
token (injected into index.html) on every /api call. Nothing is ever sent to a requester; approving a
reply records a decision in dashboards/conductor/state/app.db, and "Export" writes a score.py-style results file.
"""
import argparse
import asyncio
import json
import os
import queue
import re
import secrets
import string
import sys
import threading
import time
from collections import Counter
from pathlib import Path
from typing import List, Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from fastapi import Depends, FastAPI, HTTPException, Request  # noqa: E402
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

import chat  # noqa: E402
import db  # noqa: E402
import delivery  # noqa: E402
import local_model  # noqa: E402
import mailer  # noqa: E402
import prevention  # noqa: E402
import reply_checks  # noqa: E402
import runner  # noqa: E402
import scheduler  # noqa: E402

TOKEN = secrets.token_urlsafe(18)
STATIC = HERE / "assets"                     # this dashboard's page: index.html, js/, css/
SHARED = HERE.parents[1] / "assets"          # shared with the vendor portal: tokens, font CSS, font files
mgr: "runner.Manager" = None

REVIEW_STATES = {
    "draft_reply": {"pending", "approved", "returned"},
    "internal_action_note": {"pending", "acknowledged"},
    "no_draft": {"pending", "closed"},
}
SIGNED_OFF = {"approved", "sent", "acknowledged", "closed"}
BLOCK_APPROVE_FLAGS = reply_checks.BLOCK_APPROVE_FLAGS


def get_manager():
    global mgr
    if mgr is None:
        mgr = runner.Manager()
    return mgr


db.init()
app = FastAPI(title="Conductor", docs_url=None, redoc_url=None, openapi_url=None)


# ---------------------------------------------------------------------------- local-only guards
@app.middleware("http")
async def local_only(request: Request, call_next):
    host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]").lower()
    if host not in ("localhost", "127.0.0.1", "::1"):
        return JSONResponse({"detail": "forbidden host"}, status_code=403)
    origin = request.headers.get("origin")
    if origin and request.method not in ("GET", "HEAD") and origin.split("://", 1)[-1] != request.headers.get("host"):
        return JSONResponse({"detail": "forbidden origin"}, status_code=403)
    resp = await call_next(request)
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Content-Security-Policy"] = ("default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
                                               "connect-src 'self'; frame-ancestors 'none'")
    return resp


def auth(request: Request):
    tok = request.headers.get("x-ap-token") or request.query_params.get("token")
    if not tok or not secrets.compare_digest(tok, TOKEN):
        raise HTTPException(401, "missing or bad token")


api = [Depends(auth)]
app.state.get_manager = get_manager  # for routers in other modules: request.app.state.get_manager()


# ---------------------------------------------------------------------------- pages
@app.get("/", response_class=HTMLResponse)
def index():
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(html.replace("__AP_TOKEN__", TOKEN))


if SHARED.is_dir():
    # Order matters: /static/fonts must be mounted before /static, which would otherwise catch it.
    app.mount("/static/fonts", StaticFiles(directory=SHARED / "fonts"), name="fonts")
    app.mount("/shared", StaticFiles(directory=SHARED), name="shared")
if STATIC.is_dir():
    app.mount("/static", StaticFiles(directory=STATIC), name="static")


# ---------------------------------------------------------------------------- environment
@app.get("/api/health", dependencies=api)
def api_health():
    return {"ok": True}


def _status_payload(force=False):
    v = dict(runner.model_status(force=force))
    v["briefs_pending"] = get_manager().briefs.pending_count()
    return v


@app.get("/api/model/status", dependencies=api)
def api_model_status(force: bool = False):
    return _status_payload(force)


def _settings_payload():
    out = local_model.settings_payload()
    m = mailer.get_mailer()
    out["mail"] = {"mode": m.mode, "label": m.label, "from": mailer.default_sender(None)}
    return out


@app.get("/api/settings", dependencies=api)
def api_settings():
    return _settings_payload()


class ModelSettingsBody(BaseModel):
    url: Optional[str] = None
    model: Optional[str] = None
    timeout_s: Optional[int] = None


@app.put("/api/settings/model", dependencies=api)
def api_save_model_settings(body: ModelSettingsBody):
    given = {k: getattr(body, k) for k in body.model_fields_set if k in ("url", "model", "timeout_s")}
    try:
        local_model.set_config(**given)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"settings": _settings_payload(), "status": _status_payload(force=True)}


class ModelTestBody(BaseModel):
    text: str = Field(min_length=1, max_length=8000)
    model: Optional[str] = Field(default=None, max_length=120, pattern=r"^[A-Za-z0-9._:/-]+$")


def _sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@app.post("/api/model/test", dependencies=api)
async def api_model_test(body: ModelTestBody, request: Request):
    """Stream one reading from the local model. A worker thread does the blocking read and feeds a queue; this
    coroutine relays it and, if the browser goes away, closes the upstream connection so Ollama stops generating."""
    cancel, upstream, q = threading.Event(), local_model.Upstream(), queue.Queue()

    def work():
        try:
            for ev in local_model.stream_reading(body.text, body.model, cancel, upstream):
                q.put(ev)
                if cancel.is_set():
                    break
        except Exception as e:  # never leave the stream hanging
            q.put(("error", {"kind": "http", "message": f"The test could not be completed ({type(e).__name__})."}))
        finally:
            q.put(None)

    threading.Thread(target=work, daemon=True, name="model-test").start()

    async def gen():
        try:
            while True:
                try:
                    item = q.get_nowait()
                except queue.Empty:
                    if await request.is_disconnected():
                        return
                    await asyncio.sleep(0.1)
                    continue
                if item is None:
                    return
                yield _sse(*item)
        finally:
            cancel.set()
            upstream.close()

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})


@app.get("/api/fs/list", dependencies=api)
def api_fs_list(path: str = ""):
    """Directories only. The server is bound to localhost, so this lists the machine the app runs on."""
    shortcuts = [{"name": "Practice dataset (data)", "path": str(runner.DEFAULT_DATASET)},
                 {"name": "Project folder", "path": str(runner.FOR_NOVA)},
                 {"name": "Home", "path": str(Path.home())}]
    path = runner.clean_path(path)
    if not path:
        roots = []
        if os.name == "nt":
            for letter in string.ascii_uppercase:
                if Path(f"{letter}:\\").exists():
                    roots.append({"name": f"{letter}:\\", "path": f"{letter}:\\", "has_tickets": False})
        else:
            roots.append({"name": "/", "path": "/", "has_tickets": False})
        return {"path": "", "parent": None, "entries": roots, "shortcuts": shortcuts}
    p = Path(path).expanduser()
    if p.is_file():
        p = p.parent
    try:
        p = p.resolve()
        if not p.is_dir():
            raise HTTPException(404, "not a folder")
        entries = []
        for child in sorted(p.iterdir(), key=lambda c: c.name.lower()):
            if child.name.startswith((".", "$")) or child.name in ("System Volume Information", "node_modules", "__pycache__"):
                continue
            try:
                if child.is_dir():
                    entries.append({"name": child.name, "path": str(child), "has_tickets": (child / "tickets.json").is_file()})
            except OSError:
                continue
            if len(entries) >= 500:
                break
    except PermissionError:
        raise HTTPException(403, "no permission to read that folder")
    parent = str(p.parent) if p.parent != p else ""
    return {"path": str(p), "parent": parent, "entries": entries, "shortcuts": shortcuts,
            "is_dataset": (p / "tickets.json").is_file()}


class PathBody(BaseModel):
    path: str


@app.post("/api/dataset/validate", dependencies=api)
def api_validate(body: PathBody):
    return runner.validate_dataset(body.path)


# ---------------------------------------------------------------------------- runs
class RunBody(BaseModel):
    path: str
    use_model: bool = False        # the pipeline reader uses the model
    model_free: bool = False       # no model anywhere in the run, briefs included (cannot be combined with use_model)
    limit: Optional[int] = None


class ImportBody(BaseModel):
    path: str
    dataset_path: Optional[str] = None
    label: Optional[str] = None


def _counts(run_id):
    rows = db.list_rows(run_id)
    reviews = db.review_states(run_id)
    c = {"total": len(rows), "draft_reply": 0, "internal_action_note": 0, "no_draft": 0, "error": 0, "flagged": 0,
         "priority": 0, "pending": 0, "approved": 0, "sent": 0, "returned": 0, "signed_off": 0}
    rules = {}
    for r in rows:
        c[r["output_type"]] = c.get(r["output_type"], 0) + 1
        c["flagged"] += bool(r["flags"])
        c["priority"] += bool(r["priority"])
        rules[r["rule"]] = rules.get(r["rule"], 0) + 1
        st = (reviews.get(r["ticket_id"]) or {}).get("state", "pending")
        if r["output_type"] == "error":
            continue
        if st == "pending":
            c["pending"] += 1
        if st == "approved":
            c["approved"] += 1
        if st == "sent":
            c["sent"] += 1
        if st == "returned":
            c["returned"] += 1
        if st in SIGNED_OFF:
            c["signed_off"] += 1
    c["rules"] = sorted(rules.items(), key=lambda kv: -kv[1])[:8]
    return c


def _run_payload(r):
    out = dict(r)
    out["use_model"] = bool(r["use_model"])
    out["model_free"] = bool(r.get("model_free"))
    out["counts"] = _counts(r["id"])
    return out


@app.get("/api/runs", dependencies=api)
def api_runs(limit: int = 50):
    return {"runs": [_run_payload(r) for r in db.list_runs(max(1, min(limit, 200)))], "importable": runner.list_importable(),
            "active": get_manager().running_run()}


@app.post("/api/runs", dependencies=api)
def api_start_run(body: RunBody):
    try:
        run_id = get_manager().start_run(body.path, body.use_model, body.limit if body.limit and body.limit > 0 else None,
                                         model_free=body.model_free)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return {"run_id": run_id}


@app.post("/api/runs/import", dependencies=api)
def api_import(body: ImportBody):
    try:
        return {"run_id": get_manager().import_run(body.path, body.dataset_path, body.label)}
    except (ValueError, OSError, KeyError) as e:
        raise HTTPException(400, str(e))


def _run_or_404(run_id):
    r = db.get_run(run_id)
    if not r:
        raise HTTPException(404, "run not found")
    return r


@app.get("/api/runs/{run_id}", dependencies=api)
def api_run(run_id: str):
    return _run_payload(_run_or_404(run_id))


@app.delete("/api/runs/{run_id}", dependencies=api)
def api_delete_run(run_id: str):
    _run_or_404(run_id)
    try:
        get_manager().delete_run(run_id)
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    return {"deleted": True}


@app.post("/api/runs/{run_id}/cancel", dependencies=api)
def api_cancel(run_id: str):
    _run_or_404(run_id)
    return {"cancelled": get_manager().cancel(run_id)}


@app.get("/api/runs/{run_id}/events")
async def api_events(run_id: str, request: Request, after: int = -1, _=Depends(auth)):
    _run_or_404(run_id)
    live = get_manager().ensure_live(run_id)
    after = max(after, int(request.headers.get("last-event-id", -1) or -1))

    async def gen():
        i = after + 1
        idle = 0.0
        yield "retry: 3000\n\n"
        while not await request.is_disconnected():
            with live.cond:
                batch = live.events[i:]
            if batch:
                for ev in batch:
                    yield f"id: {ev['i']}\nevent: {ev['type']}\ndata: {json.dumps(ev['data'])}\n\n"
                i = batch[-1]["i"] + 1
                idle = 0.0
            else:
                idle += 0.3
                if idle >= 15:
                    yield ": ping\n\n"
                    idle = 0.0
                await asyncio.sleep(0.3)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})


# ---------------------------------------------------------------------------- tickets
@app.get("/api/runs/{run_id}/tickets", dependencies=api)
def api_tickets(run_id: str):
    _run_or_404(run_id)
    rows = db.list_rows(run_id)
    reviews = db.review_states(run_id)
    sources = db.brief_sources(run_id)
    for r in rows:
        r["review_state"] = (reviews.get(r["ticket_id"]) or {}).get("state", "pending")
        r["brief_source"] = sources.get(r["ticket_id"])
    return {"rows": rows}


def _default_subject(subject):
    return reply_checks.default_subject(subject)


def _mail_info(ticket):
    m = mailer.get_mailer()
    return {"mode": m.mode, "label": m.label, "from": mailer.default_sender((ticket or {}).get("to"))}


def _detail(run_id, tid):
    rec = db.get_ticket(run_id, tid)
    if not rec:
        raise HTTPException(404, "ticket not found in this run")
    b = rec["bundle"]
    rv = db.get_review(run_id, tid)
    brief = db.get_brief(run_id, tid)
    res = b.get("result", {})
    subject = rec["ticket"].get("subject") or ""
    is_reply = res.get("output_type") == "draft_reply"
    default_subject = _default_subject(subject) if is_reply else None
    draft = {
        "output_type": res.get("output_type"), "to": res.get("recipient"),
        "subject": (rv.get("edited_subject") or default_subject) if is_reply else None,
        "default_subject": default_subject,
        "subject_edited": bool(rv.get("edited_subject")) and rv.get("edited_subject") != default_subject,
        "original_text": res.get("text") or "",
        "text": rv["edited_text"] if rv.get("edited_text") is not None else (res.get("text") or ""),
        "edited": rv.get("edited_text") is not None and rv["edited_text"] != (res.get("text") or ""),
    }
    return {
        "run_id": run_id, "row": rec["row"], "ticket": rec["ticket"], "draft": draft, "brief": brief,
        "review": {"state": rv["state"], "note": rv.get("note"), "decided_at": rv.get("decided_at"),
                   "can_approve": not (BLOCK_APPROVE_FLAGS & set(res.get("flags") or [])),
                   "can_send": bool(is_reply and res.get("recipient") and rv["state"] == "approved"
                                    and not (BLOCK_APPROVE_FLAGS & set(res.get("flags") or []))),
                   "sent_at": rv.get("sent_at"), "message_id": rv.get("message_id"),
                   "send_info": json.loads(rv["send_info"]) if rv.get("send_info") else None},
        "mail": _mail_info(rec["ticket"]),
        "bundle": {k: b.get(k) for k in ("stages", "trace", "decision", "plan", "model", "advisory", "ms", "api_calls", "error")},
    }


@app.get("/api/runs/{run_id}/tickets/{ticket_id}", dependencies=api)
def api_ticket(run_id: str, ticket_id: int):
    _run_or_404(run_id)
    return _detail(run_id, ticket_id)


@app.post("/api/runs/{run_id}/tickets/{ticket_id}/brief", dependencies=api)
def api_regen_brief(run_id: str, ticket_id: int):
    run = _run_or_404(run_id)
    if run.get("model_free"):
        raise HTTPException(409, "This run was started without any model, so its briefs are written from the records only.")
    if not runner.model_status()["usable"]:
        raise HTTPException(409, "The local model is not available.")
    return {"queued": get_manager().briefs.enqueue(run_id, ticket_id, force=True)}


@app.post("/api/runs/{run_id}/briefs/upgrade", dependencies=api)
def api_upgrade_briefs(run_id: str):
    run = _run_or_404(run_id)
    if run.get("model_free") or not runner.model_status()["usable"]:
        return {"queued": 0, "model": False}
    return {"queued": get_manager().briefs.enqueue_run(run_id), "model": True}


# ---------------------------------------------------------------------------- review
class ReviewBody(BaseModel):
    state: str
    text: Optional[str] = None
    note: Optional[str] = None


class BulkBody(BaseModel):
    ids: List[int]
    state: str = "approved"


def _edit_problems(original, edited, recipient):
    """Problems an employee's edit ADDS to a reply (see reply_checks.edit_problems). Fails closed with 503."""
    try:
        return reply_checks.edit_problems(original, edited, recipient)
    except reply_checks.ChecksUnavailable as e:
        raise HTTPException(503, str(e))


def _apply_review(run_id, tid, state, text=None, note=None):
    rec = db.get_ticket(run_id, tid)
    if not rec:
        raise HTTPException(404, f"ticket {tid} not found")
    otype = rec["row"]["output_type"]
    if otype == "error":  # a crashed ticket is reviewed as whatever the bundle says it is (a note, or no reply)
        otype = (rec["bundle"].get("result") or {}).get("output_type") or "no_draft"
    if otype not in REVIEW_STATES:
        raise HTTPException(400, "this ticket has no reply to review")
    if state not in REVIEW_STATES[otype]:
        raise HTTPException(400, f"{state!r} is not valid for {otype}")
    flags = set(rec["row"].get("flags") or [])
    if db.get_review(run_id, tid)["state"] == "sent":
        raise HTTPException(409, "This reply was already sent and can't be changed.")
    if state == "approved" and BLOCK_APPROVE_FLAGS & flags:
        raise HTTPException(409, "flagged tickets cannot be approved here; a person must handle them")
    if state == "returned" and not (note or "").strip():
        raise HTTPException(400, "a reason is required when returning a reply")
    cur = db.get_review(run_id, tid)
    edited = cur.get("edited_text")
    original = (rec["bundle"].get("result") or {}).get("text") or ""
    if text is not None and otype == "draft_reply":
        if len(text) > 20000:
            raise HTTPException(400, "reply is too long")
        edited = None if text == original else text
    if state == "approved" and edited is not None:
        problems = _edit_problems(original, edited, rec["row"].get("recipient"))
        if problems:
            raise HTTPException(422, "The edited reply can't be approved: it adds " + "; ".join(problems) + ". Remove that and try again.")
    db.save_review(run_id, tid, state, edited, (note or "").strip() or None)
    scheduler.on_review_change(run_id, tid, state)


@app.put("/api/runs/{run_id}/review/{ticket_id}", dependencies=api)
def api_review(run_id: str, ticket_id: int, body: ReviewBody):
    _run_or_404(run_id)
    _apply_review(run_id, ticket_id, body.state, body.text, body.note)
    get_manager().emit(run_id, "review", {"ticket_id": ticket_id, "state": body.state})
    return _detail(run_id, ticket_id)


@app.post("/api/runs/{run_id}/review/bulk", dependencies=api)
def api_review_bulk(run_id: str, body: BulkBody):
    _run_or_404(run_id)
    done, skipped = [], []
    for tid in body.ids[:500]:
        try:
            _apply_review(run_id, tid, body.state)
            done.append(tid)
        except HTTPException as e:
            skipped.append({"ticket_id": tid, "reason": e.detail})
    return {"done": done, "skipped": skipped}


class DraftBody(BaseModel):
    text: Optional[str] = None
    subject: Optional[str] = None


def _problems_safe(original, edited, recipient):
    try:
        return _edit_problems(original, edited, recipient)
    except HTTPException as e:
        return [str(e.detail)]


def _reply_for_edit(run_id, tid):
    """The ticket and its review row, if the draft may still be edited. Raises otherwise."""
    rec = db.get_ticket(run_id, tid)
    if not rec:
        raise HTTPException(404, "ticket not found in this run")
    res = rec["bundle"].get("result") or {}
    if res.get("output_type") != "draft_reply":
        raise HTTPException(400, "only drafted replies can be edited")
    if BLOCK_APPROVE_FLAGS & set(res.get("flags") or []):
        raise HTTPException(409, "flagged tickets cannot be edited here; a person must handle them")
    cur = db.get_review(run_id, tid)
    blocked = scheduler.edit_block_reason(run_id, tid)
    if blocked:
        raise HTTPException(409, blocked)
    if cur["state"] not in ("pending", "returned"):
        raise HTTPException(409, "Reopen the reply to edit it." if cur["state"] == "approved" else "This reply was already sent.")
    return rec, res, cur


@app.put("/api/runs/{run_id}/review/{ticket_id}/draft", dependencies=api)
def api_save_draft(run_id: str, ticket_id: int, body: DraftBody):
    """Autosave the employee's edits to the reply. Never changes the review state."""
    _run_or_404(run_id)
    rec, res, cur = _reply_for_edit(run_id, ticket_id)
    original = res.get("text") or ""
    default_subject = _default_subject(rec["ticket"].get("subject"))
    text, subject = cur.get("edited_text"), cur.get("edited_subject")
    if body.text is not None:
        if len(body.text) > 20000:
            raise HTTPException(400, "reply is too long")
        text = None if body.text == original else body.text
    if body.subject is not None:
        one_line = re.sub(r"\s+", " ", body.subject).strip()[:200]
        subject = None if (not one_line or one_line == default_subject) else one_line
    db.save_draft(run_id, ticket_id, text, subject)
    problems = []
    if text is not None:
        problems += _problems_safe(original, text, res.get("recipient"))
    if subject is not None:
        problems += ["subject: " + p for p in _problems_safe(default_subject, subject, res.get("recipient"))]
    return {"saved": True, "edited": text is not None, "subject_edited": subject is not None, "problems": problems}


@app.get("/api/mail/status", dependencies=api)
def api_mail_status():
    return _mail_info({})


@app.post("/api/runs/{run_id}/tickets/{ticket_id}/send", dependencies=api)
def api_send(run_id: str, ticket_id: int):
    """Send the approved reply through the mail adapter. Recipient, subject and body all come from the server's
    own records, never from the request."""
    _run_or_404(run_id)
    try:
        delivery.deliver_reply(run_id, ticket_id)
    except delivery.DeliveryError as e:
        raise HTTPException(e.status, e.message)
    get_manager().emit(run_id, "review", {"ticket_id": ticket_id, "state": "sent"})
    return _detail(run_id, ticket_id)


@app.get("/api/runs/{run_id}/export", dependencies=api)
def api_export(run_id: str, scope: str = "signed_off"):
    run = _run_or_404(run_id)
    reviews = db.review_states(run_id)
    results = []
    for row in db.list_rows(run_id):
        rec = db.get_ticket(run_id, row["ticket_id"])
        st = (reviews.get(row["ticket_id"]) or {}).get("state", "pending")
        if scope != "all" and st not in SIGNED_OFF:
            continue
        res = dict(rec["bundle"]["result"])
        edited = (reviews.get(row["ticket_id"]) or {}).get("edited_text")
        if edited is not None and st in ("approved", "sent"):
            res["text"] = edited
        results.append(res)
    payload = json.dumps({"team": "orchestra-prototype", "results": results}, indent=1, ensure_ascii=True)
    name = f"results-{run['label'] or run_id}-{scope}.json".replace(" ", "_")
    return StreamingResponse(iter([payload]), media_type="application/json",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ---------------------------------------------------------------------------- prevention (notices, digests)
class PreventionStateBody(BaseModel):
    state: str


def _prevention_payload(run_id):
    p = db.get_prevention(run_id)
    if not p:
        return {"built": False}
    states = {f"{kind}:{key}": v for (kind, key), v in db.prevention_states(run_id).items()}
    return {"built": True, **p, "states": states}


def _prevention_item(run_id, kind, key):
    item = prevention.find(db.get_prevention(run_id), kind, key)
    if item is None:
        raise HTTPException(404, "No such notice or digest in this run.")
    return item


def _prevention_state(run_id, kind, key):
    return (db.prevention_states(run_id).get((kind, key)) or {}).get("state", "pending")


@app.get("/api/runs/{run_id}/prevention", dependencies=api)
def api_prevention(run_id: str):
    _run_or_404(run_id)
    return _prevention_payload(run_id)


@app.post("/api/runs/{run_id}/prevention/build", dependencies=api)
def api_prevention_build(run_id: str):
    run = _run_or_404(run_id)
    if run["status"] != "done":
        raise HTTPException(409, "Wait for the run to finish before building notices and digests.")
    try:
        prevention.build(run_id, get_manager())
    except prevention.Unavailable as e:
        raise HTTPException(422, str(e))
    return _prevention_payload(run_id)


@app.put("/api/runs/{run_id}/prevention/{kind}/{key}", dependencies=api)
def api_prevention_set_state(run_id: str, kind: str, key: str, body: PreventionStateBody):
    _run_or_404(run_id)
    _prevention_item(run_id, kind, key)
    if body.state not in prevention.STATES:
        raise HTTPException(422, f"state must be one of: {', '.join(prevention.STATES)}")
    if _prevention_state(run_id, kind, key) == "sent":
        raise HTTPException(409, "This was already sent.")
    db.set_prevention_state(run_id, kind, key, body.state)
    return _prevention_payload(run_id)


@app.post("/api/runs/{run_id}/prevention/{kind}/{key}/send", dependencies=api)
def api_prevention_send(run_id: str, kind: str, key: str):
    """Recipient, subject and body come from the stored build, never from the request, and are checked again here."""
    run = _run_or_404(run_id)
    item = _prevention_item(run_id, kind, key)
    st = _prevention_state(run_id, kind, key)
    if st == "sent":
        raise HTTPException(409, "This was already sent.")
    if st != "approved":
        raise HTTPException(409, "Approve it before sending.")
    runner._proto_on_path()
    if kind == "notice":
        import notices
        store = get_manager().store_for(run["dataset_path"])
        fresh = {x["vendor_id"]: x for x in notices.build(store)["notices"]} if store else {}
        if (fresh.get(key) or {}).get("text") != item["text"]:
            raise HTTPException(409, "The records changed since this notice was drafted. Build again, then review it.")
        to, subject = item["to"], "Your invoices with Orchestra: current status"
    else:
        import egress_guard
        allowed = [b["tranId"] for b in item["bills"]] + [str(t) for b in item["bills"] for t in b["ticket_ids"]]
        if not item["sendable"] or egress_guard.check_internal(item["text"], allowed):
            raise HTTPException(409, "This digest has no approver on record or failed the internal check, so it can't be sent.")
        to, subject = item["act_by"], f"Approvals waiting on you ({len(item['bills'])})"
    msg = mailer.Message(sender=mailer.default_sender(None), to=to, subject=subject, body=item["text"],
                         headers={"X-Conductor-Prevention": f"{kind}:{key}"})
    try:
        info = mailer.get_mailer().send(msg)
    except mailer.MailError as e:
        raise HTTPException(502, str(e))
    db.save_prevention_sent(run_id, kind, key, info.get("id"))
    return _prevention_payload(run_id)


# ---------------------------------------------------------------------------- feature routers (chat, scheduled send, prevention)
app.include_router(chat.router, dependencies=api)
app.include_router(scheduler.router, dependencies=api)
app.include_router(prevention.router, dependencies=api)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--open", action="store_true", help="open the app in the default browser")
    a = ap.parse_args()
    import uvicorn
    get_manager()
    scheduler.start(emit=get_manager().emit)
    url = f"http://127.0.0.1:{a.port}/"
    print(f"Conductor running at {url}  (local only; Ctrl+C to stop)", flush=True)
    if a.open:
        import webbrowser
        webbrowser.open(url)
    uvicorn.run(app, host="127.0.0.1", port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
