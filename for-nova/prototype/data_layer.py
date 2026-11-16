"""Read-only data layer.

Two backends with the same interface:
  FileBackend  reads data/*.csv and *.json directly (default).
  HttpBackend  calls mock_api.py (python mock_api.py -> http://localhost:8787).

Rules code never touches a backend directly. It uses `Lookups`, which logs
every call to the ticket's Trace with the Zendesk / NetSuite style endpoint it
mirrors. Swapping backends needs no change to rules code.

Nothing here writes anything.
"""
import csv
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

TABLE_FILES = {
    "vendor": "vendors.csv",
    "employee": "employees.csv",
    "vendorBill": "vendor_bills.csv",
    "vendorPayment": "bill_payments.csv",
    "paymentRun": "payment_runs.csv",
}


def norm_ref(s):
    """Normalized invoice reference: upper case, letters and digits only."""
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def load_tickets_file(path):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    if isinstance(d, list):
        return {"tickets": d, "users": []}
    d.setdefault("users", [])
    return d


class FileBackend:
    def __init__(self, data_dir, tickets_path=None):
        self.data_dir = Path(data_dir)
        self.tables = {}
        for name, fn in TABLE_FILES.items():
            with open(self.data_dir / fn, encoding="utf-8", newline="") as f:
                self.tables[name] = list(csv.DictReader(f))
        tp = Path(tickets_path) if tickets_path else self.data_dir / "tickets.json"
        self.ticket_file = load_tickets_file(tp)
        linked_path = self.data_dir / "linked_tickets.json"
        linked = []
        if linked_path.exists():
            with open(linked_path, encoding="utf-8") as f:
                linked = json.load(f).get("tickets", [])
        self.tickets = {t["id"]: t for t in self.ticket_file["tickets"] + linked}
        self.users = {u["id"]: u for u in self.ticket_file.get("users", [])}
        # The practice users list also covers linked-ticket authors; keep the
        # default users available when a different tickets file is passed in.
        default_users = self.data_dir / "tickets.json"
        if tickets_path and default_users.exists():
            for u in load_tickets_file(default_users).get("users", []):
                self.users.setdefault(u["id"], u)

    def query(self, table, **filters):
        return [r for r in self.tables[table] if all(r.get(k) == v for k, v in filters.items())]

    def all(self, table):
        return list(self.tables[table])

    def ticket(self, tid):
        return self.tickets.get(int(tid))

    def user(self, uid):
        return self.users.get(int(uid))

    def list_tickets(self):
        return list(self.ticket_file["tickets"])

    def all_users(self):
        return list(self.users.values())


class HttpBackend:
    """Same interface, over mock_api.py. Read-only GETs only."""

    def __init__(self, base_url):
        self.base = base_url.rstrip("/")
        self._cache = {}

    def _get(self, path, params=None):
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        if url in self._cache:
            return self._cache[url]
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                out = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                out = None
            else:
                raise
        self._cache[url] = out
        return out

    def query(self, table, **filters):
        d = self._get(f"/record/v1/{table}", filters)
        return d["items"] if d else []

    def all(self, table):
        return self.query(table)

    def ticket(self, tid):
        d = self._get(f"/api/v2/tickets/{int(tid)}.json")
        if not d:
            return None
        t = dict(d["ticket"])
        c = self._get(f"/api/v2/tickets/{int(tid)}/comments.json")
        t["comments"] = c["comments"] if c else []
        return t

    def user(self, uid):
        d = self._get(f"/api/v2/users/{int(uid)}.json")
        return d["user"] if d else None

    def list_tickets(self):
        d = self._get("/api/v2/tickets.json")
        return [self.ticket(t["id"]) for t in d["tickets"]]

    def all_users(self):
        return []


