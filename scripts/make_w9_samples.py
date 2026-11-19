"""Build the fictional W-9 seed: dashboards/conductor/seed/w9/status.json and a few filled sample PDFs.

    python scripts/make_w9_samples.py

Everything here is made up. The TINs are not real (EIN-style numbers start with 99, SSN-style numbers start with 900).
status.json keeps only the last 4 digits of any TIN. The sample PDFs hold a full fictional TIN, because a real W-9
does, so the extraction code has something real to read and mask. Running it again rewrites the same files.
"""
import csv
import json
import zlib
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "dashboards" / "conductor" / "seed" / "w9"
SAMPLES = SEED / "samples"

# Statuses by vendor id. Every other vendor is on_file.
MISSING = {"3000", "3007", "3014", "3023", "3031"}
EXPIRED = {"3005", "3018", "3033"}
NAME_MISMATCH = {"3011": "Tin Lantern Media Inc", "3026": "Greywater Audio LLC", "3035": "Marek T. Tanaka-Holt"}
TIN_MISMATCH = {"3002", "3016", "3029"}

ENTITY_TYPES = ["LLC", "C Corporation", "S Corporation", "Partnership"]
STREETS = ["Maple Court", "Harbor Road", "Linden Avenue", "Quarry Street", "Foundry Lane", "Alder Drive", "Mill Street",
           "Cedar Boulevard"]
CITIES = [("Portland", "OR", "97205"), ("Austin", "TX", "78701"), ("Denver", "CO", "80202"), ("Madison", "WI", "53703"),
          ("Raleigh", "NC", "27601"), ("Albany", "NY", "12207"), ("Tucson", "AZ", "85701"), ("Boise", "ID", "83702")]

# Field names on the sample forms (w9.py reads these, then falls back to the page text).
F_NAME, F_BUSINESS, F_ENTITY, F_ADDRESS, F_CSZ, F_TIN = "legal_name", "business_name", "entity_type", "address", "city_state_zip", "tin"


FLAT = {F_NAME: "Name", F_BUSINESS: "Business name", F_ENTITY: "Federal tax classification", F_ADDRESS: "Address",
        F_CSZ: "City, state, and ZIP code", F_TIN: "Taxpayer identification number"}


def h(*parts):
    return zlib.crc32("|".join(map(str, parts)).encode())


def vendor_record(v):
    n = int(v["internalId"])
    person = v["isPerson"] == "T"
    city, st, zipc = CITIES[h("city", n) % len(CITIES)]
    return {
        "entity_type": "Individual/sole proprietor" if person else ENTITY_TYPES[h("type", n) % len(ENTITY_TYPES)],
        "street": f"{100 + h('no', n) % 880} {STREETS[h('street', n) % len(STREETS)]}",
        "csz": f"{city}, {st} {zipc}",
        "tin_last4": f"{1000 + h('tin', n) % 9000}",
        "person": person,
    }


def date_for(n, lo_year, hi_year):
    y = lo_year + h("y", n) % (hi_year - lo_year + 1)
    return f"{y}-{1 + h('m', n) % 12:02d}-{1 + h('d', n) % 28:02d}"


def full_tin(last4, person):
    return f"900-00-{last4}" if person else f"99-999{last4}"


def build_status(vendors):
    out = {}
    for v in vendors:
        vid, n = v["internalId"], int(v["internalId"])
        r = vendor_record(v)
        row = {"tin_last4": r["tin_last4"], "entity_type": r["entity_type"], "address": f"{r['street']}, {r['csz']}",
               "legal_name": v["companyName"]}
        if vid in MISSING:
            row["status"] = "missing"
        elif vid in EXPIRED:
            row.update(status="expired", on_file_at=date_for(n, 2021, 2022))
        elif vid in NAME_MISMATCH:
            row.update(status="name_mismatch", legal_name=NAME_MISMATCH[vid], on_file_at=date_for(n, 2024, 2026))
        elif vid in TIN_MISMATCH:
            # tin_last4 is the W-9 on file; record_tin_last4 is the vendor record it should agree with.
            row.update(status="tin_mismatch", on_file_at=date_for(n, 2024, 2026),
                       record_tin_last4=r["tin_last4"], tin_last4=f"{1000 + (int(r['tin_last4']) + 3797) % 9000}")
        else:
            row.update(status="on_file", on_file_at=date_for(n, 2023, 2026))
        out[vid] = row
    return out


