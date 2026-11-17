"""Unusual-wording detector (embeddings). A net for phrasing the keyword families never saw.

Reference corpus: the redacted subject and body of the practice tickets only (never answer_key.json), embedded
once with nomic-embed-text and cached. Novelty = 1 - max cosine similarity to the corpus. The threshold is the 95th
percentile of leave-one-out novelty over the corpus itself, so nothing is hand-tuned.

annotate  writes bundle["readers"]["novelty"] and changes nothing else.
guard     additionally turns a draft_reply (except a holding reply) into an internal note for a person.
          It can never touch a no_draft or an existing note, and never clears a flag: caution only.
"""
import hashlib
import json
import math
import threading
from pathlib import Path

import extract_model
from data_layer import load_tickets_file
from model_client import EMBED_MODEL, LocalOllama
from ticket_view import build_view

ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = ROOT / "out" / ".cache" / "embed"
BATCH = 16


def cosine(a, b):
    da = math.sqrt(sum(x * x for x in a)) or 1.0
    db = math.sqrt(sum(x * x for x in b)) or 1.0
    return sum(x * y for x, y in zip(a, b)) / (da * db)


def percentile(values, q):
    v = sorted(values)
    return v[min(len(v) - 1, int(math.ceil(q * len(v))) - 1)] if v else 0.0


class NoveltyReader:
    name = "novelty"

    def __init__(self, store, mode="annotate", client=None, corpus_path=None, cache_dir=CACHE_DIR, embed_model=EMBED_MODEL):
        if mode not in ("annotate", "guard"):
            raise ValueError(mode)
        self.store, self.mode, self.embed_model = store, mode, embed_model
        self.client = client or LocalOllama()
        self.corpus_path = Path(corpus_path) if corpus_path else ROOT / "data" / "tickets.json"
        self.cache_dir = Path(cache_dir)
        self._corpus = None
        self._memo = {}
        self._lock = threading.Lock()

    # ---- corpus
    def _texts(self):
        tf = load_tickets_file(self.corpus_path)
        users = {u["id"]: u for u in tf.get("users", [])}
        out = []
        for t in tf["tickets"]:
            out.append((t["id"], extract_model.build_prompt(build_view(t, lambda uid: users.get(int(uid))))))
        return out

    def _embed_all(self, texts):
        vecs = []
        for i in range(0, len(texts), BATCH):
            vecs += self.client.embed(texts[i:i + BATCH], self.embed_model)
        return vecs

    def corpus(self):
        with self._lock:
            if self._corpus is not None:
                return self._corpus
            items = self._texts()
            sha = hashlib.sha256((self.embed_model + "\n".join(f"{i}:{t}" for i, t in items)).encode("utf-8")).hexdigest()[:20]
            path = self.cache_dir / f"corpus_{sha}.json"
            if path.is_file():
                self._corpus = json.loads(path.read_text(encoding="utf-8"))
                return self._corpus
            vecs = self._embed_all([t for _, t in items])
            loo = []
            for i, v in enumerate(vecs):
                best = max((cosine(v, w) for j, w in enumerate(vecs) if j != i), default=0.0)
                loo.append(1 - best)
            self._corpus = {"ids": [i for i, _ in items], "vectors": vecs, "threshold": percentile(loo, 0.95),
                            "loo_max": max(loo) if loo else 0.0}
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._corpus), encoding="utf-8")
            tmp.replace(path)
            return self._corpus

    # ---- scoring
    def score(self, view):
        """(novelty, nearest practice ticket id, threshold). Raises if the embedding model is unavailable."""
        prompt = extract_model.build_prompt(view)
        if prompt in self._memo:
            return self._memo[prompt]
        c = self.corpus()
        v = self.client.embed([prompt], self.embed_model)[0]
        sims = [cosine(v, w) for w in c["vectors"]]
        k = max(range(len(sims)), key=sims.__getitem__)
        res = (round(1 - sims[k], 4), c["ids"][k], c["threshold"])
        self._memo[prompt] = res
        return res

    def score_view(self, view):
        """True when novel. Used by the gate; never raises (an unavailable embedder counts as not novel)."""
        try:
            s, _, th = self.score(view)
            return s > th
        except Exception:
            return False

    # ---- post-reader
    def apply(self, bundle, ticket, store):
        readers = bundle.setdefault("readers", {})
        try:
            view = build_view(ticket, store.backend.user)
            s, nearest, th = self.score(view)
        except Exception:
            readers["novelty"] = {"skipped": "embedding model unavailable"}
            return
        novel = s > th
        readers["novelty"] = {"score": s, "threshold": round(th, 4), "nearest_ticket_id": nearest, "novel": novel}
        res, dec = bundle["result"], bundle["decision"]
        if self.mode == "guard" and novel and res["output_type"] == "draft_reply" and dec["rule"] != "holding_reply":
            res["text"] = ("Unusual wording: this message reads unlike past tickets, so a person should confirm the intent "
                           "before replying. Proposed reply for review:\n\n" + res["text"])
            res["output_type"], res["recipient"] = "internal_action_note", None
            dec["rule"] = "novelty_guard"
            dec["why"] = f"unusual wording (novelty {s} above {round(th, 4)}); nearest practice ticket {nearest}"
            readers["novelty"]["guarded"] = True
