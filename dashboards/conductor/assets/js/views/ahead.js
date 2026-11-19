// Conductor: Ahead (#/ahead). Tell vendors before they ask: status notices and approver digests drafted from the
// records, each approved and then sent by a person, plus the impact (tickets prevented, an hours estimate, and
// self-serve lookups on their own line). "See it on one invoice" walks one notice from draft to the ticket it prevents.
// Every send goes through the existing prevention routes on the inbox run, so the outbound check and the
// stale-record refusal (409) still apply. Recipients and text come from the server's records only.
import { h, icon, mount as fill } from '../lib.js';
import { api } from '../api.js';
import * as inbox from '../api-inbox.js';
import * as wf from '../api-workflow.js';
import { subscribe } from '../api-live.js';
import {
  button, setBusy, badge, chip, statusBadge, fmtMoney, stat, skeletonText, skeletonRows, reading, empty, notice, tabs, toast, mark,
} from '../components/index.js';
import {
  pageHead, sectionHead, reviewBadge, nameOf, fmtDay, fmtTime, plural, errText, liveRegion, say, dataAsOf,
} from '../components/leadership/util.js';

const MINUTES_PER_TICKET = 15; // the client's figure for an average ticket
const NOTICE_FILTERS = [
  { id: 'pending', label: 'To review' }, { id: 'approved', label: 'Approved' }, { id: 'sent', label: 'Sent' },
  { id: 'skipped', label: 'Skipped' }, { id: 'all', label: 'All' },
];
const TABS = [{ id: 'updates', label: 'Vendor updates' }, { id: 'digests', label: 'Approver digests' }, { id: 'invoice', label: 'See it on one invoice' }];

