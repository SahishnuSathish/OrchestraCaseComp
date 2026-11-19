// Team overview (#/team, CFO): queue health, aging, first-reply time against before Conductor, follow-ups, the
// approvers holding up payments, Ahead impact, feedback on drafts, a live activity feed, the audit log and who handles
// what (editable expertise). Every figure names its source. Charts follow the dataviz method: ranked bars on one
// baseline in one neutral hue, status color only where a bar means a state, and a table view for each chart.
import { h, icon, mount as fill } from '../lib.js';
import {
  button, setBusy, checkbox, chip, stat, table, skeletonText, empty, notice, toast, avatar,
} from '../components/index.js';
import {
  pageHead, sectionHead, sourceLine, sourceText, nameOf, fmtWhen, fmtTime, ago, appNow, plural, errText, liveRegion, say, dataAsOf,
} from '../components/leadership/util.js';
import { barList, compare } from '../components/leadership/charts.js';
import * as wf from '../api-workflow.js';
import * as inbox from '../api-inbox.js';
import { subscribe } from '../api-live.js';

const STATE_LABEL = {
  open: 'Open', escalated: 'Escalated', signoff_requested: 'Sign-off requested', returned: 'Returned', signed_off: 'Signed off',
  decided: 'Decided', sent: 'Sent', closed: 'Closed',
};
const FEEDBACK_LABEL = { tone: 'Tone', facts: 'Facts', missing_info: 'Missing info', other: 'Other' };
const EXPERTISE = [
  ['status', 'Payment status'], ['documents', 'Documents'], ['fraud', 'Fraud'], ['bank_change', 'Bank changes'],
  ['returns', 'Returned payments'], ['conflicts', 'Record conflicts'], ['priority', 'Priority'],
];
const ACTION_LABEL = {
  escalate: 'Escalated', 'request-signoff': 'Asked for sign-off', return: 'Returned with guidance', signoff: 'Signed off',
  decide: 'Decided', assign: 'Assigned', sent: 'Sent', approver_nudge: 'Drafted an approver chase', 'outbound-sent': 'Sent an approver chase',
  forward: 'Forwarded', 'no-reply': 'Marked no reply needed', expertise: 'Changed expertise', w9_request: 'Drafted a W-9 request',
};
const QUIET_EVENTS = new Set(['queue.counts', 'sync.status']);

