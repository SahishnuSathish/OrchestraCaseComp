// Shared HTTP layer for every api-*.js module (docs/phase3/CONTRACTS.md section 12).
// Adds the per-launch token and this tab's session. A 401 clears the session and returns to the sign-in hub.
// Phase 3 seam. Owner after the seam: p3/identity-live.

const SESSION_KEY = 'conductor.session';

function readToken() {
  try { return document.querySelector('meta[name="ap-token"]')?.content || ''; } catch { return ''; }
}

export const session = {
  get() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
  },
  set(value) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(value)); } catch { /* private mode: session lasts this page only */ }
  },
  clear() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  },
};

export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export function headers(extra = {}) {
  const h = { 'X-AP-Token': readToken(), ...extra };
  const s = session.get();
  if (s?.session) h['X-Conductor-Session'] = s.session;
  return h;
}

function onUnauthorized() {
  session.clear();
  if (location.pathname !== '/') location.assign('/');
}

async function errorFrom(res) {
  let detail = null;
  try { detail = (await res.json()).detail; } catch { /* not JSON */ }
  const message = typeof detail === 'string' ? detail : `Request failed (${res.status}).`;
  return new HttpError(res.status, message, detail);
}

export async function request(method, path, body, { signal, raw = false, redirectOn401 = true } = {}) {
  const res = await fetch(path, {
    method,
    signal,
    headers: headers(body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer) ? { 'Content-Type': 'application/json' } : {}),
    body: body === undefined ? undefined : (body instanceof Blob || body instanceof ArrayBuffer ? body : JSON.stringify(body)),
  });
  if (res.status === 401 && redirectOn401) onUnauthorized();
  if (!res.ok) throw await errorFrom(res);
  if (raw) return res;
  const type = res.headers.get('content-type') || '';
  return type.includes('application/json') ? res.json() : res.text();
}

export const getJSON = (path, opts) => request('GET', path, undefined, opts);
export const postJSON = (path, body = {}, opts) => request('POST', path, body, opts);
export const putJSON = (path, body = {}, opts) => request('PUT', path, body, opts);
export const del = (path, opts) => request('DELETE', path, undefined, opts);

// Fetch a file with this tab's headers and return an object URL (blob:) for preview or download.
export async function blob(path, opts) {
  const res = await request('GET', path, undefined, { ...opts, raw: true });
  return URL.createObjectURL(await res.blob());
}

// A single-use ticket for EventSource, which cannot send headers (CONTRACTS.md section 3).
export async function liveTicket() {
  const r = await postJSON('/api/live/ticket');
  return r.ticket;
}
