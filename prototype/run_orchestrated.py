"""CLI: the pipeline wrapped by the orchestrator. With every flag at its default the results are identical to
run_all.py (acceptance gate 1).

  python prototype/run_orchestrated.py --out out/orch_off
  python prototype/run_orchestrated.py --model --workers 2 --novelty annotate --reports --out out/orch_model
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import extract_model  # noqa: E402
from data_layer import FileBackend, HttpBackend, Store  # noqa: E402
from orchestrator import Orchestrator, collect_stats  # noqa: E402
from run_all import write_outputs  # noqa: E402
import score as scorer  # noqa: E402


def build_extractor(use_model, gate, cache, store, novelty_fn=None):
    """CachedExtractor( GatedExtractor( OllamaExtractor ) ) or None. Raises at start-up for a non-local host."""
    if not use_model:
        return None
    if not extract_model.is_local(extract_model.OLLAMA_URL):
        raise SystemExit(f"refusing non-local model host: {extract_model.OLLAMA_URL}")
    ex = extract_model.OllamaExtractor()
    if gate != "never":
        from gate import GatedExtractor
        ex = GatedExtractor(ex, store, mode=gate, novelty_fn=novelty_fn)
    if cache:
        from cache import CachedExtractor
        ex = CachedExtractor(ex)
    return ex


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--tickets")
    ap.add_argument("--data", default=str(HERE.parent / "data"))
    ap.add_argument("--out", default=str(HERE.parent / "out" / "orchestrated"))
    ap.add_argument("--api")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--ids", help="comma-separated ticket ids")
    ap.add_argument("--model", action="store_true")
    ap.add_argument("--gate", choices=["auto", "always", "never"], default="auto")
    ap.add_argument("--cache", action=argparse.BooleanOptionalAction, default=True)
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--novelty", choices=["off", "annotate", "guard"], default="off")
    ap.add_argument("--summaries", action="store_true")
    ap.add_argument("--reports", action="store_true")
    a = ap.parse_args(argv)

    backend = HttpBackend(a.api) if a.api else FileBackend(a.data, a.tickets)
    store = Store(backend)
    tickets = backend.list_tickets()
    if a.ids:
        want = {int(x) for x in a.ids.split(",")}
        tickets = [t for t in tickets if t["id"] in want]
    if a.limit:
        tickets = tickets[: a.limit]

    readers, novelty_fn = [], None
    if a.novelty != "off":
        from novelty import NoveltyReader
        nr = NoveltyReader(store, mode=a.novelty)
        readers.append(nr)
        novelty_fn = nr.score_view
    if a.summaries:
        from note_summary import NoteSummaryReader
        readers.append(NoteSummaryReader())
    extractor = build_extractor(a.model, a.gate, a.cache, store, novelty_fn)
    if a.model and a.workers > 1:
        print(f"hint: set OLLAMA_NUM_PARALLEL >= {a.workers}; on an 8 GB GPU use --workers 2 with the model.", file=sys.stderr)

    bundles = Orchestrator(store, extractor, a.workers, readers).run(tickets)
    write_outputs(bundles, a.out)
    stats = collect_stats(bundles)
    out = Path(a.out)
    (out / "orchestrator.json").write_text(json.dumps(stats, indent=1), encoding="utf-8")

    key = Path(a.data) / "answer_key.json"
    if key.exists() and not a.tickets and not a.ids and not a.limit:
        res = scorer.score(scorer.load_results(out / "results.json"), json.load(open(key)))
        print(f"tickets {res['tickets']}  correct {res['correct_decisions_pct']}%  safe {res['safe_behavior_pct']}%")
        for d in res["details"]:
            if d["problems"] or d["unsafe"]:
                print(" ", d["ticket_id"], "|", "; ".join(d["problems"]), "|", "UNSAFE: " + "; ".join(d["unsafe"]) if d["unsafe"] else "")
    print("stats:", json.dumps(stats))
    if a.reports:
        import reports
        reports.build_all(out, store)
    return bundles


if __name__ == "__main__":
    main()
