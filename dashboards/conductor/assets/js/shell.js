// The staff shell (/app): green top bar, section rail by role, ticket-tabs strip, notifications and the user menu.
// app.js owns routing; it calls startShell() once and setRoute() on every navigation.
// Wave-2 views use the exported hooks: onSearch, setTicketTabs, onTicketTabClose, setConnections, notify.
import { h, icon, $, mount, isTyping, relTime } from './lib.js';
import { lockup } from './components/marks.js';
import { avatar } from './components/badges.js';
import { openMenu, closeMenu, toast } from './components/overlays.js';
import { ensureIcons } from './components/icons.js';
import { signOut } from './hub/session-port.js';
import * as live from './api-live.js';
import * as inboxApi from './api-inbox.js';

// ---------------------------------------------------------------------------- sections by role (CONTRACTS section 1)
export const SECTIONS = {
  escalations: { label: 'Escalations', icon: 'escalations', href: '#/escalations' },
  inbox: { label: 'Inbox', icon: 'inbox', href: '#/inbox' },
  team: { label: 'Team', icon: 'team', href: '#/team' },
  ahead: { label: 'Ahead', icon: 'ahead', href: '#/ahead', title: 'Conductor: Ahead' },
  'vendor-setup': { label: 'Vendor setup', icon: 'vendor-setup', href: '#/vendor-setup' },
  approver: { label: 'Waiting on you', icon: 'approver', href: '#/approver' },
  settings: { label: 'Settings', icon: 'settings', href: '#/settings' },
};
const RAIL = {
  ap_specialist: ['inbox', 'ahead', 'vendor-setup', 'settings'],
  cfo: ['escalations', 'inbox', 'team', 'ahead', 'vendor-setup', 'settings'],
  approver: ['approver'],
};
const LEGACY = ['runs', 'run-new', 'overview', 'tickets', 'review', 'prevent'];
const ROUTES = {
  ap_specialist: ['inbox', 'ahead', 'vendor-setup', 'settings', 'connections', ...LEGACY, 'not-found'],
  cfo: ['escalations', 'inbox', 'team', 'approver', 'ahead', 'vendor-setup', 'settings', 'connections', 'styleguide', ...LEGACY, 'not-found'],
  approver: ['approver', 'not-found'],
};
// which rail item a route lights up
const SECTION_OF = { connections: 'settings', runs: 'settings', 'run-new': 'settings', overview: 'settings', tickets: 'inbox', review: 'inbox', prevent: 'ahead' };

export const isStaff = (role) => role === 'ap_specialist' || role === 'cfo';
/** May this role open this route? */
export function canOpen(role, routeName) { return (ROUTES[role] || ['not-found']).includes(routeName); }

// ---------------------------------------------------------------------------- state
let S = null; // { session, route, rail, unread, events, tabs, conns }
const searchHandlers = [];
const tabCloseHandlers = new Set();
const NOTE_KEY = 'conductor.notifications';

// ---------------------------------------------------------------------------- public hooks for views
/** onSearch(fn(query)) - take over the global search while a view is mounted. Returns unsubscribe. */
export function onSearch(fn) {
  searchHandlers.push(fn);
  return () => { const i = searchHandlers.lastIndexOf(fn); if (i >= 0) searchHandlers.splice(i, 1); };
}
/** Put text in the global search box (for example, when a view opens with ?q=). */
export function setSearchValue(q) { const el = $('#c-search-input'); if (el) el.value = q || ''; }

/**
 * setTicketTabs([{ id, label, sub, href, active, unread }]) - the Zendesk-style strip of open tickets under the top bar.
 * An empty list hides the strip. Close buttons call the onTicketTabClose handlers with the tab id.
 */
export function setTicketTabs(tabs = []) {
  if (!S) return;
  S.tabs = tabs;
  renderTabs();
}
export function onTicketTabClose(fn) { tabCloseHandlers.add(fn); return () => tabCloseHandlers.delete(fn); }

