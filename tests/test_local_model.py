"""Tests for the local-model settings, status, streaming test call and run recording (webapp/local_model.py).

Uses tests/fake_ollama.py (a protocol stand-in, no inference). Run from the repo root:
    python -m unittest tests.test_local_model -v
"""
import http.client
import json
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "webapp"))
sys.path.insert(0, str(ROOT / "prototype"))
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT))

import db  # noqa: E402

_TMP = tempfile.TemporaryDirectory()
db.STATE_DIR = Path(_TMP.name)          # never touch the real webapp/state/app.db
db.DB_PATH = db.STATE_DIR / "app.db"
db.init()

import local_model  # noqa: E402
import runner  # noqa: E402
import server  # noqa: E402
import summarize  # noqa: E402
from fake_ollama import FakeOllama  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

DATA = ROOT / "data"
A, B = "qwen3.5:9b", "llama3.2:3b"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def parse_sse(text):
    events = []
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        ev = {}
        for line in block.splitlines():
            k, _, v = line.partition(": ")
            ev[k] = v
        events.append((ev["event"], json.loads(ev["data"])))
    return events


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(server.app, base_url="http://localhost")
        cls.h = {"x-ap-token": server.TOKEN}
        cls.fake = FakeOllama(models=[A, B]).start()

    @classmethod
    def tearDownClass(cls):
        cls.fake.stop()

    def setUp(self):
        db.delete_setting(local_model.SETTING_KEY)
        local_model.invalidate()
        self.fake.fail, self.fake.first_token_delay, self.fake.token_delay = None, 0.0, 0.0
        self.fake.models[:] = [A, B]
        self.fake.reset()

    tearDown = setUp

    def put(self, **body):
        return self.c.put("/api/settings/model", json=body, headers=self.h)

    def point_at_fake(self, model=A):
        r = self.put(url=self.fake.url, model=model)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def stream_events(self, text="Where is INV-123? mail me at pat@acme.example", **body):
        r = self.c.post("/api/model/test", json={"text": text, **body}, headers=self.h)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.headers["content-type"].startswith("text/event-stream"))
        return parse_sse(r.text)

    def chat_models(self):
        return [q["model"] for q in self.fake.requests if q["path"] == "/api/chat"]


class ConfigTests(Base):
    def test_precedence_default_saved_cleared(self):
        c = local_model.get_config()
        self.assertEqual(c["source"]["url"], "default")
        self.assertEqual((c["url"], c["model"], c["timeout_s"]), ("http://127.0.0.1:11434", "qwen3.5:9b", 120))
        local_model.set_config(url="http://127.0.0.1:9999/", model=B, timeout_s=30)
        c = local_model.get_config()
        self.assertEqual((c["url"], c["model"], c["timeout_s"]), ("http://127.0.0.1:9999", B, 30))
        self.assertEqual(set(c["source"].values()), {"saved"})
        self.assertEqual(db.get_setting("model"), {"url": "http://127.0.0.1:9999", "model": B, "timeout_s": 30})
        sig = local_model.config_signature()
        local_model.set_config(model=None)
        self.assertEqual(local_model.get_config()["source"]["model"], "default")
        self.assertEqual(local_model.get_config()["url"], "http://127.0.0.1:9999")
        self.assertNotEqual(sig, local_model.config_signature())
        local_model.set_config(url=None, timeout_s=None)
        self.assertIsNone(db.get_setting("model"))

    def test_env_beats_default_but_not_saved(self):
        with mock.patch.object(local_model.extract_model, "MODEL", "env-model:1b"):
            c = local_model.get_config()
            self.assertEqual((c["model"], c["source"]["model"]), ("env-model:1b", "env"))
            local_model.set_config(model=B)
            self.assertEqual(local_model.get_config()["source"]["model"], "saved")

    def test_settings_endpoint_shape(self):
        d = self.c.get("/api/settings", headers=self.h).json()
        self.assertEqual(d["model"]["defaults"], {"url": "http://127.0.0.1:11434", "model": "qwen3.5:9b", "timeout_s": 120})
        self.assertIn(d["mail"]["mode"], ("simulated", "smtp"))

    def test_put_rejects_bad_values_and_stores_nothing(self):
        for url in ("http://example.com:11434", "https://api.openai.com", "ftp://127.0.0.1", "127.0.0.1:11434", "http://"):
            r = self.put(url=url)
            self.assertEqual(r.status_code, 400, url)
            self.assertTrue(r.json()["detail"])
        self.assertIn("Ticket text is never sent anywhere else", self.put(url="http://example.com").json()["detail"])
        for body in ({"model": ""}, {"model": "bad name!"}, {"model": "x" * 121}, {"timeout_s": 4}, {"timeout_s": 601}):
            self.assertEqual(self.put(**body).status_code, 400, body)
        self.assertEqual(self.put(timeout_s=True).status_code, 400)
        self.assertIsNone(db.get_setting("model"))
        self.assertEqual(local_model.get_config()["source"]["url"], "default")

    def test_put_accepts_local_and_returns_settings_and_status(self):
        d = self.point_at_fake(B)
        self.assertEqual(d["settings"]["model"]["url"], self.fake.url)
        self.assertEqual(d["settings"]["model"]["source"]["url"], "saved")
        self.assertEqual(d["status"]["state"], "ready")
        self.assertEqual(d["status"]["model"], B)
        self.assertEqual(self.put(timeout_s=45).json()["settings"]["model"]["timeout_s"], 45)
        d = self.put(url=None, model=None, timeout_s=None).json()
        self.assertEqual(d["settings"]["model"]["source"], {"url": "default", "model": "default", "timeout_s": "default"})

    def test_health(self):
        self.assertEqual(self.c.get("/api/health", headers=self.h).json(), {"ok": True})
        self.assertEqual(self.c.get("/api/health").status_code, 401)


