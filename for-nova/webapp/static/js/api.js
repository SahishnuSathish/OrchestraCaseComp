// Thin fetch wrapper. The per-launch token is injected into index.html by the server.
// Connection health is reported through onApiState so the shell can show "restarted" / "can't reach" banners.
const token = document.querySelector('meta[name="ap-token"]')?.content || '';

export class ApiError extends Error {
  // kind: 'network' | 'timeout' | 'auth' | 'http'
  constructor(status, message, kind = 'http') { super(message); this.name = 'ApiError'; this.status = status; this.kind = kind; }
}

const stateListeners = new Set();
let apiState = 'online';
export function onApiState(fn) { stateListeners.add(fn); return () => stateListeners.delete(fn); }
function setApiState(next) {
  if (next === apiState) return;
  apiState = next;
  for (const fn of [...stateListeners]) fn(next);
}

const isAbort = (e) => e?.name === 'AbortError';

function detailText(j, fallback) {
  const d = j?.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map((x) => x?.msg || JSON.stringify(x)).join('; ');
  return d ? JSON.stringify(d) : fallback;
}

async function httpError(res) {
  let msg = res.statusText || `Request failed (${res.status})`;
  try { msg = detailText(await res.json(), msg); } catch { /* not json */ }
  if (res.status === 401) {
    setApiState('expired');
    return new ApiError(401, 'AP Desk was restarted, so this page is out of date. Reload to continue.', 'auth');
  }
  setApiState('online');
  return new ApiError(res.status, msg, 'http');
}

function transportError(timedOut) {
  setApiState('offline');
  return timedOut
    ? new ApiError(0, 'AP Desk took too long to answer.', 'timeout')
    : new ApiError(0, "Can't reach AP Desk on this computer.", 'network');
}

async function send(method, path, body, { signal, timeout = 30000 } = {}) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = timeout ? setTimeout(() => { timedOut = true; ctl.abort(); }, timeout) : 0;
  const onAbort = () => ctl.abort();
  if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  try {
    const res = await fetch(path, {
      method, signal: ctl.signal,
      headers: { 'X-AP-Token': token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return res;
  } catch (e) {
    if (isAbort(e) && !timedOut) throw e; // the caller aborted: not a connection problem
    throw transportError(timedOut);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function request(method, path, body, opts) {
  const res = await send(method, path, body, opts);
  if (!res.ok) throw await httpError(res);
  setApiState('online');
  if (res.status === 204) return null;
  try { return await res.json(); } catch { throw new ApiError(res.status, 'AP Desk sent an unreadable answer.', 'http'); }
}

// Parse one SSE block ("event: x\ndata: y\n...") into [type, data]; comment-only blocks give null.
function parseBlock(block) {
  let type = 'message';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    const val = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') type = val;
    else if (field === 'data') data.push(val);
  }
  if (!data.length) return null;
  const raw = data.join('\n');
  try { return [type, JSON.parse(raw)]; } catch { return [type, raw]; }
}

// POST and read a text/event-stream body. Resolves when the stream ends; rejects with ApiError (HTTP/network) or AbortError.
async function stream(path, body, { signal, onEvent } = {}) {
  const res = await send('POST', path, body ?? {}, { signal, timeout: 0 });
  if (!res.ok) throw await httpError(res);
  setApiState('online');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const flush = (final) => {
    const re = /\r?\n\r?\n/;
    let m;
    while ((m = re.exec(buf))) {
      const parsed = parseBlock(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
      if (parsed) onEvent?.(parsed[0], parsed[1]);
    }
    if (final && buf.trim()) { const parsed = parseBlock(buf); buf = ''; if (parsed) onEvent?.(parsed[0], parsed[1]); }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      flush(false);
    }
    buf += decoder.decode();
    flush(true);
  } catch (e) {
    if (isAbort(e)) throw e;
    throw transportError(false);
  } finally {
    reader.cancel().catch(() => {});
  }
}

export const api = {
  get: (p, opts) => request('GET', p, undefined, opts),
  post: (p, b = {}, opts) => request('POST', p, b, opts),
  put: (p, b, opts) => request('PUT', p, b, opts),
  stream,
  health: (opts) => request('GET', '/api/health', undefined, { timeout: 4000, ...opts }),
  modelStatus: (force = false) => request('GET', `/api/model/status${force ? '?force=true' : ''}`),
  settings: () => request('GET', '/api/settings'),
  saveModelSettings: (body) => request('PUT', '/api/settings/model', body),
  modelTest: (body, opts) => stream('/api/model/test', body, opts),
  fsList: (path = '') => request('GET', `/api/fs/list?path=${encodeURIComponent(path)}`),
  validate: (path) => request('POST', '/api/dataset/validate', { path }),
  runs: (opts) => request('GET', '/api/runs?limit=50', undefined, opts),
  startRun: (body) => request('POST', '/api/runs', body),
  importRun: (path) => request('POST', '/api/runs/import', { path }),
  cancelRun: (id) => request('POST', `/api/runs/${id}/cancel`),
  deleteRun: (id) => request('DELETE', `/api/runs/${id}`),
  run: (id) => request('GET', `/api/runs/${id}`),
  tickets: (id) => request('GET', `/api/runs/${id}/tickets`),
  ticket: (id, tid) => request('GET', `/api/runs/${id}/tickets/${tid}`),
  regenBrief: (id, tid) => request('POST', `/api/runs/${id}/tickets/${tid}/brief`),
  upgradeBriefs: (id) => request('POST', `/api/runs/${id}/briefs/upgrade`),
  review: (id, tid, body) => request('PUT', `/api/runs/${id}/review/${tid}`, body),
  saveDraft: (id, tid, body) => request('PUT', `/api/runs/${id}/review/${tid}/draft`, body),
  send: (id, tid) => request('POST', `/api/runs/${id}/tickets/${tid}/send`, {}),
  bulk: (id, ids, state) => request('POST', `/api/runs/${id}/review/bulk`, { ids, state }),
  events: (id) => new EventSource(`/api/runs/${id}/events?token=${encodeURIComponent(token)}`),
  async download(path, fallbackName) {
    const res = await send('GET', path);
    if (!res.ok) throw await httpError(res);
    const blob = await res.blob();
    const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : fallbackName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
};
