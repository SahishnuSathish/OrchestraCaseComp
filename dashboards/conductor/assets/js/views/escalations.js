// Escalations (#/escalations[/:ticketId]): the CFO's home. Escalated tickets, sign-off requests and priority replies,
// each opened with its draft or internal note, the insight and the evidence. The CFO signs off the exact reply text,
// decides an internal note, or returns the ticket to the specialist with guidance. Nothing goes to a vendor from here.
import { h, icon, mount as fill } from '../lib.js';
import {
  button, setBusy, field, setFieldError, badge, riskBadges, contactBadge, chip, sourceChip, avatar, fmtMoney, timeline,
  skeletonRows, skeletonText, empty, notice, tabs, toast,
} from '../components/index.js';
import {
  pageHead, ago, fmtWhen, fmtDay, fmtTime, nameOf, firstName, REASONS, CATEGORIES, stateBadge, kv, errText, liveRegion, say, dataAsOf,
} from '../components/leadership/util.js';
import { replyHash } from '../components/leadership/reply-hash.js';
import * as wf from '../api-workflow.js';
import * as inbox from '../api-inbox.js';
import { subscribe } from '../api-live.js';

const NOTE_CATS = new Set(['fraud', 'returned', 'early_or_late_fee']);
const LIVE_TYPES = new Set(['ticket.escalated', 'signoff.requested', 'ticket.returned', 'ticket.signed_off', 'ticket.decided', 'ticket.sent', 'ticket.arrived']);
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'signoff', label: 'Sign-off' },
  { id: 'decision', label: 'Decisions' },
];
const asked = (r) => r.state === 'escalated' || r.state === 'signoff_requested';

