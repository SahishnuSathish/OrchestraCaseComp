"""The local model (Ollama) as the web app sees it: which server and model are selected, whether they work,
a streaming "try it" call, and factories that build the pipeline's reader and the brief writer from the CURRENT
selection (so changing the model in Settings is picked up by the next run, brief and test, never a stale client).

Precedence for every setting: saved in the app database > environment (OLLAMA_URL, OLLAMA_MODEL) > built-in default.
Only local hosts are ever contacted (extract_model.is_local). Standard library + pydantic only.
"""
import http.client
import json
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
for _p in (str(HERE.parents[1] / "src"), str(HERE.parents[1])):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import db  # noqa: E402
import extract_model  # noqa: E402

DEFAULT_URL = "http://127.0.0.1:11434"
DEFAULT_MODEL = "qwen3.5:9b"
DEFAULT_TIMEOUT = 120
PROBE_TIMEOUT = 4.0   # Windows takes ~2 s to refuse a connection to a closed localhost port; a shorter limit reports that as "too slow"
SETTING_KEY = "model"
UNSET = object()

NOT_LOCAL_MSG = ("Only a model server on this computer or your local network name can be used "
                 "(localhost, 127.0.0.1, *.local, *.internal). Ticket text is never sent anywhere else.")
_MODEL_RE = re.compile(r"^[A-Za-z0-9._:/-]{1,120}$")


# ---------------------------------------------------------------------------- configuration
def _saved():
    d = db.get_setting(SETTING_KEY, {})
    return d if isinstance(d, dict) else {}


def defaults():
    return {"url": DEFAULT_URL, "model": DEFAULT_MODEL, "timeout_s": DEFAULT_TIMEOUT}


def get_config():
    saved = _saved()
    cfg, source = {}, {}
    env_vals = {"url": extract_model.OLLAMA_URL, "model": extract_model.MODEL}
    for key in ("url", "model"):
        if saved.get(key):
            cfg[key], source[key] = saved[key], "saved"
        elif env_vals[key] != defaults()[key]:
            cfg[key], source[key] = env_vals[key], "env"
        else:
            cfg[key], source[key] = defaults()[key], "default"
    t = saved.get("timeout_s")
    if isinstance(t, int) and not isinstance(t, bool) and 5 <= t <= 600:
        cfg["timeout_s"], source["timeout_s"] = t, "saved"
    else:
        cfg["timeout_s"], source["timeout_s"] = DEFAULT_TIMEOUT, "default"
    cfg["url"] = str(cfg["url"]).rstrip("/")
    cfg["source"] = source
    return cfg


def config_signature():
    c = get_config()
    return (c["url"], c["model"], c["timeout_s"])


def _validate_url(url):
    if not isinstance(url, str):
        raise ValueError("The server address must be text such as http://127.0.0.1:11434.")
    u = url.strip().rstrip("/")
    p = urlparse(u)
    try:
        host, _ = p.hostname, p.port
    except ValueError:
        host = None
    if p.scheme not in ("http", "https") or not host:
        raise ValueError("Enter the server address as http://host:port, for example http://127.0.0.1:11434.")
    if not extract_model.is_local(u):
        raise ValueError(NOT_LOCAL_MSG)
    return u


def _validate_model(name):
    if not isinstance(name, str) or not _MODEL_RE.match(name.strip()):
        raise ValueError("A model name is 1 to 120 characters: letters, digits and . _ : / - only.")
    return name.strip()


def _validate_timeout(t):
    if isinstance(t, bool) or not isinstance(t, int) or not 5 <= t <= 600:
        raise ValueError("The time limit must be a whole number of seconds from 5 to 600.")
    return t


def set_config(url=UNSET, model=UNSET, timeout_s=UNSET):
    """Save the given keys (None clears one). Raises ValueError(plain message) and saves nothing if any is invalid."""
    saved = dict(_saved())
    for key, val, check in (("url", url, _validate_url), ("model", model, _validate_model),
                            ("timeout_s", timeout_s, _validate_timeout)):
        if val is UNSET:
            continue
        if val is None:
            saved.pop(key, None)
        else:
            saved[key] = check(val)
    if saved:
        db.set_setting(SETTING_KEY, saved)
    else:
        db.delete_setting(SETTING_KEY)
    invalidate()
    return get_config()


