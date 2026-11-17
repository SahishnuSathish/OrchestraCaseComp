// AP Desk shell: hash router, left rail, top bar. Views live in ./views and expose mount(root, params).
import { h, icon, mount, $, ls } from './lib.js';
import { S, on, loadRun, forgetRun, pollModel, pendingDrafts } from './state.js';
import * as runView from './views/run.js';
import * as ticketsView from './views/tickets.js';
import * as reviewView from './views/review.js';

const VIEWS = {
  run: { mod: runView, label: 'Run', icon: 'run' },
  tickets: { mod: ticketsView, label: 'Tickets', icon: 'tickets' },
  review: { mod: reviewView, label: 'Review', icon: 'review' },
};

const main = $('#main');
let current = null; // { name, inst }

function parseHash() {
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: VIEWS[name] ? name : 'run', id: arg ? Number(arg) || null : null };
}

function renderNav(active) {
  const pending = pendingDrafts();
  mount($('#nav'), ...Object.entries(VIEWS).map(([key, v]) =>
    h('a', { class: 'nav-link', href: `#/${key}`, title: v.label, 'aria-current': key === active ? 'page' : null },
      icon(v.icon), h('span', { class: 'nav-label' }, v.label),
      key === 'review' && pending > 0 && h('span', { class: 'nav-count', 'aria-label': `${pending} drafts to review` }, pending))));
}

// ---------------------------------------------------------------------------- collapsible sidebar
// The employee's choice (saved) wins. Without one, the sidebar collapses to icons on medium widths.
const railMedia = window.matchMedia('(max-width: 1199px)');
function applyRail() {
  const saved = ls('ap.rail');
  const collapsed = saved ? saved === 'collapsed' : railMedia.matches;
  document.documentElement.dataset.rail = collapsed ? 'collapsed' : 'open';
  const btn = $('#rail-toggle');
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  btn.firstElementChild.firstElementChild.setAttribute('href', collapsed ? '#i-panel-left-open' : '#i-panel-left-close');
}
function initRail() {
  $('#rail-toggle').addEventListener('click', () => {
    ls('ap.rail', document.documentElement.dataset.rail === 'collapsed' ? 'open' : 'collapsed');
    applyRail();
  });
  railMedia.addEventListener('change', applyRail);
  applyRail();
}

function renderTopbar(active) {
  const m = S.model;
  const modelChip = !m ? null : m.usable
    ? h('span', { class: 'status-chip', title: `${m.model} at ${m.host}, running locally` }, h('span', { class: 'dot dot-ok' }), h('span', { class: 'truncate' }, `Local model · ${m.model}`))
    : h('span', { class: 'status-chip', title: m.error || 'The local model is not reachable' }, h('span', { class: 'dot dot-off' }), h('span', { class: 'truncate' }, 'Local model offline · regex only'));
  const run = S.run;
  const runChip = run ? h('span', { class: 'status-chip hide-sm', title: run.dataset_path }, icon('folder', 'icon-sm'), h('span', { class: 'truncate' }, `${run.label || 'Run'} · ${run.counts.total} tickets`)) : null;
  mount($('#topbar'),
    h('div', { class: 'crumb' }, h('b', null, VIEWS[active].label)),
    h('div', { class: 'spacer' }), runChip, modelChip);
}

function chrome() {
  const { name } = parseHash();
  renderNav(name);
  renderTopbar(name);
}

let raf = 0;
function scheduleChrome() { cancelAnimationFrame(raf); raf = requestAnimationFrame(chrome); }

function route() {
  const { name, id } = parseHash();
  chrome();
  if (current && current.name === name) { current.inst?.update?.({ id }); return; }
  current?.inst?.destroy?.();
  mount(main);
  const inst = VIEWS[name].mod.mount(main, { id });
  current = { name, inst };
  main.scrollTop = 0;
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
  document.title = `${VIEWS[name].label} · AP Desk`;
}

async function boot() {
  initRail();
  on((kind) => { if (['run', 'model', 'ticket', 'progress', 'review'].includes(kind)) scheduleChrome(); });
  await pollModel();
  const saved = ls('ap.run');
  if (saved) { try { await loadRun(saved); } catch { forgetRun(); } }
  if (!location.hash) location.hash = '#/run';
  window.addEventListener('hashchange', route);
  route();
}

boot();
