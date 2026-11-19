// Waiting on you (#/approver): the budget approver's only page. Bills pending their approval and the vendor tickets
// each one is holding up. The approver can acknowledge a bill or commit to an approval date. Both are internal: the
// AP team sees them, a vendor never does. Approving a bill happens in NetSuite, never here (the case forbids
// changing financial records), so there is no approve button. The CFO can open this page read-only.
import { h, icon, mount as fill } from '../lib.js';
import {
  button, setBusy, field, setFieldError, badge, fmtMoney, stat, skeletonRows, empty, notice, tabs, modal, toast,
} from '../components/index.js';
import {
  pageHead, fmtDay, daysSince, nameOf, plural, errText, liveRegion, say, APP_TODAY, sourceLine, dataAsOf,
} from '../components/leadership/util.js';
import * as wf from '../api-workflow.js';
import { subscribe } from '../api-live.js';

const INTERNAL = 'Internal only. A date you commit to is never shown to a vendor as a payment date.';

export function mount(root, { session }) {
  let alive = true;
  let data = null;
  let loadError = null;
  let view = null; // 'blocking' | 'all'
  const readOnly = session?.role !== 'approver';
  const live = liveRegion();

  const top = h('div', { class: 'ap-top' });
  const listSlot = h('div', { class: 'ap-list-slot' });
  const asOf = h('p', { class: 'lv-meta' }, dataAsOf());
  fill(root, h('div', { class: 'page lv-page ap-page' },
    pageHead({
      title: 'Waiting on you',
      lede: readOnly
        ? 'Bills waiting on an approver, and the vendor questions each one is holding up. Read-only here; approvers answer from their own page.'
        : 'Bills that need your approval, and the vendor questions each one is holding up. Approve them in NetSuite as usual. Here you can tell the AP team where things stand.',
      meta: asOf,
    }),
    top, listSlot, live));

  async function load() {
    loadError = null;
    try {
      const d = await wf.approverQueue();
      if (!alive) return;
      data = d;
      asOf.textContent = dataAsOf();
      if (!view) view = d.bills.some((b) => b.blocked_tickets.length) ? 'blocking' : 'all';
    } catch (e) {
      if (!alive) return;
      loadError = errText(e);
    }
    render();
  }

  function delegateNote() {
    const m = /next approver (\S+@\S+) is inactive; delegate/.exec(data?.digest || '');
    if (!m) return null;
    return notice({ tone: 'info', title: `You approve for ${nameOf(m[1])}`, text: `${nameOf(m[1])} is inactive, so their pending bills come to you as delegate.` });
  }

  function render() {
    if (loadError) {
      fill(top);
      fill(listSlot, empty({ icon: 'circle-alert', title: 'Your bills could not be loaded', text: loadError, actions: button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: load }) }));
      return;
    }
    if (!data) { fill(top); fill(listSlot, skeletonRows({ rows: 6, avatar: false, label: 'Loading your bills' })); return; }
    const bills = data.bills || [];
    const blocking = bills.filter((b) => b.blocked_tickets.length);
    const tickets = new Set(blocking.flatMap((b) => b.blocked_tickets.map((t) => t.ticket_id)));
    const oldest = bills.reduce((a, b) => (!a || (b.since && b.since < a) ? b.since : a), null);
    fill(top,
      readOnly ? null : delegateNote(),
      h('div', { class: 'c-stat-grid ap-stats', role: 'group', 'aria-label': 'Summary' },
        stat({ label: 'Bills waiting on you', value: String(bills.length), icon: 'file', context: readOnly ? 'Across every approver' : 'Pending approval in NetSuite', source: 'NetSuite, read-only' }),
        stat({ label: 'Holding up vendor questions', value: String(blocking.length), icon: 'mail', tone: blocking.length ? 'waiting' : undefined,
          context: tickets.size ? `${plural(tickets.size, 'vendor ticket')} ${tickets.size === 1 ? 'waits' : 'wait'} on these bills` : 'No vendor is asking about these bills', source: 'Zendesk and NetSuite' }),
        stat({ label: 'Waiting longest', value: oldest ? String(daysSince(oldest)) : '0', unit: 'days', icon: 'clock',
          context: oldest ? `Entered ${fmtDay(oldest)}` : 'Nothing waiting', source: 'NetSuite, read-only' })),
      notice({ tone: 'info', title: 'For the AP team only', text: `${INTERNAL} Approving a bill still happens in NetSuite.` }));

    const shown = view === 'blocking' ? blocking : bills;
    const switcher = tabs({
      label: 'Show', variant: 'segmented', size: 'sm', selected: view,
      items: [{ id: 'blocking', label: 'Holding up questions', count: blocking.length }, { id: 'all', label: 'All bills', count: bills.length }],
      onSelect: (id) => { view = id; render(); },
    });
    fill(listSlot,
      h('div', { class: 'ap-listhead' }, h('h2', { class: 'lv-section-title' }, view === 'blocking' ? 'Holding up vendor questions' : 'All bills waiting on you'), switcher),
      shown.length ? h('ul', { class: 'ap-list', 'aria-label': 'Bills' }, shown.map(billRow)) : empty({
        icon: 'approver', compact: true,
        title: bills.length ? 'No vendor is waiting on these bills' : 'Nothing is waiting on you',
        text: bills.length ? 'Every bill here is pending, but no vendor has asked about one yet.' : 'When a bill needs your approval, it appears here.',
      }),
      sourceLine('NetSuite bills (read-only) and Zendesk tickets'));
  }

  function billRow(b) {
    const days = daysSince(b.since);
    const respond = [];
    if (b.commitment) respond.push(badge({ label: `Committed to ${fmtDay(b.commitment.date)}`, tone: 'scheduled', icon: 'calendar' }));
    if (b.acknowledged) respond.push(badge({ label: `Acknowledged ${fmtDay(b.acknowledged.at)}`, tone: 'neutral', icon: 'check' }));
    const actions = [];
    if (!readOnly) {
      const ack = button({ label: b.acknowledged ? 'Acknowledged' : 'Acknowledge', size: 'sm', icon: 'check', disabled: !!b.acknowledged,
        attrs: { 'aria-label': `Acknowledge ${b.tranId}` } });
      ack.addEventListener('click', async () => {
        setBusy(ack, true);
        try {
          await wf.acknowledgeBill(b.bill_id);
          toast({ message: `Acknowledged ${b.tranId}. The AP team can see it.`, tone: 'settled' });
          say(live, `Acknowledged ${b.tranId}.`);
          await load();
        } catch (e) { setBusy(ack, false); toast({ message: errText(e), tone: 'risk' }); }
      });
      actions.push(ack, button({ label: b.commitment ? 'Change date' : 'Commit to a date', size: 'sm', icon: 'calendar', onClick: () => commit(b),
        attrs: { 'aria-label': `${b.commitment ? 'Change the approval date for' : 'Commit to an approval date for'} ${b.tranId}` } }));
    }
    actions.push(h('a', { class: 'c-btn c-btn-quiet c-btn-sm ap-ns', role: 'link', 'aria-disabled': 'true', tabindex: '0', title: 'Opens in NetSuite',
      'aria-label': `Open ${b.tranId} in NetSuite (opens in NetSuite)` }, icon('external'), h('span', { class: 'c-btn-label' }, 'Open in NetSuite')));
    return h('li', { class: 'ap-bill' },
      h('div', { class: 'ap-bill-main' },
        h('div', { class: 'ap-bill-id' }, h('strong', { class: 'mono' }, b.tranId), h('span', { class: 'ap-vendor' }, b.vendor)),
        h('span', { class: 'money ap-amount' }, fmtMoney(b.amount)),
        h('div', { class: 'ap-status' },
          badge({ label: b.status === 'Pending PO' ? 'Pending PO' : 'Pending approval', tone: 'waiting', icon: 'clock' }),
          h('span', { class: 'ap-since' }, `Since ${fmtDay(b.since)}`, days != null ? h('span', { class: days > 14 ? 'ap-old' : 'lv-muted' }, ` · ${days} days`) : null)),
        readOnly ? h('span', { class: 'ap-approver lv-muted' }, nameOf(b.approver)) : null),
      b.blocked_tickets.length ? h('div', { class: 'ap-blocking' },
        h('span', { class: 'ap-blocking-label' }, icon('mail', 'icon-sm'), `Holding up ${plural(b.blocked_tickets.length, 'vendor question')}`),
        h('ul', null, b.blocked_tickets.map((t) => h('li', null,
          h('span', { class: 'mono' }, `#${t.ticket_id}`), ' ', h('span', null, t.subject || ''), t.from_name ? h('span', { class: 'lv-muted' }, ` · ${t.from_name}`) : null)))) : null,
      h('div', { class: 'ap-bill-foot' },
        h('div', { class: 'ap-response' }, respond.length ? respond : h('span', { class: 'lv-muted' }, readOnly ? 'No response yet' : 'You have not responded yet')),
        h('div', { class: 'ap-actions' }, actions)));
  }

  function commit(b) {
    const max = '2027-11-13';
    const f = field({ label: 'Approval date', type: 'date', required: true, value: b.commitment?.date || '', attrs: { min: APP_TODAY, max },
      help: 'The day you expect to approve it in NetSuite.' });
    modal({
      title: `Commit to an approval date for ${b.tranId}`,
      description: `${b.vendor} · ${fmtMoney(b.amount)}`,
      size: 'sm',
      body: () => h('div', { class: 'ap-commit' }, f, notice({ tone: 'info', text: INTERNAL })),
      actions: (dlg) => {
        const save = button({ label: 'Save date', variant: 'primary', icon: 'calendar' });
        save.addEventListener('click', async () => {
          const v = f.control.value;
          if (!v) { setFieldError(f, 'Pick a date.'); f.control.focus(); return; }
          if (v < APP_TODAY || v > max) { setFieldError(f, 'Pick a date from today to one year ahead.'); f.control.focus(); return; }
          setBusy(save, true);
          try {
            await wf.commitBill(b.bill_id, v);
            dlg.close();
            toast({ message: `Committed to ${fmtDay(v)}. The AP team sees it; vendors never do.`, tone: 'settled' });
            say(live, `Committed to ${fmtDay(v)} for ${b.tranId}.`);
            load();
          } catch (e) { setBusy(save, false); setFieldError(f, errText(e)); }
        });
        return [button({ label: 'Cancel', variant: 'quiet', onClick: () => dlg.close() }), save];
      },
    });
    setTimeout(() => f.control.focus(), 30);
  }

  const off = subscribe((ev) => { if (alive && (ev.type === 'approver.committed' || ev.type === 'ticket.arrived')) load(); });
  render();
  load();
  return { destroy() { alive = false; off?.(); } };
}
