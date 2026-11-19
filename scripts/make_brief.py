"""Builds docs/pipeline_brief.pdf: pipeline diagram + reasoning, under 3/4 of one page.
Run: python scripts/make_brief.py   (needs reportlab). Numbers come from out/ runs, set in METRICS below.
"""
import json
import sys
from pathlib import Path

from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import simpleSplit
from reportlab.pdfgen import canvas

HERE = Path(__file__).resolve().parent
METRICS = json.load(open(HERE / "metrics.json")) if (HERE / "metrics.json").exists() else {}

W, H = letter
M = 38
INK, MUTED = HexColor("#1F2937"), HexColor("#6B7280")
CODE = (HexColor("#EAF0F7"), HexColor("#3B5B7A"))
MODEL = (HexColor("#FFF3D9"), HexColor("#B7791F"))
HUMAN = (HexColor("#E4F4E8"), HexColor("#2F7D4A"))
NOTE = (HexColor("#F7F7F8"), HexColor("#9CA3AF"))

STAGES = [
    # (title, files, text, kind)
    ("1 Intake", "ticket_view.py", "Zendesk ticket in. Keeps end-user text only; agent replies dropped.", CODE),
    ("2 Sender", "resolve.py", "Vendor contact, employee or unknown? Authorized?", CODE),
    ("3 Regex read", "extract_regex.py, cues.py, validator.py", "Invoice refs, vendor hints, intent and risk cues from keyword families.", CODE),
    ("4 Local model read", "extract_model.py", "qwen3.5:9b via Ollama on this machine. Redacted text in, JSON out.", MODEL),
    ("5 Pre-checks", "prechecks.py, cues.py", "Fraud, injection, no-reply, machine notice, misrouted. Ends the ticket early.", CODE),
    ("6 Lookup plan", "planner.py", "Picks the platforms needed. The model may add a Zendesk lookup, never remove one.", MODEL),
    ("7 Lookups", "resolve.py, data_layer.py, linked.py, trace.py", "Exact-key, read-only calls to NetSuite, payments, Zendesk. Every call traced.", CODE),
    ("8 Rules engine", "rules.py", "README order of checks and record-state table. Produces the decision.", CODE),
    ("9 Drafter", "drafts.py", "Reply, internal note or no-draft from templates. Facts come from records.", CODE),
    ("10 Draft check", "draft_check.py", "Rejects bank numbers, dates not in records, wrong 'paid' wording. Fail = internal note.", CODE),
    ("11 Human review", "results.json, bundles.json", "A person approves every output. Nothing is ever sent by the pipeline.", HUMAN),
]


def box(c, x, y, w, h, kind, title, files, text):
    fill, edge = kind
    c.setFillColor(fill)
    c.setStrokeColor(edge)
    c.setLineWidth(0.9)
    c.roundRect(x, y, w, h, 4, fill=1, stroke=1)
    c.setFillColor(edge)
    c.setFont("Helvetica-Bold", 7.6)
    c.drawString(x + 6, y + h - 11, title)
    c.setFillColor(MUTED)
    c.setFont("Courier", 5.6)
    for i, ln in enumerate(simpleSplit(files, "Courier", 5.6, w - 12)[:2]):
        c.drawString(x + 6, y + h - 20 - i * 6.6, ln)
    c.setFillColor(INK)
    c.setFont("Helvetica", 6.4)
    ty = y + h - 20 - 6.6 * len(simpleSplit(files, "Courier", 5.6, w - 12)[:2]) - 3.5
    for i, ln in enumerate(simpleSplit(text, "Helvetica", 6.4, w - 12)[:4]):
        c.drawString(x + 6, ty - i * 7.6, ln)


def arrow(c, x1, y1, x2, y2, color=HexColor("#6B7280"), dash=False):
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(0.9)
    c.setDash(2, 2) if dash else c.setDash()
    c.line(x1, y1, x2, y2)
    c.setDash()
    dx, dy = x2 - x1, y2 - y1
    n = (dx * dx + dy * dy) ** 0.5 or 1
    ux, uy = dx / n, dy / n
    p = c.beginPath()
    p.moveTo(x2, y2)
    p.lineTo(x2 - 5 * ux + 2.6 * uy, y2 - 5 * uy - 2.6 * ux)
    p.lineTo(x2 - 5 * ux - 2.6 * uy, y2 - 5 * uy + 2.6 * ux)
    p.close()
    c.drawPath(p, fill=1, stroke=0)


