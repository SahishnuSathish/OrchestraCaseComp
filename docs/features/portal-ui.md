# Vendor portal page

A self-serve status page for vendors, styled like Conductor. It runs at `http://127.0.0.1:8791`, next to Conductor on `8790`.

## What changed
- Markup and CSS only, plus static routes. `PortalLogic` and `status_service` are untouched.
- Same two steps: email and invoice, then the 6-digit code. Same messages, same rate limits, same answer for unknown addresses.
- Ink top bar with the baton logo and wordmark. No navigation, no staff names, no ticket ids.
- Instrument Serif for the heading, Geist for text. Colours and radii come from `webapp/static/css/tokens.css`.
- Phone width: 16px side gutter, `box-sizing: border-box`, inputs capped at 100% width. No horizontal scroll at 360px.

## Routes
| Path | Response |
| --- | --- |
| `GET /` | The page |
| `GET /static/portal.css` | `tokens.css` + `fonts.css` + portal rules |
| `GET /static/fonts/<name>.woff2` | One of six allowlisted font files, `font/woff2` |
| `POST /status` | Step one or step two |
| anything else | 404 |

Fonts are looked up in a fixed dict of path to absolute file. No request text becomes a file path, so `..`, `%2e%2e`, backslashes and unknown names all return 404.

## Headers (every response, including 404)
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Content-Security-Policy: default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'`.

## Files
`prototype/portal_page.py` (markup, CSS, allowlist, headers), `prototype/portal_server.py` (handler, `PortalLogic`), `tests/test_portal_page.py`.
