"""Markup and CSS for the vendor status portal. Pure functions: no sockets, no records, no model calls.

The CSS is built from Conductor's own token and font files (webapp/static/css) plus the portal rules below, and is
served from one fixed route so the page can use a strict style-src. Fonts are served from a fixed allowlist.
"""
import html
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "webapp" / "static"
CSS_PATH = "/static/portal.css"
FONT_PREFIX = "/static/fonts/"
FONT_NAMES = (
    "geist-latin-wght-normal.woff2", "geist-latin-ext-wght-normal.woff2",
    "instrument-serif-latin-400-normal.woff2", "instrument-serif-latin-ext-400-normal.woff2",
    "instrument-serif-latin-400-italic.woff2", "instrument-serif-latin-ext-400-italic.woff2",
)
FONTS = {FONT_PREFIX + n: STATIC / "fonts" / n for n in FONT_NAMES}  # path -> absolute file; nothing else is served

SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; "
                               "form-action 'self'; frame-ancestors 'none'",
}

LOGO = ('<svg class="brand-mark" viewBox="0 0 32 32" width="30" height="30" role="img" aria-label="Conductor" focusable="false">'
        '<rect width="32" height="32" rx="9" fill="#34e0bd"/>'
        '<path d="M25.4 14.6A8.6 8.6 0 0 1 17.6 24.4" fill="none" stroke="#052019" stroke-opacity=".38" stroke-width="1.7" stroke-linecap="round"/>'
        '<polygon points="10,19.6 12.4,22 24.3,8.7 23.3,7.7" fill="#052019"/>'
        '<circle cx="23.8" cy="8.2" r=".7" fill="#052019"/>'
        '<circle cx="9.6" cy="22.4" r="2.8" fill="#052019"/></svg>')

PORTAL_CSS = """
/* ---- portal ---- */
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; min-height: 100dvh; background: var(--bg); color: var(--text); font-family: var(--font-sans); font-size: var(--fs-lg); line-height: 1.5; overflow-wrap: anywhere; }
.topbar { background: var(--ink); color: var(--rail-text); }
.topbar-in { max-width: 34rem; margin: 0 auto; padding: 14px 16px; display: flex; align-items: center; gap: 10px; }
.brand-mark { width: 30px; height: 30px; flex: none; }
.brand-text { font-family: var(--font-display); font-style: italic; font-weight: 400; font-size: 28px; line-height: 1; letter-spacing: -0.01em; color: var(--wordmark); }
main { max-width: 34rem; margin: 0 auto; padding: var(--s-6) 16px var(--s-7); }
h1 { font-family: var(--font-display); font-weight: 400; font-size: var(--fs-display-sm); line-height: 1.1; letter-spacing: -0.01em; margin: 0 0 var(--s-2); }
.fine { margin: 0 0 var(--s-5); font-size: var(--fs-sm); color: var(--text-3); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); padding: var(--s-5); max-width: 100%; }
.msg { padding: var(--s-3); background: var(--accent-tint); border: 1px solid var(--accent-border); color: var(--accent-ink); border-radius: var(--r-md); margin: 0 0 var(--s-4); }
label { display: block; font-size: var(--fs-md); font-weight: 500; color: var(--text-2); margin: 0 0 var(--s-4); }
.input { display: block; width: 100%; max-width: 100%; min-height: 44px; margin-top: var(--s-1); padding: 0 var(--s-3); background: var(--surface); border: 1px solid var(--input-border); border-radius: var(--r-md); font: inherit; color: var(--text); }
.input:focus-visible { outline: none; border-color: var(--accent); box-shadow: var(--shadow-focus); }
.btn { display: inline-flex; align-items: center; justify-content: center; width: 100%; min-height: 44px; padding: 0 var(--s-5); background: var(--ink); color: var(--on-ink); border: 1px solid var(--ink); border-radius: var(--r-md); font: inherit; font-weight: 500; cursor: pointer; transition: background-color var(--t-hover) ease, transform var(--t-press) var(--ease-out); }
.btn:active { transform: scale(0.97); background: var(--ink-press); }
@media (hover: hover) and (pointer: fine) { .btn:hover { background: var(--ink-hover); border-color: var(--ink-hover); } }
.btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
@media (max-width: 480px) { main { padding-top: var(--s-5); } .card { padding: var(--s-4); } }
@media (prefers-reduced-motion: reduce) { .btn { transition: none; } }
"""


def _read(rel):
    try:
        return (STATIC / rel).read_text(encoding="utf-8")
    except OSError:
        return ""


def css():
    """Conductor tokens, Conductor font-face rules, then the portal rules."""
    return _read("css/tokens.css") + "\n" + _read("css/fonts.css") + "\n" + PORTAL_CSS


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice status (demo)</title>
<link rel="stylesheet" href="{css}"></head><body>
<header class="topbar"><div class="topbar-in">{logo}<span class="brand-text">Conductor</span></div></header>
<main><h1>Invoice status</h1>
<p class="fine">Demo only. Runs on this computer and shows the records in the mock data.</p>
<div class="card">{msg}<form method="post" action="/status">
<label>Contact email<input class="input" name="email" type="email" autocomplete="email" value="{email}" required></label>
<label>Invoice number<input class="input" name="invoice" value="{invoice}" required maxlength="20"></label>
{code}<button class="btn" type="submit">{button}</button></form></div></main></body></html>"""


def render(message=None, email="", invoice="", ask_code=False):
    msg = f'<div class="msg" role="status">{html.escape(message)}</div>' if message else ""
    code = ('<label>6-digit code<input class="input" name="code" inputmode="numeric" autocomplete="one-time-code" '
            'maxlength="6" required></label>') if ask_code else ""
    return PAGE.format(css=CSS_PATH, logo=LOGO, msg=msg, email=html.escape(email), invoice=html.escape(invoice),
                       code=code, button="Show status" if ask_code else "Send me a code")
