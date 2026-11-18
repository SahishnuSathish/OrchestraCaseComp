#!/usr/bin/env python3
"""Optional read-only mock API over the fictional data pack, for the Stretch level.

Run: python3 mock_api.py   (serves http://localhost:8787)

Zendesk-style:
  GET /api/v2/tickets.json
  GET /api/v2/tickets/{id}.json
  GET /api/v2/tickets/{id}/comments.json
  GET /api/v2/users/{id}.json

NetSuite-style (filters are exact matches on column names):
  GET /record/v1/vendor?email=billing@example.example
  GET /record/v1/employee?email=...
  GET /record/v1/vendorBill?tranId=INV-1001
  GET /record/v1/vendorPayment?internalId=80001
  GET /record/v1/paymentRun?bill_internal_id=50001

The Zendesk paths mirror the public API. The NetSuite paths follow its REST record naming but are simplified.
The API reads the files in ./data. It never changes them.
"""
import csv
import json
import os
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
TICKETS_FILE = os.environ.get("TICKETS_FILE", os.path.join(DATA, "tickets.json"))
T = json.load(open(TICKETS_FILE))
LINKED = json.load(open(os.path.join(DATA, "linked_tickets.json")))["tickets"]
TICKETS = {t["id"]: t for t in T["tickets"] + LINKED}
USERS = {u["id"]: u for u in T["users"]}


def table(name):
    with open(os.path.join(DATA, name), newline="") as f:
        return list(csv.DictReader(f))


TABLES = {"vendor": table("vendors.csv"), "employee": table("employees.csv"), "vendorBill": table("vendor_bills.csv"), "vendorPayment": table("bill_payments.csv"), "paymentRun": table("payment_runs.csv")}


class H(BaseHTTPRequestHandler):
    def send(self, code, obj):
        b = json.dumps(obj, indent=1).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        p = u.path
        if p == "/api/v2/tickets.json":
            return self.send(200, {"tickets": [{k: v for k, v in t.items() if k != "comments"} for t in T["tickets"]], "count": T["count"]})
        m = re.fullmatch(r"/api/v2/tickets/(\d+)(/comments)?\.json", p)
        if m:
            t = TICKETS.get(int(m.group(1)))
            if not t:
                return self.send(404, {"error": "RecordNotFound"})
            if m.group(2):
                return self.send(200, {"comments": t["comments"], "count": len(t["comments"])})
            return self.send(200, {"ticket": {k: v for k, v in t.items() if k != "comments"}})
        m = re.fullmatch(r"/api/v2/users/(\d+)\.json", p)
        if m:
            u_ = USERS.get(int(m.group(1)))
            return self.send(200, {"user": u_}) if u_ else self.send(404, {"error": "RecordNotFound"})
        m = re.fullmatch(r"/record/v1/(\w+)", p)
        if m and m.group(1) in TABLES:
            rows = [r for r in TABLES[m.group(1)] if all(r.get(k) == v for k, v in q.items())]
            return self.send(200, {"count": len(rows), "items": rows})
        self.send(404, {"error": "unknown path"})

    def log_message(self, *a):
        pass

    def do_POST(self):
        self.send(405, {"error": "this mock API is read-only"})

    do_PUT = do_PATCH = do_DELETE = do_POST


if __name__ == "__main__":
    print("Mock API on http://localhost:8787")
    HTTPServer(("localhost", 8787), H).serve_forever()