def para(c, x, y, w, text, font="Helvetica", size=7.8, lead=9.8, color=INK):
    c.setFillColor(color)
    c.setFont(font, size)
    for ln in simpleSplit(text, font, size, w):
        c.drawString(x, y, ln)
        y -= lead
    return y


def main(out):
    c = canvas.Canvas(str(out), pagesize=letter)
    c.setTitle("Where's my payment? pipeline brief")
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 13)
    y = H - M - 6
    c.drawString(M, y, "Where's my payment? Pipeline with a local model")
    c.setFont("Helvetica", 7.6)
    c.setFillColor(MUTED)
    c.drawString(M, y - 12, "Blue = deterministic code. Amber = local model involved. Green = human. Each box lists the files that own the stage.")

    # snake layout
    gap, bw, bh, rgap = 20, 0, 60, 26
    bh3 = 72
    bw = (W - 2 * M - 3 * gap) / 4
    xs = [M + i * (bw + gap) for i in range(4)]
    top = y - 24
    rows_y = [top - bh, top - bh - rgap - bh, top - 2 * (bh + rgap) - bh3]
    pos = {}
    for i in range(4):
        pos[i] = (xs[i], rows_y[0])
    for i in range(4):
        pos[4 + i] = (xs[3 - i], rows_y[1])
    for i in range(3):
        pos[8 + i] = (xs[i], rows_y[2])
    for i, (t, f, d, k) in enumerate(STAGES):
        box(c, *pos[i], bw, (bh3 if i >= 8 else bh), k, t, f, d)
    # arrows
    for i in range(10):
        (xa, ya), (xb, yb) = pos[i], pos[i + 1]
        if ya == yb:
            if xb > xa:
                arrow(c, xa + bw, ya + bh / 2, xb, yb + bh / 2)
            else:
                arrow(c, xa, ya + bh / 2, xb + bw, yb + bh / 2)
        else:
            arrow(c, xa + bw / 2, ya, xb + bw / 2, yb + (bh3 if i + 1 >= 8 else bh))
    # label: model can only add caution
    c.setFillColor(MODEL[1])
    c.setFont("Helvetica-Oblique", 6.2)
    c.drawRightString(pos[4][0] + bw / 2 - 5, rows_y[0] - rgap / 2 - 2, "model adds caution only")
    # shortcut arrow: pre-checks stop early -> drafter
    c.setFillColor(CODE[1])
    c.drawString(pos[6][0] + 4, rows_y[1] - 9, "")
    # metrics box in slot 4 of row 3
    mx, my = xs[3], rows_y[2]
    c.setFillColor(NOTE[0])
    c.setStrokeColor(NOTE[1])
    c.setLineWidth(0.9)
    c.roundRect(mx, my, bw, bh3, 4, fill=1, stroke=1)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 7.2)
    c.drawString(mx + 6, my + bh3 - 11, "Measured on this machine")
    lines = METRICS.get("lines", ["(run the evals to fill this in)"])
    yy = my + bh3 - 20
    c.setFont("Helvetica", 6.2)
    for ln in lines:
        for s in simpleSplit(ln, "Helvetica", 6.2, bw - 12):
            c.drawString(mx + 6, yy, s)
            yy -= 7.1

    # reasoning
    y = rows_y[2] - 22
    c.setStrokeColor(HexColor("#D1D5DB"))
    c.line(M, y + 6, W - M, y + 6)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 9.5)
    c.drawString(M, y - 6, "Why it is built this way")
    y -= 19
    why = METRICS.get("why", [])
    colw = W - 2 * M
    for head, body in why:
        c.setFont("Helvetica-Bold", 7.8)
        c.setFillColor(INK)
        hw = c.stringWidth(head + "  ", "Helvetica-Bold", 7.8)
        lines = simpleSplit(" " * 0 + body, "Helvetica", 7.8, colw - hw)
        first = lines[0] if lines else ""
        # first line sits beside the bold lead-in; rest wrap at full width
        rest_text = body[len(first):].strip()
        c.drawString(M, y, head)
        c.setFont("Helvetica", 7.8)
        c.drawString(M + hw, y, first)
        y -= 9.8
        for ln in simpleSplit(rest_text, "Helvetica", 7.8, colw):
            c.drawString(M, y, ln)
            y -= 9.8
        y -= 2.6
    used = (H - y) / H
    c.showPage()
    c.save()
    print(f"content ends {used:.0%} of the way down the page")
    return used


if __name__ == "__main__":
    u = main(HERE.parent / "docs" / "pipeline_brief.pdf")
    sys.exit(0 if u <= 0.75 else "over 3/4 page")
