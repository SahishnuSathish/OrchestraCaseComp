// App state: the active run, its ticket rows, live progress (server-sent events), the model status and connection health.
import { api, onApiState } from './api.js';
import { ls } from './lib.js';

const listeners = new Set();
export const S = {
  runId: null, run: null, rows: [], byId: new Map(), model: null, settings: null,
  conn: 'ok', // ok | offline | expired
  progress: { status: 'idle', total: 0, done: 0, working: null, elapsed: 0, warnings: [], error: null },
  es: null,
};

export function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(kind, data) { for (const fn of [...listeners]) fn(kind, data); }

onApiState((s) => { S.conn = s === 'online' ? 'ok' : s; emit('conn'); });

export const isActive = (run) => !!run && (run.status === 'starting' || run.status === 'running');

// Per-run, per-view memory that survives leaving a page: { query (route query object), scrollTop, ticketId }.
const memory = new Map();
const blank = () => ({ query: {}, scrollTop: 0, ticketId: null });
export const viewState = {
  get: (runId, view) => ({ ...blank(), ...memory.get(`${runId}:${view}`) }),
  set: (runId, view, patch) => { memory.set(`${runId}:${view}`, { ...blank(), ...memory.get(`${runId}:${view}`), ...patch }); },
};

function setRows(rows) {
  S.rows = rows;
  S.byId = new Map(rows.map((r) => [r.ticket_id, r]));
}

export function upsertRow(row) {
  const cur = S.byId.get(row.ticket_id);
  if (cur) Object.assign(cur, row);
  else {
    const r = { review_state: 'pending', brief_source: 'template', ...row };
    S.rows.push(r);
    S.byId.set(r.ticket_id, r);
  }
}

export function patchRow(tid, patch) {
  const r = S.byId.get(Number(tid));
  if (r) Object.assign(r, patch);
  return r;
}

export function pendingDrafts() {
  return S.rows.filter((r) => r.output_type === 'draft_reply' && r.review_state === 'pending').length;
}

function closeStream() { if (S.es) { S.es.close(); S.es = null; } }

function progressFromRun(run) {
  const elapsed = run.finished_at && run.started_at ? run.finished_at - run.started_at : 0;
  S.progress = { status: run.status, total: run.total || 0, done: run.done || 0, working: null, elapsed, warnings: run.warnings || [], error: run.error || null, useModel: !!run.use_model };
}

let loadSeq = 0;
// Rejects with the ApiError (status 404 = no such run). Returns null when a newer loadRun superseded this one.
export async function loadRun(id) {
  const seq = ++loadSeq;
  const [run, t] = await Promise.all([api.run(id), api.tickets(id)]);
  if (seq !== loadSeq) return null;
  closeStream();
  S.runId = id;
  S.run = run;
  setRows(t.rows);
  progressFromRun(run);
  ls('ap.run', id);
  connect(id);
  emit('run');
  maybeUpgradeBriefs();
  return run;
}

// Opening an older run: upgrade template briefs to local-model briefs in the background once the model is known to be up.
// Tried once per run per page load; also called after each model check because the shell does not wait for the first one.
const upgradeTried = new Set();
function maybeUpgradeBriefs() {
  if (!S.runId || !S.model?.usable || isActive(S.run) || upgradeTried.has(S.runId)) return;
  if (!S.rows.some((r) => r.brief_source !== 'model')) return;
  upgradeTried.add(S.runId);
  api.upgradeBriefs(S.runId).catch(() => {});
}

export async function refreshRun() {
  if (!S.runId) return;
  try { S.run = await api.run(S.runId); emit('run'); } catch { /* ignore */ }
}

export function forgetRun() {
  loadSeq++;
  closeStream();
  S.runId = null; S.run = null; setRows([]);
  S.progress = { status: 'idle', total: 0, done: 0, working: null, elapsed: 0, warnings: [], error: null };
  ls('ap.run', null);
  emit('run');
}

// When the event stream breaks, ask the server once whether it is still there so the shell can show the right banner.
let healthTimer = 0;
function probeHealth() {
  clearTimeout(healthTimer);
  healthTimer = setTimeout(() => { api.health().catch(() => {}); }, 1500);
}

function connect(id) {
  const es = api.events(id);
  S.es = es;
  const parse = (e) => { try { return JSON.parse(e.data); } catch { return {}; } };
  es.addEventListener('error', probeHealth);
  es.addEventListener('start', (e) => {
    const d = parse(e);
    S.progress = { status: 'running', total: d.total, done: 0, working: null, elapsed: 0, warnings: S.progress.warnings || [], error: null, useModel: d.use_model };
    emit('progress');
  });
  es.addEventListener('working', (e) => { S.progress.working = parse(e); emit('progress'); });
  es.addEventListener('warning', (e) => { S.progress.warnings = [...(S.progress.warnings || []), parse(e).message]; emit('progress'); });
  es.addEventListener('ticket', (e) => {
    const d = parse(e);
    upsertRow(d.row);
    Object.assign(S.progress, { status: 'running', done: d.done, total: d.total, elapsed: d.elapsed });
    emit('ticket', d.row);
    emit('progress');
  });
  es.addEventListener('done', async (e) => {
    const d = parse(e);
    Object.assign(S.progress, { status: 'done', done: d.done, elapsed: d.elapsed, working: null });
    await refreshRun();
    emit('progress');
  });
  es.addEventListener('cancelled', async () => { S.progress.status = 'cancelled'; S.progress.working = null; await refreshRun(); emit('progress'); });
  es.addEventListener('failed', (e) => { Object.assign(S.progress, { status: 'failed', error: parse(e).message, working: null }); emit('progress'); });
  es.addEventListener('brief', (e) => {
    const d = parse(e);
    patchRow(d.ticket_id, { brief_source: d.source });
    emit('brief', d);
  });
  // Another tab (or this one) changed a review decision.
  es.addEventListener('review', (e) => {
    const d = parse(e);
    if (d.ticket_id == null) return;
    patchRow(d.ticket_id, { review_state: d.state });
    emit('review', d);
  });
}

// ---------------------------------------------------------------------------- model + settings
let modelTimer = null;
export async function refreshModel(force = false) {
  try {
    S.model = await api.modelStatus(force);
  } catch (e) {
    // A connection problem says nothing about the model: keep what we knew. The shell shows the banner.
    if (!S.model || e.kind === 'http') S.model = { state: 'unreachable', reachable: false, usable: false, model: '', error: e.message };
  }
  emit('model');
  maybeUpgradeBriefs();
  return S.model;
}
export function pollModel() {
  clearInterval(modelTimer);
  modelTimer = setInterval(() => { if (!document.hidden) refreshModel(); }, 20000);
  return refreshModel();
}

export async function refreshSettings() {
  S.settings = await api.settings();
  emit('settings');
  return S.settings;
}