class Store:
    """Backend plus small in-memory indexes built once at start-up.

    The indexes (normalized invoice numbers, vendor names and domains) let the
    extractor recognise candidate references without a call per token. Every
    fact used in a decision still comes through a traced Lookups call.
    """

    def __init__(self, backend):
        self.backend = backend
        self.vendors = backend.all("vendor")
        self.employees = backend.all("employee")
        bills = backend.all("vendorBill")
        self.ref_index = {}
        for b in bills:
            self.ref_index.setdefault(norm_ref(b["tranId"]), set()).add(b["tranId"])
        # Shapes of invoice numbers seen in records, e.g. "INV-#####", "CE#####".
        self.ref_prefixes = sorted({re.match(r"^([A-Z]*)", b["tranId"]).group(1) for b in bills} - {""})
        self.dash_prefixes = sorted({re.match(r"^([A-Z]+)-", b["tranId"]).group(1) for b in bills
                                     if re.match(r"^[A-Z]+-", b["tranId"])})
        self.known_domains = set()
        for v in self.vendors:
            for e in [v["email"]] + v["authorizedContacts"].split(";"):
                if "@" in e:
                    self.known_domains.add(e.split("@")[1].lower())
        for e in self.employees:
            self.known_domains.add(e["email"].split("@")[1].lower())

    def session(self, trace):
        return Lookups(self, trace)


class Lookups:
    """Traced, exact-key lookups for one ticket."""

    def __init__(self, store, trace):
        self.s = store
        self.b = store.backend
        self.trace = trace

    # ---- Zendesk-style -------------------------------------------------
    def get_user(self, uid):
        return self.trace.call("zendesk", "get_user", f"/api/v2/users/{uid}.json", uid, lambda: self.b.user(uid))

    def get_linked_ticket(self, tid):
        return self.trace.call("zendesk", "get_linked_ticket", f"/api/v2/tickets/{tid}.json + /comments.json", tid,
                               lambda: self.b.ticket(tid))

    # ---- NetSuite-style ------------------------------------------------
    def find_vendor_by_contact(self, email):
        email = (email or "").lower()
        return self.trace.call(
            "netsuite", "find_vendor_by_contact", f"/record/v1/vendor?authorizedContacts~={email}", email,
            lambda: [v for v in self.s.vendors if email in [c.strip().lower() for c in v["authorizedContacts"].split(";")]])

    def find_vendors_by_domain(self, domain):
        domain = (domain or "").lower()

        def f():
            out = []
            for v in self.s.vendors:
                doms = {c.split("@")[1].lower() for c in [v["email"]] + v["authorizedContacts"].split(";") if "@" in c}
                if domain in doms:
                    out.append(v)
            return out
        return self.trace.call("netsuite", "find_vendors_by_domain", f"/record/v1/vendor?domain={domain}", domain, f)

    def get_vendor(self, internal_id):
        return self.trace.call("netsuite", "get_vendor", f"/record/v1/vendor?internalId={internal_id}", internal_id,
                               lambda: next(iter(self.b.query("vendor", internalId=str(internal_id))), None))

    def find_employee_by_email(self, email):
        email = (email or "").lower()
        return self.trace.call("netsuite", "find_employee_by_email", f"/record/v1/employee?email={email}", email,
                               lambda: next(iter(self.b.query("employee", email=email)), None))

    def find_bills_by_tranid(self, tran_id):
        return self.trace.call("netsuite", "find_bills_by_tranId", f"/record/v1/vendorBill?tranId={tran_id}", tran_id,
                               lambda: self.b.query("vendorBill", tranId=tran_id))

    # ---- Payment system ------------------------------------------------
    def find_payments_for_bill(self, bill_internal_id):
        bid = str(bill_internal_id)

        def f():
            rows = self.b.query("vendorPayment", appliedBills=bid)
            if not rows and isinstance(self.b, FileBackend):
                rows = [p for p in self.b.tables["vendorPayment"] if bid in p["appliedBills"].split(";")]
            return rows
        return self.trace.call("payment_system", "find_payments_for_bill",
                               f"/record/v1/vendorPayment?appliedBills={bid}", bid, f)

    def find_runs_for_bill(self, bill_internal_id):
        bid = str(bill_internal_id)
        return self.trace.call("payment_system", "find_runs_for_bill", f"/record/v1/paymentRun?bill_internal_id={bid}",
                               bid, lambda: self.b.query("paymentRun", bill_internal_id=bid))

    # ---- Index helpers (not traced: no record facts) -------------------
    def canonical_refs(self, token):
        return sorted(self.s.ref_index.get(norm_ref(token), set()))
