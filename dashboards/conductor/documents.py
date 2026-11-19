"""Invoice copies and remittance advice rendered from records, as HTML and PDF; draft attachments.

Owner: p3/inbox-sync. Contract: docs/phase3/CONTRACTS.md section 8.

Everything on a document comes from the bill, vendor, payment and payment-run records, never from an email. Bank
account, routing and TIN numbers are shown as the last 4 digits at most. A remittance exists only for a Settled or
Released payment, and a returned payment's reference is never shown. Vendors see these documents (through Direct),
so nothing internal (approver, approval notes, failure reasons) is ever put on one.
"""
import datetime as dt
import html
import io
import re
import threading

from fastapi import APIRouter, Depends, HTTPException, Response

import appclock
import db
import identity
import runner

router = APIRouter()
STAFF = ("ap_specialist", "cfo")

KINDS = ("invoice", "remittance")
FORMATS = {"html": "text/html; charset=utf-8", "pdf": "application/pdf"}
PAYER = "Orchestra Accounts Payable"
_ACCOUNT_KEYS = ("bankAccount", "accountNumber", "account", "bank_account", "routingNumber", "routing")

_BACKEND = None
_BACKEND_LOCK = threading.Lock()


class NotAvailable(Exception):
    """The document cannot be produced. `code` is "missing" (no such record, 404) or "unavailable" (not allowed yet, 409)."""

    def __init__(self, message="This document is not available.", code="missing"):
        super().__init__(message)
        self.message = message
        self.code = code


# ---------------------------------------------------------------------------- schema
def init_schema():
    db._exec("CREATE TABLE IF NOT EXISTS draft_attachments ("
             " id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ticket_id INTEGER, kind TEXT, bill_id TEXT,"
             " filename TEXT, added_by TEXT, added_at REAL)")


# ---------------------------------------------------------------------------- masking
def mask_account(value):
    """Last 4 digits at most: '1234567890' -> '••••7890'. Nothing usable -> '••••'."""
    digits = re.sub(r"\D", "", str(value or ""))
    return "••••" + digits[-4:] if len(digits) >= 4 else "••••"


def account_masked(payment):
    """The payment account of a payment record, masked, or None when the record carries no account."""
    for k in _ACCOUNT_KEYS:
        if (payment or {}).get(k):
            return mask_account(payment[k])
    return None


# ---------------------------------------------------------------------------- records
def _backend():
    global _BACKEND
    with _BACKEND_LOCK:
        if _BACKEND is None:
            runner._proto_on_path()
            from data_layer import FileBackend
            _BACKEND = FileBackend(runner.DEFAULT_DATASET)
        return _BACKEND


def _latest_payment(pays):
    return sorted(pays, key=lambda p: (p.get("tranDate") or "", p["internalId"]))[-1] if pays else None


def _load(bill_internal_id):
    """The records a document is made from: {bill, vendor, payment, run, applied}. NotAvailable when the bill is unknown."""
    b = _backend()
    bills = b.query("vendorBill", internalId=str(bill_internal_id))
    if not bills:
        raise NotAvailable("We couldn't find that invoice.", "missing")
    bill = bills[0]
    vendors = b.query("vendor", internalId=str(bill["entity"]))
    pay = _latest_payment(b.payments_applying(bill["internalId"]))
    runs = b.query("paymentRun", bill_internal_id=str(bill["internalId"]))
    run = sorted(runs, key=lambda r: r.get("run_date") or "")[-1] if runs else None
    applied = []
    if pay:
        for bid in dict.fromkeys(pay["appliedBills"].split(";")):
            hit = b.query("vendorBill", internalId=bid)
            if hit:
                applied.append(hit[0])
    return {"bill": bill, "vendor": vendors[0] if vendors else None, "payment": pay, "run": run, "applied": applied}


# ---------------------------------------------------------------------------- content
def _date(iso):
    try:
        d = dt.date.fromisoformat(iso)
    except (TypeError, ValueError):
        return iso or ""
    return f"{d.strftime('%b')} {d.day}, {d.year}"


def _money(amount, currency="USD"):
    try:
        return f"{currency or 'USD'} {float(amount):,.2f}"
    except (TypeError, ValueError):
        return str(amount or "")


