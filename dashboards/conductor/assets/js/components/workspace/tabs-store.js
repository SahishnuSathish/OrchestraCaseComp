// Zendesk-style ticket tabs for threads opened in this window (shell.setTicketTabs). Kept per tab in sessionStorage,
// so the strip survives a reload. One close handler is registered for the whole session, not per view mount.
// The tabs belong to one person and one sign-in: they are stored under the signed-in email together with the session
// id, so another person never sees them, and a new sign-in (after Sign out) starts with none. The strip shows only
// while the Inbox is mounted, and only at 768 px or wider.
import { setTicketTabs, onTicketTabClose } from '../../shell.js';
import { session as httpSession } from '../../http.js';

const PREFIX = 'conductor.ticketTabs';
const MAX = 8;
const WIDE = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(min-width: 768px)') : null;
let owner = null; // the signed-in email the tabs belong to
let tabs = [];
let active = null;
let attached = false;
let hrefFor = (id) => `#/inbox/${id}`;
let onClosed = null;
let registered = false;

const keyFor = (email) => `${PREFIX}.${email}`;
const sessionId = () => httpSession.get()?.session || '';

function load(email) {
  try {
    const raw = JSON.parse(sessionStorage.getItem(keyFor(email)) || 'null');
    // Tabs from an earlier sign-in (the person signed out and in again) are not carried over.
    if (!raw || raw.session !== sessionId() || !Array.isArray(raw.tabs)) return [];
    return raw.tabs.slice(0, MAX);
  } catch { return []; }
}
function save() {
  if (!owner) return;
  try { sessionStorage.setItem(keyFor(owner), JSON.stringify({ session: sessionId(), tabs })); } catch { /* storage blocked */ }
}
/** Drop every stored strip that is not this person's, including the old unkeyed one. */
function sweep(email) {
  try {
    const keep = keyFor(email);
    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(PREFIX) && k !== keep) sessionStorage.removeItem(k);
    }
  } catch { /* storage blocked */ }
}
function paint() {
  if (!attached || !WIDE?.matches) { setTicketTabs([]); return; }
  setTicketTabs(tabs.map((t) => ({ id: t.id, label: t.label, sub: `#${t.id}${t.company ? ` · ${t.company}` : ''}`, href: hrefFor(t.id), active: t.id === active })));
}
function ensure() {
  if (registered) return;
  registered = true;
  WIDE?.addEventListener?.('change', paint);
  onTicketTabClose((id) => {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    tabs.splice(i, 1);
    save();
    const wasActive = active === id;
    if (wasActive) active = null;
    paint();
    onClosed?.(id, wasActive, tabs[i] || tabs[i - 1] || null);
  });
}

export const ticketTabs = {
  /**
   * Show the strip for the signed-in person. email: the session's email; href(id) builds each tab's link;
   * closed(id, wasActive, neighbour) runs when a tab is closed.
   */
  attach({ email, href, closed } = {}) {
    ensure();
    const who = String(email || '').toLowerCase();
    if (who !== owner) { owner = who || null; tabs = owner ? load(owner) : []; active = null; }
    if (owner) sweep(owner);
    if (href) hrefFor = href;
    onClosed = closed || null;
    attached = true;
    paint();
  },
  /** The Inbox is leaving: hide the strip (the tabs are kept for when the person comes back). */
  detach() { onClosed = null; active = null; attached = false; paint(); },
  open(thread) {
    ensure();
    if (!owner) return;
    const id = thread.ticket_id;
    const entry = { id, label: thread.subject || `Ticket #${id}`, company: thread.company || thread.from_name || '' };
    const i = tabs.findIndex((t) => t.id === id);
    if (i >= 0) tabs[i] = entry; else { tabs.unshift(entry); tabs = tabs.slice(0, MAX); }
    active = id;
    save();
    paint();
  },
  setActive(id) { active = id ?? null; paint(); },
  refresh() { paint(); },
  /** Forget this person's tabs (for Sign out). */
  clear() {
    tabs = []; active = null;
    try { if (owner) sessionStorage.removeItem(keyFor(owner)); } catch { /* storage blocked */ }
    paint();
  },
};