class StatusTests(Base):
    def status(self, force=True):
        return self.c.get("/api/model/status", params={"force": force}, headers=self.h).json()

    def test_ready_and_models_shape(self):
        self.point_at_fake(A)
        s = self.status()
        self.assertEqual((s["state"], s["usable"], s["reachable"], s["installed"], s["local"]), ("ready", True, True, True, True))
        self.assertEqual(s["version"], "0.0.0-fake")
        self.assertEqual([m["name"] for m in s["models"]], [A, B])
        self.assertEqual(set(s["models"][0]), {"name", "size_bytes", "parameter_size", "family", "quantization", "modified_at"})
        self.assertEqual(s["models"][0]["quantization"], "Q4_K_M")
        self.assertEqual(s["host"], self.fake.url.replace("http://", ""))
        self.assertIsNone(s["error"])
        self.assertEqual(s["briefs_pending"], 0)
        self.assertIn("checked_at", s)

    def test_name_without_tag_matches_latest(self):
        self.fake.models[:] = ["tiny:latest"]
        self.point_at_fake("tiny")
        self.assertEqual(self.status()["state"], "ready")

    def test_model_missing(self):
        self.point_at_fake("nope:1b")
        s = self.status()
        self.assertEqual((s["state"], s["usable"], s["reachable"], s["installed"]), ("model_missing", False, True, False))
        self.assertIn("ollama pull nope:1b", s["error"])
        self.assertEqual(len(s["models"]), 2)

    def test_no_models(self):
        self.fake.models[:] = []
        self.point_at_fake(A)
        s = self.status()
        self.assertEqual((s["state"], s["usable"], s["reachable"]), ("no_models", False, True))
        self.assertEqual(s["models"], [])

    def test_unreachable(self):
        self.put(url=f"http://127.0.0.1:{free_port()}")
        s = self.status()
        self.assertEqual((s["state"], s["usable"], s["reachable"], s["models"]), ("unreachable", False, False, []))
        self.assertIn("Nothing is answering at 127.0.0.1:", s["error"])
        self.assertIn("Start Ollama", s["error"])

    def test_not_local_is_never_contacted(self):
        db.set_setting("model", {"url": "http://example.com:11434"})   # as if it came from a hand-edited env var
        local_model.invalidate()
        with mock.patch("urllib.request.urlopen", side_effect=AssertionError("contacted")), \
                mock.patch("http.client.HTTPConnection", side_effect=AssertionError("contacted")):
            s = self.status()
            ev = self.stream_events()
        self.assertEqual((s["state"], s["usable"], s["local"], s["reachable"]), ("not_local", False, False, False))
        self.assertEqual(ev, [("error", {"kind": "not_local", "message": local_model.NOT_LOCAL_MSG})])
        self.assertEqual(self.fake.requests, [])

    def test_status_is_cached_five_seconds_unless_forced(self):
        self.point_at_fake(A)
        with mock.patch.object(local_model, "_probe", wraps=local_model._probe) as p:
            self.status(force=True)
            self.status(force=False)
            self.assertEqual(p.call_count, 1)
            self.status(force=True)
            self.assertEqual(p.call_count, 2)


