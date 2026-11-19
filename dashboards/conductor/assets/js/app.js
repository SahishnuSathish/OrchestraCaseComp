// Conductor staff workspace (/app): session check, the shell (shell.js) and route dispatch.
// Views live in ./views and expose mount(root, { route, session }) -> { update?({ route }), destroy?() }.
// The run-era views (runs, tickets, review, prevent, settings) still render here, with a slim context bar for their
// breadcrumbs, until wave 2 replaces them.
import { h, icon, mount, $, ls } from './lib.js';
import { api } from './api.js';
import { S, on, loadRun, pollModel, refreshModel, refreshRun, isActive } from './state.js';
import { parse, href, navigate, onNavigate, crumbs } from './router.js';
import { banner } from './ui.js';
import { empty, button, progress } from './components/index.js';
import { startShell, setRoute, canOpen, isStaff, syncChrome } from './shell.js';
import { current, homeFor } from './hub/session-port.js';
import * as runsView from './views/runs.js';
import * as runNewView from './views/run-new.js';
import * as overviewView from './views/overview.js';
import * as ticketsView from './views/tickets.js';
import * as reviewView from './views/review.js';
import * as preventView from './views/prevent.js';
import * as settingsView from './views/settings.js';
import * as notFoundView from './views/not-found.js';
// Phase 3 views (docs/phase3/CONTRACTS.md section 12)
import * as inboxView from './views/inbox.js';
import * as escalationsView from './views/escalations.js';
import * as teamView from './views/team.js';
import * as approverView from './views/approver.js';
import * as aheadView from './views/ahead.js';
import * as vendorSetupView from './views/vendor-setup.js';
import * as connectionsView from './views/connections.js';
import * as styleguideView from './views/styleguide.js';

const VIEWS = {
  runs: runsView, 'run-new': runNewView, overview: overviewView, tickets: ticketsView,
  review: reviewView, prevent: preventView, settings: settingsView, 'not-found': notFoundView,
  inbox: inboxView, escalations: escalationsView, team: teamView, approver: approverView, ahead: aheadView,
  'vendor-setup': vendorSetupView, connections: connectionsView, styleguide: styleguideView,
};
const LEGACY = new Set(['runs', 'run-new', 'overview', 'tickets', 'review', 'prevent', 'settings', 'not-found']);
const TITLES = {
  inbox: 'Inbox', escalations: 'Escalations', team: 'Team', approver: 'Waiting on you', ahead: 'Conductor: Ahead',
  'vendor-setup': 'Vendor setup', connections: 'Settings', styleguide: 'Style guide', runs: 'Runs', 'run-new': 'New run',
  overview: 'Overview', prevent: 'Prevent', settings: 'Settings', 'not-found': 'Page not found', tickets: 'Tickets', review: 'Review',
};

const main = $('#main');
let session = null;
let home = '#/inbox';
let mounted = null; // { name, runId, inst }
let route = null;
let routeSeq = 0;

// ---------------------------------------------------------------------------- model status wording (legacy context bar)
function modelInfo(m) {
  if (!m) return { tone: 'off', chip: 'Local model', title: 'Checking the local model' };
  const state = m.state || (m.usable ? 'ready' : 'unreachable');
  const at = m.host ? ` at ${m.host}` : '';
  switch (state) {
    case 'ready': return { tone: 'ok', chip: m.model, title: `${m.model}${at}, running on this computer` };
    case 'model_missing': return { tone: 'off', chip: 'Model not installed', title: m.error || `${m.model || 'The selected model'} is not installed${at}` };
    case 'no_models': return { tone: 'off', chip: 'Model not installed', title: m.error || `No models are installed${at}` };
    case 'not_local': return { tone: 'bad', chip: 'Model server blocked', title: m.error || 'The configured model server is not on this computer, so it is never contacted' };
    default: return { tone: 'off', chip: 'Local model offline', title: m.error || `The local model is not reachable${at}. Runs use the regex reader only` };
  }
}

// ---------------------------------------------------------------------------- legacy context bar (breadcrumbs, run pages, model)
let subSig = '';
function renderSubbar() {
  const bar = $('#subbar');
  if (!route || !LEGACY.has(route.name)) {
    if (!bar.hidden) { bar.hidden = true; mount(bar); subSig = ''; }
    return;
  }
  const run = S.runId === route.runId ? S.run : null;
  const items = crumbs(route, run);
  const info = modelInfo(S.model);
  const runTabs = route.runId ? [
    ['Overview', 'overview', href('overview', { runId: route.runId })],
    ['Tickets', 'tickets', href('tickets', { runId: route.runId })],
    ['Review', 'review', href('review', { runId: route.runId })],
    ['Prevent', 'prevent', href('prevent', { runId: route.runId })],
  ] : [];
  const live = !!run && (isActive(run) || isActive({ status: S.progress.status }));
  const sig = JSON.stringify([items, info, runTabs.map((t) => t[1]), route.name, live]);
  if (sig === subSig) return;
  subSig = sig;
  bar.hidden = false;
  const parent = items.length > 1 ? items[items.length - 2] : null;
  mount(bar,
    parent ? h('a', { class: 'c-btn c-btn-quiet c-btn-icon c-btn-sm c-subbar-back', href: parent.href, 'aria-label': `Back to ${parent.label}` }, icon('chev-left')) : null,
    h('nav', { class: 'c-crumbs', 'aria-label': 'Breadcrumb' }, h('ol', null, items.map((c) => h('li', null,
      c.href ? h('a', { href: c.href, title: c.label }, c.label) : h('span', { 'aria-current': 'page', title: c.label }, c.label))))),
    live ? h('span', { class: 'c-dot-label c-subbar-live' }, h('span', { class: 'c-dot c-dot-settled is-live', 'aria-hidden': 'true' }), 'Running') : null,
    runTabs.length ? h('nav', { class: 'c-subbar-tabs', 'aria-label': 'Run pages' }, runTabs.map(([label, name, to]) =>
      h('a', { class: 'c-subbar-tab', href: to, 'aria-current': route.name === name ? 'page' : null }, label))) : null,
    h('span', { class: 'c-subbar-spacer' }),
    h('a', { class: 'c-subbar-model', href: href('settings'), title: info.title, 'aria-label': `${info.chip}. Open settings` },
      h('span', { class: `dot dot-${info.tone}`, 'aria-hidden': 'true' }), icon('cpu'), h('span', { class: 'truncate' }, info.chip)));
}

