# Changes wanted in files this work did not edit

1. **UI agent (webapp/static):** briefs now have 4 or 5 bullets labelled Issue, Sources, Reply, Next and optionally Watch. The UI session said it is adding Next styling. Nothing else is needed from the front end.
2. **Pipeline owner (`prototype/pipeline.py`):** the bundle does not carry vendor, invoice references or per-item status in structured form, so `brief_facts.py` and `batch_groups.py` re-derive them with an untraced session. If the bundle gained `bundle["items"]` (ref, status, vendor id) and `bundle["vendor"]`, both could drop the re-derivation.
3. **Pipeline owner (`prototype/run_all.py`):** no per-ticket try/except. The orchestrator wraps it, so `run_all.py` still stops on a crash.
4. **Cache info (`prototype/cache.py`, mine):** a cache hit does not carry the gate's `signals`, so the dashboard cannot show why a ticket was gated on cached runs. Cosmetic.
5. **Machine setup:** `ollama pull nomic-embed-text` (about 270 MB) for `--novelty`.