class ModelSelectionTests(Base):
    def view(self):
        from data_layer import FileBackend, Store
        from ticket_view import build_view
        be = FileBackend(str(DATA))
        t = be.list_tickets()[0]
        return build_view(t, lambda uid: be.user(uid)), Store(be)

    def facts(self):
        return summarize.build_facts({"ticket_id": 1, "stages": [], "model": None, "advisory": None, "plan": {}, "trace": [],
                                      "result": {"ticket_id": 1, "output_type": "draft_reply", "recipient": "a@b.example", "reason_tag": None,
                                                 "priority": False, "flags": [], "text": "Hi"},
                                      "decision": {"rule": "paid", "why": "ok", "act_by": None}}, {"subject": "Hello INV-1"})

    def test_selected_model_is_the_one_used_everywhere(self):
        self.point_at_fake(B)
        view, _ = self.view()
        for chosen in (B, A):
            if chosen == A:
                self.put(model=A)
            self.fake.reset()
            ev = self.stream_events()                                        # (a) the Settings test call
            self.assertEqual(ev[0][1]["model"], chosen)
            self.assertEqual(self.chat_models(), [chosen])
            self.fake.reset()
            reading, info = local_model.make_extractor().read(view)         # (b) the pipeline reader
            self.assertIsNotNone(reading)
            self.assertEqual(info["model"], chosen)
            self.assertEqual(self.chat_models(), [chosen])
            self.fake.reset()
            summ = local_model.make_summarizer()                            # (c) the brief writer
            summ.summarize(self.facts())
            self.assertEqual(self.chat_models(), [chosen])

    def test_test_call_can_try_a_model_without_selecting_it(self):
        self.point_at_fake(A)
        ev = self.stream_events(model=B)
        self.assertEqual(ev[0][1]["model"], B)
        self.assertEqual(local_model.get_config()["model"], A)

    def test_brief_worker_rebuilds_its_summarizer_when_the_model_changes(self):
        self.point_at_fake(A)
        m = runner.Manager()
        w = m.briefs
        s1 = w._summarizer()
        self.assertIs(s1, w._summarizer())
        self.put(model=B)
        s2 = w._summarizer()
        self.assertIsNot(s1, s2)
        self.assertEqual(s2.model, B)
        custom = runner.Manager(summarizer_factory=lambda: "custom")
        self.assertEqual(custom.briefs._summarizer(), "custom")
        self.put(model=A)
        self.assertEqual(custom.briefs._summarizer(), "custom")

    def start_run(self, **kw):
        r = self.c.post("/api/runs", json={"path": str(DATA), "limit": 3, **kw}, headers=self.h)
        self.assertEqual(r.status_code, 200, r.text)
        rid = r.json()["run_id"]
        for _ in range(240):
            run = self.c.get(f"/api/runs/{rid}", headers=self.h).json()
            if run["status"] in ("done", "failed", "cancelled"):
                break
            time.sleep(0.25)
        # The run row says "done" a moment before its worker thread finishes: that thread still checks whether the
        # model is usable and, if so, queues the background brief upgrade. Wait for it, so a test that points the app
        # at the fake model AFTER this returns cannot race that check.
        live = server.get_manager().live.get(rid)
        for _ in range(240):
            if live is None or live.finished:
                break
            time.sleep(0.05)
        return rid, run

    def drain_briefs(self):
        for _ in range(240):
            if not server.get_manager().briefs.pending_count():
                return
            time.sleep(0.25)

    def test_run_records_and_uses_the_selected_model(self):
        import cache
        import gate
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)

        class TmpCache(cache.CachedExtractor):          # never write into the tracked out/.cache
            def __init__(self, inner, cache_dir=tmp.name):
                super().__init__(inner, cache_dir)

        self.point_at_fake(B)
        with mock.patch.object(cache, "CachedExtractor", TmpCache), \
                mock.patch.object(gate.GatedExtractor, "would_skip", lambda self, v: False):
            rid, run = self.start_run(use_model=True)
            self.drain_briefs()
        self.assertEqual(run["status"], "done", run)
        self.assertEqual(run["model"], B)
        self.assertTrue(run["use_model"])
        self.assertEqual(run["warnings"], [])
        self.assertTrue(self.chat_models())
        self.assertEqual(set(self.chat_models()), {B})
        self.assertEqual(self.c.get(f"/api/runs/{rid}", headers=self.h).json()["model"], B)
        listed = next(r for r in self.c.get("/api/runs", headers=self.h).json()["runs"] if r["id"] == rid)
        self.assertEqual((listed["model"], listed["warnings"]), (B, []))


