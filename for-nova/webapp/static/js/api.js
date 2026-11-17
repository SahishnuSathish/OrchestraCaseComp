// Thin fetch wrapper. The per-launch token is injected into index.html by the server.
const token = document.querySelector('meta[name="ap-token"]')?.content || '';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'X-AP-Token': token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  modelStatus: (force = false) => request('GET', `/api/model/status${force ? '?force=true' : ''}`),
  fsList: (path = '') => request('GET', `/api/fs/list?path=${encodeURIComponent(path)}`),
  validate: (path) => request('POST', '/api/dataset/validate', { path }),
  runs: () => request('GET', '/api/runs'),
  startRun: (body) => request('POST', '/api/runs', body),
  importRun: (path) => request('POST', '/api/runs/import', { path }),
  cancelRun: (id) => request('POST', `/api/runs/${id}/cancel`),
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
    const res = await fetch(path, { headers: { 'X-AP-Token': token } });
    if (!res.ok) throw new ApiError(res.status, 'Export failed');
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