export function mount(root) {
  let alive = true;
  let data = null;
  let audit = null;
  let people = null;
  let threads = null;
  let pendingBy = null; // approver email -> every bill pending their approval, not only those tied to tickets
  let loadError = null;
  let activity = [];
  let expNode = null; // kept across live refreshes so unsaved expertise edits survive
  const live = liveRegion();

  const kpis = h('div', { class: 'tm-kpis' });
  const grid = h('div', { class: 'tm-grid' });
  const asOf = h('p', { class: 'lv-meta' }, dataAsOf());
  const refreshBtn = button({ label: 'Refresh', icon: 'refresh', size: 'sm', variant: 'quiet', onClick: () => load(true) });
  fill(root, h('div', { class: 'page lv-page tm-page' },
    pageHead({ title: 'Team', lede: 'How the accounts payable inbox is doing right now, and where work is waiting.', meta: asOf, actions: refreshBtn }),
    kpis, grid, live));

  async function load(manual = false) {
    loadError = null;
    if (manual) setBusy(refreshBtn, true);
    try {
      const [o, a, ex, th] = await Promise.all([
        wf.teamOverview(), wf.audit(100).catch(() => ({ rows: [] })), wf.expertise().catch(() => null), inbox.threads({}).catch(() => ({ rows: [] })),
      ]);
      if (!alive) return;
      data = o;
      audit = a.rows || [];
      people = ex;
      expNode = null;
      threads = th.rows || [];
      activity = (o.activity?.rows || []).filter((e) => !QUIET_EVENTS.has(e.type));
    } catch (e) {
      if (!alive) return;
      loadError = errText(e);
    } finally {
      if (manual) setBusy(refreshBtn, false);
    }
    render();
    if (!pendingBy && !loadError) loadPending();
  }

  // Every bill pending each approver's approval (the whole list is slow to read, so it fills in after the page).
  let pendingAsked = false;
  async function loadPending() {
    if (pendingAsked) return;
    pendingAsked = true;
    try {
      const aq = await wf.approverQueue();
      if (!alive) return;
      pendingBy = countBy(aq.bills || [], (b) => String(b.approver || '').toLowerCase());
      const scroll = window.scrollY;
      render();
      window.scrollTo(0, scroll);
    } catch { pendingAsked = false; }
  }

  // ------------------------------------------------------------------ figures
  // Ages come from the server's overview. When it has none for open tickets, they are worked out here from each
  // open thread's received date (the same rule: tickets still waiting on a person), and the source says so.
  function aging() {
    const srv = data.aging || { buckets: [] };
    const openTotal = (data.queues?.by_specialist || []).reduce((n, p) => n + (p.open || 0), 0);
    const srvSum = (srv.buckets || []).reduce((n, b) => n + b.count, 0);
    if (srvSum || !openTotal || !threads?.length) return srv;
    const now = appNow();
    const open = threads.filter((t) => t.outcome !== 'no_reply' && !['sent', 'acknowledged', 'closed'].includes(t.review_state)
      && !['sent', 'closed', 'decided'].includes(t.workflow_state));
    const ages = open.map((t) => (now - new Date(t.received_at)) / 86400000).filter((d) => Number.isFinite(d) && d >= 0);
    const edges = [['under 1 day', 0, 1], ['1 to 1.5 days', 1, 1.5], ['1.5 to 3 days', 1.5, 3], ['over 3 days', 3, Infinity]];
    const sorted = ages.slice().sort((x, y) => x - y);
    const mid = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
    return {
      buckets: edges.map(([label, lo, hi]) => ({ label, count: ages.filter((a) => a >= lo && a < hi).length })),
      median_open_days: mid == null ? null : Math.round(mid * 100) / 100,
      source: 'Zendesk tickets by date received',
    };
  }

  const days = (d) => (d == null ? '—' : d < 1 ? `${Math.round(d * 24)} h` : `${d.toFixed(1)} days`);

  function renderKpis() {
    const fr = data.first_reply || {};
    const fu = data.follow_up_rate || {};
    const ag = aging();
    const prevented = data.ahead?.prevented?.value;
    const lookups = data.ahead?.self_serve_lookups?.value;
    const openTotal = (data.queues?.by_specialist || []).reduce((n, p) => n + (p.open || 0), 0);
    const escalated = (data.queues?.by_specialist || []).reduce((n, p) => n + (p.escalated || 0), 0);
    const beats = fr.beats_baseline;
    fill(kpis, h('div', { class: 'c-stat-grid tm-stats', role: 'group', 'aria-label': 'Headline figures' },
      stat({ label: 'Open, waiting on a person', value: String(openTotal), icon: 'inbox', context: escalated ? `${escalated} waiting for CFO sign-off` : 'None waiting for CFO sign-off', href: '#/inbox', source: sourceText(data.queues?.source) }),
      stat({ label: 'Median first reply', value: fr.median_days == null ? '—' : days(fr.median_days), icon: 'clock',
        tone: beats === true ? 'settled' : beats === false ? 'risk' : undefined,
        context: fr.median_days == null ? `No replies sent yet. Open tickets have waited a median ${days(ag.median_open_days)}. Before Conductor: more than 1.5 days.` : `${beats ? 'Faster than' : 'Slower than'} before Conductor (more than 1.5 days), over ${plural(fr.replies_sent, 'reply', 'replies')}.`,
        source: sourceText(fr.source) }),
      stat({ label: 'Follow-up rate', value: fu.pct == null ? '—' : `${fu.pct}%`, icon: 'refresh',
        context: `${fu.follow_ups ?? 0} of ${fu.tickets ?? 0} tickets point to an earlier ticket. Before Conductor: more than 25%.`, source: sourceText(fu.source) }),
      stat({ label: 'Tickets prevented', value: prevented == null ? '—' : String(prevented), icon: 'ahead', href: '#/ahead',
        context: prevented == null ? 'Open Conductor: Ahead to build notices.' : `${prevented} of ${data.queues?.total ?? 0} tickets asked about an invoice a drafted Ahead notice covers. An estimate.`, source: sourceText(data.ahead?.prevented?.source) }),
      stat({ label: 'Self-serve lookups', value: lookups == null ? '—' : String(lookups), icon: 'search',
        context: 'Vendors who checked an invoice in Conductor: Direct. Not counted as tickets prevented.', source: sourceText(data.ahead?.self_serve_lookups?.source) })));
  }

  // ------------------------------------------------------------------ panes
  const card = (id, title, sub, body, extra) => h('section', { class: `c-pane tm-card tm-${id}`, 'aria-labelledby': `tm-${id}-h` },
    h('header', { class: 'c-pane-head' }, h('div', { class: 'c-pane-titles' }, h('h2', { class: 'c-pane-title', id: `tm-${id}-h` }, title), sub ? h('p', { class: 'c-pane-sub' }, sub) : null), extra || null),
    h('div', { class: 'c-pane-body' }, body));

  function queuesCard() {
    const spec = (data.queues?.by_specialist || []).slice().sort((a, b) => b.open - a.open);
    const byState = (data.queues?.by_state || []).slice().sort((a, b) => b.count - a.count);
    return card('queues', 'Queue health', 'Open tickets by specialist, and every ticket by state.', [
      h('h3', { class: 'tm-h3' }, 'By specialist'),
      barList({
        label: 'Open tickets by specialist', valueLabel: 'Open',
        rows: spec.map((p) => ({ key: p.email, label: p.name || nameOf(p.email), sub: [p.escalated ? `${p.escalated} waiting for CFO sign-off` : null, p.returned ? `${p.returned} returned` : null].filter(Boolean).join(' · ') || null, value: p.open })),
      }),
      h('h3', { class: 'tm-h3' }, 'By state'),
      barList({ label: 'Tickets by state', valueLabel: 'Tickets', rows: byState.map((s) => ({ key: s.state, label: STATE_LABEL[s.state] || s.state, value: s.count })) }),
      sourceLine(data.queues?.source)]);
  }

  function agingCard() {
    const ag = aging();
    const rows = (ag.buckets || []).map((b) => {
      const past = /1\.5 to 3|over 3/.test(b.label);
      return { key: b.label, label: b.label[0].toUpperCase() + b.label.slice(1), value: b.count,
        tone: /over 3/.test(b.label) ? 'risk' : past ? 'waiting' : undefined, toneLabel: past && b.count ? 'over 1.5 days' : null };
    });
    return card('aging', 'Aging', 'Tickets still waiting on a person, by time since they arrived. Before Conductor, a first reply took more than 1.5 days.', [
      barList({ label: 'Open tickets by age', valueLabel: 'Tickets', rows }),
      h('p', { class: 'tm-note' }, `Median age of open tickets: ${days(ag.median_open_days)}.`),
      sourceLine(ag.source)]);
  }

  function firstReplyCard() {
    const fr = data.first_reply || {};
    const ag = aging();
    const items = [
      { label: 'First reply now', value: fr.median_days, display: fr.median_days == null ? 'No replies yet' : days(fr.median_days), tone: fr.beats_baseline === false ? 'risk' : undefined },
      { label: 'Open tickets have waited', value: ag.median_open_days, display: days(ag.median_open_days), tone: ag.median_open_days > 1.5 ? 'waiting' : undefined },
      { label: 'Before Conductor', value: fr.baseline_days ?? 1.5, display: 'more than 1.5 days' },
    ];
    const top = Math.max(1.5, ...items.map((i) => Number(i.value) || 0)) * 1.1;
    return card('reply', 'First reply time', 'Before Conductor: more than 1.5 days.', [
      compare({ label: 'First reply time, now and before Conductor', items, max: top }),
      h('p', { class: 'tm-note' }, fr.replies_sent ? `${plural(fr.replies_sent, 'reply', 'replies')} sent from Conductor so far.` : 'The median appears once replies are sent from Conductor.'),
      sourceLine(fr.source)]);
  }

  function bottleneckCard() {
    const rows = data.bottlenecks?.rows || [];
    // The bars count tickets blocked. The line under each name counts bills, so the two numbers are never confused.
    const billsLine = (r) => {
      const pending = pendingBy?.get(String(r.approver || '').toLowerCase());
      const tied = `${plural(r.bills, 'bill')} holding up tickets`;
      return pending != null && pending !== r.bills ? `${plural(pending, 'bill')} pending · ${tied}` : tied;
    };
    return card('bottlenecks', 'Approvers holding up payments', 'Ranked by vendor tickets blocked on their approval.', [
      rows.length ? barList({
        label: 'Tickets blocked by approver', valueLabel: 'Tickets blocked', format: (v) => `${plural(v, 'ticket')} blocked`,
        rows: rows.map((r) => ({ key: r.approver, label: r.name || nameOf(r.approver), value: r.blocked_count,
          sub: `${billsLine(r)}${r.delegate_note ? ' · delegate for an inactive approver' : ''}`,
          note: r.blocked_tickets?.length ? `Tickets ${r.blocked_tickets.map((t) => `#${t}`).join(', ')}` : null })),
      }) : empty({ icon: 'approver', compact: true, title: 'No approver is holding anything up' }),
      h('p', { class: 'tm-note' }, h('a', { href: '#/ahead?tab=digests' }, 'Send approver digests from Conductor: Ahead')),
      sourceLine(data.bottlenecks?.source)]);
  }

  function feedbackCard() {
    const f = data.feedback || {};
    const cats = (f.by_category || []).slice().sort((a, b) => b.count - a.count);
    return card('feedback', 'Feedback on drafts', 'When someone edits a draft before sending, Conductor asks what was off.', [
      f.total ? barList({ label: 'Feedback by reason', valueLabel: 'Answers', rows: cats.map((c) => ({ key: c.category, label: FEEDBACK_LABEL[c.category] || c.category, value: c.count })) })
        : empty({ icon: 'mail-check', compact: true, title: 'No feedback yet', text: 'It appears here after a specialist edits a draft and says what was off.' }),
      h('p', { class: 'tm-note' }, `${plural(f.edited_drafts || 0, 'edited draft')}${f.answer_rate != null ? `, ${Math.round(f.answer_rate * 100)}% answered` : ''}.`),
      (f.recent || []).length ? h('ul', { class: 'tm-recent' }, f.recent.slice(0, 4).map((r) => h('li', null,
        h('strong', null, FEEDBACK_LABEL[r.category] || r.category), ' ', h('span', { class: 'lv-muted' }, `${nameOf(r.by)} · #${r.ticket_id} · ${fmtWhen(r.at)}`),
        r.note ? h('p', null, r.note) : null))) : null,
      sourceLine(f.source)]);
  }

  const activityList = h('ol', { class: 'tm-activity', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  function renderActivity() {
    fill(activityList, activity.length ? activity.slice(0, 30).map((e) => h('li', { class: 'tm-act' },
      h('span', { class: 'tm-act-icon', 'aria-hidden': 'true' }, icon(iconFor(e.type))),
      h('span', { class: 'tm-act-text' }, e.ticket_id ? h('a', { href: `#/inbox/${e.ticket_id}` }, e.summary || e.type) : (e.summary || e.type)),
      h('time', { class: 'tm-act-at' }, fmtTime(e.at)))) : h('li', { class: 'tm-act-empty lv-muted' }, 'Nothing yet. Arrivals, escalations, sends and replies show up here as they happen.'));
  }
  function activityCard() {
    renderActivity();
    return card('activity', 'Activity', 'Arrivals, escalations, sends and replies as they happen.', [activityList, sourceLine(data.activity?.source || 'Since this morning')],
      h('span', { class: 'tm-live' }, h('span', { class: 'c-dot c-dot-settled is-live', 'aria-hidden': 'true' }), 'Live'));
  }

  function auditCard() {
    const rows = audit || [];
    return card('audit', 'Audit log', 'Every workflow change, newest first.', [
      rows.length ? table({
        caption: 'Audit log', dense: true, rowKey: (r) => r.id,
        columns: [
          { key: 'at', label: 'When', width: 132, render: (r) => fmtWhen(r.at) },
          { key: 'actor', label: 'Who', render: (r) => nameOf(r.actor) },
          { key: 'ticket_id', label: 'Ticket', kind: 'mono', width: 80, render: (r) => (r.ticket_id ? h('a', { href: `#/inbox/${r.ticket_id}` }, `#${r.ticket_id}`) : '') },
          { key: 'action', label: 'What', render: (r) => [ACTION_LABEL[r.action] || r.action, r.to_state && r.from_state !== r.to_state ? h('span', { class: 'lv-muted' }, ` · ${STATE_LABEL[r.from_state] || r.from_state || 'new'} to ${STATE_LABEL[r.to_state] || r.to_state}`) : null] },
          { key: 'detail', label: 'Detail', render: (r) => h('span', { class: 'tm-detail' }, auditDetail(r)) },
        ],
        rows,
      }) : empty({ icon: 'list', compact: true, title: 'No changes yet', text: 'Escalations, sign-offs, decisions and sends are recorded here.' }),
      sourceLine('Change history')]);
  }
  function auditDetail(r) {
    const d = r.detail || {};
    if (d.guidance) return `Guidance: ${d.guidance}`;
    if (d.action_taken) return d.action_taken;
    if (d.note) return d.note;
    if (d.reason) return d.reason.replace(/_/g, ' ');
    if (d.to) return `To ${nameOf(d.to)}`;
    if (d.reply_hash) return 'Signed off the exact reply text';
    if (d.people) return d.people.map(nameOf).join(', ');
    return '';
  }

  function expertiseCard() {
    if (!people?.people?.length) return card('expertise', 'Who handles what', null, empty({ icon: 'team', compact: true, title: 'Expertise is not available' }));
    const draft = people.people.map((p) => ({ ...p, categories: [...(p.categories || [])] }));
    const save = button({ label: 'Save', variant: 'primary', size: 'sm', icon: 'check', disabled: true });
    const status = h('span', { class: 'lv-muted tm-exp-status', role: 'status' });
    const dirty = () => { save.disabled = false; status.textContent = 'Unsaved changes'; };
    save.addEventListener('click', async () => {
      setBusy(save, true);
      try {
        const r = await wf.saveExpertise(draft.map((p) => ({ email: p.email, exceptions: !!p.exceptions, categories: p.categories })));
        people = { ...people, people: r.people };
        toast({ message: 'Expertise saved. New tickets route by it.', tone: 'settled' });
        say(live, 'Expertise saved.');
        status.textContent = 'Saved';
        setBusy(save, false);
        save.disabled = true;
      } catch (e) { setBusy(save, false); toast({ message: errText(e), tone: 'risk' }); }
    });
    const rows = draft.map((p) => h('div', { class: 'tm-person' },
      h('div', { class: 'tm-person-head' }, avatar({ name: p.name, size: 'md' }),
        h('div', null, h('strong', null, p.name), h('p', { class: 'lv-muted' }, `${plural(p.replies, 'past reply', 'past replies')} in Zendesk`))),
      checkbox({ label: 'Handles exceptions', help: 'Fraud, bank changes, returns and conflicts route to this person first.', checked: !!p.exceptions,
        onChange: (e) => { p.exceptions = e.target.checked; dirty(); } }),
      h('div', { class: 'tm-cats', role: 'group', 'aria-label': `Categories for ${p.name}` }, EXPERTISE.map(([id, label]) => {
        const c = chip({ label, pressed: p.categories.includes(id), onClick: () => {
          p.categories = p.categories.includes(id) ? p.categories.filter((x) => x !== id) : [...p.categories, id];
          c.setAttribute('aria-pressed', String(p.categories.includes(id)));
          dirty();
        } });
        return c;
      }))));
    return card('expertise', 'Who handles what', 'Unassigned tickets route by expertise. Seeded from who answered which tickets.', [
      h('div', { class: 'tm-people' }, rows), sourceLine(people.source || 'past replies in Zendesk')],
    h('div', { class: 'tm-exp-actions' }, status, save));
  }

  function render() {
    if (loadError) {
      fill(kpis);
      fill(grid, empty({ icon: 'circle-alert', title: 'The overview could not be loaded', text: loadError, actions: button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: () => load(true) }) }));
      return;
    }
    if (!data) {
      fill(kpis, skeletonText({ lines: 2, label: 'Loading the overview' }));
      fill(grid);
      return;
    }
    asOf.textContent = dataAsOf(data.as_of);
    if (!data.available) {
      fill(kpis);
      fill(grid, notice({ tone: 'info', title: 'The inbox is still connecting', text: 'Figures appear once Conductor has read the inbox.' }));
      return;
    }
    renderKpis();
    fill(grid,
      h('div', { class: 'tm-col' }, queuesCard(), agingCard(), firstReplyCard()),
      h('div', { class: 'tm-col' }, bottleneckCard(), activityCard(), feedbackCard()),
      h('div', { class: 'tm-wide' }, expNode || (expNode = expertiseCard())),
      h('div', { class: 'tm-wide' }, auditCard()));
  }

  // ------------------------------------------------------------------ live
  let refreshTimer = 0;
  const off = subscribe((ev) => {
    if (!alive || QUIET_EVENTS.has(ev.type)) return;
    if (!activity.some((a) => a.id === ev.id)) {
      activity.unshift(ev);
      activity = activity.slice(0, 50);
      if (data) renderActivity();
    }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      try {
        const [o, a] = await Promise.all([wf.teamOverview(), wf.audit(100)]);
        if (!alive) return;
        data = o; audit = a.rows || [];
        renderKpis();
        const scroll = window.scrollY;
        render();
        window.scrollTo(0, scroll);
      } catch { /* keep the last figures */ }
    }, 1500);
  });

  render();
  load();
  return { destroy() { alive = false; off?.(); clearTimeout(refreshTimer); } };
}

function countBy(list, key) {
  const m = new Map();
  list.forEach((x) => { const k = key(x); m.set(k, (m.get(k) || 0) + 1); });
  return m;
}

function iconFor(type = '') {
  if (type === 'ticket.arrived' || type === 'direct.question') return 'mail';
  if (type === 'ticket.escalated' || type === 'signoff.requested') return 'escalations';
  if (type === 'ticket.returned') return 'arrow-left';
  if (type.endsWith('.sent')) return 'send';
  if (type === 'ticket.signed_off' || type === 'ticket.decided') return 'circle-check';
  if (type === 'ticket.assigned') return 'user';
  if (type === 'approver.committed') return 'calendar';
  if (type === 'w9.received') return 'file';
  return 'bell';
}
