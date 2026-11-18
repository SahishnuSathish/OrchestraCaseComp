// Conductor shell: router dispatch, sidebar (drawer on narrow screens), topbar breadcrumbs, global banners.
// Views live in ./views and expose mount(root, { route }) -> { update?({ route }), destroy? }.
import { h, icon, mount, $, ls } from './lib.js';
import { api } from './api.js';
import { S, on, loadRun, pollModel, refreshModel, refreshRun, pendingDrafts, isActive, viewState } from './state.js';
import { parse, href, navigate, onNavigate, crumbs } from './router.js';
import { banner, emptyState } from './ui.js';
import * as runsView from './views/runs.js';
import * as runNewView from './views/run-new.js';
import * as overviewView from './views/overview.js';
import * as ticketsView from './views/tickets.js';
import * as reviewView from './views/review.js';
import * as preventView from './views/prevent.js';
import * as settingsView from './views/settings.js';
import * as notFoundView from './views/not-found.js';

const VIEWS = {
  runs: runsView, 'run-new': runNewView, overview: overviewView, tickets: ticketsView,
  review: reviewView, prevent: preventView, settings: settingsView, 'not-found': notFoundView,
};

const root = document.documentElement;
const main = $('#main');
const mainCol = $('#main-col');
const sidebar = $('#sidebar');
const menuBtn = $('#menu-btn');
let current = null; // { name, runId, inst }
let route = parse(location.hash);
let routeSeq = 0;

// ---------------------------------------------------------------------------- model status wording
function modelInfo(m) {
  if (!m) return { tone: 'off', side: 'Checking local model', chip: 'Local model', title: 'Checking the local model' };
  const state = m.state || (m.usable ? 'ready' : 'unreachable');
  const at = m.host ? ` at ${m.host}` : '';
  switch (state) {
    case 'ready': return { tone: 'ok', side: 'Local model ready', chip: m.model, title: `${m.model}${at}, running on this computer` };
    case 'model_missing': return { tone: 'off', side: 'Model not installed', chip: 'Model not installed', title: m.error || `${m.model || 'The selected model'} is not installed${at}` };
    case 'no_models': return { tone: 'off', side: 'Model not installed', chip: 'Model not installed', title: m.error || `No models are installed${at}` };
    case 'not_local': return { tone: 'bad', side: 'Model server blocked', chip: 'Model server blocked', title: m.error || 'The configured model server is not on this computer, so it is never contacted' };
    default: return { tone: 'off', side: 'Local model offline', chip: 'Local model offline', title: m.error || `The local model is not reachable${at}. Runs use the regex reader only` };
  }
}

// ---------------------------------------------------------------------------- sidebar
let sideSig = '';
function renderSide() {
  const info = modelInfo(S.model);
  const runId = S.runId;
  const inRun = (name) => route.runId === runId && route.name === name;
  const tickets = runId ? viewState.get(runId, 'tickets') : null;
  const review = runId ? viewState.get(runId, 'review') : null;
  const data = {
    runs: route.name === 'runs' || route.name === 'run-new',
    settings: route.name === 'settings',
    run: runId && S.run ? {
      label: S.run.label || 'Run', path: S.run.dataset_path || '', live: isActive(S.run) || isActive({ status: S.progress.status }),
      overview: [href('overview', { runId }), inRun('overview')],
      tickets: [href('tickets', { runId, query: tickets.query }), inRun('tickets')],
      review: [href('review', { runId, ticketId: review.ticketId, query: review.query }), inRun('review')],
      prevent: [href('prevent', { runId }), inRun('prevent')],
      pending: pendingDrafts(),
    } : null,
    model: [info.tone, info.side, info.title],
  };
  const sig = JSON.stringify(data);
  if (sig === sideSig) return;
  sideSig = sig;

  const link = (label, ic, to, current, count) => h('a', {
    class: 'nav-link', href: to, title: label, 'aria-label': count > 0 ? `${label}, ${count} to review` : label, 'aria-current': current ? 'page' : null,
  }, icon(ic), h('span', { class: 'nav-label' }, label), count > 0 ? h('span', { class: 'nav-count', 'aria-hidden': 'true' }, count) : null);

  const r = data.run;
  const headingId = 'side-run-heading';
  mount($('#side-body'),
    h('div', { class: 'nav-group' }, link('Runs', 'layers', href('runs'), data.runs)),
    r ? h('div', { class: 'side-section', role: 'group', 'aria-labelledby': headingId },
      h('div', { class: 'side-heading', id: headingId, title: r.path || null },
        r.live ? h('span', { class: 'dot dot-live', role: 'img', 'aria-label': 'Run in progress' }) : null, h('span', { class: 'truncate' }, r.label)),
      link('Overview', 'gauge', ...r.overview),
      link('Tickets', 'tickets', ...r.tickets),
      link('Review', 'review', ...r.review, r.pending),
      link('Prevent', 'send', ...r.prevent))
      : h('div', { class: 'side-section' }, h('p', { class: 'side-empty' }, 'Open a run to see its tickets and review queue.')),
    h('div', { class: 'side-foot' },
      link('Settings', 'settings', href('settings'), data.settings),
      h('a', { class: 'nav-link side-model', href: href('settings'), title: info.title, 'aria-label': `${info.side}. Open settings` },
        h('span', { class: `dot dot-${info.tone}` }), h('span', { class: 'nav-label' }, info.side)),
      h('p', { class: 'side-fine' }, 'Runs on this computer. Nothing is sent without your approval.')));
}