class WarningAndDeleteTests(Base):
    def start_run(self, **kw):
        return ModelSelectionTests.start_run(self, **kw)

    def test_unusable_model_warning_is_persisted(self):
        self.put(url=f"http://127.0.0.1:{free_port()}")
        rid, run = self.start_run(use_model=True)
        self.assertEqual(run["status"], "done")
        self.assertIsNone(run["model"])
        self.assertFalse(run["use_model"])
        self.assertEqual(len(run["warnings"]), 1)
        self.assertIn("requested but was not available", run["warnings"][0])
        self.assertEqual(db.get_run(rid)["warnings"], run["warnings"])      # survives, not just an SSE event
        rid2, run2 = self.start_run(use_model=False)
        self.assertEqual((run2["warnings"], run2["model"]), ([], None))

    def test_delete_run(self):
        self.assertEqual(self.c.delete("/api/runs/nosuchrun", headers=self.h).status_code, 404)
        rid, run = self.start_run(use_model=False)
        self.c.put(f"/api/runs/{rid}/review/{db.list_rows(rid)[0]['ticket_id']}", json={"state": "pending"}, headers=self.h)
        db.save_draft(rid, db.list_rows(rid)[0]["ticket_id"], "edited", None)
        self.assertGreater(db.count_tickets(rid), 0)
        self.assertEqual(self.c.delete(f"/api/runs/{rid}").status_code, 401)
        r = self.c.delete(f"/api/runs/{rid}", headers=self.h)
        self.assertEqual((r.status_code, r.json()), (200, {"deleted": True}))
        self.assertIsNone(db.get_run(rid))
        self.assertEqual(db.count_tickets(rid), 0)
        self.assertEqual(db.list_rows(rid), [])
        self.assertEqual(db.review_states(rid), {})
        self.assertEqual(db.brief_sources(rid), {})
        self.assertEqual(self.c.get(f"/api/runs/{rid}", headers=self.h).status_code, 404)

    def test_delete_refused_while_running(self):
        m = server.get_manager()
        live = m.ensure_live("abcd1234")
        db.create_run("abcd1234", DATA, "run", False, None, 5, status="running")
        try:
            self.assertEqual(self.c.delete("/api/runs/abcd1234", headers=self.h).status_code, 409)
            self.assertIsNotNone(db.get_run("abcd1234"))
            live.finished = True
            self.assertEqual(self.c.delete("/api/runs/abcd1234", headers=self.h).status_code, 200)
        finally:
            db.delete_run("abcd1234")

    def test_runs_limit_and_payload_fields(self):
        r = self.c.get("/api/runs", params={"limit": 1}, headers=self.h).json()
        self.assertLessEqual(len(r["runs"]), 1)
        for run in self.c.get("/api/runs", headers=self.h).json()["runs"]:
            self.assertIn("model", run)
            self.assertIsInstance(run["warnings"], list)

    def test_db_migration_adds_columns(self):
        import sqlite3
        d = Path(tempfile.mkdtemp())
        con = sqlite3.connect(d / "app.db")
        con.execute("CREATE TABLE runs (id TEXT PRIMARY KEY, created_at REAL, dataset_path TEXT, source TEXT, use_model INTEGER,"
                    " limit_n INTEGER, status TEXT, total INTEGER, done INTEGER, error TEXT, label TEXT, started_at REAL, finished_at REAL)")
        con.commit()
        con.close()
        old = db.STATE_DIR, db.DB_PATH
        try:
            db.STATE_DIR, db.DB_PATH = d, d / "app.db"
            db.init()
            db.create_run("r1", "x", "run", True, None, 1, model="m", warnings=["w"])
            self.assertEqual((db.get_run("r1")["model"], db.get_run("r1")["warnings"]), ("m", ["w"]))
        finally:
            db.STATE_DIR, db.DB_PATH = old


