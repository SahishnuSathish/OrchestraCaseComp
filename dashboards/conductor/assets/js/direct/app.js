// Conductor: Direct, the vendor dashboard at /direct. Owner: p3/direct-ui. Contract: docs/phase3/CONTRACTS.md sections 9 and 12.
// Boot: check the session (vendors only), build the navy frame, then route on the hash.
// Views follow the workspace convention: mount(root, { route, ctx }) -> { update?, destroy?, heading?, onLive? }.
import { h } from '../lib.js';
import { directShell, toast, progress, empty, button } from '../components/index.js';
import { current, signOut } from '../api-session.js';
import * as direct from '../api-direct.js';
import { subscribe } from '../api-live.js';
import { ensureDirectIcons } from './icons.js';
import { parse, format } from './routes.js';
import * as invoicesView from './views/invoices.js';
import * as invoiceView from './views/invoice.js';
import * as messagesView from './views/messages.js';
import * as documentsView from './views/documents.js';
import * as updatesView from './views/updates.js';

const NEXT_KEY = 'conductor.direct.next';   // where a signed-out visitor was headed (sessionStorage, this tab only)
const TITLES = { invoices: 'Invoices', messages: 'Messages', documents: 'Documents and W-9', updates: 'Updates' };
const VIEWS = { invoices: invoicesView, messages: messagesView, documents: documentsView, updates: updatesView };

// The phone nav shows a short label; screen readers always get the full one.
function navLabel(full, short) {
  if (full === short) return full;
  return h('span', { class: 'dx-navlabel' },
    h('span', { class: 'dx-navlabel-short', 'aria-hidden': 'true' }, short),
    h('span', { class: 'dx-navlabel-full' }, full));
}

async function boot() {
  const mountPoint = document.getElementById('direct-root');
  let s = null;
  try { s = await current(); } catch { s = null; }
  if (!s || s.role !== 'vendor') {
    if (!s && location.hash && location.hash.length > 2) {
      try { sessionStorage.setItem(NEXT_KEY, location.hash); } catch { /* storage blocked */ }
    }
    location.replace('/');
    return;
  }
  try {
    const next = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
    if (next && !location.hash) history.replaceState(null, '', next);
  } catch { /* storage blocked */ }

  ensureDirectIcons();

  const nav = [
    { id: 'invoices', label: 'Invoices', href: format({ section: 'invoices' }) },
    { id: 'messages', label: 'Messages', href: format({ section: 'messages' }) },
    { id: 'documents', label: navLabel('Documents & W-9', 'Documents'), href: format({ section: 'documents' }) },
    { id: 'updates', label: 'Updates', href: format({ section: 'updates' }) },
  ];
  const shell = directShell({
    vendor: { name: s.vendor?.name || '' },
    contact: { name: s.name || '', email: s.email || '' },
    nav, current: 'invoices', onSignOut: () => signOut(),
  });
  shell.classList.add('dx-app');
  mountPoint.replaceWith(shell);

  let view = null;
  let viewKey = null;
  let first = true;

  function setCounts(me) {
    const unread = { messages: me?.unread_messages || 0, updates: me?.unread_updates || 0 };
    for (const n of nav) n.count = unread[n.id] || null;
    shell.update({});
    // the badge is a bare number, so the link's name says what it counts
    shell.querySelectorAll('.c-direct-navlink').forEach((a, i) => {
      const n = nav[i];
      const badge = a.querySelector('.c-direct-navcount');
      if (badge) {
        badge.setAttribute('aria-hidden', 'true');
        a.setAttribute('aria-label', `${n.id === 'messages' ? 'Messages' : 'Updates'}, ${n.count} new`);
      } else a.removeAttribute('aria-label');
    });
  }

  const ctx = {
    me: null,
    listHash: '#/invoices',
    async refreshMe() {
      try {
        ctx.me = await direct.me();
        shell.update({
          vendor: { name: ctx.me.vendor?.name || s.vendor?.name || '' },
          contact: { name: ctx.me.contact?.name || s.name || '', email: ctx.me.contact?.email || s.email || '' },
        });
        setCounts(ctx.me);
      } catch { /* the header keeps the names from the session */ }
      return ctx.me;
    },
    setCounts,
  };
  ctx.mePromise = progress.track(ctx.refreshMe());

  function route() {
    const r = parse(location.hash);
    if (!r.known) { history.replaceState(null, '', format({ section: 'invoices' })); route(); return; }
    const key = r.ref ? `invoice:${r.ref}` : r.section;
    if (r.section === 'invoices' && !r.ref) ctx.listHash = format({ section: 'invoices', query: r.query });

    shell.update({ current: r.section });
    setCounts(ctx.me);
    if (view && key === viewKey && view.update) { view.update({ route: r }); return; }

    view?.destroy?.();
    const host = h('div', { class: 'dx-view' });
    shell.main.replaceChildren(host);
    document.title = `${r.ref ? `Invoice ${r.ref}` : TITLES[r.section]} | Conductor: Direct`;
    viewKey = key;
    try {
      view = (r.ref ? invoiceView : VIEWS[r.section]).mount(host, { route: r, ctx }) || {};
    } catch (e) {
      console.error(e);
      view = {};
      host.replaceChildren(empty({ icon: 'circle-alert', title: "This page didn't load.", text: 'Please reload the page.', actions: button({ label: 'Reload', icon: 'refresh', onClick: () => location.reload() }) }));
    }
    if (!first) {
      window.scrollTo({ top: 0 });
      const hd = typeof view.heading === 'function' ? view.heading() : view.heading;
      (hd || shell.main.querySelector('h1') || shell.main).focus({ preventScroll: true });
    }
    first = false;
  }

  window.addEventListener('hashchange', route);
  route();

  subscribe((ev) => {
    if (ev.type !== 'direct.message' && ev.type !== 'direct.update') return;
    const isMsg = ev.type === 'direct.message';
    const target = isMsg ? 'messages' : 'updates';
    if (viewKey === target && view?.onLive) { view.onLive(ev); return; }
    ctx.refreshMe();
    toast({
      tone: 'info',
      title: isMsg ? 'New reply' : 'New update',
      message: isMsg ? 'Our team has replied. You can read it in Messages.' : 'There is a new payment update for you.',
      actionLabel: isMsg ? 'Open Messages' : 'Open Updates',
      onAction: () => { location.hash = format({ section: target }); },
    });
  });
}

boot();