export function mount(root, { route }) {
  let alive = true;
  let runId = null;
  let data = null;           // prevention payload
  let threads = [];          // inbox rows, to name the tickets a notice covers
  let summary = null;        // inbox summary (prevented_this_week)
  let nudges = [];           // approver chases (outbound approver_nudge)
  let demo = null;
  let busy = false;
  let loadError = null;
  let tab = TABS.some((t) => t.id === route.query?.tab) ? route.query.tab : 'updates';
  let noticeFilter = 'pending';
  const acted = new Set(); // notices acted on under the current filter stay in view until the filter changes
  const live = liveRegion();

  const figureSlot = h('div', { class: 'ah-figure-slot' });
  const statsSlot = h('div', { class: 'ah-stats-slot' });
  const tabSlot = h('div', { class: 'ah-tabs' });
  const tabSelect = h('select', { class: 'c-input c-select ah-tabselect', id: 'ah-tabselect', 'aria-label': 'Ahead section' },
    TABS.map((t) => h('option', { value: t.id }, t.label)));
  tabSelect.addEventListener('change', () => chooseTab(tabSelect.value));
  const panel = h('div', { class: 'ah-panel', role: 'tabpanel', id: 'ah-panel', tabindex: '-1' });
  const builtLine = h('p', { class: 'lv-meta' });
  const rebuildBtn = button({ label: 'Rebuild from records', icon: 'refresh', size: 'sm', variant: 'quiet', onClick: () => build(true) });

  const asOf = h('p', { class: 'lv-meta' }, dataAsOf());
  fill(root, h('div', { class: 'page lv-page ah-page' },
    pageHead({
      product: 'ahead', id: 'ah-title', title: 'Tell vendors before they ask.', meta: asOf,
      lede: 'Ahead drafts status notices for vendors and reminders for approvers from our records. A person approves each one, then sends it. Every notice answers a question before it becomes a ticket.',
    }),
    h('section', { class: 'ah-hero', 'aria-label': 'Impact' }, figureSlot, statsSlot),
    h('div', { class: 'ah-bar' }, tabSlot, tabSelect, h('div', { class: 'ah-bar-tools' }, builtLine, rebuildBtn)),
    panel, live));

  // ------------------------------------------------------------------ data
  const stateOf = (kind, key) => (data?.states?.[`${kind}:${key}`] || {}).state || 'pending';
  const sentAt = (kind, key) => (data?.states?.[`${kind}:${key}`] || {}).sent_at;

  // The tickets a notice would have prevented: the server's covered list (notices.coverage), attributed to the notice
  // whose vendor and invoices match the ticket, the same test notices.coverage applies.
  function coverageFor(n) {
    const covered = new Set(data?.report?.preventable_by_notice?.ticket_ids || []);
    const bills = new Set(n.bills || []);
    return threads.filter((t) => covered.has(t.ticket_id) && t.company === n.vendor && (t.invoice_refs || []).length
      && t.invoice_refs.every((r) => bills.has(r)));
  }

  async function load() {
    loadError = null;
    try {
      const s = await inbox.summary();
      if (!alive) return;
      summary = s;
      runId = s.run_id;
      const [p, th, ob] = await Promise.all([
        api.prevention(runId),
        inbox.threads({}).catch(() => ({ rows: [] })),
        wf.outbound('approver_nudge').catch(() => ({ rows: [] })),
      ]);
      if (!alive) return;
      data = p;
      threads = th.rows || [];
      nudges = ob.rows || [];
      api.get(`/api/runs/${runId}/prevention/demo`).then((d) => { if (alive) { demo = d; if (tab === 'invoice') renderPanel(); } }).catch((e) => { demo = { available: false, message: errText(e) }; });
      if (!data.built) await build(false);
    } catch (e) {
      if (!alive) return;
      loadError = errText(e);
    }
    render();
  }

  async function build(manual) {
    if (busy) return;
    busy = true;
    setBusy(rebuildBtn, true);
    if (!manual) fill(panel, reading({ text: 'Conductor is reading the records…' }));
    try {
      const next = await api.buildPrevention(runId);
      if (!alive) return;
      data = next;
      if (manual) toast({ message: 'Rebuilt from the current records.', tone: 'settled' });
    } catch (e) {
      if (alive) { if (manual) toast({ message: errText(e), tone: 'risk' }); else loadError = errText(e); }
    } finally {
      busy = false;
      setBusy(rebuildBtn, false);
      if (manual && alive) render();
    }
  }

  async function act(fn, okText, key) {
    if (busy) return false;
    if (key) acted.add(key);
    busy = true;
    try {
      const next = await fn();
      if (!alive) return false;
      data = next;
      if (okText) { toast({ message: okText, tone: 'settled' }); say(live, okText); }
      inbox.summary().then((s) => { if (alive) { summary = s; renderImpact(); } }).catch(() => {});
      return true;
    } catch (e) {
      if (alive) toast({ message: errText(e), tone: 'risk' });
      return false;
    } finally {
      busy = false;
      if (alive) render();
    }
  }

  // ------------------------------------------------------------------ impact
  function renderImpact() {
    if (!data?.built) {
      fill(figureSlot, loadError ? null : h('div', { class: 'ah-impact-loading' }, skeletonText({ lines: 3, label: 'Loading impact' })));
      fill(statsSlot);
      return;
    }
    const r = data.report || {};
    const prevented = r.preventable_by_notice || { count: 0, ticket_ids: [] };
    const hours = (prevented.count * MINUTES_PER_TICKET) / 60;
    const sentCovered = summary?.prevented_this_week ?? 0;
    const lookups = summary?.self_serve_lookups;
    const named = prevented.ticket_ids || [];
    // The same denominator as Team: every ticket in the inbox.
    const total = threads.length || r.tickets || 0;
    const pct = total ? Math.round((1000 * prevented.count) / total) / 10 : 0;
    const top = (data.notices || []).map((n) => ({ vendor: n.vendor, n: coverageFor(n).length })).sort((a, b) => b.n - a.n)[0];
    fill(figureSlot,
      h('div', { class: 'ah-hero-figure' },
        h('div', { class: 'ah-figure' }, h('span', { class: 'ah-figure-value' }, String(prevented.count)),
          h('span', { class: 'ah-figure-label' }, 'tickets prevented', h('span', { class: 'ah-figure-sub' }, `${pct}% of the ${total} tickets in the inbox. Each one asked about an invoice a drafted notice already covers. An estimate.`))),
        named.length ? h('p', { class: 'ah-named-line' },
          `Would have answered ${plural(named.length, 'vendor email')}${top?.n ? `, e.g. ${top.vendor} (${top.n})` : ''}.`) : null,
        named.length ? h('details', { class: 'lv-review-more ah-named-more' },
          h('summary', null, `Show the ${plural(named.length, 'email')}`, icon('chev-down', 'icon-sm')),
          h('div', { class: 'ah-named' }, named.map((id) => chip({ label: `#${id}`, title: ticketTitle(id), onClick: () => { location.hash = `#/inbox/${id}`; } })))) : null));
    fill(statsSlot,
      h('div', { class: 'c-stat-grid ah-stats', role: 'group', 'aria-label': 'Impact' },
        stat({ label: 'Estimated hours saved', value: hours.toFixed(1), unit: 'h', icon: 'clock',
          context: `${prevented.count} tickets at ${MINUTES_PER_TICKET} minutes each, Orchestra's average. An estimate.` }),
        stat({ label: 'Prevented by sent notices', value: String(sentCovered), icon: 'send',
          context: sentCovered ? 'Tickets whose invoices a sent notice answered.' : 'Send a notice to start this count.', source: 'Notices sent from Conductor' }),
        stat({ label: 'Self-serve lookups', value: lookups == null ? '—' : String(lookups), icon: 'search',
          context: 'Vendors who checked an invoice in Conductor: Direct. Not counted as tickets prevented.' }),
        stat({ label: 'Approver reminders', value: String(r.approver_consolidation?.digests ?? 0), icon: 'approver',
          context: `${plural(r.approver_consolidation?.notes ?? 0, 'reminder')} become ${r.approver_consolidation?.digests ?? 0}: one digest per approver.` })));
  }
  const ticketTitle = (id) => { const t = threads.find((x) => x.ticket_id === id); return t ? `${t.subject} · ${t.from_name}` : `Ticket ${id}`; };

  // ------------------------------------------------------------------ tabs
  function renderTabs() {
    const pendingN = (data?.notices || []).filter((n) => stateOf('notice', n.key) === 'pending').length;
    const digestN = (data?.digests || []).filter((d) => stateOf('digest', d.key) === 'pending').length;
    fill(tabSlot, tabs({
      label: 'Ahead sections', selected: tab,
      items: TABS.map((t) => ({ ...t, panelId: 'ah-panel', count: t.id === 'updates' && data?.built ? pendingN : t.id === 'digests' && data?.built ? digestN : null })),
      onSelect: chooseTab,
    }));
    tabSelect.value = tab;
    builtLine.textContent = data?.built_at ? `Built from records at ${fmtTime(data.built_at)}` : '';
    rebuildBtn.hidden = !data?.built;
  }

  function chooseTab(id) {
    tab = id;
    history.replaceState(null, '', `#/ahead${id === 'updates' ? '' : `?tab=${id}`}`);
    renderTabs();
    renderPanel();
  }

  function render() {
    renderImpact();
    renderTabs();
    renderPanel();
  }

  function renderPanel() {
    if (loadError) {
      fill(panel, empty({ icon: 'circle-alert', title: 'Ahead could not be loaded', text: loadError, actions: button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: load }) }));
      return;
    }
    if (!data) { fill(panel, skeletonRows({ rows: 5, avatar: false, label: 'Loading Ahead' })); return; }
    if (!data.built) { fill(panel, reading({ text: 'Conductor is reading the records…' })); return; }
    if (tab === 'digests') fill(panel, digestsView());
    else if (tab === 'invoice') fill(panel, invoiceView());
    else fill(panel, noticesView());
  }

  // ------------------------------------------------------------------ review actions (shared by notices and digests)
  function actions(kind, item, to, canSend) {
    const st = stateOf(kind, item.key);
    const out = [reviewBadge(st)];
    if (st === 'sent') {
      const at = sentAt(kind, item.key);
      out.push(h('span', { class: 'lv-muted ah-sent' }, at ? `Sent ${fmtTime(at)}` : 'Sent'));
      return out;
    }
    if (st === 'approved') {
      out.push(button({ label: 'Undo', variant: 'quiet', size: 'sm', onClick: () => act(() => api.preventionState(runId, kind, item.key, 'pending'), null, item.key) }));
      const send = button({ label: 'Send', variant: 'primary', size: 'sm', icon: 'send', disabled: !canSend,
        title: canSend ? `Send to ${to}` : 'There is no approver on record to send this to' });
      send.addEventListener('click', () => { setBusy(send, true); act(() => api.preventionSend(runId, kind, item.key), `Sent to ${to}.`, item.key); });
      out.push(send);
    } else if (st === 'skipped') {
      out.push(button({ label: 'Undo skip', variant: 'quiet', size: 'sm', onClick: () => act(() => api.preventionState(runId, kind, item.key, 'pending'), null, item.key) }));
    } else {
      out.push(button({ label: 'Skip', variant: 'quiet', size: 'sm', onClick: () => act(() => api.preventionState(runId, kind, item.key, 'skipped'), null, item.key) }));
      out.push(button({ label: 'Approve', size: 'sm', icon: 'check', disabled: !canSend, onClick: () => act(() => api.preventionState(runId, kind, item.key, 'approved'), 'Approved. Send it when you are ready.', item.key) }));
    }
    return out;
  }

  // ------------------------------------------------------------------ vendor updates
  function noticesView() {
    const all = data.notices || [];
    const keep = new Set(acted);
    const counts = Object.fromEntries(NOTICE_FILTERS.map((f) => [f.id, f.id === 'all' ? all.length : all.filter((n) => stateOf('notice', n.key) === f.id).length]));
    const list = all.filter((n) => noticeFilter === 'all' || stateOf('notice', n.key) === noticeFilter || keep.has(n.key))
      .map((n) => ({ n, cov: coverageFor(n) }))
      .sort((a, b) => b.cov.length - a.cov.length || a.n.vendor.localeCompare(b.n.vendor));
    const skipped = data.report?.preventable_by_notice?.vendors_skipped?.returned_or_conflict;
    return h('section', { class: 'ah-section', 'aria-labelledby': 'ah-updates-h' },
      sectionHead({ id: 'ah-updates-h', title: 'Vendor updates', sub: 'One notice per vendor, listing where each open invoice stands. Written from NetSuite and the payment runs, never from what a vendor wrote.',
        actions: tabs({ label: 'Filter notices', variant: 'segmented', size: 'sm', selected: noticeFilter,
          items: NOTICE_FILTERS.map((f) => ({ ...f, count: counts[f.id] })), onSelect: (id) => { noticeFilter = id; acted.clear(); renderPanel(); } }) }),
      skipped ? notice({ tone: 'info', text: `${plural(skipped, 'vendor')} with a returned payment or a record conflict ${skipped === 1 ? 'gets' : 'get'} no notice. Those stay with a person.` }) : null,
      list.length ? h('ul', { class: 'lv-reviews' }, list.map(({ n, cov }) => h('li', { class: 'lv-review', 'data-state': stateOf('notice', n.key) },
        h('div', { class: 'lv-review-head' },
          h('div', { class: 'lv-review-main' },
            h('h3', { class: 'lv-review-title' }, n.vendor),
            h('p', { class: 'lv-review-sub' }, h('span', { class: 'mono' }, n.to), ` · ${plural((n.bills || []).length, 'invoice')}`),
            cov.length ? h('div', { class: 'lv-refs' }, h('span', { class: 'lv-muted' }, `Would have answered ${plural(cov.length, 'email')}:`),
              cov.map((t) => chip({ label: `#${t.ticket_id}`, title: `${t.subject} · ${t.from_name}`, onClick: () => { location.hash = `#/inbox/${t.ticket_id}`; } }))) : null),
          h('div', { class: 'lv-review-actions' }, actions('notice', n, n.to, true))),
        h('details', { class: 'lv-review-more' }, h('summary', null, 'Preview', icon('chev-down', 'icon-sm')),
          h('div', { class: 'lv-letter' }, n.text))))) : empty({ icon: 'send', compact: true, title: noticeFilter === 'pending' ? 'Every notice is reviewed' : 'Nothing here', text: noticeFilter === 'pending' ? 'Approved notices wait under Approved until you send them.' : 'Try another filter.' }),
    );
  }

  // ------------------------------------------------------------------ approver digests
  function chaseLine(email) {
    const mine = nudges.filter((x) => (x.to || '').toLowerCase() === String(email || '').toLowerCase());
    const sent = mine.filter((x) => x.state === 'sent');
    if (!mine.length) return 'No reminder sent yet';
    if (!sent.length) return `${plural(mine.length, 'reminder')} drafted, not sent yet`;
    const last = sent.map((x) => x.sent_at).sort().pop();
    return `Reminder sent ${plural(sent.length, 'time')}, last ${fmtDay(last)}`;
  }

  function digestsView() {
    // Oldest wait first: the approver whose longest-pending bill has waited most.
    const list = (data.digests || []).slice().sort((a, b) => oldestOf(b) - oldestOf(a) || ticketsOf(b).length - ticketsOf(a).length);
    return h('section', { class: 'ah-section', 'aria-labelledby': 'ah-digests-h' },
      sectionHead({ id: 'ah-digests-h', title: 'Approver digests', sub: 'Approvers whose pending approvals hold up vendor payments, with the tickets each one blocks. One reminder per approver replaces separate chases. Internal only.' }),
      list.length ? h('ul', { class: 'lv-reviews' }, list.map((d) => {
        const tickets = ticketsOf(d);
        const oldest = oldestOf(d);
        const name = d.approver_name || nameOf(d.act_by) || 'No approver on record';
        const delegate = d.delegate_note && /inactive/.test(d.delegate_note)
          ? `Delegate for ${nameOf((d.delegate_note.match(/next approver (\S+)/) || [])[1])}, who is inactive` : null;
        return h('li', { class: 'lv-review', 'data-state': stateOf('digest', d.key) },
          h('div', { class: 'lv-review-head' },
            h('div', { class: 'lv-review-main' },
              h('h3', { class: 'lv-review-title' }, name),
              h('p', { class: 'lv-review-sub' },
                d.act_by ? h('span', { class: 'mono' }, d.act_by) : 'No approver on record, so this can’t be sent',
                ` · ${plural((d.bills || []).length, 'bill')} · ${plural(tickets.length, 'ticket')} blocked · oldest ${oldest} days`),
              delegate ? h('p', { class: 'lv-review-sub' }, delegate) : null,
              h('p', { class: 'ah-chase' }, icon('clock', 'icon-sm'), chaseLine(d.act_by))),
            h('div', { class: 'lv-review-actions' }, actions('digest', d, d.act_by, d.sendable))),
          h('details', { class: 'lv-review-more' }, h('summary', null, 'Preview', icon('chev-down', 'icon-sm')),
            h('ul', { class: 'ah-bills' }, (d.bills || []).map((b) => h('li', { class: 'ah-bill' },
              h('span', { class: 'mono' }, b.tranId), h('span', { class: 'ah-bill-vendor' }, b.vendor),
              h('span', { class: 'money' }, fmtMoney(b.amount)),
              b.stuck_over_14_days ? badge({ label: `${b.days_pending} days`, tone: 'waiting', icon: 'clock' }) : h('span', { class: 'lv-muted' }, `${b.days_pending} days`),
              h('span', { class: 'ah-bill-tickets' }, (b.ticket_ids || []).map((t) => chip({ label: `#${t}`, title: ticketTitle(t), onClick: () => { location.hash = `#/inbox/${t}`; } })))))),
            h('div', { class: 'lv-letter' }, d.text)));
      })) : empty({ icon: 'approver', compact: true, title: 'No approver is holding up a payment', text: 'When a ticket waits on an approval, its approver appears here.' }));
  }
  const ticketsOf = (d) => [...new Set((d.bills || []).flatMap((b) => b.ticket_ids || []))];
  const oldestOf = (d) => Math.max(0, ...(d.bills || []).map((b) => b.days_pending || 0));

  // ------------------------------------------------------------------ see it on one invoice
  function invoiceView() {
    if (!demo) return skeletonText({ lines: 4, label: 'Loading' });
    if (!demo.available) return empty({ icon: 'file', title: 'No invoice qualifies right now', text: 'No pending invoice with a vendor question qualifies. Every candidate is already answered or under review.' });
    const inv = demo.invoice;
    const drafted = !!demo.drafted;
    const st = drafted ? demo.state : null;
    const sent = st === 'sent';
    const step = (n, title, done, current, ...kids) => h('li', { class: `ah-step${done ? ' is-done' : ''}${current ? ' is-current' : ''}`, 'aria-current': current ? 'step' : null },
      h('span', { class: 'ah-step-n', 'aria-hidden': 'true' }, done ? icon('check') : String(n)),
      h('div', { class: 'ah-step-body' }, h('h3', { class: 'ah-step-title' }, title, done ? h('span', { class: 'sr-only' }, ' (done)') : null), ...kids));
    const demoBtn = (label, path, opts = {}) => {
      const b = button({ label, size: 'sm', ...opts });
      b.addEventListener('click', async () => {
        setBusy(b, true);
        try {
          demo = await api.post(`/api/runs/${runId}/prevention/demo/${path}`);
          if (path === 'send') { toast({ message: `Sent to ${demo.notice?.to}.`, tone: 'settled' }); inbox.summary().then((s) => { summary = s; renderImpact(); }).catch(() => {}); }
        } catch (e) { toast({ message: errText(e), tone: 'risk' }); }
        if (alive) renderPanel();
      });
      return b;
    };
    const lookup = demo.lookup;
    const covered = demo.covered_tickets || [];
    return h('section', { class: 'ah-section', 'aria-labelledby': 'ah-one-h' },
      sectionHead({ id: 'ah-one-h', title: 'See it on one invoice', sub: 'One real invoice, from the records to the vendor’s screen to the ticket nobody has to write.' }),
      h('div', { class: 'ah-one' },
        h('div', { class: 'ah-one-invoice' },
          h('span', { class: 'lv-muted' }, 'Invoice'), h('strong', { class: 'mono' }, inv.ref),
          h('span', null, inv.vendor), h('span', { class: 'money' }, fmtMoney(inv.amount, inv.currency || 'USD')),
          h('span', { class: 'lv-muted' }, `Entered ${fmtDay(inv.tran_date)}`),
          statusBadge({ code: inv.status === 'pending' ? 'pending_approval' : inv.status, label: inv.status === 'pending' ? 'Awaiting internal approval' : inv.status })),
        h('p', { class: 'ah-rule' }, h('span', { class: 'lv-muted' }, 'Chosen by rule: '), demo.rule),
        h('ol', { class: 'ah-steps' },
          step(1, 'Draft from the records', drafted, !drafted,
            drafted ? h('div', { class: 'lv-letter' }, demo.notice?.text) : h('p', { class: 'lv-muted' }, 'Conductor writes the notice from NetSuite only.'),
            drafted ? h('p', { class: 'lv-muted' }, 'To ', h('span', { class: 'mono' }, demo.notice?.to), '. The outbound check passed.') : demoBtn('Draft the notice', 'draft', { variant: 'primary', icon: 'file' })),
          step(2, 'Approve', st === 'approved' || sent, drafted && st === 'pending',
            drafted && st === 'pending' ? demoBtn('Approve', 'approve', { variant: 'primary', icon: 'check' }) : h('p', { class: 'lv-muted' }, st === 'approved' || sent ? 'Approved by a person.' : 'A person approves it before anything is sent.')),
          step(3, 'Send', sent, st === 'approved',
            st === 'approved' ? demoBtn('Send', 'send', { variant: 'primary', icon: 'send' }) : h('p', { class: 'lv-muted' }, sent ? `Sent${demo.sent_at ? ` at ${fmtTime(demo.sent_at)}` : ''} from the AP mailbox. It also appears under Updates in the vendor’s Conductor: Direct.` : 'The records are checked again at the moment of sending.')),
          step(4, 'What the vendor sees in Conductor: Direct', sent && !!lookup, false,
            sent && lookup ? directCard(inv, lookup) : h('p', { class: 'lv-muted' }, 'After sending, the vendor’s own lookup for this invoice gives the same answer.')),
          step(5, 'The ticket it prevents', sent, false,
            sent ? (covered.length
              ? h('div', { class: 'lv-refs' }, h('span', { class: 'lv-muted' }, 'Would have answered'), covered.map((t) => chip({ label: `#${t}`, title: ticketTitle(Number(t)), onClick: () => { location.hash = `#/inbox/${t}`; } })))
              : h('p', { class: 'lv-muted' }, 'No ticket in the inbox asked about this invoice.'))
              : h('p', { class: 'lv-muted' }, 'The inbox ticket that asked about this invoice is the one nobody has to answer next time.')))));
  }

  function directCard(inv, lookup) {
    return h('div', { class: 'ah-direct' },
      h('div', { class: 'ah-direct-bar' }, mark({ product: 'direct', size: 18 }), h('span', null, 'Conductor: Direct'), h('span', { class: 'ah-direct-co' }, inv.vendor)),
      h('div', { class: 'ah-direct-body' },
        h('div', { class: 'ah-direct-row' }, h('strong', { class: 'mono' }, inv.ref), statusBadge({ code: inv.status === 'pending' ? 'pending_approval' : inv.status, label: inv.status === 'pending' ? 'Awaiting internal approval' : inv.status })),
        h('p', null, lookup.message),
        h('p', { class: 'ah-direct-src' }, 'Source: Orchestra accounts payable records, updated Nov 13, 2026')),
      h('div', { class: 'ah-direct-check' }, lookup.same_answer
        ? badge({ label: 'Same status and balance as the notice', tone: 'settled', icon: 'circle-check' })
        : badge({ label: 'Differs from the notice', tone: 'risk', icon: 'alert' })));
  }

  // ------------------------------------------------------------------ live
  const off = subscribe((ev) => {
    if (!alive) return;
    if (ev.type === 'ahead.sent' || ev.type === 'outbound.sent') {
      inbox.summary().then((s) => { if (alive) { summary = s; renderImpact(); } }).catch(() => {});
      if (ev.type === 'outbound.sent') wf.outbound('approver_nudge').then((o) => { if (alive) { nudges = o.rows || []; if (tab === 'digests') renderPanel(); } }).catch(() => {});
    }
  });

  render();
  load();

  return {
    update({ route: next }) {
      const t = TABS.some((x) => x.id === next.query?.tab) ? next.query.tab : 'updates';
      if (t !== tab) { tab = t; renderTabs(); renderPanel(); }
    },
    destroy() { alive = false; off?.(); },
  };
}