// ---------------------------------------------------------------------------- topbar
let topSig = '';
function renderTopbar() {
  const run = S.runId === route.runId ? S.run : null;
  const items = crumbs(route, run);
  const info = modelInfo(S.model);
  const sig = JSON.stringify([items, info]);
  if (sig === topSig) return;
  topSig = sig;
  const parent = items.length > 1 ? items[items.length - 2] : null;
  mount($('#crumbs'),
    parent ? h('a', { class: 'btn btn-quiet btn-icon crumb-back', href: parent.href, 'aria-label': `Back to ${parent.label}` }, icon('chev-left')) : null,
    h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('ol', null, items.map((c) => h('li', null,
      c.href ? h('a', { href: c.href, title: c.label }, c.label) : h('span', { 'aria-current': 'page', title: c.label }, c.label))))));
  mount($('#status-area'), h('a', { class: 'status-chip', href: href('settings'), title: info.title, 'aria-label': `${info.side}. Open settings` },
    h('span', { class: `dot dot-${info.tone}` }), icon('cpu', 'chip-icon'), h('span', { class: 'chip-text truncate' }, info.chip)));
}

function renderTitle() {
  const leaf = { runs: 'Runs', 'run-new': 'New run', overview: 'Overview', prevent: 'Prevent', settings: 'Settings', 'not-found': 'Page not found' }[route.name]
    || `${route.name === 'tickets' ? 'Tickets' : 'Review'}${route.ticketId ? ` #${route.ticketId}` : ''}`;
  const label = route.runId && S.runId === route.runId ? S.run?.label : null;
  document.title = [leaf, label, 'Conductor'].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------- global banners
let bannerSig = '';
function renderBanners() {
  if (S.conn === bannerSig) return;
  bannerSig = S.conn;
  const slot = $('#banners');
  if (S.conn === 'expired') {
    mount(slot, banner({
      tone: 'danger', role: 'alert', text: 'Conductor was restarted, so this page is out of date. Reload to continue.',
      actions: h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => location.reload() }, icon('refresh'), 'Reload'),
    }));
  } else if (S.conn === 'offline') {
    mount(slot, banner({
      tone: 'warning', role: 'alert', text: "Can't reach Conductor on this computer. Retrying…",
      actions: h('button', { class: 'btn btn-sm', type: 'button', onclick: () => api.health().catch(() => {}) }, icon('refresh'), 'Retry now'),
    }));
  } else mount(slot);
}

let healthPoll = 0;
let wasOffline = false;
function onConn() {
  if (S.conn === 'offline' && !healthPoll) healthPoll = setInterval(() => api.health().catch(() => {}), 5000);
  if (S.conn !== 'offline') { clearInterval(healthPoll); healthPoll = 0; }
  if (S.conn === 'offline') wasOffline = true;
  else if (S.conn === 'ok' && wasOffline) { wasOffline = false; refreshModel(); refreshRun(); }
}

function chrome() {
  renderSide();
  renderTopbar();
  renderTitle();
  renderBanners();
}
let raf = 0;
function scheduleChrome() { cancelAnimationFrame(raf); raf = requestAnimationFrame(chrome); }

// ---------------------------------------------------------------------------- collapsible sidebar (desktop)
// The employee's choice (saved) wins. Without one, the sidebar collapses to icons on medium widths.
const railMedia = window.matchMedia('(max-width: 1199px)');
function applyRail() {
  const saved = ls('ap.rail');
  const collapsed = saved ? saved === 'collapsed' : railMedia.matches;
  root.dataset.rail = collapsed ? 'collapsed' : 'open';
  const btn = $('#rail-toggle');
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  btn.firstElementChild.firstElementChild.setAttribute('href', collapsed ? '#i-panel-left-open' : '#i-panel-left-close');
}