function renderTitle() {
  if (!route) return;
  const leaf = TITLES[route.name] || 'Conductor';
  const id = route.ticketId ? ` #${route.ticketId}` : '';
  const label = route.runId && S.runId === route.runId ? S.run?.label : null;
  document.title = [`${leaf}${id}`, label, 'Conductor'].filter(Boolean).join(' · ');
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
  renderSubbar();
  renderTitle();
  renderBanners();
  syncChrome();
}
let raf = 0;
function scheduleChrome() { cancelAnimationFrame(raf); raf = requestAnimationFrame(chrome); }

// ---------------------------------------------------------------------------- routing
const page = (...kids) => h('div', { class: 'page' }, ...kids);

function teardown() {
  mounted?.inst?.destroy?.();
  mounted = null;
}

function showRunError(err) {
  teardown();
  chrome();
  const goRuns = button({ label: 'Go to runs', variant: 'primary', href: href('runs') });
  if (err.status === 404) {
    if (ls('ap.run') === route.runId) ls('ap.run', null);
    mount(main, page(empty({ icon: 'circle-alert', title: 'This run no longer exists', text: 'It may have been deleted, or this link came from another computer.', actions: goRuns })));
  } else {
    mount(main, page(empty({
      icon: 'plug', title: "Couldn't open this run", text: err.message || 'Something went wrong while loading it.',
      actions: [button({ label: 'Try again', variant: 'primary', icon: 'refresh', onClick: () => dispatchRoute() }), button({ label: 'Go to runs', href: href('runs') })],
    })));
  }
  main.focus({ preventScroll: true });
}

async function dispatchRoute() {
  const seq = ++routeSeq;
  // An empty hash (or "#/") opens this person's home, not the old run list.
  if (!location.hash || location.hash === '#' || location.hash === '#/') { navigate(home, { replace: true }); return; }
  const next = parse(location.hash);
  if (next.redirect) { navigate(next.redirect, { replace: true }); return; }
  if (!canOpen(session.role, next.name)) { navigate(home, { replace: true }); return; }
  route = next;
  setRoute(route);
  progress.start();
  try {
    if (route.runId && route.runId !== S.runId) {
      teardown();
      chrome();
      mount(main, page(h('div', { class: 'loading-block', role: 'status' }, h('span', { class: 'c-spinner', 'aria-hidden': 'true' }), 'Opening run…')));
      try { await loadRun(route.runId); } catch (err) { if (seq === routeSeq) showRunError(err); return; }
      if (seq !== routeSeq || S.runId !== route.runId) return;
    }

    chrome();
    const runId = route.runId || null;
    if (mounted && mounted.name === route.name && mounted.runId === runId && mounted.inst.update) {
      mounted.inst.update({ route });
      return;
    }
    teardown();
    window.scrollTo(0, 0);
    main.scrollTop = 0;
    main.dataset.view = route.name;
    try {
      mounted = { name: route.name, runId, inst: VIEWS[route.name].mount(main, { route, session }) || {} };
    } catch (err) {
      console.error(err);
      mount(main, page(empty({ icon: 'circle-alert', title: 'This page could not be shown', text: err.message, actions: button({ label: 'Go to your home page', variant: 'primary', href: home }) })));
    }
    main.focus({ preventScroll: true });
  } finally {
    progress.done();
  }
}

async function boot() {
  let s = null;
  try { s = await current(); } catch { s = null; }
  if (!s || !s.role) { location.replace('/'); return; }
  if (s.role === 'vendor') { location.replace(homeFor('vendor')); return; }
  session = s;
  const target = homeFor(s.role) || '';
  home = target.includes('#') ? `#${target.split('#')[1]}` : '#/inbox';
  startShell({ session });

  on((kind) => { if (['run', 'model', 'ticket', 'progress', 'review', 'conn'].includes(kind)) scheduleChrome(); });
  on((kind) => { if (kind === 'conn') onConn(); });
  onNavigate(dispatchRoute);
  window.addEventListener('hashchange', dispatchRoute);
  if (isStaff(s.role)) pollModel();
  dispatchRoute();
  // Run pages opened later still know the last run (the legacy views read it).
  const saved = ls('ap.run');
  if (isStaff(s.role) && saved && !route?.runId) {
    loadRun(saved).catch((err) => { if (err.status === 404) ls('ap.run', null); });
  }
}

boot();
