// Runs home: every run, import of saved results, and the way into "New run".
// Also exports a few helpers shared by the New run and Overview pages (status badge, reader text, delete flow).
import { h, icon, mount as fill, relTime, plural, fmtInt } from '../lib.js';
import { api } from '../api.js';
import { S, on, isActive, forgetRun } from '../state.js';
import { pageHeader, panel, emptyState, toast, banner, menuButton, confirmDialog } from '../ui.js';
import { href, navigate } from '../router.js';

// ---------------------------------------------------------------------------- shared helpers
export function statusBadge(status) {
  switch (status) {
    case 'done': return h('span', { class: 'badge badge-success' }, icon('check'), 'Done');
    case 'starting': return h('span', { class: 'badge badge-accent' }, h('span', { class: 'dot dot-live' }), 'Starting');
    case 'running': return h('span', { class: 'badge badge-accent' }, h('span', { class: 'dot dot-live' }), 'Running');
    case 'cancelled': return h('span', { class: 'badge badge-quiet' }, icon('circle-dash'), 'Stopped');
    case 'interrupted': return h('span', { class: 'badge badge-warning' }, icon('alert'), 'Interrupted');
    case 'failed': return h('span', { class: 'badge badge-danger' }, icon('circle-alert'), 'Failed');
    default: return null;
  }
}

export function readerText(run) {
  if (run.model) return `Regex + ${run.model}`;
  return run.use_model ? 'Regex + local model' : 'Regex reader';
}