class StreamTests(Base):
    def test_events_in_order(self):
        self.point_at_fake(A)
        ev = self.stream_events("Where is INV-123? mail me at pat@acme.example acct 1234567890123")
        kinds = [k for k, _ in ev]
        self.assertEqual(kinds[0], "start")
        self.assertEqual(kinds[-1], "done")
        self.assertGreater(kinds.count("token"), 3)
        self.assertEqual(kinds.count("done") + kinds.count("error"), 1)
        start, done = ev[0][1], ev[-1][1]
        self.assertEqual(start["model"], A)
        self.assertIn("[email]", start["sent"])
        self.assertNotIn("pat@acme.example", start["sent"])
        self.assertIn("[number withheld]", start["sent"])
        self.assertNotIn("1234567890123", start["sent"])
        self.assertEqual("".join(d["text"] for k, d in ev if k == "token"), done["raw"])
        self.assertEqual(done["reading"]["intent"], "status_request")
        self.assertEqual(done["reading"]["invoice_refs"], ["INV-123"])
        self.assertIsNone(done["problem"])
        self.assertGreaterEqual(done["tokens"], 1)
        self.assertIn("ms", done)
        sent_to_fake = [q for q in self.fake.requests if q["path"] == "/api/chat"]
        self.assertTrue(sent_to_fake[0]["stream"])

    def test_garbage_output_gives_done_with_a_problem(self):
        self.point_at_fake(A)
        self.fake.fail = "garbage"
        ev = self.stream_events()
        self.assertEqual(ev[-1][0], "done")
        self.assertIsNone(ev[-1][1]["reading"])
        self.assertIn("did not match", ev[-1][1]["problem"])
        self.assertTrue(ev[-1][1]["raw"])

    def test_unknown_model_is_model_missing(self):
        self.point_at_fake(A)
        ev = self.stream_events(model="ghost:7b")
        self.assertEqual(ev[-1][0], "error")
        self.assertEqual(ev[-1][1]["kind"], "model_missing")
        self.assertIn("ollama pull ghost:7b", ev[-1][1]["message"])

    def test_http_error_kind(self):
        self.point_at_fake(A)
        self.fake.fail = "http500"
        ev = self.stream_events()
        self.assertEqual((ev[-1][0], ev[-1][1]["kind"]), ("error", "http"))

    def test_closed_port_is_unreachable(self):
        self.put(url=f"http://127.0.0.1:{free_port()}")
        ev = self.stream_events()
        self.assertEqual((ev[-1][0], ev[-1][1]["kind"]), ("error", "unreachable"))

    def test_timeout_kind(self):
        self.point_at_fake(A)
        self.fake.first_token_delay = 3
        cfg = local_model.get_config()
        with mock.patch.object(local_model, "get_config", return_value=dict(cfg, timeout_s=1)):
            ev = list(local_model.stream_reading("hello"))
        self.assertEqual((ev[-1][0], ev[-1][1]["kind"]), ("error", "timeout"))

    def test_body_validation_is_plain_json_4xx(self):
        for body in ({"text": ""}, {"text": "x" * 8001}, {}, {"text": "hi", "model": "bad name"}):
            r = self.c.post("/api/model/test", json=body, headers=self.h)
            self.assertEqual(r.status_code, 422, body)
            self.assertTrue(r.headers["content-type"].startswith("application/json"))
        self.assertEqual(self.c.post("/api/model/test", json={"text": "hi"}).status_code, 401)


