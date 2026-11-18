"""Headless prevention demo on one real invoice from the data pack.

Chain: 1 draft the notice from the records, 2 approve it, 3 send it (simulated: an .eml in the outbox), 4 the vendor's own
status lookup for that invoice gives the same answer, and the ticket the notice would have prevented is named.

    python prototype/demo_prevention.py [--data data] [--out FOLDER]

Output goes to a folder outside the repo unless --out is given. Nothing leaves this computer.
"""
import argparse
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "prototype"), str(ROOT / "webapp")]

import egress_guard  # noqa: E402
import notices  # noqa: E402
import rules  # noqa: E402
from data_layer import FileBackend, Store  # noqa: E402
from trace import NullTrace  # noqa: E402


def run(data_dir, out_dir, say=print):
    """Run the chain. Returns {'ok': bool, 'steps': [...], ...}. Writes eml and demo.json under out_dir."""
    import mailer
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    store = Store(FileBackend(Path(data_dir)))
    demo = notices.build_demo(store)
    if demo is None:
        say("No invoice in the records qualifies for the demo.")
        return {"ok": False, "steps": []}
    inv, n = demo["invoice"], demo["notice"]
    say(f"Chosen invoice: {inv['ref']} from {inv['vendor']}, {inv['currency']} {inv['amount']:,.2f}, status {inv['status']}, "
        f"dated {inv['tran_date']}.")
    say(f"Rule: {demo['rule']}")
    steps = []

    # 1 draft (egress checked before it is kept)
    o = rules.classify_bill(next(b for b in store.backend.all("vendorBill") if b["internalId"] == inv["internal_id"]),
                            store.session(NullTrace()))
    problems = egress_guard.check_outbound(n["text"], [o], n["bills"], recipient=n["to"])
    steps.append({"step": "draft", "ok": not problems, "to": n["to"]})
    say(f"1. Draft: notice to {n['to']} built from the records. Outbound check: {'passed' if not problems else problems}.")

    # 2 approve: a person does this on the page; the headless run records it as the demo's approval
    steps.append({"step": "approve", "ok": not problems})
    say("2. Approve: approved for sending (on the Prevent page a person clicks Approve).")

    # 3 send, simulated
    fresh = notices.build_demo(store)
    stale = fresh is None or fresh["notice"]["text"] != n["text"]
    info = None
    if not problems and not stale:
        info = mailer.OutboxMailer(out_dir / "outbox").send(mailer.Message(
            sender=mailer.default_sender(None), to=n["to"], subject=notices.DEMO_SUBJECT, body=n["text"],
            headers={"X-Conductor-Prevention": f"demo:{inv['internal_id']}"}))
    steps.append({"step": "send", "ok": info is not None, "file": info and info["path"]})
    say(f"3. Send: {'saved ' + info['path'] + ' (simulated, nothing left this computer)' if info else 'not sent'}.")

    # 4 the vendor's own lookup, and the ticket it would have prevented
    lk = notices.demo_lookup(demo, store)
    steps.append({"step": "lookup", "ok": lk["same_answer"], "message": lk["message"]})
    say(f"4. Vendor lookup: {lk['message']}")
    say(f"   Same status and balance as the notice: {'yes' if lk['same_answer'] else 'no'}.")
    tickets = demo["covered_tickets"]
    say(f"   Ticket this notice would have prevented: {', '.join(str(t) for t in tickets) or 'none'}.")

    ok = all(s["ok"] for s in steps) and bool(tickets)
    (out_dir / "demo.json").write_text(json.dumps({"invoice": inv, "notice": n, "steps": steps, "prevented_tickets": tickets},
                                                  indent=1), encoding="utf-8")
    return {"ok": ok, "steps": steps, "invoice": inv, "prevented_tickets": tickets}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", default=str(ROOT / "data"))
    ap.add_argument("--out", default=str(Path(tempfile.gettempdir()) / "conductor-prevention-demo"))
    a = ap.parse_args(argv)
    res = run(a.data, a.out)
    print(f"Output: {a.out}")
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