def _invoice_doc(r):
    bill, vendor = r["bill"], r["vendor"] or {}
    meta = [("Invoice number", bill["tranId"]), ("Invoice date", _date(bill.get("tranDate"))),
            ("Due date", _date(bill.get("dueDate")))]
    if vendor.get("terms"):
        meta.append(("Terms", vendor["terms"]))
    if bill.get("poNumber"):
        meta.append(("PO number", bill["poNumber"]))
    return {
        "kind": "invoice", "title": "Invoice copy", "number": bill["tranId"],
        "intro": "A copy of the invoice as recorded in Orchestra's accounts payable system.",
        "parties": [("Billed to", [bill.get("subsidiary") or PAYER]), ("From", [vendor.get("companyName") or bill.get("entityName")])],
        "meta": meta,
        "lines": [(bill.get("memo") or "Services", _money(bill.get("userTotal"), bill.get("currency")))],
        "total": ("Invoice total", _money(bill.get("userTotal"), bill.get("currency"))),
        "notes": ["Generated from accounting records on " + _date(appclock.today().isoformat()) + "."],
    }


def _remittance_doc(r):
    bill, vendor, pay = r["bill"], r["vendor"] or {}, r["payment"]
    if not pay:
        raise NotAvailable("There is no payment on record for this invoice, so there is no remittance advice.", "unavailable")
    status = pay.get("custbody_release_status")
    if status not in ("Settled", "Released"):  # Returned (or anything unknown): no remittance, and never its reference
        raise NotAvailable("Remittance advice is available only for payments that have been released or settled.", "unavailable")
    if status == "Settled":
        when = ("Settled", pay.get("custbody_settled_date") or pay.get("tranDate"))
    else:
        when = ("Released", pay.get("custbody_released_date") or pay.get("tranDate"))
    acct = account_masked(pay)
    method = pay.get("paymentMethod") or ""
    meta = [("Payment number", pay["tranId"]), ("Payment date", _date(pay.get("tranDate"))),
            (when[0] + " on", _date(when[1])), ("Method", method),
            ("Reference", pay.get("referenceNumber") or ""), ("Paid to bank account", acct or "")]
    lines = [(f"Invoice {b['tranId']}" + (f" - {b['memo']}" if b.get("memo") else ""), _money(b.get("userTotal"), b.get("currency")))
             for b in (r["applied"] or [bill])]
    notes = [] if acct else [f"Paid by {method or 'bank transfer'} to the bank account on file."]
    if status == "Released":
        notes.append("This payment has been released and has not settled yet. Settlement can take a few business days.")
    return {
        "kind": "remittance", "title": "Remittance advice", "number": pay["tranId"],
        "intro": f"Payment details for invoice {bill['tranId']}.",
        "parties": [("Paid by", [bill.get("subsidiary") or PAYER]), ("Paid to", [vendor.get("companyName") or bill.get("entityName")])],
        "meta": meta, "lines": lines, "total": ("Payment total", _money(pay.get("total"), bill.get("currency"))),
        "notes": notes,
    }


def _doc(kind, bill_internal_id):
    if kind not in KINDS:
        raise NotAvailable("Unknown document type.", "missing")
    r = _load(bill_internal_id)
    return (_invoice_doc(r) if kind == "invoice" else _remittance_doc(r)), r


# ---------------------------------------------------------------------------- HTML
_CSS = """
:root{color-scheme:light}*{box-sizing:border-box}
body{margin:0;background:#fff;color:#1a1a1a;font:14px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
.page{max-width:760px;margin:0 auto;padding:40px 36px}
.brand{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #1a1a1a;padding-bottom:12px;margin-bottom:24px}
.brand b{font-size:20px;letter-spacing:.04em}.brand span{color:#555}
h1{font-size:22px;margin:0 0 4px}.intro{color:#555;margin:0 0 24px}
.parties{display:flex;gap:32px;margin-bottom:24px}.parties div{flex:1}
.label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#555}
table{width:100%;border-collapse:collapse;margin:0 0 20px}
td,th{padding:8px 0;border-bottom:1px solid #d8d8d8;text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#555;font-weight:600}
.num{text-align:right;white-space:nowrap}.meta td:first-child{width:38%;color:#555}
.total td{font-weight:700;border-top:2px solid #1a1a1a;border-bottom:0}
.notes{color:#555;font-size:12px}
@media print{.page{padding:0;max-width:none}}
"""