def settings_payload():
    c = get_config()
    return {"model": {"url": c["url"], "model": c["model"], "timeout_s": c["timeout_s"], "source": c["source"],
                      "defaults": defaults()}}


# ---------------------------------------------------------------------------- status
_cache = {"t": 0.0, "sig": None, "v": None}
_cache_lock = threading.Lock()


def invalidate():
    with _cache_lock:
        _cache.update(t=0.0, sig=None, v=None)


def _host(url):
    return re.sub(r"^https?://", "", url).rstrip("/")


def _is_timeout(e):
    if isinstance(e, (socket.timeout, TimeoutError)):
        return True
    return isinstance(e, urllib.error.URLError) and isinstance(getattr(e, "reason", None), (socket.timeout, TimeoutError))


def _unreachable_message(e, host):
    if _is_timeout(e):
        return "The model server took too long to answer."
    return f"Nothing is answering at {host}. Start Ollama, then check again."


def _get_json(url, timeout):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _model_entry(m):
    d = m.get("details") or {}
    return {"name": m.get("name") or m.get("model"), "size_bytes": m.get("size"), "parameter_size": d.get("parameter_size"),
            "family": d.get("family"), "quantization": d.get("quantization_level"), "modified_at": m.get("modified_at")}


def _name_matches(selected, name):
    return name == selected or (":" not in selected and name == selected + ":latest")


def _probe(cfg):
    url, model = cfg["url"], cfg["model"]
    host = _host(url)
    local = extract_model.is_local(url)
    v = {"state": "not_local", "usable": False, "reachable": False, "installed": False, "local": local, "url": url,
         "host": host, "model": model, "version": None, "models": [], "error": None, "checked_at": time.time(),
         "timeout_s": cfg["timeout_s"], "source": {"url": cfg["source"]["url"], "model": cfg["source"]["model"]},
         "briefs_pending": 0}
    if not local:
        v["error"] = NOT_LOCAL_MSG
        return v
    try:
        tags = _get_json(url + "/api/tags", PROBE_TIMEOUT)
    except urllib.error.HTTPError as e:
        v.update(state="unreachable", error=f"The model server answered with an error (HTTP {e.code}).")
        return v
    except (urllib.error.URLError, OSError, ValueError) as e:
        v.update(state="unreachable", error=_unreachable_message(e, host))
        return v
    v["reachable"] = True
    v["models"] = [_model_entry(m) for m in (tags.get("models") or []) if isinstance(m, dict)]
    try:
        v["version"] = _get_json(url + "/api/version", PROBE_TIMEOUT).get("version")
    except Exception:
        pass
    names = [m["name"] for m in v["models"] if m["name"]]
    v["installed"] = any(_name_matches(model, n) for n in names)
    if not names:
        v.update(state="no_models", error="No models are installed on the model server. Install one with: ollama pull " + model)
    elif not v["installed"]:
        v.update(state="model_missing", error=f"{model} is not installed on this computer. Install it with: ollama pull {model}")
    else:
        v.update(state="ready", usable=True)
    return v


def status(force=False):
    cfg = get_config()
    sig = (cfg["url"], cfg["model"], cfg["timeout_s"])
    with _cache_lock:
        if not force and _cache["v"] is not None and _cache["sig"] == sig and time.time() - _cache["t"] < 5:
            return dict(_cache["v"])
    v = _probe(cfg)
    with _cache_lock:
        _cache.update(t=time.time(), sig=sig, v=v)
    return dict(v)


# ---------------------------------------------------------------------------- streaming "try it"
class Upstream:
    """Handle on the in-flight HTTP request so another thread can abort it (closing the socket makes Ollama stop)."""

    def __init__(self):
        self.conn = None
        self.closed = False
        self._lock = threading.Lock()

    def attach(self, conn):
        with self._lock:
            self.conn = conn
            if self.closed:
                self._kill()

    def _kill(self):
        c = self.conn
        if c is None:
            return
        try:
            if c.sock is not None:
                try:
                    c.sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            c.close()
        except Exception:
            pass

    def close(self):
        with self._lock:
            self.closed = True
            self._kill()