class CancelTests(Base):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        import uvicorn
        cfg = uvicorn.Config(server.app, host="127.0.0.1", port=0, log_level="error")
        cls.uv = uvicorn.Server(cfg)
        cls.thread = threading.Thread(target=cls.uv.run, daemon=True)
        cls.thread.start()
        for _ in range(100):
            if cls.uv.started:
                break
            time.sleep(0.05)
        cls.port = cls.uv.servers[0].sockets[0].getsockname()[1]

    @classmethod
    def tearDownClass(cls):
        cls.uv.should_exit = True
        cls.thread.join(5)
        super().tearDownClass()

    def wait_aborted(self, limit=2.0):
        t0 = time.time()
        while time.time() - t0 < limit:
            reqs = [q for q in self.fake.requests if q["path"] == "/api/chat"]
            if reqs and reqs[-1]["aborted"]:
                return time.time() - t0
            time.sleep(0.05)
        self.fail(f"upstream request was not aborted within {limit}s: {self.fake.requests}")

    def open_stream(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("POST", "/api/model/test", json.dumps({"text": "Where is INV-9?"}),
                     {"Content-Type": "application/json", "x-ap-token": server.TOKEN})
        return conn, conn.getresponse()

    def test_disconnect_while_waiting_for_the_first_token(self):
        self.point_at_fake(A)
        self.fake.first_token_delay = 5
        conn, resp = self.open_stream()
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.getheader("X-Accel-Buffering"), "no")
        seen = b""
        while b"event: start" not in seen:                              # start arrives while the model is still silent
            seen += resp.fp.readline()
        time.sleep(0.3)
        t0 = time.time()
        conn.sock.shutdown(socket.SHUT_RDWR)
        conn.close()
        self.wait_aborted(2.0)
        self.assertLess(time.time() - t0, 2.0)

    def test_disconnect_mid_stream(self):
        self.point_at_fake(A)
        self.fake.token_delay = 0.2
        conn, resp = self.open_stream()
        seen = b""
        while seen.count(b"event: token") < 2:
            seen += resp.fp.readline()
        conn.sock.shutdown(socket.SHUT_RDWR)
        conn.close()
        self.wait_aborted(2.0)


if __name__ == "__main__":
    unittest.main()


class BriefQueueTests(unittest.TestCase):
    """Asking to rewrite one ticket's brief must not wait behind the background upgrade of a whole run."""

    def test_explicit_rewrite_jumps_ahead_of_background_upgrades(self):
        order = []
        done = threading.Event()
        gate, started = threading.Event(), threading.Event()

        class Recorder(runner.BriefWorker):
            def _one(self, run_id, tid, force):
                started.set()
                gate.wait(5)          # hold the first item so the rest are queued behind it
                order.append((tid, force))
                if len(order) == 5:
                    done.set()

        w = Recorder(runner.Manager(summarizer_factory=lambda: None))
        self.assertTrue(w.enqueue("r", 1))
        self.assertTrue(started.wait(5))                     # ticket 1 is now running, held at the gate
        for tid in (2, 3, 4):
            self.assertTrue(w.enqueue("r", tid))             # background upgrade of a run
        self.assertTrue(w.enqueue("r", 4, force=True))      # the person rewrites ticket 4, already queued
        gate.set()
        self.assertTrue(done.wait(5))
        # ticket 1 was already running; the forced rewrite of 4 goes before 2 and 3
        self.assertEqual([t for t, _ in order[:2]], [1, 4])
        self.assertTrue(order[1][1])