def _to_html(doc):
    e = html.escape
    parties = "".join(f'<div><div class="label">{e(lbl)}</div>' + "".join(f"<div>{e(str(x))}</div>" for x in rows if x) + "</div>"
                      for lbl, rows in doc["parties"])
    meta = "".join(f"<tr><td>{e(k)}</td><td>{e(str(v))}</td></tr>" for k, v in doc["meta"] if v != "")
    lines = "".join(f'<tr><td>{e(str(d))}</td><td class="num">{e(a)}</td></tr>' for d, a in doc["lines"])
    notes = "".join(f"<p>{e(n)}</p>" for n in doc["notes"])
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{e(doc["title"])} {e(str(doc["number"]))}</title><style>{_CSS}</style></head><body><div class="page">'
            f'<div class="brand"><b>ORCHESTRA</b><span>{e(doc["title"])}</span></div>'
            f'<h1>{e(doc["title"])} {e(str(doc["number"]))}</h1><p class="intro">{e(doc["intro"])}</p>'
            f'<div class="parties">{parties}</div><table class="meta">{meta}</table>'
            f'<table><thead><tr><th>Description</th><th class="num">Amount</th></tr></thead><tbody>{lines}'
            f'<tr class="total"><td>{e(doc["total"][0])}</td><td class="num">{e(doc["total"][1])}</td></tr></tbody></table>'
            f'<div class="notes">{notes}</div></div></body></html>').encode("utf-8")


# ---------------------------------------------------------------------------- PDF (reportlab only)
def _to_pdf(doc):
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import inch
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    def esc(s):
        return html.escape(str(s))  # Paragraph reads a small XML dialect

    ss = getSampleStyleSheet()
    body = ParagraphStyle("b", parent=ss["Normal"], fontName="Helvetica", fontSize=10, leading=14)
    small = ParagraphStyle("s", parent=body, fontSize=8, textColor=colors.HexColor("#555555"))
    h1 = ParagraphStyle("h1", parent=body, fontName="Helvetica-Bold", fontSize=16, leading=20, spaceAfter=4)
    brand = ParagraphStyle("brand", parent=body, fontName="Helvetica-Bold", fontSize=14, leading=18)
    buf = io.BytesIO()
    pdf = SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.9 * inch, rightMargin=0.9 * inch, topMargin=0.8 * inch,
                            bottomMargin=0.8 * inch, title=f"{doc['title']} {doc['number']}", author="Orchestra Accounts Payable")
    w = LETTER[0] - 1.8 * inch
    story = [Paragraph("ORCHESTRA", brand), Spacer(1, 4)]
    rule = Table([[""]], colWidths=[w], rowHeights=[2])
    rule.setStyle(TableStyle([("LINEABOVE", (0, 0), (-1, 0), 1.5, colors.HexColor("#1a1a1a"))]))
    story += [rule, Spacer(1, 10), Paragraph(f"{esc(doc['title'])} {esc(doc['number'])}", h1),
              Paragraph(esc(doc["intro"]), small), Spacer(1, 12)]
    cols = [[Paragraph(esc(lbl.upper()), small)] + [Paragraph(esc(x), body) for x in rows if x] for lbl, rows in doc["parties"]]
    party_tbl = Table([cols], colWidths=[w / len(cols)] * len(cols))
    party_tbl.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story += [party_tbl, Spacer(1, 12)]
    meta_tbl = Table([[Paragraph(esc(k), small), Paragraph(esc(v), body)] for k, v in doc["meta"] if v != ""],
                     colWidths=[w * 0.38, w * 0.62])
    meta_tbl.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.5, colors.HexColor("#d8d8d8")), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                  ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story += [meta_tbl, Spacer(1, 14)]
    rows = [[Paragraph("DESCRIPTION", small), Paragraph("AMOUNT", small)]]
    rows += [[Paragraph(esc(d), body), Paragraph(esc(a), body)] for d, a in doc["lines"]]
    rows.append([Paragraph(f"<b>{esc(doc['total'][0])}</b>", body), Paragraph(f"<b>{esc(doc['total'][1])}</b>", body)])
    lines_tbl = Table(rows, colWidths=[w * 0.7, w * 0.3])
    lines_tbl.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -2), 0.5, colors.HexColor("#d8d8d8")),
                                   ("LINEABOVE", (0, -1), (-1, -1), 1.2, colors.HexColor("#1a1a1a")),
                                   ("ALIGN", (1, 0), (1, -1), "RIGHT"), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                   ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    story += [lines_tbl, Spacer(1, 14)] + [Paragraph(esc(n), small) for n in doc["notes"]]
    pdf.build(story)
    return buf.getvalue()