def _request_body(text, model):
    return {"model": model, "stream": True, "think": False, "keep_alive": "30m",
            "format": extract_model.ModelReading.model_json_schema(),
            "options": {"temperature": 0, "num_ctx": 4096, "num_predict": 400},
            "messages": [{"role": "system", "content": extract_model.SYSTEM},
                         {"role": "user", "content": "Subject: (test message)\nBody:\n" + text}]}


def stream_reading(text, model=None, cancel=None, upstream=None):
    """Yield (event, data) tuples: start, token*, then exactly one of done / error. Returns silently when cancelled.

    `cancel` is a threading.Event; `upstream` (an Upstream) lets the caller close the connection from another thread.
    """
    cancel = cancel or threading.Event()
    upstream = upstream or Upstream()
    cfg = get_config()
    url, model = cfg["url"], (model or cfg["model"])
    host = _host(url)
    if not extract_model.is_local(url):
        yield "error", {"kind": "not_local", "message": NOT_LOCAL_MSG}
        return
    sent = extract_model.redact(text)
    yield "start", {"model": model, "host": host, "sent": sent}
    p = urlparse(url)
    t0 = time.perf_counter()
    conn = None
    try:
        cls = http.client.HTTPSConnection if p.scheme == "https" else http.client.HTTPConnection
        conn = cls(p.hostname, p.port, timeout=cfg["timeout_s"])
        upstream.attach(conn)
        payload = json.dumps(_request_body(sent, model)).encode("utf-8")
        conn.request("POST", (p.path.rstrip("/") or "") + "/api/chat", payload, {"Content-Type": "application/json"})
        resp = conn.getresponse()
        if resp.status != 200:
            detail = ""
            try:
                detail = json.loads(resp.read().decode("utf-8", "replace")).get("error", "")
            except Exception:
                pass
            if resp.status == 404:
                yield "error", {"kind": "model_missing",
                                "message": f"{model} is not installed on this computer. Install it with: ollama pull {model}"}
            else:
                yield "error", {"kind": "http", "message": f"The model server answered with an error (HTTP {resp.status})."
                                + (f" {detail[:160]}" if detail else "")}
            return
        parts, tokens, final = [], 0, {}
        while True:
            line = resp.readline()
            if cancel.is_set():
                return
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line.decode("utf-8"))
            except ValueError:
                continue
            if obj.get("error"):
                yield "error", {"kind": "http", "message": f"The model reported an error: {str(obj['error'])[:160]}"}
                return
            chunk = (obj.get("message") or {}).get("content") or ""
            if chunk:
                parts.append(chunk)
                tokens += 1
                yield "token", {"text": chunk}
            if obj.get("done"):
                final = obj
                break
        if cancel.is_set():
            return
        raw = "".join(parts)
        reading, problem = None, None
        try:
            reading = extract_model.ModelReading.model_validate_json(raw).model_dump()
        except Exception as e:
            first = (str(e).splitlines() or [""])[0][:120]
            problem = "The output did not match the reader's form" + (f": {first}" if first else ".")
        yield "done", {"ms": round((time.perf_counter() - t0) * 1000), "tokens": final.get("eval_count") or tokens,
                       "raw": raw, "reading": reading, "problem": problem}
    except Exception as e:
        if cancel.is_set() or upstream.closed:
            return
        if _is_timeout(e):
            yield "error", {"kind": "timeout", "message": "The model server took too long to answer."}
        elif isinstance(e, (OSError, http.client.HTTPException)):
            yield "error", {"kind": "unreachable", "message": f"Nothing is answering at {host}. Start Ollama, then try again."}
        else:
            yield "error", {"kind": "http", "message": f"The test could not be completed ({type(e).__name__})."}
    finally:
        upstream.close()


# ---------------------------------------------------------------------------- factories
def make_extractor(store=None):
    """The pipeline's model reader for the current selection (gated + cached when a store is given)."""
    cfg = get_config()
    ex = extract_model.OllamaExtractor(url=cfg["url"], model=cfg["model"], timeout=cfg["timeout_s"])
    if store is not None:
        from cache import CachedExtractor
        from gate import GatedExtractor
        ex = CachedExtractor(GatedExtractor(ex, store))
    return ex


def make_summarizer():
    import summarize
    cfg = get_config()
    return summarize.OllamaSummarizer(url=cfg["url"], model=cfg["model"], timeout=cfg["timeout_s"])
