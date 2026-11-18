"""Dataset validation, the threaded pipeline run, run import, and the background brief worker.

Everything here wraps the prototype; none of it edits it. The run loop mirrors `run_all.run` (build a
Store over a FileBackend, call `pipeline.process_ticket` per ticket) but publishes an event after every ticket
so the UI can stream results and the employee can start reviewing while the run continues.
"""
import csv
import inspect
import itertools
import json
import queue
import re
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

import db
import local_model
import summarize

FOR_NOVA = Path(__file__).resolve().parents[1]
PROTO = FOR_NOVA / "prototype"
DEFAULT_DATASET = FOR_NOVA / "data"

REQUIRED = ["tickets.json", "vendors.csv", "employees.csv", "vendor_bills.csv", "bill_payments.csv", "payment_runs.csv"]
OPTIONAL = ["linked_tickets.json", "answer_key.json"]


def _proto_on_path():
    for p in (str(PROTO), str(FOR_NOVA)):
        if p not in sys.path:
            sys.path.insert(0, p)


# ---------------------------------------------------------------------------- dataset
def _csv_rows(path):
    with open(path, encoding="utf-8", newline="") as f:
        return max(0, sum(1 for _ in csv.reader(f)) - 1)


def validate_dataset(path):
    """Check a directory looks like a dataset the pipeline can read. Never raises for a bad path."""
    out = {"path": str(path), "exists": False, "ok": False, "files": [], "tickets": 0, "has_answer_key": False}
    try:
        p = Path(path).expanduser()
        out["path"] = str(p)
        if not p.is_dir():
            out["error"] = "That path is not a folder."
            return out
    except (OSError, ValueError):
        out["error"] = "That path is not valid."
        return out
    out["exists"] = True
    ok = True
    for name in REQUIRED + OPTIONAL:
        f = p / name
        required = name in REQUIRED
        entry = {"name": name, "required": required}
        if not f.is_file():
            entry.update(status="missing" if required else "absent", detail="Not found" if required else "Optional, not found")
            ok = ok and not required
        else:
            try:
                if name.endswith(".csv"):
                    entry.update(status="ok", detail=f"{_csv_rows(f):,} rows")
                else:
                    with open(f, encoding="utf-8") as fh:
                        d = json.load(fh)
                    if name == "tickets.json":
                        tickets = d["tickets"] if isinstance(d, dict) else d
                        out["tickets"] = len(tickets)
                        entry.update(status="ok", detail=f"{len(tickets):,} tickets")
                    elif name == "answer_key.json":
                        out["has_answer_key"] = True
                        entry.update(status="ok", detail=f"{len(d):,} expected results")
                    else:
                        n = len(d.get("tickets", d)) if isinstance(d, (dict, list)) else 0
                        entry.update(status="ok", detail=f"{n:,} tickets")
            except Exception as e:  # unreadable or malformed file
                entry.update(status="error", detail=f"Could not read: {str(e)[:80]}")
                ok = ok and not required
        out["files"].append(entry)
    out["ok"] = ok and out["tickets"] > 0
    if not out["ok"] and "error" not in out:
        out["error"] = "This folder is missing files the pipeline needs." if not ok else "No tickets found."
    return out


def list_importable():
    """Existing result sets on disk (for-nova/out/*/bundles.json) so the UI can open one without re-running."""
    found = []
    for b in sorted((FOR_NOVA / "out").glob("*/bundles.json")):
        try:
            found.append({"path": str(b), "name": b.parent.name, "modified": b.stat().st_mtime,
                          "size_kb": round(b.stat().st_size / 1024)})
        except OSError:
            continue
    return found


# ---------------------------------------------------------------------------- model status
def model_status(force=False):
    return local_model.status(force=force)


