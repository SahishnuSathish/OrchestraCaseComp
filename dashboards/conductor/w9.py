"""W-9 status, uploads, extraction and checks.

Owner: p3/direct-w9. Contract: docs/phase3/CONTRACTS.md section 10 (and the upload routes of section 9).

Rules this module keeps:
  * A TIN is never stored, returned or logged beyond its last 4 digits. The full number exists only in memory
    while one PDF is read (and inside the uploaded PDF itself, which lives under the state folder, never the repo).
  * Bank details are never accepted. An upload whose text carries routing or account numbers, or asks to change bank
    details, is held as needs_review with a fraud reason. Nothing is verified automatically.
  * Nothing here sends anything. A W-9 request is an outbound item that a person approves and sends.
"""
import hashlib
import hmac
import json
import math
import re
import secrets
import shutil
import sys
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request

import appclock
import db
import direct
import identity

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
for _p in (ROOT / "src", HERE):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import egress_guard  # noqa: E402

router = APIRouter()

SEED_FILE = HERE / "seed" / "w9" / "status.json"
CHUNK_SIZE = 1024 * 1024
MAX_SIZE = 50 * 1024 * 1024
MAX_OPEN_UPLOADS = 5
NEXT_STEP = "Update NetSuite vendor record"
UPLOAD_LINE = "Upload it securely in Conductor: Direct"

STAFF_LABELS = {"on_file": "On file", "missing": "Missing", "expired": "Expired", "name_mismatch": "Name mismatch",
                "tin_mismatch": "TIN mismatch"}