# ------------------------------------------------------------------ PDFs
def _page(c, title):
    c.setFont("Helvetica-Bold", 16)
    c.drawString(54, 740, "Form W-9 (sample, fictional data)")
    c.setFont("Helvetica", 9)
    c.drawString(54, 726, title)


def make_pdf(path, name, business, entity, street, csz, tin, form_fields=True, extra_lines=()):
    c = canvas.Canvas(str(path), pagesize=letter, invariant=1)
    _page(c, "Request for Taxpayer Identification Number and Certification")
    rows = [("Name (as shown on your income tax return)", F_NAME, name, 690),
            ("Business name / disregarded entity name, if different", F_BUSINESS, business, 640),
            ("Federal tax classification", F_ENTITY, entity, 590),
            ("Address (number, street, and apt. or suite no.)", F_ADDRESS, street, 540),
            ("City, state, and ZIP code", F_CSZ, csz, 490),
            ("Taxpayer identification number", F_TIN, tin, 440)]
    for label, field, value, y in rows:
        c.setFont("Helvetica", 9)
        c.drawString(54, y + 28, label)
        if form_fields:
            c.acroForm.textfield(name=field, tooltip=label, x=54, y=y, width=420, height=22, value=value,
                                 borderStyle="inset", forceBorder=True, fontSize=11)
        else:
            c.setFont("Helvetica", 11)
            c.drawString(54, y + 8, f"{FLAT[field]}: {value}")
    y = 400
    c.setFont("Helvetica", 9)
    for line in extra_lines:
        c.drawString(54, y, line)
        y -= 14
    c.drawString(54, 120, "Under penalties of perjury, I certify that the number shown on this form is my correct TIN.")
    c.save()


def build_samples(vendors, status):
    by = {v["internalId"]: v for v in vendors}
    SAMPLES.mkdir(parents=True, exist_ok=True)
    made = []

    def sample(fname, vid, **over):
        v, r = by[vid], vendor_record(by[vid])
        args = dict(name=v["companyName"], business="", entity=r["entity_type"], street=r["street"], csz=r["csz"],
                    tin=full_tin(r["tin_last4"], r["person"]), form_fields=True)
        args.update(over)
        make_pdf(SAMPLES / fname, **args)
        made.append(fname)

    # Dovetail Lane Printing (3023, W-9 missing): a clean upload, a name mismatch and a TIN mismatch.
    r23 = vendor_record(by["3023"])
    sample("w9_dovetail_lane_printing_ok.pdf", "3023")
    sample("w9_dovetail_lane_printing_name_mismatch.pdf", "3023", name="Dovetail Print and Design Group LLC")
    sample("w9_dovetail_lane_printing_tin_mismatch.pdf", "3023",
           tin=full_tin(f"{1000 + (int(r23['tin_last4']) + 4321) % 9000}", False))
    # Quillfern Studio (3000, missing): the same data on a flat PDF with no form fields (text fallback).
    sample("w9_quillfern_studio_text_only.pdf", "3000", form_fields=False)
    return made


def main():
    vendors = list(csv.DictReader(open(ROOT / "data" / "vendors.csv", newline="", encoding="utf-8")))
    SEED.mkdir(parents=True, exist_ok=True)
    status = build_status(vendors)
    (SEED / "status.json").write_text(json.dumps(status, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    made = build_samples(vendors, status)
    counts = {}
    for r in status.values():
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    print(f"status.json: {len(status)} vendors {counts}")
    print("samples:", ", ".join(made))


if __name__ == "__main__":
    main()