# ---------------------------------------------------------------------------- per-ticket shaping
def ticket_context(ticket, user_fn):
    """Everything the UI shows from the original ticket (the bundle does not carry it)."""
    _proto_on_path()
    ctx = {"id": ticket.get("id"), "subject": ticket.get("subject"), "body": ticket.get("description"),
           "sender_name": None, "sender_email": None, "received_at": ticket.get("created_at"), "cc": [],
           "attachments": [], "linked_ticket_ids": [], "to": None, "status": ticket.get("status")}
    try:
        from ticket_view import build_view
        v = build_view(ticket, user_fn)
        ctx.update(body=v.body or ticket.get("description"), sender_name=v.sender_name, sender_email=v.sender_email,
                   attachments=list(v.attachments), linked_ticket_ids=list(v.linked_ticket_ids or []))
        for uid in v.cc_user_ids or []:
            u = user_fn(uid) or {}
            ctx["cc"].append({"name": u.get("name"), "email": u.get("email"), "role": u.get("role")})
    except Exception:
        src = ((ticket.get("via") or {}).get("source") or {})
        ctx["sender_name"] = (src.get("from") or {}).get("name")
        ctx["sender_email"] = (src.get("from") or {}).get("address")
    ctx["to"] = (((ticket.get("via") or {}).get("source") or {}).get("to") or {}).get("address")
    return ctx


def row_from_bundle(bundle, ctx, seq, facts=None):
    res, dec = bundle.get("result", {}), bundle.get("decision", {})
    facts = facts or summarize.build_facts(bundle, ctx)
    return {
        "ticket_id": bundle.get("ticket_id"), "seq": seq, "subject": ctx.get("subject"),
        "sender_name": ctx.get("sender_name"), "sender_email": ctx.get("sender_email"), "vendor": facts["vendor"],
        "intent": facts["intent"], "rule": dec.get("rule"), "why": dec.get("why"), "act_by": dec.get("act_by"),
        "output_type": res.get("output_type"), "reason_tag": res.get("reason_tag"),
        "priority": bool(res.get("priority")), "flags": list(res.get("flags") or []), "recipient": res.get("recipient"),
        "ms": bundle.get("ms"), "api_calls": bundle.get("api_calls"),
        "model_used": bool(((bundle.get("model") or {}).get("notes") or {}).get("used")),
        "error": bundle.get("error"),
    }


def error_bundle(ticket_id, exc):
    """A crashed ticket becomes an internal note for a person (the README counts withholding an answer as a
    violation). The exception stays in `error` and `decision.why`, which are staff-only; `result.text` never has it."""
    _proto_on_path()
    try:
        from orchestrator import crash_bundle
        return crash_bundle(ticket_id, exc)
    except Exception:
        text = ("The assistant could not process this ticket automatically (internal error). "
                "A person should review it from the original email.")
        return {"ticket_id": ticket_id, "stages": [], "model": None, "trace": [], "api_calls": 0, "ms": 0,
                "error": f"{type(exc).__name__}: {str(exc)[:160]}",
                "result": {"ticket_id": ticket_id, "output_type": "internal_action_note", "recipient": None,
                           "reason_tag": None, "priority": False, "flags": [], "text": text},
                "decision": {"rule": "pipeline_error", "why": f"{type(exc).__name__}: {str(exc)[:160]}", "act_by": None}}


def _takes_arg(fn):
    try:
        return len(inspect.signature(fn).parameters) >= 1
    except (TypeError, ValueError):
        return False


# ---------------------------------------------------------------------------- live runs + events
class LiveRun:
    def __init__(self, run_id):
        self.id = run_id
        self.events = []
        self.cond = threading.Condition()
        self.cancel = threading.Event()
        self.finished = False

    def emit(self, kind, data=None):
        with self.cond:
            self.events.append({"i": len(self.events), "type": kind, "data": data or {}})
            self.cond.notify_all()