/** setConnections({ zendesk, outlook, netsuite }) - each { status: 'connected' | 'syncing' | 'error', detail?, last_sync? }. */
export function setConnections(patch) {
  if (!S) return;
  for (const [k, v] of Object.entries(patch || {})) S.conns[k] = { ...S.conns[k], ...v };
  renderConn();
}

/** notify(event) - add a live event to the tray (and toast it when it is addressed to the viewer). */
export function notify(ev) { if (S) onLiveEvent(ev); }

/** The signed-in session the shell was started with. */
export function getSession() { return S?.session || null; }

// ---------------------------------------------------------------------------- start
/** startShell({ session }) - build the chrome once. Returns { setRoute }. */
export function startShell({ session }) {
  ensureIcons();
  S = {
    session, route: null, tabs: [], events: loadEvents(), unread: 0,
    conns: {
      zendesk: { name: 'Zendesk', status: 'connected', detail: 'orchestra-mock.zendesk.com', scope: 'Read tickets, add internal notes, set status' },
      outlook: { name: 'Outlook', status: 'connected', detail: 'ap@orchestra-mock.example', scope: 'Read and send from the shared AP mailbox' },
      netsuite: { name: 'NetSuite', status: 'connected', detail: 'Read-only', scope: 'Read vendors, bills and payments. No write access' },
    },
  };
  S.unread = S.events.filter((e) => !e.read).length;
  document.documentElement.dataset.role = session.role;
  renderTopbar();
  renderRail();
  renderTabs();
  watchChromeHeight();
  bindKeys();
  if (isStaff(session.role)) loadConnections();
  try { live.subscribe?.(onLiveEvent); } catch (err) { console.warn('Live updates are unavailable.', err); }
  $('#app').removeAttribute('aria-busy');
  return { setRoute };
}

export function setRoute(route) {
  if (!S) return;
  S.route = route;
  renderRail();
}

// ---------------------------------------------------------------------------- top bar
function renderTopbar() {
  const { session } = S;
  const staff = isStaff(session.role);
  const home = (RAIL[session.role] || ['inbox'])[0];
  mount($('#topbar'),
    h('a', { class: 'c-topbar-brand', href: SECTIONS[home].href, 'aria-label': `Orchestra Conductor, ${SECTIONS[home].label}` },
      lockup({ product: 'conductor', tone: 'dark' })),
    staff ? searchBox() : null,
    h('div', { class: 'c-topbar-spacer' }),
    h('div', { class: 'c-topbar-tools' },
      staff ? h('button', { class: 'c-topbar-btn c-topbar-search-toggle', type: 'button', 'aria-label': 'Search', title: 'Search', onclick: openSearch }, icon('search')) : null,
      staff ? h('div', { id: 'c-conn', class: 'c-conn-slot' }) : null,
      bellButton(),
      userButton()));
  if (staff) renderConn();
  renderBell();
}

function searchBox() {
  const input = h('input', {
    id: 'c-search-input', class: 'c-search-input', type: 'search', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Search tickets, vendors and invoices', 'aria-label': 'Search tickets, vendors and invoices',
  });
  const form = h('form', {
    class: 'c-search', role: 'search', id: 'c-search',
    onsubmit: (e) => {
      e.preventDefault();
      const q = input.value.trim();
      const handler = searchHandlers[searchHandlers.length - 1];
      if (handler) handler(q);
      else location.hash = q ? `#/inbox?q=${encodeURIComponent(q)}` : '#/inbox';
      document.documentElement.classList.remove('c-search-open');
    },
  }, icon('search', 'c-search-icon'), input, h('kbd', { class: 'c-search-kbd', 'aria-hidden': 'true' }, '/'),
  h('button', { class: 'c-search-close', type: 'button', 'aria-label': 'Close search', onclick: closeSearch }, icon('x')));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.blur(); closeSearch(); } });
  return form;
}
function openSearch() {
  document.documentElement.classList.add('c-search-open');
  $('#c-search-input')?.focus();
}
function closeSearch() {
  document.documentElement.classList.remove('c-search-open');
}

