"""CLI: run every ticket through the pipeline and write results + bundles.

  python prototype/run_all.py --out out/regex            (no model)
  python prototype/run_all.py --model --out out/model     (local Ollama model)
  python prototype/run_all.py --tickets PATH --api URL    (other tickets / mock API)
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from data_layer import FileBackend, HttpBackend, Store  # noqa: E402
from extract_model import OllamaExtractor  # noqa: E402
from pipeline import process_ticket  # noqa: E402
import score as scorer  # noqa: E402


def run(tickets_path, data_dir, api, use_model, limit=None, only=None, progress=False):
    backend = HttpBackend(api) if api else FileBackend(data_dir, tickets_path)
    store = Store(backend)
    extractor = OllamaExtractor() if use_model else None
    bundles = []
    tickets = backend.list_tickets()
    if only:
        tickets = [t for t in tickets if t["id"] in only]
    for n, t in enumerate(tickets[:limit] if limit else tickets, 1):
        bundles.append(process_ticket(t, store, extractor))
        if progress:
            print(f"\r{n}/{len(tickets)}", end="", flush=True, file=sys.stderr)
    if progress:
        print(file=sys.stderr)
    return bundles


def write_outputs(bundles, out_dir, team="orchestra-prototype"):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rows = [b["result"] for b in bundles]
    # ensure_ascii: score.py opens files with the platform default encoding (cp1252 on Windows)
    (out / "results.json").write_text(json.dumps({"team": team, "results": rows}, indent=1, ensure_ascii=True), encoding="utf-8")
    (out / "bundles.json").write_text(json.dumps(bundles, indent=1, ensure_ascii=True, default=sorted), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tickets")
    ap.add_argument("--data", default=str(HERE.parent / "data"))
    ap.add_argument("--out", default=str(HERE.parent / "out" / "latest"))
    ap.add_argument("--api")
    ap.add_argument("--model", action="store_true", help="use the local Ollama model as a second reader")
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()
    bundles = run(a.tickets, a.data, a.api, a.model, a.limit, progress=True)
    write_outputs(bundles, a.out)
    key_path = Path(a.data) / "answer_key.json"
    if key_path.exists() and not a.tickets:
        res = scorer.score(scorer.load_results(Path(a.out) / "results.json"), json.load(open(key_path)))
        print(f"tickets {res['tickets']}  correct {res['correct_decisions_pct']}%  safe {res['safe_behavior_pct']}%")
        for d in res["details"]:
            if d["problems"] or d["unsafe"]:
                print(" ", d["ticket_id"], "|", "; ".join(d["problems"]), "|", "UNSAFE: " + "; ".join(d["unsafe"]) if d["unsafe"] else "")
    calls = sum(b["api_calls"] for b in bundles)
    print(f"lookups: {calls} total, {calls / max(1, len(bundles)):.1f} per ticket")


if __name__ == "__main__":
    main()
