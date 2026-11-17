"""Tiny local-only client for Ollama /api/chat and /api/embed (standard library only).

Every text that goes out is redacted here, so no caller can skip it. The constructor refuses any URL that is
not a local host (extract_model.is_local); there is no silent fallback to a remote host.
"""
import json
import urllib.error
import urllib.request

import extract_model
from extract_model import redact

EMBED_MODEL = "nomic-embed-text"


class LocalOllama:
    def __init__(self, url=None, timeout=60, keep_alive="30m"):
        url = (url or extract_model.OLLAMA_URL).rstrip("/")
        if not extract_model.is_local(url):
            raise ValueError(f"refusing non-local model host: {url}")
        self.url, self.timeout, self.keep_alive = url, timeout, keep_alive

    def _post(self, path, body, timeout=None):
        req = urllib.request.Request(self.url + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout or self.timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    def available(self, model=None):
        """True if the server answers (and, when `model` is given, has it installed)."""
        try:
            with urllib.request.urlopen(self.url + "/api/tags", timeout=2) as r:
                names = [m.get("name", "") for m in json.loads(r.read().decode("utf-8")).get("models", [])]
        except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError):
            return False
        return True if model is None else any(n == model or n.split(":")[0] == model for n in names)

    def embed(self, texts, model=EMBED_MODEL):
        """Embeddings for redacted copies of `texts`. Returns a list of float vectors, one per text."""
        d = self._post("/api/embed", {"model": model, "input": [redact(t) for t in texts], "keep_alive": self.keep_alive})
        return d["embeddings"]

    def chat_json(self, system, user, schema_model, model=None, num_predict=300):
        """Schema-constrained chat. `user` is redacted. Returns a validated pydantic object or raises."""
        body = {"model": model or extract_model.MODEL, "stream": False, "think": False, "keep_alive": self.keep_alive,
                "format": schema_model.model_json_schema(),
                "options": {"temperature": 0, "num_ctx": 4096, "num_predict": num_predict},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": redact(user)}]}
        d = self._post("/api/chat", body)
        return schema_model.model_validate_json(d["message"]["content"])
