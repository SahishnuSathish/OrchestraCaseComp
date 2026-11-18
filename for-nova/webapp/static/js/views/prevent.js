// Prevent: answers sent before anyone has to ask. Deflection numbers, proactive vendor notices and approver digests,
// each approved and then sent (or skipped) by a person. Recipients and text come from the server's records only.
import { h, icon, mount as fill, fmtInt, plural } from '../lib.js';
import { api } from '../api.js';
import { pageHeader, panel, statTile, emptyState, banner, toast, copyButton } from '../ui.js';

const STATE_LABEL = { pending: 'To review', approved: 'Approved', skipped: 'Skipped', sent: 'Sent' };
const STATE_BADGE = { pending: 'badge-quiet', approved: 'badge-accent', skipped: 'badge-quiet', sent: 'badge-success' };

export function mount(root, { route }) {
  const runId = route.runId;
  let alive = true;
  let busy = false;
  let data = null;

  const body = h('div', { class: 'page-grid' });
  const buildBtn = h('button', { class: 'btn', type: 'button', onclick: () => build() }, icon('rotate'), 'Build from records');
  fill(root, h('div', { class: 'page' },
    pageHeader({ title: 'Prevent', meta: 'Answers sent before anyone has to ask. Nothing goes out until you approve and send it.', actions: buildBtn }),
    body));

  const stateOf = (kind, key) => (data.states[`${kind}:${key}`] || {}).state || 'pending';

  async function act(fn, okText) {
    if (busy) return;
    busy = true;
    buildBtn.disabled = true;
    try {
      const next = await fn();
      if (!alive) return;
      data = next;
      render();
      if (okText) toast({ message: okText });
    } catch (e) {
      if (alive) toast({ message: e.message });
    } finally {
      busy = false;
      buildBtn.disabled = false;
    }
  }

  const build = () => act(() => api.buildPrevention(runId), 'Built from the current records.');
  const setState = (kind, key, state) => act(() => api.preventionState(runId, kind, key, state));

  function actions(kind, item, to, canSend) {
    const st = stateOf(kind, item.key);
    if (st === 'sent') return [];
    const btn = (label, cls, onclick, extra = {}) => h('button', { class: `btn btn-sm ${cls}`, type: 'button', onclick, ...extra }, label);
    const out = [];
    if (st === 'approved') {
      out.push(btn([icon('send'), 'Send'], 'btn-primary', () => act(() => api.preventionSend(runId, kind, item.key), `Sent to ${to}.`),
        { disabled: canSend ? null : true, title: canSend ? `Send to ${to}` : 'There is no approver on record to send this to' }));
      out.push(btn('Undo', 'btn-quiet', () => setState(kind, item.key, 'pending')));
    } else if (st === 'skipped') {
      out.push(btn('Undo skip', 'btn-quiet', () => setState(kind, item.key, 'pending')));
    } else {
      out.push(btn([icon('check'), 'Approve'], '', () => setState(kind, item.key, 'approved')));
      out.push(btn('Skip', 'btn-quiet', () => setState(kind, item.key, 'skipped')));
    }
    return out;
  }

  function itemCard(kind, item, title, to, canSend) {
    const st = stateOf(kind, item.key);
    return h('article', { class: 'prevent-item', 'data-kind': kind, 'data-key': item.key, 'data-state': st },
      h('div', { class: 'prevent-item-head' },
        h('div', { class: 'prevent-item-title' },
          h('h3', null, title),
          h('p', { class: 'muted' }, to ? `To ${to}` : 'No approver on record, so this can’t be sent')),
        h('div', { class: 'prevent-item-actions' },
          h('span', { class: `badge ${STATE_BADGE[st]}` }, st === 'sent' ? icon('check') : null, STATE_LABEL[st]),
          ...actions(kind, item, to, canSend))),
      h('details', { class: 'prevent-message' },
        h('summary', null, 'Message'),
        h('pre', { class: 'prevent-text' }, item.text),
        h('div', { class: 'prevent-item-actions' }, copyButton(item.text, 'Copy text'))));
  }

  function countText(kind, items) {
    const todo = items.filter((x) => stateOf(kind, x.key) === 'pending').length;
    return todo ? `${fmtInt(todo)} to review` : `${fmtInt(items.length)}`;
  }

  function render() {
    body.classList.add('prevent-ready'); // loaded (tests wait for this)
    if (!data.built) {
      fill(body, emptyState({
        iconName: 'send', title: 'Nothing built yet',
        text: 'Build vendor notices and approver digests from this run’s records. It takes a few seconds and changes no ticket.',
        action: h('button', { class: 'btn btn-primary', type: 'button', onclick: () => build() }, 'Build from records'),
      }));
      return;
    }
    const r = data.report;
    const [lo, hi] = r.monthly_estimate.self_servable_tickets_per_month;
    fill(body,
      banner({ tone: 'info', text: `Estimates from this run’s ${fmtInt(r.tickets)} tickets, not measured on live mail. Built ${new Date(data.built_at * 1000).toLocaleString()}.` }),
      h('div', { class: 'stat-grid', role: 'group', 'aria-label': 'Tickets that need not be written' },
        statTile({ label: 'Self-servable', value: `${r.self_servable.pct}%`, sub: `${fmtInt(r.self_servable.count)} of ${fmtInt(r.tickets)} tickets`, icon: 'inbox' }),
        statTile({ label: 'Preventable by a notice', value: `${r.preventable_by_notice.pct}%`, sub: plural(r.preventable_by_notice.count, 'ticket'), icon: 'send' }),
        statTile({ label: 'Approver notes', value: `${fmtInt(r.approver_consolidation.notes)} → ${fmtInt(r.approver_consolidation.digests)}`, sub: 'notes become digests', icon: 'review' }),
        statTile({ label: 'Per month (estimate)', value: `${fmtInt(lo)}–${fmtInt(hi)}`, sub: 'payment-status tickets avoided', icon: 'clock' })),
      panel({
        title: 'Vendor notices', icon: 'send', count: countText('notice', data.notices), flush: true,
        body: data.notices.length
          ? h('div', { class: 'prevent-list' }, data.notices.map((n) => itemCard('notice', n, n.vendor, n.to, true)))
          : emptyState({ title: 'No notices', text: 'No vendor has a scheduled, released or just-paid invoice.' }),
      }),
      panel({
        title: 'Approver digests', icon: 'review', count: countText('digest', data.digests), flush: true,
        body: data.digests.length
          ? h('div', { class: 'prevent-list' }, data.digests.map((d) =>
            itemCard('digest', d, d.approver_name || d.act_by || 'No approver on record', d.act_by, d.sendable)))
          : emptyState({ title: 'No digests', text: 'No ticket in this run waits on an approver.' }),
      }));
  }

  (async () => {
    try {
      const first = await api.prevention(runId);
      if (!alive) return;
      data = first;
      render();
    } catch (e) {
      if (alive) fill(body, emptyState({ iconName: 'circle-alert', title: 'Could not load', text: e.message }));
    }
  })();

  return { destroy() { alive = false; } };
}