// ---------------------------------------------------------------------------- drawer (<= 900px)
const narrow = window.matchMedia('(max-width: 900px)');
let drawerOpen = false;
function setDrawer(open, { refocus = true } = {}) {
  if (open === drawerOpen || (open && !narrow.matches)) return;
  drawerOpen = open;
  root.dataset.drawer = open ? 'open' : 'closed';
  menuBtn.setAttribute('aria-expanded', String(open));
  menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  mainCol.inert = open;
  if (open) $('#drawer-close').focus();
  else if (refocus) menuBtn.focus();
}
const drawerFocusables = () => [...sidebar.querySelectorAll('a[href], button:not(:disabled)')].filter((el) => el.offsetParent !== null);

function initChrome() {
  $('#rail-toggle').addEventListener('click', () => {
    ls('ap.rail', root.dataset.rail === 'collapsed' ? 'open' : 'collapsed');
    applyRail();
  });
  railMedia.addEventListener('change', applyRail);
  applyRail();

  menuBtn.addEventListener('click', () => setDrawer(!drawerOpen));
  $('#drawer-close').addEventListener('click', () => setDrawer(false));
  $('#scrim').addEventListener('click', () => setDrawer(false));
  narrow.addEventListener('change', () => { if (!narrow.matches) setDrawer(false, { refocus: false }); });
  sidebar.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    setDrawer(false, { refocus: false });
    if (a.getAttribute('href') === location.hash) main.focus({ preventScroll: true }); // same page: no route change will move focus
  });
  document.addEventListener('keydown', (e) => {
    if (!drawerOpen) return;
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { e.preventDefault(); setDrawer(false); return; }
    if (e.key !== 'Tab') return;
    const items = drawerFocusables();
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (!sidebar.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  $('.skip').addEventListener('click', (e) => { e.preventDefault(); main.focus({ preventScroll: true }); });

  // Workspace pages size themselves below the topbar and any global banner.
  new ResizeObserver(() => root.style.setProperty('--banner-h', `${$('#banners').offsetHeight}px`)).observe($('#banners'));
}

// ---------------------------------------------------------------------------- routing
const page = (...kids) => h('div', { class: 'page' }, ...kids);

function teardown() {
  current?.inst?.destroy?.();
  current = null;
}

function showRunError(err) {
  teardown();
  chrome();
  const goRuns = h('a', { class: 'btn btn-primary', href: href('runs') }, 'Go to runs');
  if (err.status === 404) {
    if (ls('ap.run') === route.runId) ls('ap.run', null);
    mount(main, page(emptyState({
      iconName: 'circle-alert', title: 'This run no longer exists',
      text: 'It may have been deleted, or this link came from another computer.', action: goRuns,
    })));
  } else {
    mount(main, page(emptyState({
      iconName: 'plug', title: "Couldn't open this run", text: err.message || 'Something went wrong while loading it.',
      actions: [h('button', { class: 'btn btn-primary', type: 'button', onclick: () => dispatchRoute() }, icon('rotate'), 'Try again'), h('a', { class: 'btn', href: href('runs') }, 'Go to runs')],
    })));
  }
  main.focus({ preventScroll: true });
}

async function dispatchRoute() {
  const seq = ++routeSeq;
  const next = parse(location.hash);
  if (next.redirect) { navigate(next.redirect, { replace: true }); return; }
  route = next;
  setDrawer(false, { refocus: false });

  if (route.runId && route.runId !== S.runId) {
    teardown();
    chrome();
    mount(main, page(h('div', { class: 'loading-block', role: 'status' }, h('span', { class: 'spinner' }), 'Opening run…')));
    try { await loadRun(route.runId); } catch (err) { if (seq === routeSeq) showRunError(err); return; }
    if (seq !== routeSeq || S.runId !== route.runId) return;
  }

  chrome();
  const runId = route.runId || null;
  if (current && current.name === route.name && current.runId === runId && current.inst.update) {
    current.inst.update({ route });
    return;
  }
  teardown();
  window.scrollTo(0, 0);
  main.scrollTop = 0;
  try {
    current = { name: route.name, runId, inst: VIEWS[route.name].mount(main, { route }) || {} };
  } catch (err) {
    console.error(err);
    mount(main, page(emptyState({ iconName: 'circle-alert', title: 'This page could not be shown', text: err.message, action: h('a', { class: 'btn btn-primary', href: href('runs') }, 'Go to runs') })));
  }
  main.focus({ preventScroll: true });
}

function boot() {
  initChrome();
  on((kind) => { if (['run', 'model', 'ticket', 'progress', 'review', 'conn'].includes(kind)) scheduleChrome(); });
  on((kind) => { if (kind === 'conn') onConn(); });
  onNavigate(dispatchRoute);
  window.addEventListener('hashchange', dispatchRoute);
  pollModel();
  dispatchRoute();
  // Pages outside a run (#/runs, #/settings) still show the last opened run in the sidebar.
  const saved = ls('ap.run');
  if (saved && !route.runId) {
    loadRun(saved).catch((err) => { if (err.status === 404) ls('ap.run', null); });
  }
}

boot();