# ---------------------------------------------------------------------------- public
def _filename(kind, doc, bill, fmt):
    stem = ("Invoice-" + bill["tranId"]) if kind == "invoice" else ("Remittance-" + str(doc["number"]))
    return re.sub(r"[^A-Za-z0-9._-]+", "_", stem) + "." + fmt


def render(kind, bill_internal_id, fmt):
    """(bytes, mime, filename) for an invoice copy or remittance advice, from records only. Raises NotAvailable."""
    if fmt not in FORMATS:
        raise NotAvailable("Unknown format.", "missing")
    doc, r = _doc(kind, bill_internal_id)
    data = _to_html(doc) if fmt == "html" else _to_pdf(doc)
    return data, FORMATS[fmt], _filename(kind, doc, r["bill"], fmt)


def attachment_filename(kind, bill_internal_id):
    doc, r = _doc(kind, bill_internal_id)
    return _filename(kind, doc, r["bill"], "pdf")


# ---------------------------------------------------------------------------- draft attachments
def list_attachments(run_id, ticket_id):
    rows = db._all("SELECT id, kind, bill_id, filename, added_by, added_at FROM draft_attachments WHERE run_id=? AND ticket_id=? ORDER BY id",
                   (run_id, int(ticket_id)))
    return [{"id": r["id"], "kind": r["kind"], "bill_id": r["bill_id"], "filename": r["filename"], "added_by": r["added_by"],
             "added_at": appclock.iso(r["added_at"]) if r["added_at"] else None} for r in rows]


def add_attachment(run_id, ticket_id, kind, bill_id, added_by=None):
    """Attach a rendered document to the draft. NotAvailable if it cannot be produced. Adding the same one twice is a no-op."""
    filename = attachment_filename(kind, bill_id)  # raises NotAvailable
    have = db._one("SELECT id FROM draft_attachments WHERE run_id=? AND ticket_id=? AND kind=? AND bill_id=?",
                   (run_id, int(ticket_id), kind, str(bill_id)))
    if not have:
        db._exec("INSERT INTO draft_attachments (run_id, ticket_id, kind, bill_id, filename, added_by, added_at) VALUES (?,?,?,?,?,?,?)",
                 (run_id, int(ticket_id), kind, str(bill_id), filename, added_by, appclock.now()))
    return list_attachments(run_id, ticket_id)


def remove_attachment(run_id, ticket_id, attachment_id):
    db._exec("DELETE FROM draft_attachments WHERE id=? AND run_id=? AND ticket_id=?", (int(attachment_id), run_id, int(ticket_id)))
    return list_attachments(run_id, ticket_id)


def clear_run(run_id):
    db._exec("DELETE FROM draft_attachments WHERE run_id=?", (run_id,))


def attachments_for(run_id, ticket_id):
    """[(filename, mime, pdf_bytes)] attached to this draft, rendered fresh from records at send time."""
    out = []
    for a in list_attachments(run_id, ticket_id):
        try:
            data, mime, name = render(a["kind"], a["bill_id"], "pdf")
        except NotAvailable as e:  # the records changed since it was attached: send without it rather than fail the send
            print(f"[documents] attachment {a['kind']} for bill {a['bill_id']} skipped: {e.message}", flush=True)
            continue
        out.append((name, mime, data))
    return out


# ---------------------------------------------------------------------------- routes
@router.get("/api/documents/{kind}/{bill_id}.{fmt}", dependencies=[Depends(identity.require_role(*STAFF))])
def api_document(kind: str, bill_id: str, fmt: str):
    try:
        data, mime, name = render(kind, bill_id, fmt)
    except NotAvailable as e:
        raise HTTPException(404 if e.code == "missing" else 409, e.message)
    # The marker lets the middleware relax frame-ancestors to 'self' for this response only, so the app can preview it.
    return Response(content=data, media_type=mime, headers={"X-Conductor-Frame": "self",
                                                            "Content-Disposition": f'inline; filename="{name}"'})
