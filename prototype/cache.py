"""Disk cache for model readings, so re-runs and eval loops cost nothing.

The key covers the model name, the system prompt, the output schema and the redacted prompt, so if
extract_model.SYSTEM or ModelReading changes the old entries simply stop matching. Only readings are stored
(refs, vendor names, cues, a short safety reason); gated or failed results are never cached. Writes are
atomic so worker threads cannot collide.
"""
import hashlib
import json
import os
import tempfile
from pathlib import Path

import extract_model
from extract_model import ModelReading

DEFAULT_DIR = Path(__file__).resolve().parents[1] / "out" / ".cache" / "model"


class CachedExtractor:
    def __init__(self, inner, cache_dir=DEFAULT_DIR):
        self.inner, self.dir = inner, Path(cache_dir)
        self.dir.mkdir(parents=True, exist_ok=True)

    @property
    def model(self):
        return getattr(self.inner, "model", "unknown")

    def key(self, view):
        blob = (self.model + extract_model.SYSTEM + json.dumps(ModelReading.model_json_schema(), sort_keys=True)
                + extract_model.build_prompt(view))
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def read(self, view):
        # A ticket the gate would skip is never answered from the cache, so results do not depend on cache state.
        would_skip = getattr(self.inner, "would_skip", None)
        if would_skip and would_skip(view):
            return self.inner.read(view)
        path = self.dir / (self.key(view) + ".json")
        if path.is_file():
            try:
                reading = ModelReading.model_validate_json(path.read_text(encoding="utf-8"))
                return reading, {"model": self.model, "host": "cache", "local": True, "attempts": 0, "error": None,
                                 "ms": 0, "cache": "hit", "gated": False}
            except ValueError:
                pass  # corrupt entry: fall through and recompute
        reading, info = self.inner.read(view)
        if reading is not None:
            fd, tmp = tempfile.mkstemp(dir=self.dir, suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(reading.model_dump_json())
            os.replace(tmp, path)
            info = dict(info, cache="miss")
        return reading, info
