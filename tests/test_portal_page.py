"""Portal page: Conductor styling, static allowlist, security headers, and unchanged PortalLogic. No Ollama."""
import http.client
import sys
import tempfile
import threading
import unittest
from http.server import HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

import importlib.util  # noqa: E402

# Loaded by path under a unique name: the portal's server.py and Conductor's server.py share a file name.
_spec = importlib.util.spec_from_file_location("vendor_portal_server", ROOT / "dashboards" / "vendor_portal" / "server.py")
portal_server = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(portal_server)  # also puts the portal folder on sys.path, so its page module is importable
portal_page = portal_server.page
from data_layer import FileBackend, Store  # noqa: E402


class PageTests(unittest.TestCase):
    def test_ports_differ_and_loopback(self):
        self.assertEqual(portal_server.HOST, "127.0.0.1")
        self.assertEqual(portal_server.PORT, 8791)
        self.assertNotEqual(portal_server.PORT, 8790)

    def test_render_signature_and_steps(self):
        step1 = portal_server.render()
        self.assertIn("Send me a code", step1)
        self.assertNotIn('name="code"', step1)
        step2 = portal_server.render("Hi <b>", "a@b.example", "INV-1", ask_code=True)
        self.assertIn('name="code"', step2)
        self.assertIn("Show status", step2)
        self.assertIn("Hi &lt;b&gt;", step2)

    def test_page_is_vendor_facing_and_uses_static_css(self):
        page = portal_server.render()
        self.assertIn('href="/static/portal.css"', page)
        self.assertNotIn("<style", page)
        self.assertIn('name="viewport"', page)
        self.assertIn("brand-mark", page)
        self.assertNotIn("nav-link", page)

    def test_css_uses_tokens_and_fonts(self):
        css = portal_page.css()
        self.assertIn("--ink:", css)
        self.assertIn("@font-face", css)
        for needle in ("var(--font-display)", "var(--font-sans)", "var(--bg)", "var(--accent-tint)", "padding: 14px 16px", "box-sizing: border-box"):
            self.assertIn(needle, css)

    def test_every_font_in_css_is_allowlisted_and_exists(self):
        for path, f in portal_page.FONTS.items():
            self.assertTrue(f.is_file(), f)
            self.assertIn(path, portal_page.css())


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        logic = portal_server.PortalLogic(Store(FileBackend(ROOT / "data")), Path(cls.tmp.name) / "log.jsonl", printer=lambda *_: None)
        cls.srv = HTTPServer(("127.0.0.1", 0), portal_server.make_handler(logic))
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def get(self, path):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", path)
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, body

    def assert_secure(self, h):
        self.assertEqual(h["cache-control"], "no-store")
        self.assertEqual(h["x-content-type-options"], "nosniff")
        self.assertEqual(h["referrer-policy"], "no-referrer")
        csp = h["content-security-policy"]
        for part in ("default-src 'self'", "style-src 'self'", "font-src 'self'", "form-action 'self'", "frame-ancestors 'none'"):
            self.assertIn(part, csp)

    def test_page_css_font_headers(self):
        st, h, body = self.get("/")
        self.assertEqual(st, 200)
        self.assertTrue(h["content-type"].startswith("text/html"))
        self.assert_secure(h)
        st, h, body = self.get("/static/portal.css")
        self.assertEqual(st, 200)
        self.assertTrue(h["content-type"].startswith("text/css"))
        self.assertIn(b"--ink", body)
        self.assert_secure(h)
        st, h, body = self.get("/static/fonts/geist-latin-wght-normal.woff2")
        self.assertEqual(st, 200)
        self.assertEqual(h["content-type"], "font/woff2")
        self.assertEqual(body[:4], b"wOF2")
        self.assert_secure(h)

    def test_unknown_and_traversal_paths_404(self):
        paths = ["/nope", "/static", "/static/", "/static/portal.css/x", "/static/fonts/", "/static/fonts/LICENSE-geist.txt",
                 "/static/fonts/geist-mono-latin-wght-normal.woff2", "/static/../../data/vendors.csv",
                 "/static/fonts/../../data/vendors.csv", "/static/fonts/%2e%2e/%2e%2e/data/vendors.csv",
                 "/static/fonts/..%2f..%2fdata%2fvendors.csv", "/static/fonts/..\\..\\data\\vendors.csv",
                 "/static/fonts/nope.woff2?x=geist-latin-wght-normal.woff2", "/../dashboards/vendor_portal/server.py", "//etc/passwd"]
        for p in paths:
            st, h, body = self.get(p)
            self.assertEqual(st, 404, p)
            self.assertNotIn(b"vendor", body.lower(), p)
            self.assert_secure(h)

    def test_post_to_other_path_404(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("POST", "/nope", body="a=b", headers={"Content-Type": "application/x-www-form-urlencoded"})
        r = c.getresponse()
        r.read()
        self.assertEqual(r.status, 404)
        self.assertEqual(r.getheader("Referrer-Policy"), "no-referrer")
        c.close()

    def test_post_flow_same_answer_for_unknown_email(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("POST", "/status", body="email=nobody%40nowhere.example&invoice=INV-1",
                  headers={"Content-Type": "application/x-www-form-urlencoded"})
        r = c.getresponse()
        body = r.read().decode()
        self.assertEqual(r.status, 200)
        self.assertIn("a 6-digit code has been sent", body)
        self.assertIn('name="code"', body)
        c.close()


class LogicUnchangedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = [1000.0]
        self.printed = []
        self.logic = portal_server.PortalLogic(Store(FileBackend(ROOT / "data")), Path(self.tmp.name) / "log.jsonl",
                                               now=lambda: self.t[0], printer=self.printed.append)

    def tearDown(self):
        self.tmp.cleanup()

    def test_unknown_email_same_answer_and_no_code(self):
        r = self.logic.request_code("x@y.example", "INV-1", "1.1.1.1")
        self.assertEqual(r, {"ok": True, "message": portal_server.SENT, "step": "code"})
        self.assertEqual(self.printed, [])
        bad = self.logic.check("x@y.example", "INV-1", "000000", "1.1.1.1")
        self.assertEqual(bad["message"], "That code is not valid or has expired.")
        self.assertEqual(bad["step"], "code")

    def test_rate_limit_per_email(self):
        res = [self.logic.request_code("x@y.example", "INV-1", "2.2.2.2")["ok"] for _ in range(portal_server.PER_EMAIL + 1)]
        self.assertEqual(res, [True] * portal_server.PER_EMAIL + [False])
        self.assertEqual(self.logic.request_code("x@y.example", "INV-1", "2.2.2.2")["message"], "Too many requests. Please try again later.")


if __name__ == "__main__":
    unittest.main()