VENDOR_LABELS = {"on_file": "On file", "missing": "Needed", "expired": "Needs updating", "under_review": "Under review"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS w9_status (
  vendor_id TEXT PRIMARY KEY, status TEXT, tin_last4 TEXT, record_tin_last4 TEXT, legal_name TEXT, entity_type TEXT,
  address TEXT, on_file_at TEXT, requested_at REAL, verified_by TEXT, verified_at REAL
);
CREATE TABLE IF NOT EXISTS w9_uploads (
  id TEXT PRIMARY KEY, vendor_id TEXT, filename TEXT, size INTEGER, sha256 TEXT, path TEXT, state TEXT, fields TEXT,
  uploaded_at REAL, verified_by TEXT, verified_at REAL, contact TEXT, reason TEXT
);
"""


def init_schema():
    with db._LOCK, db._connect() as con:
        con.executescript(SCHEMA)
        try:
            seed = json.loads(SEED_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            seed = {}
        for vid, r in seed.items():
            con.execute("INSERT OR IGNORE INTO w9_status (vendor_id, status, tin_last4, record_tin_last4, legal_name, entity_type,"
                        " address, on_file_at) VALUES (?,?,?,?,?,?,?,?)",
                        (vid, r.get("status"), r.get("tin_last4"), r.get("record_tin_last4"), r.get("legal_name"),
                         r.get("entity_type"), r.get("address"), r.get("on_file_at")))


# ------------------------------------------------------------------ status
def status_row(vendor_id):
    return db._one("SELECT * FROM w9_status WHERE vendor_id=?", (vendor_id,))


def _uploads_root():
    return Path(db.STATE_DIR) / "uploads" / "w9"


def _upload(upload_id):
    return db._one("SELECT * FROM w9_uploads WHERE id=?", (upload_id,))


def _latest_upload(vendor_id):
    return db._one("SELECT * FROM w9_uploads WHERE vendor_id=? AND state IN ('received','needs_review','verified') "
                   "ORDER BY uploaded_at DESC LIMIT 1", (vendor_id,))


def vendor_status(vendor_id):
    """What the vendor sees: on_file, missing, expired, or under_review (an upload or a mismatch). Never the reason."""
    row = status_row(vendor_id)
    st = row["status"] if row else "missing"
    up = _latest_upload(vendor_id)
    if (up and up["state"] in ("received", "needs_review")) or st in ("name_mismatch", "tin_mismatch"):
        code = "under_review"
    else:
        code = st
    return {"status": code, "label": VENDOR_LABELS[code]}


def _mask_tin(last4):
    return f"XXX-XX-{last4}" if last4 else ""


# ------------------------------------------------------------------ extraction
FIELD_ALIASES = {
    "legal_name": ("legalname", "name", "nameasshownonyourincometaxreturn", "line1", "name1"),
    "entity_type": ("entitytype", "taxclassification", "federaltaxclassification", "classification"),
    "address": ("address", "streetaddress", "addressnumberstreetandaptorsuiteno"),
    "csz": ("citystatezip", "citystateandzipcode", "citystatezipcode"),
    "tin": ("tin", "taxpayeridentificationnumber", "ssn", "ein", "socialsecuritynumber"),
}
TEXT_PATTERNS = {
    "legal_name": r"^\s*(?:legal )?name\s*:\s*(.+?)\s*$",
    "entity_type": r"^\s*(?:federal )?tax classification\s*:\s*(.+?)\s*$",
    "address": r"^\s*address\s*:\s*(.+?)\s*$",
    "csz": r"^\s*city,? state,? (?:and )?zip(?: code)?\s*:\s*(.+?)\s*$",
    "tin": r"^\s*(?:taxpayer identification number|tin|ssn|ein)\s*:?\s*([0-9Xx*\- ]{9,})\s*$",
}
TIN_SHAPES = re.compile(r"\b\d{3}-\d{2}-\d{4}\b|\b\d{2}-\d{7}\b")
BANK_PATTERNS = [re.compile(p, re.I) for p in (
    r"\brouting\b", r"\biban\b", r"\bswift\b", r"\bsort code\b",
    r"account\s*(?:number|no\.?|#)\s*[:#]?\s*[\dXx*\-]{4,}",
    r"\b(?:change|update|new|different)\b[^.\n]{0,25}\bbank\b",
    r"\bbank\s+(?:details|account|information|info|transfer)\b",
    r"\bwire\s+(?:instructions|details)\b",
)]
LONG_DIGITS = re.compile(r"\b\d{8,17}\b")


class Unreadable(Exception):
    pass


def _form_fields(reader):
    out = {}
    try:
        for name, f in (reader.get_fields() or {}).items():
            v = f.get("/V")
            if v is not None and str(v).strip():
                out[re.sub(r"[^a-z0-9]", "", str(name).lower())] = str(v).strip()
    except Exception:
        pass
    return out


def extract(path):
    """Read a W-9 PDF (AcroForm fields first, page text as the fallback). Returns {legal_name, entity_type, address,
    tin_last4, bank_flag}. The full TIN is reduced to its last 4 digits here; neither it nor the page text leaves."""
    from pypdf import PdfReader
    try:
        reader = PdfReader(str(path))
        if reader.is_encrypted and not reader.decrypt(""):
            raise Unreadable("encrypted")
        form = _form_fields(reader)
        text = "\n".join((p.extract_text() or "") for p in list(reader.pages)[:8])
    except Unreadable:
        raise
    except Exception as e:
        raise Unreadable(type(e).__name__)

    def pick(field):
        for alias in FIELD_ALIASES[field]:
            if form.get(alias):
                return form[alias]
        m = re.search(TEXT_PATTERNS[field], text, re.I | re.M)
        return m.group(1).strip() if m else ""

    tin_raw = pick("tin")
    digits = re.sub(r"\D", "", tin_raw)
    result = {"legal_name": pick("legal_name"), "entity_type": pick("entity_type"),
              "address": ", ".join(x for x in (pick("address"), pick("csz")) if x),
              "tin_last4": digits[-4:] if len(digits) >= 4 else ""}
    scan = "\n".join([text] + list(form.values()))
    for t in (tin_raw, digits):
        if t:
            scan = scan.replace(t, " ")
    scan = TIN_SHAPES.sub(" ", scan)
    result["bank_flag"] = any(p.search(scan) for p in BANK_PATTERNS) or bool(LONG_DIGITS.search(scan))
    return result


# ------------------------------------------------------------------ checks
NAME_NOISE = {"inc", "llc", "co", "corp", "corporation", "company", "ltd", "the", "incorporated", "limited"}
ENTITY_KEYS = (("llc", ("llc", "limited liability")), ("c_corp", ("c corp", "c-corp")), ("s_corp", ("s corp", "s-corp")),
               ("partnership", ("partnership",)), ("individual", ("individual", "sole proprietor")),
               ("trust", ("trust", "estate")))
ADDR_WORDS = {"street": "st", "avenue": "ave", "road": "rd", "drive": "dr", "boulevard": "blvd", "lane": "ln",
              "court": "ct", "suite": "ste", "apartment": "apt"}


def _norm_name(s):
    words = re.sub(r"[^a-z0-9 ]", " ", (s or "").lower().replace("&", " and ")).split()
    return " ".join(w for w in words if w not in NAME_NOISE)


def _norm_entity(s):
    low = (s or "").lower()
    for key, needles in ENTITY_KEYS:
        if any(n in low for n in needles):
            return key
    return re.sub(r"[^a-z]", "", low)


def _norm_addr(s):
    words = re.sub(r"[^a-z0-9 ]", " ", (s or "").lower()).split()
    return " ".join(ADDR_WORDS.get(w, w) for w in words)


def check_fields(found, vendor, row):
    """[{name, value_masked, record, match}] for one extraction against the vendor record. A TIN shows its last 4 only.
    match is True or False, or None when there is no record to compare with."""
    row = row or {}
    rec_last4 = row.get("record_tin_last4") or row.get("tin_last4") or ""

    def cmp(a, b, norm):
        if not a:
            return False
        if not b:
            return None
        return norm(a) == norm(b)

    return [
        {"name": "Legal name", "value_masked": found["legal_name"], "record": vendor["companyName"],
         "match": cmp(found["legal_name"], vendor["companyName"], _norm_name)},
        {"name": "Entity type", "value_masked": found["entity_type"], "record": row.get("entity_type") or "",
         "match": cmp(found["entity_type"], row.get("entity_type"), _norm_entity)},
        {"name": "Address", "value_masked": found["address"], "record": row.get("address") or "",
         "match": cmp(found["address"], row.get("address"), _norm_addr)},
        {"name": "TIN", "value_masked": _mask_tin(found["tin_last4"]), "record": _mask_tin(rec_last4),
         "match": cmp(found["tin_last4"], rec_last4, str)},
    ]


def _public_fields(fields):
    """Belt and braces: whatever is stored or returned, a TIN-like value is cut to its last 4 digits."""
    out = []
    for f in fields:
        f = dict(f)
        if f["name"] == "TIN":
            for k in ("value_masked", "record"):
                d = re.sub(r"\D", "", f.get(k) or "")
                f[k] = _mask_tin(d[-4:]) if d else ""
        out.append(f)
    return out


def analyze(upload_id):
    """Read a completed upload and settle its state. Returns (state, reason, fields)."""
    up = _upload(upload_id)
    vendor = direct._vendor_row(up["vendor_id"]) or {"companyName": ""}
    try:
        found = extract(up["path"])
    except Unreadable:
        return "needs_review", "unreadable", []
    fields = _public_fields(check_fields(found, vendor, status_row(up["vendor_id"])))
    if found["bank_flag"]:
        return "needs_review", "fraud: bank details in the upload", fields
    bad = [f["name"].lower() for f in fields if f["match"] is not True]
    if bad:
        return "needs_review", "does not match the vendor record: " + ", ".join(bad), fields
    return "received", None, fields


# ------------------------------------------------------------------ vendor routes (Direct)
@router.get("/api/direct/w9")
def direct_w9(s=Depends(direct.vendor_session)):
    vendor, _ = direct._ctx(s)
    v = vendor_status(vendor["internalId"])
    up = _latest_upload(vendor["internalId"])
    last = None
    if up:
        last = {"at": appclock.iso(up["uploaded_at"]), "filename": up["filename"],
                "state": "verified" if up["state"] == "verified" else "under_review"}
    return {"status": v["status"], "label": v["label"], "last_upload": last}


@router.post("/api/direct/w9/uploads")
async def start_upload(request: Request, s=Depends(direct.vendor_session)):
    vendor, contact = direct._ctx(s)
    try:
        body = await request.json()
        filename, size, mime = str(body["filename"]), int(body["size"]), str(body.get("mime") or "")
    except Exception:
        raise HTTPException(422, "Please choose a PDF file.")
    if size <= 0:
        raise HTTPException(422, "That file is empty.")
    if size > MAX_SIZE:
        raise HTTPException(413, "That file is larger than 50 MB.")
    if mime.lower() not in ("application/pdf", "application/x-pdf") or not filename.lower().endswith(".pdf"):
        raise HTTPException(415, "Please upload a PDF file.")
    open_n = db._one("SELECT COUNT(*) AS n FROM w9_uploads WHERE vendor_id=? AND state='uploading'", (vendor["internalId"],))["n"]
    if open_n >= MAX_OPEN_UPLOADS:
        raise HTTPException(429, "Please finish your other uploads first.")
    upload_id = secrets.token_hex(8)
    name = re.sub(r"[^\w .()\-]", "_", Path(filename).name)[:120] or "w9.pdf"
    db._exec("INSERT INTO w9_uploads (id, vendor_id, filename, size, state, uploaded_at, contact) VALUES (?,?,?,?,'uploading',?,?)",
             (upload_id, vendor["internalId"], name, size, appclock.now(), contact))
    return {"upload_id": upload_id, "chunk_size": CHUNK_SIZE}


def _mine(upload_id, s):
    vendor, _ = direct._ctx(s)
    up = _upload(upload_id)
    if not up or up["vendor_id"] != vendor["internalId"]:
        raise HTTPException(404, "We couldn't find that upload.")
    return vendor, up


def _discard(upload_id):
    shutil.rmtree(_uploads_root() / upload_id, ignore_errors=True)
    try:
        (_uploads_root() / f"{upload_id}.pdf").unlink()
    except OSError:
        pass
    db._exec("UPDATE w9_uploads SET state='rejected', path=NULL WHERE id=?", (upload_id,))


def _parts(upload_id):
    d = _uploads_root() / upload_id
    return {int(p.stem): p for p in d.glob("*.part")} if d.is_dir() else {}


@router.put("/api/direct/w9/uploads/{upload_id}/chunks/{n}")
async def put_chunk(upload_id: str, n: int, request: Request, s=Depends(direct.vendor_session)):
    _, up = _mine(upload_id, s)
    if up["state"] != "uploading":
        raise HTTPException(409, "This upload is already finished.")
    total = math.ceil(up["size"] / CHUNK_SIZE)
    if not 0 <= n < total:
        raise HTTPException(422, "Unexpected part number.")
    expected = CHUNK_SIZE if n < total - 1 else up["size"] - CHUNK_SIZE * (total - 1)
    buf = bytearray()
    async for piece in request.stream():
        buf += piece
        if len(buf) > expected:
            raise HTTPException(413, "That part is larger than expected.")
    if len(buf) != expected:
        raise HTTPException(422, "That part is not the expected size.")
    if n == 0 and bytes(buf[:4]) != b"%PDF":
        _discard(upload_id)
        raise HTTPException(415, "Please upload a PDF file.")
    d = _uploads_root() / upload_id
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / f"{n}.tmp"
    tmp.write_bytes(bytes(buf))
    tmp.replace(d / f"{n}.part")
    return {"received": sum(p.stat().st_size for p in _parts(upload_id).values())}


@router.delete("/api/direct/w9/uploads/{upload_id}")
def cancel_upload(upload_id: str, s=Depends(direct.vendor_session)):
    """The vendor cancelled an unfinished upload: drop its parts so it no longer counts against MAX_OPEN_UPLOADS."""
    _, up = _mine(upload_id, s)
    if up["state"] != "uploading":
        raise HTTPException(409, "This upload is already finished.")
    _discard(upload_id)
    return {"ok": True}


@router.post("/api/direct/w9/uploads/{upload_id}/complete")
async def complete_upload(upload_id: str, request: Request, s=Depends(direct.vendor_session)):
    vendor, up = _mine(upload_id, s)
    if up["state"] != "uploading":
        raise HTTPException(409, "This upload is already finished.")
    try:
        sha = str((await request.json()).get("sha256") or "").strip().lower()
    except Exception:
        sha = ""
    if not re.fullmatch(r"[0-9a-f]{64}", sha):
        raise HTTPException(422, "Missing file checksum.")
    total = math.ceil(up["size"] / CHUNK_SIZE)
    parts = _parts(upload_id)
    if set(parts) != set(range(total)):
        raise HTTPException(409, "Some parts of the file have not arrived yet.")
    final = _uploads_root() / f"{upload_id}.pdf"
    h, written = hashlib.sha256(), 0
    with open(final, "wb") as out:  # hash while streaming the parts into one file, 64 KB at a time
        for i in range(total):
            with open(parts[i], "rb") as src:
                while True:
                    block = src.read(65536)
                    if not block:
                        break
                    h.update(block)
                    out.write(block)
                    written += len(block)
    digest = h.hexdigest()
    if written != up["size"] or not hmac.compare_digest(digest, sha):
        _discard(upload_id)
        raise HTTPException(400, "The file didn't arrive intact. Please try again.")
    with open(final, "rb") as f:
        if f.read(4) != b"%PDF":
            _discard(upload_id)
            raise HTTPException(415, "Please upload a PDF file.")
    shutil.rmtree(_uploads_root() / upload_id, ignore_errors=True)
    db._exec("UPDATE w9_uploads SET sha256=?, path=?, state='received' WHERE id=?", (digest, str(final), upload_id))
    state, reason, fields = analyze(upload_id)
    db._exec("UPDATE w9_uploads SET state=?, reason=?, fields=? WHERE id=?", (state, reason, json.dumps(fields), upload_id))
    direct._publish("w9.received", {"vendor_id": vendor["internalId"], "upload_id": upload_id,
                                    "summary": f"{vendor['companyName']} uploaded a W-9"})
    return {"ok": True, "status": "received", "message": "Thanks. Our team will review it."}


# ------------------------------------------------------------------ staff routes
def staff_session(s=Depends(identity.require_role("ap_specialist", "cfo"))):
    """The signed-in staff member. Tests replace this with app.dependency_overrides."""
    if s is None:
        raise HTTPException(401, "Please sign in.")
    return s


def _held(vendor_id):
    rows = []
    for o in direct._classified(vendor_id):
        if o["outcome"] in ("paid", "released"):
            continue
        b = o["bill"]
        rows.append({"tranId": b["tranId"], "amount": float(b["userTotal"]) if b.get("userTotal") else None,
                     "status": direct.status_chip(o)["label"]})
    rows.sort(key=lambda r: r["tranId"])
    return rows


def _upload_summary(u):
    return {"upload_id": u["id"], "filename": u["filename"], "size": u["size"], "state": u["state"],
            "uploaded_at": appclock.iso(u["uploaded_at"]), "reason": u["reason"]}


@router.get("/api/w9/queue")
def queue(s=Depends(staff_session)):
    rows = []
    for v in direct._store().vendors:
        if v.get("isInactive", "F") == "T":
            continue
        row = status_row(v["internalId"])
        st = row["status"] if row else "missing"
        up = _latest_upload(v["internalId"])
        waiting = bool(up and up["state"] in ("received", "needs_review"))
        if st == "on_file" and not waiting:
            continue
        rows.append({"vendor_id": v["internalId"], "vendor": v["companyName"], "status": st, "label": STAFF_LABELS.get(st, st),
                     "upload_id": up["id"] if waiting else None, "bills_held": _held(v["internalId"])})
    rows.sort(key=lambda r: (-len(r["bills_held"]), r["vendor"]))
    return {"rows": rows}


def _vendor_or_404(vendor_id):
    v = direct._vendor_row(vendor_id)
    if not v:
        raise HTTPException(404, "We couldn't find that vendor.")
    return v


@router.get("/api/w9/uploads/{upload_id}")
def upload_detail(upload_id: str, s=Depends(staff_session)):
    u = _upload(upload_id)
    if not u or u["state"] in ("uploading", "rejected"):
        raise HTTPException(404, "We couldn't find that upload.")
    v = direct._vendor_row(u["vendor_id"]) or {"companyName": ""}
    fraud = (u["reason"] or "").startswith("fraud")
    return {"upload_id": u["id"], "vendor_id": u["vendor_id"], "vendor": v["companyName"], "filename": u["filename"],
            "state": u["state"], "reason": u["reason"], "flags": ["fraud"] if fraud else [],
            "fields": _public_fields(json.loads(u["fields"] or "[]")), "sha256": u["sha256"], "size": u["size"],
            "uploaded_at": appclock.iso(u["uploaded_at"]), "verified_by": u["verified_by"],
            "verified_at": appclock.iso(u["verified_at"]) if u["verified_at"] else None,
            "next_step": NEXT_STEP if u["state"] == "verified" else None}


@router.post("/api/w9/uploads/{upload_id}/verify")
def verify(upload_id: str, s=Depends(staff_session)):
    u = _upload(upload_id)
    if not u or u["state"] not in ("received", "needs_review", "verified"):
        raise HTTPException(404, "We couldn't find that upload.")
    if (u["reason"] or "").startswith("fraud"):
        raise HTTPException(409, "This upload needs CFO review. It can't be marked verified here.")
    if u["state"] == "verified":
        raise HTTPException(409, "This upload is already verified.")
    now = appclock.now()
    who = getattr(s, "subject", None) or getattr(s, "name", None) or "staff"
    db._exec("UPDATE w9_uploads SET state='verified', verified_by=?, verified_at=? WHERE id=?", (who, now, upload_id))
    f = {x["name"]: x["value_masked"] for x in json.loads(u["fields"] or "[]")}
    last4 = re.sub(r"\D", "", f.get("TIN", ""))[-4:]
    db._exec("UPDATE w9_status SET status='on_file', on_file_at=?, verified_by=?, verified_at=?, "
             "legal_name=COALESCE(NULLIF(?, ''), legal_name), entity_type=COALESCE(NULLIF(?, ''), entity_type), "
             "address=COALESCE(NULLIF(?, ''), address), tin_last4=COALESCE(NULLIF(?, ''), tin_last4), record_tin_last4=NULL "
             "WHERE vendor_id=?",
             (appclock.today().isoformat(), who, now, f.get("Legal name", ""), f.get("Entity type", ""),
              f.get("Address", ""), last4, u["vendor_id"]))
    return {"ok": True, "state": "verified", "verified_by": who, "verified_at": appclock.iso(now), "next_step": NEXT_STEP}


@router.get("/api/w9/{vendor_id}")
def vendor_detail(vendor_id: str, s=Depends(staff_session)):
    v = _vendor_or_404(vendor_id)
    row = status_row(vendor_id) or {}
    st = row.get("status") or "missing"
    uploads = db._all("SELECT * FROM w9_uploads WHERE vendor_id=? AND state NOT IN ('uploading','rejected') "
                      "ORDER BY uploaded_at DESC", (vendor_id,))
    return {"vendor_id": vendor_id, "vendor": v["companyName"], "email": v["email"], "status": st,
            "label": STAFF_LABELS.get(st, st),
            "on_file": {"legal_name": row.get("legal_name"), "entity_type": row.get("entity_type"), "address": row.get("address"),
                        "tin_masked": _mask_tin(row.get("tin_last4")), "on_file_at": row.get("on_file_at"),
                        "verified_by": row.get("verified_by"),
                        "verified_at": appclock.iso(row["verified_at"]) if row.get("verified_at") else None},
            "bills_held": _held(vendor_id), "uploads": [_upload_summary(u) for u in uploads],
            "requested_at": appclock.iso(row["requested_at"]) if row.get("requested_at") else None}


def draft_request(vendor):
    """The W-9 request text, from records only. It names no amount, date or invoice."""
    return (f"Hello,\n\nWe need a current Form W-9 for {vendor['companyName']} to keep your vendor record complete.\n\n"
            f"{UPLOAD_LINE}. Sign in with your usual contact address, open W-9 and add the PDF. "
            "Please don't send tax forms or bank details by email.\n\n"
            "Best regards,\nOrchestra Accounts Payable")


@router.post("/api/w9/{vendor_id}/request")
def request_w9(vendor_id: str, s=Depends(staff_session)):
    v = _vendor_or_404(vendor_id)
    row = status_row(vendor_id) or {}
    if row.get("status") == "on_file":
        raise HTTPException(409, "A W-9 is already on file for this vendor.")
    to, subject, body = v["email"], "W-9 needed for your Orchestra vendor record", draft_request(v)
    if egress_guard.check_outbound(body, [], [], recipient=to):
        raise HTTPException(409, "This request failed the outbound check, so it can't be drafted.")
    import workflow
    oid = workflow.create_outbound("w9_request", to, subject, body, created_by=getattr(s, "subject", None) or "staff",
                                   vendor_id=vendor_id)
    db._exec("UPDATE w9_status SET requested_at=? WHERE vendor_id=?", (appclock.now(), vendor_id))
    return {"ok": True, "outbound_id": oid, "to": to, "subject": subject, "body": body, "state": "pending"}
