// App state: the active run, its ticket rows, live progress (server-sent events), and the model status.
import { api } from './api.js';
import { ls } from './lib.js';

const listeners = new Set();
export const S = {
  runId: null, run: null, rows: [], byId: new Map(), model: null,
  progress: { status: 'idle', total: 0, done: 0, working: null, elapsed: 0, warnings: [], error: null },
  es: null,
};

export function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(kind, data) { for (const fn of [...listeners]) fn(kind, data); }

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
  S.progress = { status: run.status, total: run.total || 0, done: run.done || 0, working: null, elapsed, warnings: [], error: run.error || null, useModel: !!run.use_model };
}

export async function loadRun(id) {
  closeStream();
  const [run, t] = await Promise.all([api.run(id), api.tickets(id)]);
  S.runId = id;
  S.run = run;
  setRows(t.rows);
  progressFromRun(run);
  ls('ap.run', id);
  connect(id);
  emit('run');
  // Opening an older run: upgrade template briefs to local-model briefs in the background when the model is up.
  if (run.status !== 'running' && run.status !== 'starting' && S.model?.usable && t.rows.some((r) => r.brief_source !== 'model')) {
    api.upgradeBriefs(id).catch(() => {});
  }
  return run;
}

export async function refreshRun() {
  if (!S.runId) return;
  try { S.run = await api.run(S.runId); emit('run'); } catch { /* ignore */ }
}

export function forgetRun() {
  closeStream();
  S.runId = null; S.run = null; setRows([]);
  S.progress = { status: 'idle', total: 0, done: 0, working: null, elapsed: 0, warnings: [], error: null };
  ls('ap.run', null);
  emit('run');
}

function connect(id) {
  const es = api.events(id);
  S.es = es;
  const parse = (e) => { try { return JSON.parse(e.data); } catch { return {}; } };
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
}

let modelTimer = null;
export async function refreshModel(force = false) {
  try { S.model = await api.modelStatus(force); } catch { S.model = { reachable: false, usable: false, model: '', error: 'unreachable' }; }
  emit('model');
  return S.model;
}
export function pollModel() {
  clearInterval(modelTimer);
  modelTimer = setInterval(() => { if (!document.hidden) refreshModel(); }, 20000);
  return refreshModel();
}