class FailedRewriteTests(Base):
    """A rewrite that the validator rejects must not turn a valid model-written brief into a 'template' one."""

    def start_run(self, **kw):
        # No usable model may exist while the run finishes, or its worker queues a background brief upgrade. With
        # nothing configured the app falls back to 127.0.0.1:11434, which is a real, working Ollama on a developer
        # machine (and nothing at all in a CI container). Point at a model the fake server does not have instead.
        self.point_at_fake("not-installed:1b")
        return ModelSelectionTests.start_run(self, **kw)

    def test_rejected_rewrite_keeps_the_existing_model_brief(self):
        rid, _ = self.start_run(use_model=False, limit=2)      # model not configured yet: no background upgrade
        tid = db.list_rows(rid)[0]["ticket_id"]
        self.point_at_fake()
        self.fake.fail = "garbage"                              # the model answers, but not in a usable form
        mgr = server.get_manager()
        rec = db.get_ticket(rid, tid)
        h = summarize.facts_hash(mgr.facts_for(rid, rec))
        good = [{"label": "Issue", "text": "Model-written issue."}, {"label": "Sources", "text": "x"},
                {"label": "Reply", "text": "y"}, {"label": "Next", "text": "z"}]
        db.save_brief(rid, tid, h, good, "model", {"model": A})
        events = []
        mgr.emit = lambda run_id, kind, data=None: events.append((kind, data))   # capture instead of streaming
        try:
            mgr.briefs._one(rid, tid, True)
        finally:
            del mgr.emit
        cur = db.get_brief(rid, tid)
        self.assertEqual(cur["source"], "model")                    # still labelled for what it is
        self.assertEqual(cur["bullets"], good)                      # and the text is untouched
        kind, data = events[-1]
        self.assertEqual((kind, data["source"], data["kept"]), ("brief", "model", True))
        self.assertTrue(data["error"])

    def test_rejected_first_rewrite_stores_records_only_bullets(self):
        rid, _ = self.start_run(use_model=False, limit=2)
        tid = db.list_rows(rid)[0]["ticket_id"]
        self.point_at_fake()
        self.fake.fail = "garbage"
        mgr = server.get_manager()
        before = db.get_brief(rid, tid)
        self.assertEqual(before["source"], "template")
        mgr.briefs._one(rid, tid, True)
        after = db.get_brief(rid, tid)
        self.assertEqual(after["source"], "template")
        self.assertEqual(after["bullets"], before["bullets"])      # deterministic, from the facts


class ModelStatesTests(Base):
    """A run has three model states. Regex + model; regex reader with the model still allowed to reword briefs;
    and strictly model-free, where the model is not used for anything even though it is up."""

    def start_run(self, **kw):
        return ModelSelectionTests.start_run(self, **kw)

    def drain_briefs(self):
        return ModelSelectionTests.drain_briefs(self)

    def sources(self, rid):
        return set(db.brief_sources(rid).values())

    def test_regex_only_run_still_lets_the_model_reword_briefs(self):
        self.point_at_fake()
        rid, run = self.start_run(use_model=False, limit=2)
        self.drain_briefs()
        self.assertFalse(run["use_model"])
        self.assertFalse(run["model_free"])
        self.assertEqual(self.sources(rid), {"model"})            # briefs were upgraded by the model
        self.assertTrue(self.chat_models())                       # and it was only used for briefs

    def test_model_free_run_never_touches_the_model(self):
        self.point_at_fake()                                      # the model is up and usable
        rid, run = self.start_run(model_free=True, limit=2)
        self.drain_briefs()
        self.assertEqual((run["status"], run["use_model"], run["model_free"], run["model"]), ("done", False, True, None))
        self.assertEqual(self.sources(rid), {"template"})
        self.assertEqual(self.fake.requests, [])                  # no chat call, no embedding, nothing
        tid = db.list_rows(rid)[0]["ticket_id"]
        r = self.c.post(f"/api/runs/{rid}/tickets/{tid}/brief", headers=self.h)
        self.assertEqual(r.status_code, 409, r.text)              # a rewrite is refused ...
        r = self.c.post(f"/api/runs/{rid}/briefs/upgrade", headers=self.h)
        self.assertEqual((r.status_code, r.json()["queued"]), (200, 0))   # ... and so is a bulk upgrade
        self.assertFalse(server.get_manager().briefs.enqueue(rid, tid, force=True))
        self.assertEqual(self.sources(rid), {"template"})
        self.assertEqual(self.fake.requests, [])
        self.assertTrue(self.c.get(f"/api/runs/{rid}", headers=self.h).json()["model_free"])

    def test_model_free_cannot_be_combined_with_the_model_reader(self):
        r = self.c.post("/api/runs", json={"path": str(DATA), "limit": 1, "use_model": True, "model_free": True}, headers=self.h)
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("model-free", r.json()["detail"])

    def test_old_runs_read_as_not_model_free(self):
        self.point_at_fake("not-installed:1b")
        rid, run = self.start_run(use_model=False, limit=1)
        db.update_run(rid, model_free=None)                       # a row from before the column existed
        self.assertFalse(self.c.get(f"/api/runs/{rid}", headers=self.h).json()["model_free"])
