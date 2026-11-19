// Zendesk-style ticket tabs for threads opened in this window (shell.setTicketTabs). Kept per tab in sessionStorage,
// so the strip survives a reload. One close handler is registered for the whole session, not per view mount.
import { setTicketTabs, onTicketTabClose } from '../../shell.js';

const KEY = 'conductor.ticketTabs';
const MAX = 8;
let tabs = load();
let active = null;
let hrefFor = (id) => `#/inbox/${id}`;
let onClosed = null;
let registered = false;

function load() { try { return JSON.parse(sessionStorage.getItem(KEY) || '[]').slice(0, MAX); } catch { return []; } }
function save() { try { sessionStorage.setItem(KEY, JSON.stringify(tabs)); } catch { /* storage blocked */ } }
function paint() {
  setTicketTabs(tabs.map((t) => ({ id: t.id, label: t.label, sub: `#${t.id}${t.company ? ` · ${t.company}` : ''}`, href: hrefFor(t.id), active: t.id === active })));
}
function ensure() {
  if (registered) return;
  registered = true;
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
  /** Show the strip; hrefFor(id) builds each tab's link; closed(id, wasActive, neighbour) runs when a tab is closed. */
  attach({ href, closed } = {}) { ensure(); if (href) hrefFor = href; onClosed = closed || null; paint(); },
  detach() { onClosed = null; active = null; paint(); },
  open(thread) {
    ensure();
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
};
