"""Runs the batch tools (no model) over a finished output folder and writes their files.

  python src/reports.py --out out/regex [--all-pending]
Writes: same_invoice_groups.json, approver_digests.json, proactive_notices.json, deflection.json, DEFLECTION_REPORT.md
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import approver_digest  # noqa: E402
import batch_groups  # noqa: E402
import deflection_report  # noqa: E402
import notices as notices_mod  # noqa: E402


def _dump(path, obj):
    Path(path).write_text(json.dumps(obj, indent=1, ensure_ascii=True, default=sorted), encoding="utf-8")


def build_all(out_dir, store, all_pending=False):
    out = Path(out_dir)
    bundles = json.loads((out / "bundles.json").read_text(encoding="utf-8"))
    index = batch_groups.ticket_index(bundles, store)
    groups = batch_groups.build(index)
    digests = approver_digest.build(index, store, all_pending=all_pending)
    notices = notices_mod.build(store)
    notices["covered_tickets"] = notices_mod.coverage(notices["notices"], index)
    orch = None
    if (out / "orchestrator.json").is_file():
        orch = json.loads((out / "orchestrator.json").read_text(encoding="utf-8"))
    report = deflection_report.build(index, notices, digests, groups, orch)
    _dump(out / "same_invoice_groups.json", groups)
    _dump(out / "approver_digests.json", digests)
    _dump(out / "proactive_notices.json", notices)
    deflection_report.write(report, out)
    print(f"reports written to {out}: {report['self_servable']['count']}/{report['tickets']} self-servable, "
          f"{len(notices['notices'])} notices, {digests['summary']}")
    return report


def main():
    from data_layer import FileBackend, Store
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--data", default=str(HERE.parent / "data"))
    ap.add_argument("--all-pending", action="store_true")
    a = ap.parse_args()
    build_all(a.out, Store(FileBackend(a.data)), a.all_pending)


if __name__ == "__main__":
    main()