export const fullDate = (sec) => (sec ? new Date(sec * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
export const shortDate = (sec) => (sec ? new Date(sec * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

export function runAgainHref(run) {
  return href('run-new', { query: { dataset: run.dataset_path, limit: run.limit_n, model: run.use_model ? 1 : 0 } });
}

// Dataset paths are shown truncated from the left (the folder name at the end is the useful part).
export function pathLine(path, cls = '') {
  return h('span', { class: `path-line mono ${cls}`.trim(), title: path || null }, h('span', { class: 'path-inner' }, path || ''));
}

// Confirm, delete, refresh state. Resolves true when the run was deleted.
export async function deleteRunFlow(run) {
  const ok = await confirmDialog({
    title: 'Delete this run?',
    message: "Its tickets, briefs and review decisions are removed from AP Desk. The dataset files and anything already sent are not touched. This can't be undone.",
    confirmLabel: 'Delete run', danger: true,
  });
  if (!ok) return false;
  try {
    await api.deleteRun(run.id);
  } catch (e) {
    toast({ message: e.status === 409 ? (e.message || 'This run is in progress. Stop it before deleting.') : (e.message || 'Could not delete the run'), duration: 6000 });
    return false;
  }
  toast({ message: `Deleted ${run.label || run.id}` });
  return true;
}

function reviewed(r) {
  const c = r.counts || {};
  const drafts = c.draft_reply || 0;
  return { drafts, done: Math.min(drafts, (c.approved || 0) + (c.sent || 0) + (c.returned || 0)) };
}

// ---------------------------------------------------------------------------- page
export function mount(root) {
  const bannerSlot = h('div');
  const runsBody = h('div');
  const savedSlot = h('div');
  const newRun = h('a', { class: 'btn btn-primary', href: href('run-new') }, icon('plus'), 'New run');
  const runsPanelCount = h('span', { class: 'panel-count' });
  const runsPanel = panel({ title: 'Runs', icon: 'layers', body: runsBody, flush: true, class: 'runs-panel' });
  runsPanel.querySelector('.panel-head h2').append(runsPanelCount);
  fill(root, h('div', { class: 'page' },
    pageHeader({ title: 'Runs', meta: 'Each run is one pass of the pipeline over a dataset folder.', actions: newRun }),
    h('div', { class: 'page-grid' }, bannerSlot, runsPanel, savedSlot)));

  let alive = true;
  const ctl = new AbortController();
  let loaded = false;
  let data = null;
  let sig = '';
  let lastLoad = 0;
  let loadTimer = 0;

  function reviewCell(r, withText = true) {
    const { drafts, done } = reviewed(r);
    if (!drafts) return h('span', { class: 'faint', title: 'This run has no drafted replies' }, '–');
    const frac = done / drafts;
    return h('div', { class: 'rv' },
      withText ? h('span', { class: 'rv-text num' }, `${fmtInt(done)} of ${fmtInt(drafts)}`) : null,
      h('div', { class: 'bar mini-bar', role: 'img', 'aria-label': `${done} of ${drafts} drafts reviewed` }, h('div', { class: 'bar-fill', style: { transform: `scaleX(${frac})` } })));
  }

  function rowMenu(r) {
    const noTickets = !(r.counts?.total > 0);
    return menuButton({
      label: `More actions for ${r.label || r.id}`, icon: 'more', small: true,
      items: [
        { label: 'Open overview', icon: 'gauge', onSelect: () => navigate(href('overview', { runId: r.id })) },
        { label: 'Review drafts', icon: 'review', disabled: noTickets, title: noTickets ? 'This run has no tickets' : null, onSelect: () => navigate(href('review', { runId: r.id })) },
        { label: 'Browse tickets', icon: 'tickets', disabled: noTickets, title: noTickets ? 'This run has no tickets' : null, onSelect: () => navigate(href('tickets', { runId: r.id })) },
        { label: 'Run again', icon: 'rotate', onSelect: () => navigate(runAgainHref(r)) },
        { label: 'Delete run…', icon: 'trash', danger: true, disabled: isActive(r), title: isActive(r) ? 'Stop the run before deleting it' : null, onSelect: () => remove(r) },
      ],
    });
  }

  const nameLink = (r) => h('a', { class: 'run-name truncate', href: href('overview', { runId: r.id }), title: r.label || r.id }, r.label || r.id);
  const errorLine = (r) => (r.status === 'failed' && r.error ? h('span', { class: 'run-error truncate', title: r.error }, r.error) : null);

  function tableRow(r) {
    const tr = h('tr', { class: 'run-row' },
      h('td', { class: 'c-run' },
        h('div', { class: 'run-main' }, nameLink(r), r.id === S.runId ? h('span', { class: 'badge badge-quiet' }, 'Open') : null),
        pathLine(r.dataset_path, 'run-path'), errorLine(r)),
      h('td', null, statusBadge(r.status)),
      h('td', { class: 'num c-num' }, fmtInt(r.counts?.total ?? 0)),
      h('td', { class: 'c-reader' }, readerText(r)),
      h('td', { class: 'c-rev' }, reviewCell(r)),
      h('td', { class: 'c-when', title: fullDate(r.created_at) }, relTime(r.created_at)),
      h('td', { class: 'c-menu' }, rowMenu(r)));
    tr.addEventListener('click', (e) => { if (!e.target.closest('a, button, .menu')) navigate(href('overview', { runId: r.id })); });
    return tr;
  }

  function cardRow(r) {
    const meta = [plural(r.counts?.total ?? 0, 'ticket'), readerText(r), relTime(r.created_at)].join(' · ');
    return h('li', { class: 'run-card' },
      h('div', { class: 'rc-top' },
        h('div', { class: 'rc-title' }, nameLink(r), r.id === S.runId ? h('span', { class: 'badge badge-quiet' }, 'Open') : null, statusBadge(r.status)),
        rowMenu(r)),
      h('div', { class: 'rc-meta truncate', title: fullDate(r.created_at) }, meta),
      pathLine(r.dataset_path, 'run-path'),
      errorLine(r),
      reviewed(r).drafts ? h('div', { class: 'rc-rev' }, reviewCell(r)) : null);
  }

  function renderRuns() {
    const runs = data.runs || [];
    runsPanelCount.textContent = runs.length ? String(runs.length) : '';
    if (!runs.length) {
      fill(runsBody, emptyState({
        iconName: 'layers', title: 'No runs yet', text: 'Start a run on a dataset folder to draft replies for review.',
        action: h('a', { class: 'btn btn-primary', href: href('run-new') }, icon('plus'), 'New run'),
      }));
    } else {
      fill(runsBody,
        h('table', { class: 'runs-table' },
          h('thead', null, h('tr', null,
            h('th', { scope: 'col', class: 'c-run' }, 'Run'), h('th', { scope: 'col', class: 'c-status' }, 'Status'), h('th', { scope: 'col', class: 'c-num' }, 'Tickets'),
            h('th', { scope: 'col', class: 'c-reader' }, 'Reader'), h('th', { scope: 'col', class: 'c-rev' }, 'Reviewed'), h('th', { scope: 'col', class: 'c-when' }, 'Started'),
            h('th', { scope: 'col', class: 'c-menu' }, h('span', { class: 'sr-only' }, 'Actions')))),
          h('tbody', null, runs.map(tableRow))),
        h('ul', { class: 'runs-cards' }, runs.map(cardRow)));
    }
    renderSaved();
    renderBanner();
  }

  function renderSaved() {
    const saved = data.importable || [];
    const hasRuns = (data.runs || []).length > 0;
    fill(savedSlot, saved.length ? panel({
      title: 'Saved results on disk', icon: 'database', count: saved.length, collapsible: true, open: !hasRuns, flush: true,
      body: [
        h('p', { class: 'saved-intro muted' }, 'Result files written by the command-line pipeline (out/<name>/bundles.json). Importing one creates a run here that you can browse and review.'),
        h('ul', { class: 'saved-list' }, saved.map((s) => h('li', { class: 'saved-row' },
          h('div', { class: 'saved-meta' },
            h('div', { class: 'mono truncate', title: s.path }, `out/${s.name}`),
            h('div', { class: 'faint saved-sub' }, `${s.size_kb} KB · ${relTime(s.modified)}`)),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: (e) => importSaved(s, e.currentTarget) }, 'Import')))),
      ],
    }) : null);
  }

  function renderBanner() {
    const act = (data?.runs || []).find(isActive);
    if (!act) { fill(bannerSlot); return; }
    const live = act.id === S.runId && S.progress ? S.progress : act;
    const total = live.total || act.total || 0;
    const done = live.done ?? act.done ?? 0;
    fill(bannerSlot, banner({
      tone: 'info', role: 'status', title: 'A run is in progress',
      text: ` ${act.label || act.id} · ${fmtInt(done)} of ${fmtInt(total)} tickets`,
      actions: h('a', { class: 'btn btn-sm', href: href('overview', { runId: act.id }) }, 'View progress'),
    }));
  }

  async function load({ quiet = false } = {}) {
    lastLoad = Date.now();
    if (!quiet || !loaded) fill(runsBody, h('div', { class: 'loading-block', role: 'status' }, h('span', { class: 'spinner' }), 'Loading runs…'));
    try {
      const d = await api.runs({ signal: ctl.signal });
      if (!alive) return;
      loaded = true;
      const next = JSON.stringify([d.runs.map((r) => [r.id, r.label, r.status, r.counts, r.error, r.model]), d.importable?.map((s) => s.path), S.runId]);
      data = d;
      if (next !== sig) { sig = next; renderRuns(); } else renderBanner();
    } catch (e) {
      if (!alive || e.name === 'AbortError' || (quiet && loaded)) return;
      sig = '';
      fill(runsBody, emptyState({
        iconName: 'plug', title: "Couldn't load your runs", text: e.message,
        action: h('button', { class: 'btn btn-primary', type: 'button', onclick: () => load() }, icon('rotate'), 'Retry'),
      }));
    }
  }

  // Progress events arrive per ticket: refresh the list at most every 1.5 s.
  function scheduleLoad() {
    if (loadTimer) return;
    const wait = Math.max(0, 1500 - (Date.now() - lastLoad));
    loadTimer = setTimeout(() => { loadTimer = 0; if (alive) load({ quiet: true }); }, wait);
  }

  async function remove(r) {
    if (!(await deleteRunFlow(r))) return;
    if (r.id === S.runId) forgetRun();
    sig = '';
    load({ quiet: true });
  }

  async function importSaved(s, btn) {
    btn.disabled = true; btn.textContent = 'Importing…';
    try {
      const { run_id } = await api.importRun(s.path);
      navigate(href('overview', { runId: run_id }));
    } catch (e) {
      toast({ message: e.message || 'Could not import that result set', duration: 6000 });
      btn.disabled = false; btn.textContent = 'Import';
    }
  }

  const off = on((kind) => { if (kind === 'run' || kind === 'progress') scheduleLoad(); });
  const onVisible = () => { if (!document.hidden) load({ quiet: true }); };
  document.addEventListener('visibilitychange', onVisible);
  load();
  return { destroy() { alive = false; ctl.abort(); off(); clearTimeout(loadTimer); document.removeEventListener('visibilitychange', onVisible); } };
}
