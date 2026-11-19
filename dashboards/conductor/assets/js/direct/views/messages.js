// Messages: replies our team approved and sent, newest first. A question appears here only once a person has
// reviewed and sent the answer. Live: a direct.message event reloads the list.
import { h, icon } from '../../lib.js';
import { button, empty, skeletonRows } from '../../components/index.js';
import * as direct from '../../api-direct.js';
import { fmtStamp } from '../format.js';
import { format, invoiceHref } from '../routes.js';
import { pageHead } from '../components/page.js';

export function mount(root, { ctx }) {
  const head = pageHead({ title: 'Messages', sub: 'Replies from our accounts payable team. A person reviews every answer before it is sent.' });
  const list = h('div', { class: 'dx-feed-slot' }, h('div', { class: 'dx-panel' }, skeletonRows({ rows: 3, avatar: false, lines: 3, label: 'Loading your messages' })));
  const live = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  root.replaceChildren(h('div', { class: 'dx-page dx-messages' }, head, live, list));
  let alive = true;
  let known = null;

  function item(m, isNew) {
    return h('li', null, h('article', { class: `dx-msg${isNew ? ' is-new' : ''}` },
      h('header', { class: 'dx-msg-head' },
        h('h2', { class: 'dx-msg-subject' }, m.subject || 'Reply from accounts payable'),
        h('time', { class: 'dx-msg-at', datetime: m.at }, fmtStamp(m.at))),
      m.invoice ? h('a', { class: 'dx-msg-ref', href: invoiceHref(m.invoice) }, icon('file', 'icon-sm'), h('span', null, 'Invoice '), h('span', { class: 'mono' }, m.invoice)) : null,
      h('div', { class: 'dx-msg-body' }, m.body)));
  }

  async function load({ announce = false } = {}) {
    try {
      const r = await direct.messages();
      if (!alive) return;
      const rows = r.rows || [];
      const keys = rows.map((m) => `${m.at}|${m.subject}`);
      const fresh = known ? new Set(keys.filter((k) => !known.has(k))) : new Set();
      known = new Set(keys);
      if (!rows.length) {
        list.replaceChildren(h('div', { class: 'dx-panel' }, empty({
          icon: 'message', title: 'No replies yet.',
          text: 'Ask a question from any invoice. When our team replies, the answer appears here and in your email.',
          actions: button({ label: 'Go to invoices', variant: 'secondary', href: format({ section: 'invoices' }) }),
        })));
      } else {
        list.replaceChildren(h('ul', { class: 'dx-feed', 'aria-label': 'Replies' }, rows.map((m, i) => item(m, fresh.has(keys[i])))));
      }
      if (announce && fresh.size) live.textContent = 'A new reply from our team has arrived.';
      if (fresh.size) setTimeout(() => list.querySelectorAll('.is-new').forEach((n) => n.classList.remove('is-new')), 6000);
      ctx.refreshMe?.();   // reading the list marks it read on the server
    } catch {
      if (!alive) return;
      list.replaceChildren(h('div', { class: 'dx-panel' }, empty({
        icon: 'circle-alert', title: "We couldn't load your messages.", text: 'Please try again in a moment.',
        actions: button({ label: 'Try again', icon: 'refresh', onClick: () => load() }),
      })));
    }
  }
  load();

  return {
    heading: head.heading,
    onLive() { load({ announce: true }); },
    destroy() { alive = false; },
  };
}