// connection indicator: Zendesk · Outlook · NetSuite
async function loadConnections() {
  if (typeof inboxApi.connections !== 'function') return;
  try {
    const r = await inboxApi.connections();
    const patch = {};
    for (const c of r.connections || []) if (S.conns[c.id]) patch[c.id] = { status: c.status, detail: c.detail || S.conns[c.id].detail, last_sync: c.last_sync };
    setConnections(patch);
  } catch { /* keep the last known state */ }
}
function connTone(status) { return status === 'connected' ? 'settled' : status === 'syncing' ? 'scheduled' : 'risk'; }
function renderConn() {
  const slot = $('#c-conn');
  if (!slot) return;
  const list = Object.values(S.conns);
  const allOk = list.every((c) => c.status === 'connected');
  const summary = allOk ? 'Zendesk, Outlook and NetSuite connected' : `Connection problem: ${list.filter((c) => c.status !== 'connected').map((c) => c.name).join(', ')}`;
  const btn = h('button', { class: `c-conn${allOk ? '' : ' has-problem'}`, type: 'button', 'aria-label': `${summary}. Show connections`, title: summary, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    list.map((c) => h('span', { class: 'c-conn-item' }, h('span', { class: `c-dot c-dot-${connTone(c.status)}`, 'aria-hidden': 'true' }), h('span', { class: 'c-conn-name' }, c.name))));
  btn.addEventListener('click', () => {
    openMenu({
      anchor: btn, align: 'end', label: 'Connections', width: 320,
      items: [
        { heading: 'Connections' },
        ...list.map((c) => ({ node: h('div', { class: 'c-conn-row' },
          h('span', { class: `c-dot c-dot-${connTone(c.status)}`, 'aria-hidden': 'true' }),
          h('div', { class: 'c-conn-row-text' },
            h('strong', null, c.name, h('span', { class: 'c-conn-state' }, c.status === 'connected' ? 'Connected' : c.status === 'syncing' ? 'Syncing' : 'Not connected')),
            h('span', { class: 'mono' }, c.detail), h('span', null, c.scope),
            c.last_sync ? h('span', null, `Last sync ${relTime(c.last_sync)}`) : null)) })),
        { separator: true },
        { label: 'Manage connections', icon: 'plug', href: '#/connections' },
      ],
    });
  });
  mount(slot, btn);
}

// notifications
function bellButton() {
  return h('button', { class: 'c-topbar-btn c-bell', id: 'c-bell', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: toggleTray },
    icon('bell'), h('span', { class: 'c-bell-count', id: 'c-bell-count', 'aria-hidden': 'true' }));
}
function renderBell() {
  const btn = $('#c-bell');
  if (!btn) return;
  const n = S.unread;
  btn.setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications');
  btn.title = n ? `${n} unread` : 'Notifications';
  const c = $('#c-bell-count');
  c.textContent = n > 99 ? '99+' : String(n);
  c.hidden = !n;
}

let tray = null;
function toggleTray() { if (tray) closeTray(); else openTray(); }
function closeTray({ refocus = false } = {}) {
  if (!tray) return;
  tray.remove();
  tray = null;
  document.removeEventListener('pointerdown', onTrayOutside, true);
  $('#c-bell')?.setAttribute('aria-expanded', 'false');
  if (refocus) $('#c-bell')?.focus();
}
function onTrayOutside(e) { if (tray && !tray.contains(e.target) && !$('#c-bell').contains(e.target)) closeTray(); }
function openTray() {
  closeMenu();
  const list = S.events;
  tray = h('section', { class: 'c-tray', role: 'dialog', 'aria-label': 'Notifications', tabindex: '-1' },
    h('header', { class: 'c-tray-head' },
      h('h2', null, 'Notifications'),
      list.some((e) => !e.read) ? h('button', { class: 'c-btn c-btn-quiet c-btn-sm', type: 'button', onclick: () => { markAllRead(); closeTray({ refocus: true }); } }, 'Mark all as read') : null,
      h('button', { class: 'c-btn c-btn-quiet c-btn-icon c-btn-sm', type: 'button', 'aria-label': 'Close notifications', onclick: () => closeTray({ refocus: true }) }, icon('x'))),
    list.length
      ? h('ol', { class: 'c-tray-list' }, list.map((e) => h('li', { class: `c-tray-item${e.read ? '' : ' is-unread'}` },
        h('a', { href: linkFor(e), onclick: () => closeTray() },
          h('span', { class: 'c-tray-icon', 'aria-hidden': 'true' }, icon(iconFor(e.type))),
          h('span', { class: 'c-tray-text' }, h('span', null, e.summary || e.type), h('time', null, timeOf(e))),
          e.read ? null : h('span', { class: 'sr-only' }, 'Unread')))))
      : h('div', { class: 'c-tray-empty' }, icon('bell'), h('strong', null, 'No notifications yet'), h('span', null, 'Arrivals, escalations and replies that need you show up here.')),
    h('footer', { class: 'c-tray-foot' }, 'Keeps the last 50 updates for this window.'));
  tray.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeTray({ refocus: true }); } });
  document.body.append(tray);
  document.addEventListener('pointerdown', onTrayOutside, true);
  $('#c-bell').setAttribute('aria-expanded', 'true');
  tray.focus();
  markAllRead({ render: false });
}
function markAllRead({ render = true } = {}) {
  S.events.forEach((e) => { e.read = true; });
  S.unread = 0;
  saveEvents();
  renderBell();
  void render;
}

