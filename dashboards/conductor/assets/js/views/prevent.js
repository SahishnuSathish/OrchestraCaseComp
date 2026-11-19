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
  const demoBox = h('div', { class: 'demo-box' });
  let demo = null;
  const buildBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => build() }, icon('rotate'), 'Build from records');
  fill(root, h('div', { class: 'page' },
    pageHeader({ title: 'Prevent', meta: 'Answers sent before anyone has to ask. Nothing goes out until you approve and send it.', actions: buildBtn }),
    demoBox, body));

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

  // ---- demo on one real invoice: draft -> approve -> send -> vendor lookup -> ticket prevented
  const demoUrl = (tail = '') => `/api/runs/${runId}/prevention/demo${tail}`;

  async function demoAct(fn) {
    if (busy) return;
    busy = true;
    try {
      const next = await fn();
      if (!alive) return;
      demo = next;
      renderDemo();
    } catch (e) {
      if (alive) toast({ message: e.message });
    } finally {
      busy = false;
    }
  }

  function demoStep(n, title, state, children) {
    return h('li', { class: 'demo-step', 'data-step': n, 'data-done': state === 'done' ? 'true' : 'false' },
      h('span', { class: 'demo-step-n num' }, state === 'done' ? icon('check') : String(n)),
      h('div', { class: 'demo-step-body' }, h('h3', null, title), ...children));
  }

  function renderDemo() {
    if (!demo) return;
    if (!demo.available) {
      fill(demoBox, panel({ title: 'Demo on one invoice', icon: 'send', body: emptyState({ title: 'No invoice qualifies', text: demo.message }) }));
      return;
    }
    const inv = demo.invoice;
    const drafted = demo.drafted;
    const st = drafted ? demo.state : null;
    const btn = (label, cls, onclick, ic) => h('button', { class: `btn btn-sm ${cls}`, type: 'button', onclick }, ic ? icon(ic) : null, label);
    const steps = [
      demoStep(1, 'Draft from the records', drafted ? 'done' : 'todo', [
        h('p', { class: 'muted' }, `Invoice ${inv.ref} from ${inv.vendor}: ${inv.currency} ${inv.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}, status ${inv.status}.`),
        drafted ? h('pre', { class: 'prevent-text demo-notice' }, demo.notice.text) : null,
        drafted ? h('p', { class: 'muted' }, `To ${demo.notice.to}. Outbound check passed.`) : null,
        drafted ? null : btn('Draft notice', 'btn-primary', () => demoAct(() => api.post(demoUrl('/draft'))), 'send'),
      ]),
      demoStep(2, 'Approve', st === 'approved' || st === 'sent' ? 'done' : 'todo', [
        drafted && st === 'pending' ? btn('Approve', '', () => demoAct(() => api.post(demoUrl('/approve'))), 'check') : null,
        !drafted ? h('p', { class: 'muted' }, 'A person approves it before anything is sent.') : null,
      ]),
      demoStep(3, 'Send (simulated)', st === 'sent' ? 'done' : 'todo', [
        st === 'approved' ? btn('Send', 'btn-primary', () => demoAct(() => api.post(demoUrl('/send'))), 'send') : null,
        st === 'sent' ? h('p', { class: 'muted' }, 'Saved as an .eml in the outbox. Nothing left this computer.') : null,
      ]),
      demoStep(4, 'Vendor looks it up', st === 'sent' ? 'done' : 'todo', [
        st === 'sent' && demo.lookup ? h('p', null, demo.lookup.message) : h('p', { class: 'muted' }, 'After sending, the vendor’s own status lookup answers for this invoice.'),
        st === 'sent' && demo.lookup ? h('p', null, h('span', { class: `badge ${demo.lookup.same_answer ? 'badge-success' : 'badge-quiet'}` },
          demo.lookup.same_answer ? 'Same status and balance as the notice' : 'Differs from the notice')) : null,
      ]),
    ];
    const prevented = demo.covered_tickets || [];
    fill(demoBox, panel({
      title: 'Demo on one invoice', icon: 'send',
      body: h('div', { class: 'demo' },
        h('p', { class: 'muted' }, `Chosen by rule: ${demo.rule}`),
        h('ol', { class: 'demo-steps' }, ...steps),
        st === 'sent' ? banner({ tone: 'info', text: prevented.length
          ? `This notice would have prevented ticket ${prevented.join(', ')}.` : 'No ticket in this run asked about this invoice.' }) : null),
    }));
  }

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

  api.get(demoUrl()).then((d) => { if (alive) { demo = d; renderDemo(); } }).catch(() => {});

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
