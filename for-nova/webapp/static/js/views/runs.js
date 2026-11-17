// Runs home: every run, import of saved results, and the way into "New run".
import { h, icon, mount as fill, relTime, plural } from '../lib.js';
import { api } from '../api.js';
import { S, on } from '../state.js';
import { pageHeader, panel, emptyState, toast } from '../ui.js';
import { href, navigate } from '../router.js';

const STATUS = {
  starting: ['badge-accent', 'play', 'Starting'],
  running: ['badge-accent', 'play', 'Running'],
  failed: ['badge-danger', 'circle-alert', 'Failed'],
  cancelled: ['', 'circle-dash', 'Stopped'],
  interrupted: ['badge-warning', 'alert', 'Interrupted'],
};

function statusBadge(status) {
  const s = STATUS[status];
  return s ? h('span', { class: `badge ${s[0]}` }, icon(s[1]), s[2]) : null;
}

export function mount(root) {
  const runsBody = h('div');
  const savedSlot = h('div');
  const newRun = h('a', { class: 'btn btn-primary', href: href('run-new') }, icon('plus'), 'New run');
  const runsPanel = panel({ title: 'All runs', icon: 'layers', body: runsBody, flush: true });
  fill(root, h('div', { class: 'page' },
    pageHeader({ title: 'Runs', meta: 'Each run processes a dataset folder and keeps its tickets and review decisions.', actions: newRun }),
    h('div', { class: 'page-grid' }, runsPanel, savedSlot)));

  let alive = true;
  const ctl = new AbortController();
  let loaded = false;

  function runRow(r) {
    const model = r.model || null;
    const sub = [plural(r.counts?.total ?? 0, 'ticket'), model ? model : 'no model', relTime(r.created_at)].filter(Boolean).join(' · ');
    return h('a', { class: 'run-item run-link', href: href('overview', { runId: r.id }) },
      h('div', { class: 'meta' }, h('div', { class: 'name truncate', title: r.dataset_path || null }, r.label || r.id), h('div', { class: 'sub truncate' }, sub)),
      r.id === S.runId ? h('span', { class: 'badge badge-quiet' }, 'Open') : null,
      r.status !== 'done' ? statusBadge(r.status) : null,
      icon('chev-right', 'icon-sm'));
  }

  function renderRuns(data) {
    const runs = data.runs || [];
    fill(runsBody, runs.length ? runs.map(runRow) : emptyState({
      iconName: 'layers', title: 'No runs yet', text: 'Start a run to process a dataset. Your runs will be listed here.',
      action: h('a', { class: 'btn btn-primary', href: href('run-new') }, icon('plus'), 'New run'),
    }));
    const saved = data.importable || [];
    fill(savedSlot, saved.length ? panel({
      title: 'Saved results on disk', icon: 'database', count: saved.length, collapsible: true, open: false, flush: true,
      body: saved.map((s) => h('div', { class: 'run-item' },
        h('div', { class: 'meta' }, h('div', { class: 'name mono truncate', title: s.path }, `out/${s.name}`), h('div', { class: 'sub' }, `bundles.json · ${s.size_kb} KB · ${relTime(s.modified)}`)),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: (e) => importSaved(s, e.currentTarget) }, 'Open'))),
    }) : null);
  }

  async function load({ quiet = false } = {}) {
    if (!quiet || !loaded) fill(runsBody, h('div', { class: 'loading-block', role: 'status' }, h('span', { class: 'spinner' }), 'Loading runs…'));
    try {
      const data = await api.runs({ signal: ctl.signal });
      if (!alive) return;
      loaded = true;
      renderRuns(data);
    } catch (e) {
      if (!alive || e.name === 'AbortError' || (quiet && loaded)) return;
      fill(runsBody, emptyState({
        iconName: 'plug', title: "Couldn't load your runs", text: e.message,
        action: h('button', { class: 'btn btn-primary', type: 'button', onclick: () => load() }, icon('rotate'), 'Retry'),
      }));
    }
  }

  async function importSaved(s, btn) {
    btn.disabled = true; btn.textContent = 'Opening…';
    try {
      const { run_id } = await api.importRun(s.path);
      navigate(href('overview', { runId: run_id }));
    } catch (e) {
      toast({ message: e.message || 'Could not open that result set' });
      btn.disabled = false; btn.textContent = 'Open';
    }
  }

  const off = on((kind) => { if (kind === 'run') load({ quiet: true }); });
  load();
  return { destroy() { alive = false; ctl.abort(); off(); } };
}