export function mount(root, { route }) {
  let alive = true;
  let rows = null;          // escalation rows merged with their inbox row
  let loadError = null;
  let filter = FILTERS.some((f) => f.id === route.query?.show) ? route.query.show : 'all';
  let selected = route.ticketId || null;
  let detail = null;        // { id, thread, wf, hash } | { id, loading } | { id, error }
  let detailSeq = 0;
  const fresh = new Set();  // ticket ids that arrived while the page was open
  const live = liveRegion();

  const listBody = h('div', { class: 'esc-list-body' });
  const filterSlot = h('div', { class: 'esc-filter' });
  const listPane = h('section', { class: 'c-pane esc-list', 'aria-labelledby': 'esc-list-h' },
    h('header', { class: 'c-pane-head' },
      h('div', { class: 'c-pane-titles' }, h('h2', { class: 'c-pane-title', id: 'esc-list-h' }, 'Queue'),
        h('p', { class: 'c-pane-sub' }, 'Oldest ask first. Updates live.')),
      filterSlot),
    listBody);
  const detailPane = h('section', { class: 'c-pane esc-detail', 'aria-label': 'Selected ticket', tabindex: '-1' });
  const grid = h('div', { class: 'esc-grid' }, listPane, detailPane);
  const asOf = h('p', { class: 'lv-meta' }, dataAsOf());

  fill(root, h('div', { class: 'page lv-page esc-page' },
    pageHead({
      title: 'Escalations',
      lede: 'Priority replies to sign off, and internal notes to decide. Nothing here reaches a vendor until you act.',
      meta: asOf,
    }),
    grid, live));

  // ------------------------------------------------------------------ list
  const needsOf = (r) => (r.category === 'priority' ? 'signoff' : 'decision');
  const visible = () => (rows || []).filter((r) => filter === 'all' || needsOf(r) === filter);

  function renderFilter() {
    const counts = { all: rows?.length || 0, signoff: 0, decision: 0 };
    (rows || []).forEach((r) => { counts[needsOf(r)] += 1; });
    fill(filterSlot, tabs({
      label: 'Show', variant: 'segmented', size: 'sm', selected: filter,
      items: FILTERS.map((f) => ({ ...f, count: rows ? counts[f.id] : null })),
      onSelect: (id) => { filter = id; renderList(); },
    }));
  }

  function rowNode(r) {
    const active = r.ticket_id === selected;
    const when = r.at ? `Escalated ${ago(r.at)}` : r.received_at ? `Received ${ago(r.received_at)}` : '';
    const reason = r.reason ? REASONS[r.reason] || r.reason : null;
    return h('li', null, h('a', {
      class: `esc-row${active ? ' is-active' : ''}${fresh.has(r.ticket_id) ? ' is-new' : ''}`,
      href: `#/escalations/${r.ticket_id}`, 'aria-current': active ? 'true' : null,
    },
    h('div', { class: 'esc-row-top' },
      h('span', { class: 'esc-row-from truncate' }, r.from_name || 'Unknown sender', r.company && r.company !== r.from_name ? h('span', { class: 'esc-row-co' }, ` · ${r.company}`) : null),
      h('span', { class: 'esc-row-age' }, when)),
    h('div', { class: 'esc-row-subject truncate' }, r.subject || '(no subject)'),
    r.note ? h('p', { class: 'esc-row-note' }, h('span', { class: 'esc-row-who' }, `${firstName(r.from)}: `), r.note) : null,
    h('div', { class: 'esc-row-badges' },
      fresh.has(r.ticket_id) ? badge({ label: 'New', tone: 'info' }) : null,
      badge({ label: r.category === 'priority' ? 'Sign-off' : 'Decision', tone: asked(r) ? 'waiting' : 'neutral', icon: r.category === 'priority' ? 'mail-check' : 'file' }),
      badge({ label: reason || CATEGORIES[r.category] || 'Escalated', tone: 'neutral' }),
      riskBadges(r.flags || []),
      h('span', { class: 'esc-row-id mono' }, `#${r.ticket_id}`))));
  }

  function renderList() {
    renderFilter();
    if (loadError) {
      fill(listBody, empty({ icon: 'circle-alert', title: 'The queue could not be loaded', text: loadError, compact: true,
        actions: button({ label: 'Try again', icon: 'refresh', onClick: load }) }));
      return;
    }
    if (!rows) { fill(listBody, skeletonRows({ rows: 5, avatar: false, label: 'Loading escalations' })); return; }
    const list = visible();
    if (!list.length) {
      fill(listBody, empty({
        icon: 'escalations', compact: true,
        title: rows.length ? 'Nothing in this view' : 'Nothing waiting on you',
        text: rows.length ? 'Try another filter.' : 'When a specialist escalates a ticket or asks for sign-off, it appears here straight away.',
      }));
      return;
    }
    const mine = list.filter(asked);
    const rest = list.filter((r) => !asked(r));
    fill(listBody,
      mine.length ? h('h3', { class: 'esc-group' }, 'Asked of you', h('span', { class: 'lv-count' }, mine.length)) : null,
      mine.length ? h('ul', { class: 'esc-rows' }, mine.map(rowNode)) : null,
      rest.length ? h('h3', { class: 'esc-group' }, 'Priority, not yet escalated', h('span', { class: 'lv-count' }, rest.length)) : null,
      rest.length ? h('ul', { class: 'esc-rows' }, rest.map(rowNode)) : null);
  }

  async function load() {
    loadError = null;
    try {
      const [esc, threads] = await Promise.all([wf.escalations(), inbox.threads({}).catch(() => ({ rows: [] }))]);
      if (!alive) return;
      asOf.textContent = dataAsOf();
      const byId = new Map((threads.rows || []).map((t) => [t.ticket_id, t]));
      const before = rows ? new Set(rows.map((r) => r.ticket_id)) : null;
      rows = (esc.rows || []).map((r) => {
        const t = byId.get(r.ticket_id) || {};
        return { ...r, company: t.company, flags: t.flags || [], received_at: t.received_at, sender_verified: t.sender_verified };
      });
      const ts = (r) => Date.parse(r.at || r.received_at || 0) || 0;
      rows.sort((a, b) => (asked(a) !== asked(b) ? (asked(a) ? -1 : 1) : ts(a) - ts(b)));
      if (before) rows.forEach((r) => { if (!before.has(r.ticket_id)) fresh.add(r.ticket_id); });
    } catch (e) {
      if (!alive) return;
      loadError = errText(e);
    }
    renderList();
    if (!selected) renderDetail();
  }

  // ------------------------------------------------------------------ detail
  async function openDetail(id, { quiet = false } = {}) {
    const seq = ++detailSeq;
    if (!id) { detail = null; renderDetail(); return; }
    if (!quiet || detail?.id !== id) { detail = { id, loading: true }; renderDetail(); }
    try {
      const [thread, state] = await Promise.all([inbox.thread(id), wf.state(id)]);
      const d = thread.review?.draft;
      const hash = d && d.output_type === 'draft_reply' && d.to ? await replyHash(d.to, d.subject, d.text) : null;
      if (!alive || seq !== detailSeq) return;
      detail = { id, thread, wf: state, hash };
    } catch (e) {
      if (!alive || seq !== detailSeq) return;
      detail = { id, error: e.status === 404 ? 'This ticket is not in the inbox.' : errText(e) };
    }
    renderDetail();
  }

  function renderDetail() {
    grid.toggleAttribute('data-open', !!selected);
    if (!selected) {
      fill(detailPane, h('div', { class: 'esc-detail-body' }, empty({
        icon: 'escalations', title: 'Choose a ticket',
        text: 'Open a ticket from the queue to read the draft or note, the insight and the evidence.',
      })));
      return;
    }
    if (!detail || detail.loading) {
      fill(detailPane, h('div', { class: 'esc-detail-body' }, skeletonText({ lines: 3, label: 'Opening ticket' }), skeletonText({ lines: 6 })));
      return;
    }
    if (detail.error) {
      fill(detailPane, h('div', { class: 'esc-detail-body' }, backLink(), empty({
        icon: 'circle-alert', title: 'This ticket could not be opened', text: detail.error,
        actions: [button({ label: 'Try again', icon: 'refresh', onClick: () => openDetail(selected) }), button({ label: 'Open in inbox', href: `#/inbox/${selected}`, variant: 'quiet' })],
      })));
      return;
    }
    fill(detailPane, detailView(detail));
  }

  const backLink = () => h('a', { class: 'esc-back', href: '#/escalations' }, icon('chev-left'), 'Back to the queue');

  function detailView({ id, thread: t, wf: st, hash }) {
    const row = (rows || []).find((r) => r.ticket_id === id) || {};
    const res = t.result || {};
    const category = st.category || row.category;
    const isPriority = category === 'priority';
    const isNote = !isPriority && (NOTE_CATS.has(category) || res.output_type === 'internal_action_note');
    const specialist = st.assignee || row.assignee;
    const lastAsk = [...(st.history || [])].reverse().find((a) => a.action === 'escalate' || a.action === 'request-signoff');

    const head = h('header', { class: 'esc-dhead' },
      backLink(),
      h('div', { class: 'esc-dhead-main' },
        h('div', { class: 'esc-dhead-titles' },
          h('h2', { class: 'esc-dtitle' }, t.subject || '(no subject)'),
          h('p', { class: 'esc-dfrom' },
            h('strong', null, t.from_name || 'Unknown sender'), t.company ? ` · ${t.company}` : '',
            t.from_email ? h('span', { class: 'mono esc-dmail' }, ` · ${t.from_email}`) : null,
            t.received_at ? h('span', { class: 'lv-muted' }, ` · received ${fmtDay(t.received_at)}`) : null)),
        button({ label: 'Open in inbox', icon: 'inbox', href: `#/inbox/${id}`, size: 'sm' })),
      h('div', { class: 'esc-dbadges' },
        stateBadge(st.state),
        badge({ label: CATEGORIES[category] || 'Escalated', tone: 'neutral', icon: isPriority ? 'mail-check' : 'file' }),
        riskBadges(t.flags || []),
        contactBadge(!!t.sender_verified),
        sourceChip({ label: `Zendesk #${id}` }),
        specialist ? h('span', { class: 'esc-assignee' }, avatar({ name: nameOf(specialist), size: 'sm' }), nameOf(specialist)) : null));

    const action = isPriority && res.output_type === 'draft_reply'
      ? signoffBlock(id, t, st, hash, specialist)
      : isNote ? noteBlock(id, t, st, specialist) : otherBlock(id, t, st, specialist);
    return h('div', { class: 'esc-detail-body' }, head, askBlock(lastAsk, isPriority), insightBlock(t), action, evidenceBlock(t), historyBlock(id, st));
  }

  function askBlock(a, isPriority) {
    if (!a) {
      return notice({ tone: 'info', title: isPriority ? 'Priority reply' : 'Not escalated yet',
        text: isPriority ? 'No one has asked for sign-off yet. A priority reply comes to you before it can go out.' : 'This ticket is here because of its category.' });
    }
    const d = a.detail || {};
    const reason = d.reason === 'signoff' ? 'Sign-off requested' : (REASONS[d.reason] || 'Escalated');
    return h('section', { class: 'esc-ask', 'aria-label': 'Specialist note' },
      avatar({ name: nameOf(a.actor), size: 'md' }),
      h('div', { class: 'esc-ask-body' },
        h('p', { class: 'esc-ask-head' }, h('strong', null, nameOf(a.actor)), h('span', { class: 'lv-muted' }, ` · ${ago(a.at)}`), badge({ label: reason, tone: 'neutral' })),
        d.note ? h('blockquote', { class: 'esc-ask-note' }, d.note) : h('p', { class: 'lv-muted' }, 'No note added.')));
  }

  function insightBlock(t) {
    const i = t.insight || {};
    if (!i.wants && !i.status_line) return null;
    return h('section', { class: 'esc-insight', 'aria-label': 'Insight' },
      kv([
        i.wants ? ['They want', i.wants] : null,
        i.invoice ? ['Invoice', i.invoice] : null,
        i.status_line ? ['From records', i.status_line] : null,
        i.why ? ['Why it is here', i.why] : null,
      ], 'lv-kv-wide'));
  }

  const cardHead = (id, title, sub) => h('header', { class: 'c-pane-head' }, h('div', { class: 'c-pane-titles' },
    h('h3', { class: 'c-pane-title', id }, title), sub ? h('p', { class: 'c-pane-sub' }, sub) : null));

  // ---- priority: sign off the exact reply text
  function signoffBlock(id, t, st, hash, specialist) {
    const d = t.review?.draft || {};
    const requested = [...(st.history || [])].reverse().find((a) => a.action === 'request-signoff');
    const changed = requested?.detail?.reply_hash && hash && requested.detail.reply_hash !== hash;
    const sent = st.state === 'sent' || t.review_state === 'sent';
    const signed = st.state === 'signed_off' && st.signoff?.hash === hash;
    const who = firstName(specialist) || 'The specialist';
    const signBtn = button({ label: signed ? 'Signed off' : 'Sign off', variant: 'primary', icon: 'circle-check', disabled: signed || sent || !hash });
    const returnBtn = button({ label: 'Return with guidance', icon: 'arrow-left', disabled: sent });
    const formSlot = h('div');
    signBtn.addEventListener('click', async () => {
      setBusy(signBtn, true);
      try {
        await wf.signoff(id, hash);
        toast({ message: `Signed off. ${who} can send it now.`, tone: 'settled' });
        say(live, `Signed off ticket ${id}.`);
        await Promise.all([openDetail(id, { quiet: true }), load()]);
      } catch (e) {
        setBusy(signBtn, false);
        toast({ message: errText(e), tone: 'risk' });
        if (e.status === 409) openDetail(id, { quiet: true });
      }
    });
    returnBtn.addEventListener('click', () => fill(formSlot, returnForm(id, specialist, () => fill(formSlot))));
    return h('section', { class: 'c-pane esc-card', 'aria-labelledby': `esc-reply-${id}` },
      cardHead(`esc-reply-${id}`, 'Holding reply', `The exact text you sign off. ${who} sends it after you do.`),
      h('div', { class: 'c-pane-body' },
        sent ? notice({ tone: 'settled', title: 'Sent', text: 'This reply has gone to the vendor.' }) : null,
        signed && !sent ? notice({ tone: 'settled', title: 'Signed off', text: `You signed off${st.signoff?.at ? ` ${fmtWhen(st.signoff.at)}` : ''}. ${who} can send it now.` }) : null,
        changed && !signed ? notice({ tone: 'waiting', title: 'The text changed after sign-off was requested', text: 'Read the current text below before you sign off.' }) : null,
        kv([['To', h('span', { class: 'mono' }, d.to || '')], ['Subject', d.subject || '']], 'esc-mailhead'),
        h('div', { class: 'esc-mailbody' }, d.text || ''),
        d.edited ? h('p', { class: 'lv-muted esc-edited' }, icon('pencil', 'icon-sm'), 'Edited by the specialist from the records-only draft.') : null),
      h('footer', { class: 'c-pane-foot esc-actions' },
        h('span', { class: 'esc-fingerprint', title: hash ? `SHA-256 ${hash}` : '' }, 'Text fingerprint ', h('span', { class: 'mono' }, hash ? hash.slice(0, 10) : '')),
        h('span', { class: 'lv-spacer' }), returnBtn, signBtn),
      formSlot);
  }

  // ---- note tickets: decide; there is never a compose box on these
  function noteBlock(id, t, st, specialist) {
    const res = t.result || {};
    const done = ['decided', 'closed', 'sent'].includes(st.state);
    const lastDecide = [...(st.history || [])].reverse().find((a) => a.action === 'decide');
    let choice = 'acknowledged';
    const ackId = `esc-ack-${id}`;
    const closeId = `esc-close-${id}`;
    const action = field({ label: 'Action taken', type: 'textarea', rows: 3, required: true, help: 'What was done, in a line or two. It goes on the Zendesk ticket as an internal note.' });
    const noteF = field({ label: 'Note', type: 'textarea', rows: 2, help: 'Optional.' });
    function sync() { action.hidden = choice !== 'acknowledged'; setFieldError(action, null); }
    const radio = (rid, value, title, text, checked) => h('label', { class: 'esc-radio', for: rid },
      h('input', { type: 'radio', name: `esc-dec-${id}`, id: rid, value, checked: checked || null, onchange: () => { choice = value; sync(); } }),
      h('span', { class: 'esc-radio-text' }, h('strong', null, title), h('span', { class: 'lv-muted' }, text)));
    const radios = h('fieldset', { class: 'esc-choice' },
      h('legend', { class: 'c-field-label' }, 'Decision'),
      radio(ackId, 'acknowledged', 'Acknowledge', 'Record the action taken. Zendesk is set to Pending.', true),
      radio(closeId, 'closed', 'Close', 'No further action is needed.'));
    const saveBtn = button({ label: 'Record decision', variant: 'primary', icon: 'check' });
    const returnBtn = button({ label: 'Return with guidance', icon: 'arrow-left' });
    const formSlot = h('div');
    saveBtn.addEventListener('click', async () => {
      const text = action.control.value.trim();
      if (choice === 'acknowledged' && !text) { setFieldError(action, 'Say what action was taken.'); action.control.focus(); return; }
      setBusy(saveBtn, true);
      try {
        await wf.decide(id, choice, choice === 'acknowledged' ? text : '', noteF.control.value.trim());
        toast({ message: choice === 'acknowledged' ? 'Decision recorded. Zendesk updated.' : 'Closed. Zendesk updated.', tone: 'settled' });
        say(live, `Decision recorded on ticket ${id}.`);
        await Promise.all([openDetail(id, { quiet: true }), load()]);
      } catch (e) {
        setBusy(saveBtn, false);
        toast({ message: errText(e), tone: 'risk' });
      }
    });
    returnBtn.addEventListener('click', () => fill(formSlot, returnForm(id, specialist, () => fill(formSlot))));
    const fraud = (t.flags || []).includes('fraud') || st.category === 'fraud';
    return h('section', { class: 'c-pane esc-card', 'aria-labelledby': `esc-note-${id}` },
      cardHead(`esc-note-${id}`, 'Internal action note', 'No reply is written on this ticket. You decide what happens to the note.'),
      h('div', { class: 'c-pane-body' },
        fraud ? notice({ tone: 'risk', title: 'Fraud review', text: 'Approval is blocked on this ticket. Bank details are never changed from an email.' }) : null,
        h('div', { class: 'esc-mailbody esc-notebody' }, res.text || t.decision?.why || 'No note text.'),
        t.decision?.act_by ? kv([['Next step owner', nameOf(t.decision.act_by)]]) : null,
        done && lastDecide ? notice({ tone: 'settled', title: lastDecide.detail?.decision === 'closed' ? 'Closed' : 'Acknowledged',
          text: [lastDecide.detail?.action_taken, `${nameOf(lastDecide.actor)} · ${fmtWhen(lastDecide.at)}`].filter(Boolean).join(' · ') }) : null,
        done ? null : h('div', { class: 'esc-decide' }, radios, action, noteF)),
      done ? null : h('footer', { class: 'c-pane-foot esc-actions' }, h('span', { class: 'lv-spacer' }), returnBtn, saveBtn),
      formSlot);
  }

  // ---- an escalated ticket that is neither a priority reply nor a note: read it, return it, or close it
  function otherBlock(id, t, st, specialist) {
    const d = t.review?.draft || {};
    const done = ['decided', 'closed', 'sent'].includes(st.state);
    const returnBtn = button({ label: 'Return with guidance', variant: 'primary', icon: 'arrow-left', disabled: done });
    const closeBtn = button({ label: 'Close without a reply', variant: 'quiet', disabled: done });
    const formSlot = h('div');
    returnBtn.addEventListener('click', () => fill(formSlot, returnForm(id, specialist, () => fill(formSlot))));
    closeBtn.addEventListener('click', async () => {
      setBusy(closeBtn, true);
      try {
        await wf.decide(id, 'closed', '', 'Closed from Escalations');
        toast({ message: 'Closed. Zendesk updated.', tone: 'settled' });
        await Promise.all([openDetail(id, { quiet: true }), load()]);
      } catch (e) { setBusy(closeBtn, false); toast({ message: errText(e), tone: 'risk' }); }
    });
    const who = firstName(specialist) || 'The specialist';
    return h('section', { class: 'c-pane esc-card', 'aria-labelledby': `esc-other-${id}` },
      cardHead(`esc-other-${id}`, d.text ? 'Draft reply' : 'Ticket',
        d.text ? `${who} approves and sends routine replies. Return it with guidance if it needs a change.` : 'There is no reply on this ticket.'),
      d.text ? h('div', { class: 'c-pane-body' }, kv([['To', h('span', { class: 'mono' }, d.to || '')], ['Subject', d.subject || '']], 'esc-mailhead'), h('div', { class: 'esc-mailbody' }, d.text)) : null,
      h('footer', { class: 'c-pane-foot esc-actions' }, h('span', { class: 'lv-spacer' }), closeBtn, returnBtn),
      formSlot);
  }

  function returnForm(id, specialist, onCancel) {
    const who = firstName(specialist) || 'the specialist';
    const g = field({ label: `Guidance for ${who}`, type: 'textarea', rows: 3, required: true, help: `${who} sees this on the ticket and in a notification.` });
    const send = button({ label: `Return to ${who}`, variant: 'primary', icon: 'arrow-left' });
    const cancel = button({ label: 'Cancel', variant: 'quiet', onClick: onCancel });
    send.addEventListener('click', async () => {
      const text = g.control.value.trim();
      if (!text) { setFieldError(g, 'Write the guidance first.'); g.control.focus(); return; }
      setBusy(send, true);
      try {
        await wf.returnWithGuidance(id, text);
        toast({ message: `Returned to ${who} with guidance.`, tone: 'settled' });
        say(live, `Returned ticket ${id}.`);
        await Promise.all([openDetail(id, { quiet: true }), load()]);
      } catch (e) {
        setBusy(send, false);
        setFieldError(g, errText(e));
      }
    });
    setTimeout(() => g.control.focus(), 0);
    return h('div', { class: 'esc-return' }, g, h('div', { class: 'esc-return-actions' }, cancel, send));
  }

  function evidenceBlock(t) {
    const e = t.evidence || {};
    const items = e.items || [];
    const v = e.vendor;
    const req = e.requester;
    return h('section', { class: 'esc-evidence', 'aria-labelledby': `esc-ev-${t.ticket_id}` },
      h('h3', { class: 'esc-h3', id: `esc-ev-${t.ticket_id}` }, 'Evidence'),
      v || req ? kv([
        v ? ['Vendor', v.name] : null, v?.subsidiary ? ['Subsidiary', v.subsidiary] : null, v?.terms ? ['Terms', v.terms] : null,
        req ? ['Requester', h('span', { class: 'esc-req' }, req.name || req.email || '', req.authorized ? badge({ label: 'Authorized contact', tone: 'settled', icon: 'shield-check' }) : badge({ label: 'Not on file', tone: 'neutral', icon: 'user-x' }))] : null,
      ], 'lv-kv-wide') : null,
      items.length ? h('ul', { class: 'esc-items' }, items.map((it) => {
        const b = it.bill || {};
        const p = it.payment;
        const parts = [];
        if (p) parts.push(`Payment ${[p.status, p.date ? fmtDay(p.date) : null, p.method, p.account ? `account ${p.account}` : null].filter(Boolean).join(', ')}`);
        if (it.run) parts.push(`Run ${it.run.run_id}, ${String(it.run.run_status || '').toLowerCase()}${it.run.run_date ? ` for ${fmtDay(it.run.run_date)}` : ''}`);
        return h('li', { class: 'esc-item' },
          h('div', { class: 'esc-item-head' },
            h('strong', { class: 'mono' }, it.ref),
            b.userTotal ? h('span', { class: 'money' }, fmtMoney(b.userTotal, b.currency || 'USD')) : null,
            h('span', { class: 'lv-muted' }, it.status === 'found' ? [b.status, b.approvalStatus].filter(Boolean).join(' · ') : 'Not found in NetSuite')),
          parts.length ? h('p', { class: 'esc-item-line' }, parts.join(' · ')) : null,
          (it.sources || []).length ? h('div', { class: 'esc-item-sources' }, it.sources.map((s) => sourceChip({ label: s.label }))) : null);
      })) : h('p', { class: 'lv-muted' }, 'No invoice was matched on this ticket.'),
      (e.linked || []).length ? h('div', { class: 'esc-linked' }, h('span', { class: 'lv-muted' }, 'Linked tickets'), e.linked.map((l) => chip({ label: `#${l.id}`, title: l.subject }))) : null);
  }

  function historyBlock(id, st) {
    const hist = st.history || [];
    if (!hist.length) return null;
    const label = (a) => ({
      escalate: 'Escalated', 'request-signoff': 'Sign-off requested', return: 'Returned with guidance', signoff: 'Signed off',
      decide: a.detail?.decision === 'closed' ? 'Closed' : 'Acknowledged', assign: 'Assigned', sent: 'Sent', approver_nudge: 'Approver chase drafted',
      'outbound-sent': 'Approver chased', forward: 'Forwarded', 'no-reply': 'Marked no reply needed',
    }[a.action] || a.action);
    const text = (a) => a.detail?.guidance || a.detail?.note || a.detail?.action_taken || null;
    return h('section', { class: 'esc-history', 'aria-labelledby': `esc-hist-${id}` },
      h('h3', { class: 'esc-h3', id: `esc-hist-${id}` }, 'History'),
      timeline({ label: 'Ticket history', items: hist.map((a) => ({ title: label(a), at: fmtWhen(a.at), actor: nameOf(a.actor), detail: text(a), state: 'done' })) }));
  }

  // ------------------------------------------------------------------ live
  let reloadTimer = 0;
  const off = subscribe((ev) => {
    if (!alive || !LIVE_TYPES.has(ev.type)) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      load();
      if (selected && Number(ev.ticket_id) === selected) openDetail(selected, { quiet: true });
    }, 250);
    if (ev.type === 'ticket.escalated' || ev.type === 'signoff.requested') say(live, ev.summary || 'A new escalation arrived.');
  });

  renderList();
  renderDetail();
  load();
  if (selected) openDetail(selected);

  return {
    update({ route: next }) {
      const id = next.ticketId || null;
      if (id === selected) return;
      selected = id;
      if (id) fresh.delete(id);
      renderList();
      openDetail(id);
      if (id) detailPane.focus({ preventScroll: true });
    },
    destroy() { alive = false; off?.(); clearTimeout(reloadTimer); },
  };
}
