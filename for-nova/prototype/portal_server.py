"""Demo-only vendor status portal. Standard library, bound to 127.0.0.1:8790, read-only.

Flow: the vendor enters their contact email and an invoice number; a one-time code is "sent" by printing it to
THIS console (a real deployment emails a magic link to the address already on the vendor record, never to an
address the visitor typed); the second step checks the code and calls status_service.lookup_status.
The answer to step one is identical whether or not the email is on file. Rate limited per email and per IP.
The server never writes records, never sends email and never calls a model. The log holds a masked email, the
reference and the outcome state, never message text.
"""
import html
import json
import secrets
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import egress_guard  # noqa: E402
import status_service  # noqa: E402
from data_layer import FileBackend, Store  # noqa: E402
from trace import Trace  # noqa: E402

HOST, PORT = "127.0.0.1", 8790
CODE_TTL, WINDOW, PER_EMAIL, PER_IP = 600, 600, 5, 20
LOG = HERE.parent / "out" / "portal_log.jsonl"
SENT = "If that address is on file, a 6-digit code has been sent to it. Enter it below to see the status."


class PortalLogic:
    """All behaviour without any socket, so it can be tested directly."""

    def __init__(self, store, log_path=LOG, now=time.time, printer=print):
        self.store, self.log_path, self.now, self.printer = store, Path(log_path), now, printer
        self.codes, self.hits = {}, {}

    def _limited(self, key, limit):
        t = self.now()
        recent = [x for x in self.hits.get(key, []) if t - x < WINDOW]
        self.hits[key] = recent
        if len(recent) >= limit:
            return True
        recent.append(t)
        return False

    def _log(self, email, ref, state):
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"t": round(self.now()), "email": egress_guard.mask_email(email), "ref": ref, "state": state}) + "\n")

    def request_code(self, email, ref, ip):
        email = (email or "").strip().lower()
        if self._limited(("ip", ip), PER_IP) or self._limited(("email", email), PER_EMAIL):
            return {"ok": False, "message": "Too many requests. Please try again later.", "step": "code"}
        if self.store.session(Trace()).find_vendor_by_contact(email):
            code = f"{secrets.randbelow(10**6):06d}"
            self.codes[(email, (ref or "").strip())] = (code, self.now() + CODE_TTL)
            self.printer(f"[portal demo] one-time code for {egress_guard.mask_email(email)}: {code}")
        return {"ok": True, "message": SENT, "step": "code"}  # same answer for unknown addresses

    def check(self, email, ref, code, ip):
        email = (email or "").strip().lower()
        if self._limited(("ip", ip), PER_IP) or self._limited(("email", email), PER_EMAIL):
            return {"ok": False, "message": "Too many requests. Please try again later.", "step": "result"}
        entry = self.codes.get((email, (ref or "").strip()))
        if not entry or entry[1] < self.now() or not secrets.compare_digest(entry[0], (code or "").strip()):
            return {"ok": False, "message": "That code is not valid or has expired.", "step": "code"}
        del self.codes[(email, (ref or "").strip())]
        res = status_service.lookup_status(email, ref, self.store)
        self._log(email, ref, res["state"])
        return {"ok": res["ok"], "message": res["message"], "step": "result"}


PAGE = """<!doctype html><meta charset="utf-8"><title>Invoice status (demo)</title>
<style>body{{font:16px/1.5 system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem}}input,button{{font:inherit;padding:.5rem;margin:.25rem 0;width:100%;box-sizing:border-box}}
.msg{{padding:.75rem;background:#eef;border-radius:6px;margin:1rem 0}}small{{color:#555}}</style>
<h1>Invoice status</h1><small>Demo only. Runs on this computer and shows the records in the mock data.</small>
{msg}<form method="post" action="/status">
<label>Contact email<input name="email" value="{email}" required></label>
<label>Invoice number<input name="invoice" value="{invoice}" required maxlength="20"></label>
{code}<button>{button}</button></form>"""


def render(message=None, email="", invoice="", ask_code=False):
    msg = f'<div class="msg">{html.escape(message)}</div>' if message else ""
    code = '<label>6-digit code<input name="code" inputmode="numeric" maxlength="6" required></label>' if ask_code else ""
    return PAGE.format(msg=msg, email=html.escape(email), invoice=html.escape(invoice), code=code,
                       button="Show status" if ask_code else "Send me a code")


def make_handler(logic):
    class H(BaseHTTPRequestHandler):
        def _send(self, body, status=200):
            data = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self._send(render() if self.path == "/" else "Not found", 200 if self.path == "/" else 404)

        def do_POST(self):
            if self.path != "/status":
                return self._send("Not found", 404)
            n = min(int(self.headers.get("Content-Length") or 0), 2000)
            f = {k: v[0] for k, v in parse_qs(self.rfile.read(n).decode("utf-8", "replace")).items()}
            email, inv, code = f.get("email", ""), f.get("invoice", ""), f.get("code")
            ip = self.client_address[0]
            res = logic.check(email, inv, code, ip) if code else logic.request_code(email, inv, ip)
            self._send(render(res["message"], email, inv, ask_code=res["step"] == "code"))

        def log_message(self, *a):  # keep the console for the demo codes
            pass
    return H


def main():
    store = Store(FileBackend(HERE.parent / "data"))
    srv = HTTPServer((HOST, PORT), make_handler(PortalLogic(store)))
    if srv.server_address[0] != "127.0.0.1":
        raise SystemExit("portal must bind to 127.0.0.1 only")
    print(f"Portal demo on http://{HOST}:{PORT}  (codes are printed here)")
    srv.serve_forever()


if __name__ == "__main__":
    main()