function iconFor(type = '') {
  if (type.startsWith('ticket.arrived') || type === 'direct.question') return 'mail';
  if (type === 'ticket.escalated' || type === 'signoff.requested') return 'escalations';
  if (type === 'ticket.returned') return 'arrow-left';
  if (type === 'ticket.sent' || type === 'outbound.sent' || type === 'ahead.sent') return 'send';
  if (type === 'ticket.signed_off' || type === 'ticket.decided') return 'circle-check';
  if (type === 'ticket.assigned') return 'user';
  if (type === 'w9.received') return 'file';
  if (type === 'approver.committed') return 'calendar';
  return 'bell';
}
function linkFor(e) {
  const role = S.session.role;
  if (role === 'approver') return '#/approver';
  if (e.ticket_id) return role === 'cfo' && (e.type === 'ticket.escalated' || e.type === 'signoff.requested') ? `#/escalations/${e.ticket_id}` : `#/inbox/${e.ticket_id}`;
  if (e.type === 'w9.received') return '#/vendor-setup';
  if (e.type === 'ahead.sent') return '#/ahead';
  return location.hash || '#/';
}
function timeOf(e) {
  const t = e.at ? Date.parse(e.at) : NaN;
  return Number.isNaN(t) ? '' : new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function loadEvents() { try { return JSON.parse(sessionStorage.getItem(NOTE_KEY) || '[]').slice(0, 50); } catch { return []; } }
function saveEvents() { try { sessionStorage.setItem(NOTE_KEY, JSON.stringify(S.events.slice(0, 50))); } catch { /* storage blocked */ } }

const QUIET = new Set(['queue.counts', 'sync.status', 'ticket.outcome']); // counts and progress update in place; not worth a notification
function addressedToMe(ev) {
  const me = (S.session.email || '').toLowerCase();
  if (ev.actor?.email && ev.actor.email.toLowerCase() === me) return false;
  if ((ev.to || []).some((x) => String(x).toLowerCase() === me)) return true;
  if (S.session.role === 'cfo' && (ev.type === 'ticket.escalated' || ev.type === 'signoff.requested')) return true;
  return false;
}
function onLiveEvent(ev) {
  if (!ev || !ev.type || QUIET.has(ev.type)) return;
  if (ev.id && S.events.some((e) => e.id === ev.id)) return;
  const mine = addressedToMe(ev);
  S.events.unshift({ id: ev.id, type: ev.type, summary: ev.summary, at: ev.at, ticket_id: ev.ticket_id, read: false });
  S.events = S.events.slice(0, 50);
  S.unread = S.events.filter((e) => !e.read).length;
  saveEvents();
  renderBell();
  if (mine) toast({ message: ev.summary || 'You have an update.', tone: ev.type === 'ticket.escalated' ? 'risk' : 'neutral', actionLabel: ev.ticket_id ? 'Open' : null, onAction: () => { location.hash = linkFor(ev); } });
}

// user menu
function userButton() {
  const { session } = S;
  const btn = h('button', { class: 'c-user', type: 'button', 'aria-label': `Account: ${session.name}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
    avatar({ name: session.name, size: 'sm', tone: 'chrome' }),
    h('span', { class: 'c-user-name' }, session.name),
    icon('chev-down', 'c-user-caret'));
  btn.addEventListener('click', () => {
    closeTray();
    openMenu({
      anchor: btn, align: 'end', label: 'Account', width: 280,
      items: [
        { node: h('div', { class: 'c-usercard' }, h('strong', null, session.name), session.title ? h('span', null, session.title) : null, h('span', null, session.email)) },
        { separator: true },
        session.role === 'cfo' ? { label: 'Style guide', icon: 'palette', href: '#/styleguide' } : null,
        { label: 'Sign out', icon: 'log-out', onSelect: () => signOut() },
      ],
    });
  });
  return btn;
}

// ---------------------------------------------------------------------------- rail
let railSig = '';
function renderRail() {
  const role = S.session.role;
  const items = RAIL[role] || [];
  const routeName = S.route?.name;
  const active = SECTION_OF[routeName] || routeName;
  const sig = `${role}|${active}`;
  if (sig === railSig) return;
  railSig = sig;
  const link = (id) => {
    const s = SECTIONS[id];
    return h('a', { class: `c-rail-item${id === 'settings' ? ' is-foot' : ''}`, href: s.href, 'aria-current': active === id ? 'page' : null, title: s.title || s.label },
      icon(s.icon), h('span', { class: 'c-rail-label' }, s.label));
  };
  mount($('#rail'), h('div', { class: 'c-rail-items' }, items.filter((i) => i !== 'settings').map(link)),
    items.includes('settings') ? h('div', { class: 'c-rail-foot' }, link('settings')) : null);
}

// ---------------------------------------------------------------------------- ticket tabs
function renderTabs() {
  const strip = $('#ticket-tabs');
  const tabs = S.tabs || [];
  strip.hidden = !tabs.length;
  mount(strip, tabs.map((t) => h('div', { class: `c-ttab${t.active ? ' is-active' : ''}` },
    h('a', { class: 'c-ttab-link', href: t.href, 'aria-current': t.active ? 'page' : null, title: t.sub ? `${t.label}, ${t.sub}` : t.label },
      t.unread ? h('span', { class: 'c-dot c-dot-scheduled', 'aria-hidden': 'true' }) : icon('mail', 'c-ttab-icon'),
      h('span', { class: 'c-ttab-text' }, h('span', { class: 'c-ttab-label' }, t.label), t.sub ? h('span', { class: 'c-ttab-sub' }, t.sub) : null)),
    h('button', { class: 'c-ttab-close', type: 'button', 'aria-label': `Close ${t.label}`, onclick: () => tabCloseHandlers.forEach((fn) => fn(t.id)) }, icon('x')))));
}

// ---------------------------------------------------------------------------- layout bookkeeping
// --topbar-h is everything sticky above <main> (green bar + ticket strip + legacy context bar); the old views size
// themselves with it. --banner-h is the global banner below it.
function watchChromeHeight() {
  const root = document.documentElement;
  const update = () => {
    const chrome = $('#topbar').offsetHeight;
    const head = $('#workhead').offsetHeight;
    root.style.setProperty('--chrome-h', `${chrome}px`);
    root.style.setProperty('--topbar-h', `${chrome + head}px`);
    root.style.setProperty('--banner-h', `${$('#banners').offsetHeight}px`);
  };
  const ro = new ResizeObserver(update);
  ro.observe($('#topbar'));
  ro.observe($('#workhead'));
  ro.observe($('#banners'));
  update();
}

function bindKeys() {
  // The skip link moves focus without touching the hash (a hash change would be read as a route).
  $('.skip')?.addEventListener('click', (e) => { e.preventDefault(); $('#main').focus({ preventScroll: false }); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !isTyping(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey && $('#c-search-input') && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      openSearch();
    }
  });
}
