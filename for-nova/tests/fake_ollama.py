"""TEST STAND-IN for Ollama. It performs NO inference.

A small threaded HTTP server bound to 127.0.0.1 that speaks just enough of Ollama's protocol (/api/version,
/api/tags, /api/chat with and without streaming, HTTP 404 for an unknown model) for the AP Desk tests and for
checking the UI by hand. The "model output" is canned: a valid ModelReading built from the request text, or a
plausible brief built from the facts packet. Never use it for anything but tests and manual UI checks.

In a test:
    srv = FakeOllama(models=["qwen3.5:9b", "llama3.2:3b"], token_delay=0.01); srv.start()
    srv.url -> "http://127.0.0.1:<port>";  srv.requests -> list of {"path","model","stream","aborted","t"};  srv.stop()

From the command line:
    python tests/fake_ollama.py --port 11434 --models qwen3.5:9b,llama3.2:3b --token-delay 0.03 --first-token-delay 0
    --fail http500|garbage exercises failure states.  GET /__requests lists the log, POST /__reset clears it.
"""
import argparse
import json
import re
import select
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_INV = re.compile(r"\bINV-\d+\b", re.I)


def _reading(user_text):
    return {"intent": "status_request", "invoice_refs": list(dict.fromkeys(_INV.findall(user_text))),
            "vendor_names": [], "mentioned_ticket_ids": [], "risk_cues": [], "asks_about_multiple_invoices": False,
            "needs_platforms": [], "safety": "safe", "safety_reason": ""}


def _brief(user_text):
    try:
        p = json.loads(user_text)
    except ValueError:
        p = {}
    refs = ", ".join(p.get("invoice_refs") or []) or "an invoice"
    vendor = p.get("vendor") or "The requester"
    systems = ", ".join(s.get("system", "") for s in p.get("systems_consulted") or []) or "no systems"
    nxt = ((p.get("next_action") or {}).get("label")) or "Review the draft."
    return {"issue": f"{vendor} asked about {refs}.",
            "sources": f"Checked {systems}. Retrieval: {(p.get('retrieval') or {}).get('status') or 'complete'}.",
            "reply": "A draft reply is ready for review." if p.get("output_type") == "draft_reply" else "No reply goes to the requester.",
            "next": nxt, "watch": ""}


class FakeOllama:
    def __init__(self, models=("qwen3.5:9b",), first_token_delay=0.0, token_delay=0.0, fail=None, host="127.0.0.1", port=0):
        self.models = list(models)
        self.first_token_delay, self.token_delay, self.fail = first_token_delay, token_delay, fail
        self.requests = []
        self._lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def _json(self, code, obj):
                data = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path == "/api/version":
                    return self._json(200, {"version": "0.0.0-fake"})
                if self.path == "/api/tags":
                    return self._json(200, {"models": [
                        {"name": m, "model": m, "size": 1_000_000_000 + i, "modified_at": "2026-11-01T10:00:00Z",
                         "details": {"family": m.split(":")[0], "parameter_size": "9B", "quantization_level": "Q4_K_M"}}
                        for i, m in enumerate(outer.models)]})
                if self.path == "/__requests":
                    with outer._lock:
                        return self._json(200, {"requests": list(outer.requests)})
                self._json(404, {"error": "not found"})

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                if self.path == "/__reset":
                    with outer._lock:
                        outer.requests.clear()
                    return self._json(200, {"ok": True})
                if self.path != "/api/chat":
                    return self._json(404, {"error": "not found"})
                try:
                    body = json.loads(raw or b"{}")
                except ValueError:
                    return self._json(400, {"error": "invalid json"})
                rec = {"path": self.path, "model": body.get("model"), "stream": bool(body.get("stream")), "aborted": False,
                       "t": time.time()}
                with outer._lock:
                    outer.requests.append(rec)
                if body.get("model") not in outer.models:
                    return self._json(404, {"error": f"model '{body.get('model')}' not found"})
                if outer.fail == "http500":
                    return self._json(500, {"error": "fake server failure"})
                content = outer._content(body)
                if not rec["stream"]:
                    if not self._wait(outer.first_token_delay, rec):
                        return
                    return self._json(200, {"model": body["model"], "message": {"role": "assistant", "content": content},
                                            "done": True, "eval_count": max(1, len(content) // 4)})
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                chunks = [content[i:i + 6] for i in range(0, len(content), 6)] or [""]
                try:
                    if not self._wait(outer.first_token_delay, rec):
                        return
                    for c in chunks:
                        self._line({"model": body["model"], "message": {"role": "assistant", "content": c}, "done": False})
                        if not self._wait(outer.token_delay, rec):
                            return
                    self._line({"model": body["model"], "done": True, "eval_count": len(chunks),
                                "message": {"role": "assistant", "content": ""}})
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionError, OSError):
                    self._abort(rec)

            def _line(self, obj):
                data = (json.dumps(obj) + "\n").encode()
                self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                self.wfile.flush()

            def _abort(self, rec):
                with outer._lock:
                    rec["aborted"] = True
                self.close_connection = True

            def _wait(self, seconds, rec):
                """Sleep, but notice a client that has hung up. False means it did (and the request is marked aborted)."""
                end = time.time() + seconds
                while True:
                    left = end - time.time()
                    if left <= 0:
                        return True
                    r, _, _ = select.select([self.connection], [], [], min(left, 0.05))
                    if r:
                        try:
                            if self.connection.recv(1, socket.MSG_PEEK) == b"":
                                self._abort(rec)
                                return False
                        except OSError:
                            self._abort(rec)
                            return False

        self.httpd = ThreadingHTTPServer((host, port), Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self._thread = None

    def _content(self, body):
        if self.fail == "garbage":
            return "this is not json {"
        props = ((body.get("format") or {}).get("properties")) or {}
        user = next((m.get("content", "") for m in reversed(body.get("messages") or []) if m.get("role") == "user"), "")
        if "intent" in props:
            return json.dumps(_reading(user))
        if "issue" in props:
            return json.dumps(_brief(user))
        return "{}"

    def start(self):
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True, name="fake-ollama")
        self._thread.start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def reset(self):
        with self._lock:
            self.requests.clear()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=11434)
    ap.add_argument("--models", default="qwen3.5:9b,llama3.2:3b")
    ap.add_argument("--token-delay", type=float, default=0.03)
    ap.add_argument("--first-token-delay", type=float, default=0.0)
    ap.add_argument("--fail", choices=["http500", "garbage"], default=None)
    a = ap.parse_args()
    srv = FakeOllama([m for m in a.models.split(",") if m], a.first_token_delay, a.token_delay, a.fail, port=a.port)
    print(f"FAKE Ollama (test stand-in, no inference) on {srv.url}", flush=True)
    try:
        srv.httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