class Manager:
    def __init__(self, summarizer_factory=None, extractor_factory=None):
        self.live = {}
        self.lock = threading.Lock()
        self.briefs = BriefWorker(self)
        self.custom_summarizer = summarizer_factory is not None
        self.summarizer_factory = summarizer_factory or local_model.make_summarizer
        self.extractor_factory = extractor_factory
        self._stores = {}
        self._stores_lock = threading.Lock()

    # -- events
    def ensure_live(self, run_id):
        with self.lock:
            if run_id not in self.live:
                self.live[run_id] = LiveRun(run_id)
            return self.live[run_id]

    def emit(self, run_id, kind, data=None):
        self.ensure_live(run_id).emit(kind, data)

    def running_run(self):
        for r in db.list_runs(5):
            if r["status"] in ("starting", "running"):
                lr = self.live.get(r["id"])
                if lr and not lr.finished:
                    return r["id"]
        return None

    # -- starting a run
    def start_run(self, dataset_path, use_model=False, limit=None, model_free=False):
        """Three model states. use_model: the pipeline reader runs. Neither flag: the regex reader runs, but the brief
        writer may still reword briefs when the model is up. model_free: no model at all, briefs included."""
        if model_free and use_model:
            raise ValueError("A model-free run cannot also use the model.")
        v = validate_dataset(dataset_path)
        if not v["ok"]:
            raise ValueError(v.get("error") or "Dataset is not valid.")
        if self.running_run():
            raise RuntimeError("A run is already in progress.")
        run_id = uuid.uuid4().hex[:8]
        total = min(v["tickets"], limit) if limit else v["tickets"]
        db.create_run(run_id, v["path"], "run", use_model, limit, total, label=Path(v["path"]).name, model_free=model_free)
        live = self.ensure_live(run_id)
        t = threading.Thread(target=self._work, args=(live, v["path"], use_model, limit, model_free), daemon=True, name=f"run-{run_id}")
        t.start()
        return run_id

    def _work(self, live, path, use_model, limit, model_free=False):
        run_id = live.id
        try:
            _proto_on_path()
            from data_layer import FileBackend, Store
            from pipeline import process_ticket
            backend = FileBackend(path)
            store = Store(backend)
            extractor = None
            used_model = False
            model_name = None
            if use_model:
                st = model_status(force=True)
                if st["usable"]:
                    try:
                        factory = self.extractor_factory or _default_extractor
                        extractor = factory(store) if _takes_arg(factory) else factory()
                        used_model = True
                        model_name = st["model"]
                    except Exception as e:
                        self._warn(live, f"Could not start the local model: {e}")
                else:
                    self._warn(live, "The local model was requested but was not available, so this run used the regex reader only.")
            tickets = backend.list_tickets()
            if limit:
                tickets = tickets[:limit]
            db.update_run(run_id, status="running", total=len(tickets), use_model=int(used_model), model=model_name, started_at=time.time())
            live.emit("start", {"total": len(tickets), "use_model": used_model})
            t_run = time.perf_counter()
            for n, t in enumerate(tickets, 1):
                if live.cancel.is_set():
                    db.update_run(run_id, status="cancelled", done=n - 1, finished_at=time.time())
                    live.emit("cancelled", {"done": n - 1})
                    return
                live.emit("working", {"ticket_id": t.get("id"), "subject": t.get("subject"), "n": n})
                ctx = ticket_context(t, lambda uid: backend.user(uid))
                try:
                    bundle = process_ticket(t, store, extractor)
                except Exception as e:  # one bad ticket must not stop the run
                    traceback.print_exc()
                    bundle = error_bundle(t.get("id"), e)
                self._store_ticket(run_id, n, bundle, ctx, t, store)
                elapsed = time.perf_counter() - t_run
                db.update_run(run_id, done=n)
                live.emit("ticket", {"row": db.get_ticket(run_id, bundle["ticket_id"])["row"], "done": n, "total": len(tickets),
                                     "elapsed": round(elapsed, 1)})
            db.update_run(run_id, status="done", finished_at=time.time())
            # Finished the moment the record says done: the model check below can take seconds (a refused localhost
            # connection on Windows), and a "done" run must not look busy to delete_run or running_run meanwhile.
            live.finished = True
            live.emit("done", {"done": len(tickets), "elapsed": round(time.perf_counter() - t_run, 1)})
            if not model_free and (used_model or model_status()["usable"]):
                self.briefs.enqueue_run(run_id)
        except Exception as e:
            traceback.print_exc()
            db.update_run(run_id, status="failed", error=f"{type(e).__name__}: {e}", finished_at=time.time())
            live.emit("failed", {"message": f"{type(e).__name__}: {e}"})
        finally:
            live.finished = True

    @staticmethod
    def _warn(live, message):
        db.add_run_warning(live.id, message)
        live.emit("warning", {"message": message})

    def delete_run(self, run_id):
        """Forget a run and its tickets, briefs and reviews. Refuses while the run is still being processed."""
        with self.lock:
            live = self.live.get(run_id)
            if live and not live.finished:
                raise RuntimeError("This run is still in progress. Stop it before deleting it.")
            self.live.pop(run_id, None)
        db.delete_run(run_id)

    def _store_ticket(self, run_id, seq, bundle, ctx, ticket=None, store=None):
        facts = summarize.build_facts(bundle, ctx, store=store, raw=ticket)
        row = row_from_bundle(bundle, ctx, seq, facts)
        db.save_ticket(run_id, bundle["ticket_id"], seq, bundle, ctx, row)
        bullets, source, info = summarize.make_brief(facts, None)  # instant, no model: upgraded in the background
        db.save_brief(run_id, bundle["ticket_id"], summarize.facts_hash(facts), bullets, source, info)
        return row

    def store_for(self, dataset_path):
        """A read-only Store per dataset, built once. None if the dataset cannot be read (briefs fall back)."""
        key = str(dataset_path)
        with self._stores_lock:
            if key not in self._stores:
                try:
                    _proto_on_path()
                    from data_layer import FileBackend, Store
                    self._stores[key] = Store(FileBackend(key))
                except Exception:
                    self._stores[key] = None
            return self._stores[key]

    def facts_for(self, run_id, rec):
        """Same facts the ticket was stored with (structured when the dataset is available)."""
        run = db.get_run(run_id) or {}
        store = self.store_for(run.get("dataset_path")) if run.get("dataset_path") else None
        raw = None
        if store is not None:
            try:
                raw = store.backend.ticket(rec["bundle"].get("ticket_id"))
            except Exception:
                raw = None
        return summarize.build_facts(rec["bundle"], rec["ticket"], store=store if raw else None, raw=raw)

    def cancel(self, run_id):
        live = self.live.get(run_id)
        if live and not live.finished:
            live.cancel.set()
            return True
        return False

    # -- importing an existing result set
    def import_run(self, bundles_path, dataset_path=None, label=None):
        _proto_on_path()
        bp = Path(bundles_path)
        if not bp.is_file():
            raise ValueError("bundles.json not found")
        with open(bp, encoding="utf-8") as f:
            bundles = json.load(f)
        if not isinstance(bundles, list) or not bundles:
            raise ValueError("bundles.json is empty or not a list of bundles")
        ds = Path(dataset_path) if dataset_path else DEFAULT_DATASET
        from data_layer import load_tickets_file
        tf = load_tickets_file(ds / "tickets.json")
        by_id = {t["id"]: t for t in tf["tickets"]}
        users = {u["id"]: u for u in tf.get("users", [])}
        run_id = uuid.uuid4().hex[:8]
        used_model = any(b.get("model") for b in bundles)
        model_name = None
        for b in bundles:
            info = (b.get("model") or {}).get("info") or {}
            if info.get("model") and not info.get("gated"):
                model_name = info["model"]
                break
        db.create_run(run_id, ds, "import", used_model, None, len(bundles), label=label or f"{bp.parent.name} (saved)",
                      status="done", model=model_name)
        store = self.store_for(ds)
        for n, b in enumerate(bundles, 1):
            ticket = by_id.get(b.get("ticket_id")) or {"id": b.get("ticket_id"), "subject": f"Ticket {b.get('ticket_id')}"}
            ctx = ticket_context(ticket, lambda uid: users.get(int(uid)))
            self._store_ticket(run_id, n, b, ctx, ticket, store)
        db.update_run(run_id, done=len(bundles), finished_at=time.time())
        self.ensure_live(run_id).finished = True
        if model_status()["usable"]:
            self.briefs.enqueue_run(run_id)
        return run_id


