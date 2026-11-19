// Updates: Conductor: Ahead notices sent to this vendor (live on direct.update), and notification preferences.
import { h } from '../../lib.js';
import { button, checkbox, empty, skeletonRows, skeletonText, setBusy, mark } from '../../components/index.js';
import * as direct from '../../api-direct.js';
import { fmtStamp } from '../format.js';
import { pageHead, section, liveStatus } from '../components/page.js';

const TYPES = [
  { id: 'payment_updates', label: 'Payment updates', help: 'When an invoice is scheduled for payment or a payment is sent.' },
  { id: 'approval_delays', label: 'Approval delays', help: 'When an invoice is taking longer than usual to approve.' },
  { id: 'document_requests', label: 'Document requests', help: 'When we need a document from you, such as a W-9.' },
];

function prefsForm() {
  const node = h('div', { class: 'dx-prefs' }, skeletonText({ lines: 4, label: 'Loading your preferences' }));
  const status = liveStatus();

  function render(p) {
    const email = checkbox({ label: 'Email me updates', help: 'We send each update to your email as well as posting it here.', checked: !!p.email_updates });
    const types = TYPES.map((t) => {
      const c = checkbox({ label: t.label, help: t.help, checked: (p.notice_types || []).includes(t.id) });
      c.dataset.type = t.id;
      return c;
    });
    const save = button({ label: 'Save preferences', variant: 'primary', type: 'submit' });
    const form = h('form', { class: 'dx-prefs-form' },
      email,
      h('fieldset', { class: 'dx-fieldset' }, h('legend', null, 'Tell me about'), types),
      h('div', { class: 'dx-prefs-foot' }, save, status));
    form.addEventListener('change', () => status.say(''));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      setBusy(save, true);
      try {
        const next = await direct.savePreferences({
          email_updates: email.control.checked,
          notice_types: types.filter((c) => c.control.checked).map((c) => c.dataset.type),
        });
        email.control.checked = !!next.email_updates;
        for (const c of types) c.control.checked = (next.notice_types || []).includes(c.dataset.type);
        setBusy(save, false);
        status.say('Preferences saved.');
      } catch {
        setBusy(save, false);
        status.say("Your preferences weren't saved. Please try again.", 'risk');
      }
    });
    node.replaceChildren(form);
  }

  direct.preferences().then(render).catch(() => {
    node.replaceChildren(empty({ compact: true, icon: 'circle-alert', title: "We couldn't load your preferences.", text: 'Please try again in a moment.' }));
  });
  return node;
}

export function mount(root, { ctx }) {
  const head = pageHead({ title: 'Updates', sub: 'Notes from our team about your invoices, sent before you need to ask.' });
  const list = h('div', { class: 'dx-feed-slot' }, h('div', { class: 'dx-panel' }, skeletonRows({ rows: 3, avatar: false, lines: 2, label: 'Loading your updates' })));
  const live = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  let alive = true;
  let known = null;

  root.replaceChildren(h('div', { class: 'dx-page dx-updates' }, head, live,
    h('div', { class: 'dx-updates-grid' },
      h('div', { class: 'dx-updates-main' }, list),
      section({ id: 'dx-prefs', title: 'Notification preferences', body: prefsForm(), class: 'dx-prefs-section' }))));

  async function load({ announce = false } = {}) {
    try {
      const r = await direct.updates();
      if (!alive) return;
      const rows = r.rows || [];
      const keys = rows.map((u) => `${u.at}|${u.title}`);
      const fresh = known ? new Set(keys.filter((k) => !known.has(k))) : new Set();
      known = new Set(keys);
      list.replaceChildren(rows.length
        ? h('ul', { class: 'dx-feed', 'aria-label': 'Updates' }, rows.map((u, i) => h('li', null,
          h('article', { class: `dx-msg dx-update${fresh.has(keys[i]) ? ' is-new' : ''}` },
            h('header', { class: 'dx-msg-head' },
              h('div', { class: 'dx-update-title' }, mark({ product: 'ahead', size: 20 }), h('h2', { class: 'dx-msg-subject' }, u.title)),
              h('time', { class: 'dx-msg-at', datetime: u.at }, fmtStamp(u.at))),
            h('div', { class: 'dx-msg-body' }, u.body)))))
        : h('div', { class: 'dx-panel' }, empty({
          icon: 'bell', title: 'No updates yet.',
          text: 'When an invoice is scheduled, paid or needs something from you, we post a note here.',
        })));
      if (announce && fresh.size) live.textContent = 'A new update has arrived.';
      ctx.refreshMe?.();   // reading the list marks it read on the server
    } catch {
      if (!alive) return;
      list.replaceChildren(h('div', { class: 'dx-panel' }, empty({
        icon: 'circle-alert', title: "We couldn't load your updates.", text: 'Please try again in a moment.',
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