def _default_extractor(store=None):
    """Local model reader for the CURRENT selection. With a store it is wrapped as CachedExtractor(GatedExtractor(...)),
    so runs started from the UI skip the model where regex is confident and re-runs cost nothing."""
    _proto_on_path()
    return local_model.make_extractor(store)


# ---------------------------------------------------------------------------- brief worker
class BriefWorker:
    """One thread, one model call at a time. Upgrades template briefs to local-model briefs in the background."""

    def __init__(self, manager):
        self.m = manager
        self.q = queue.PriorityQueue()   # (priority, order, key, force): explicit rewrites run before background upgrades
        self._order = itertools.count()
        self.pending = set()
        self.lock = threading.Lock()
        self.thread = None
        self._summ = None
        self._summ_sig = None

    @staticmethod
    def _model_free(run_id):
        """A strictly model-free run never gets a model-written brief, whoever asks."""
        run = db.get_run(run_id)
        return bool(run and run.get("model_free"))

    def pending_count(self):
        with self.lock:
            return len(self.pending)

    def _ensure_thread(self):
        with self.lock:
            if not self.thread or not self.thread.is_alive():
                self.thread = threading.Thread(target=self._loop, daemon=True, name="brief-worker")
                self.thread.start()

    def enqueue(self, run_id, ticket_id, force=False):
        if self._model_free(run_id):
            return False
        key = (run_id, int(ticket_id))
        with self.lock:
            if key in self.pending and not force:
                return False
            self.pending.add(key)
        # A person asking to rewrite the ticket in front of them must not wait behind the upgrade of a whole run.
        self.q.put((0 if force else 1, next(self._order), key, force))
        self._ensure_thread()
        return True

    def enqueue_run(self, run_id, only_template=True):
        if self._model_free(run_id):
            return 0
        n = 0
        sources = db.brief_sources(run_id)
        for r in db.list_rows(run_id):
            if only_template and sources.get(r["ticket_id"]) == "model":
                continue
            n += self.enqueue(run_id, r["ticket_id"])
        return n

    def _summarizer(self):
        sig = None if self.m.custom_summarizer else local_model.config_signature()
        if self._summ is None or sig != self._summ_sig:
            self._summ = self.m.summarizer_factory()
            self._summ_sig = sig
        return self._summ

    def _loop(self):
        while True:
            try:
                _, _, (run_id, tid), force = self.q.get(timeout=300)
            except queue.Empty:
                return
            try:
                self._one(run_id, tid, force)
            except Exception:
                traceback.print_exc()
            finally:
                with self.lock:
                    self.pending.discard((run_id, tid))

    def _one(self, run_id, tid, force):
        if self._model_free(run_id):
            return
        rec = db.get_ticket(run_id, tid)
        if not rec:
            return
        facts = self.m.facts_for(run_id, rec)
        h = summarize.facts_hash(facts)
        cur = db.get_brief(run_id, tid)
        if cur and cur["source"] == "model" and cur["bundle_hash"] == h and not force:
            return
        if not model_status()["usable"]:
            self.m.emit(run_id, "brief", {"ticket_id": tid, "source": "template", "error": "model unavailable"})
            return
        bullets, source, info = summarize.make_brief(facts, self._summarizer())
        kept = False
        if source == "model":
            db.save_brief(run_id, tid, h, bullets, "model", info)
        elif cur and cur["source"] == "model" and cur["bundle_hash"] == h:
            kept = True  # this attempt failed, but the model-written brief we already have is still valid: leave it alone
        else:  # the records-only brief for the current facts, and why the model version was not used
            db.save_brief(run_id, tid, h, bullets, "template", info)
        self.m.emit(run_id, "brief", {"ticket_id": tid, "source": "model" if kept else source, "kept": kept,
                                      "error": info.get("error")})
