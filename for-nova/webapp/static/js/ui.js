// Shared UI pieces: toasts, dialogs, badges, the brief card, and the ticket-detail sections.
import { h, icon, $, mount, fmtDate, fmtMs, humanize } from './lib.js';

// ---------------------------------------------------------------------------- toast
export function toast({ message, actionLabel, onAction, duration = 5000 }) {
  const root = $('#toasts');
  while (root.children.length >= 3) root.firstChild.remove();
  let timer;
  const close = () => {
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 140);
  };
  const el = h('div', { class: 'toast' },
    h('span', null, message),
    actionLabel && h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => { onAction?.(); close(); } }, actionLabel),
    h('button', { class: 'btn btn-quiet btn-sm btn-icon', type: 'button', 'aria-label': 'Dismiss', onclick: close }, icon('x')));
  root.append(el);
  timer = setTimeout(close, duration);
  return close;
}

// ---------------------------------------------------------------------------- dialog
export function openDialog({ title, body, actions, onClose, width }) {
  const dlg = h('dialog', { class: 'dialog', 'aria-labelledby': 'dlg-title' });
  if (width) dlg.style.width = `min(${width}px, calc(100vw - 32px))`;
  const closeBtn = h('button', { class: 'btn btn-quiet btn-icon btn-sm', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x'));
  const foot = actions ? h('div', { class: 'dialog-foot' }, actions(dlg)) : null;
  dlg.append(h('div', { class: 'dialog-head' }, h('h2', { id: 'dlg-title' }, title), closeBtn),
    h('div', { class: 'dialog-body' }, body(dlg)), foot);
  // Finish exactly once, however the dialog ends. Not every embedded browser fires the 'close' event reliably,
  // so closing through our own handle also finishes directly; the events remain as the fallback (Escape, backdrop).
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onClose?.();
    setTimeout(() => dlg.remove(), 220);
  };
  const nativeClose = dlg.close.bind(dlg);
  dlg.close = (...a) => { nativeClose(...a); finish(); };
  dlg.addEventListener('close', finish);
  dlg.addEventListener('cancel', () => setTimeout(finish, 0));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('#modal-root').append(dlg);
  dlg.showModal();
  return dlg;
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    openDialog({
      title, width: 440,
      body: () => h('p', null, message),
      actions: (dlg) => [
        h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', autofocus: true, onclick: () => { result = true; dlg.close(); } }, confirmLabel),
      ],
      onClose: () => resolve(result),
    });
  });
}

// ---------------------------------------------------------------------------- badges
const OUTPUT = {
  draft_reply: ['badge-accent', 'mail', 'Reply'],
  internal_action_note: ['', 'file', 'Internal note'],
  no_draft: ['badge-quiet', 'circle-dash', 'No reply'],
  error: ['badge-danger', 'circle-alert', 'Error'],
};
export function outputBadge(type) {
  const [cls, ic, label] = OUTPUT[type] || ['', 'file', humanize(type)];
  return h('span', { class: `badge ${cls}` }, icon(ic), label);
}

export function flagBadges(row) {
  const out = [];
  for (const f of row.flags || []) out.push(h('span', { class: 'badge badge-danger' }, icon('shield-alert'), humanize(f)));
  if (row.priority) out.push(h('span', { class: 'badge badge-warning' }, icon('flag'), 'Priority'));
  if (row.error) out.push(h('span', { class: 'badge badge-danger', title: row.error }, icon('circle-alert'), 'Failed'));
  return out;
}

export function reviewBadge(row) {
  const s = row.review_state || 'pending';
  if (row.output_type === 'error') return h('span', { class: 'badge badge-danger' }, icon('circle-alert'), 'Failed');
  if (s === 'sent') return h('span', { class: 'badge badge-success' }, icon('send'), 'Sent');
  if (s === 'approved') return h('span', { class: 'badge badge-success' }, icon('check'), 'Approved');
  if (s === 'returned') return h('span', { class: 'badge badge-warning' }, icon('undo'), 'Returned');
  if (s === 'acknowledged') return h('span', { class: 'badge badge-success' }, icon('check'), 'Acknowledged');
  if (s === 'closed') return h('span', { class: 'badge badge-success' }, icon('check'), 'Closed');
  return h('span', { class: 'badge badge-quiet' }, row.output_type === 'draft_reply' ? 'To review' : 'Open');
}

// ---------------------------------------------------------------------------- brief
export function briefCard({ brief, canRewrite, onRewrite, swap = false }) {
  if (!brief) {
    return h('section', { class: 'brief', 'aria-label': 'Brief', 'aria-busy': 'true' },
      h('div', { class: 'brief-head' }, h('h3', null, 'Brief')),
      h('div', { class: 'brief-list' }, [0, 1, 2].map(() => h('div', { class: 'brief-item' }, h('div', { class: 'skeleton', style: { height: '12px', width: '48px' } }), h('div', { class: 'skeleton', style: { height: '14px', width: '85%' } })))));
  }
  const fromModel = brief.source === 'model';
  const info = brief.info || {};
  const srcTitle = fromModel ? `Written by ${info.model || 'the local model'}${info.ms ? ` in ${fmtMs(info.ms)}` : ''} and checked against the records`
    : info.error ? `Generated from records. Local model not used: ${info.error}` : 'Generated from records';
  const src = h('span', { class: 'src', title: srcTitle }, icon(fromModel ? 'cpu' : 'database', 'icon-sm'), fromModel ? 'Written by local model' : 'Generated from records');
  const rewrite = canRewrite && onRewrite
    ? h('button', { class: 'btn btn-quiet btn-sm btn-icon', type: 'button', title: 'Rewrite with the local model', 'aria-label': 'Rewrite brief with the local model', onclick: (e) => onRewrite(e.currentTarget) }, icon('refresh'))
    : null;
  return h('section', { class: `brief${swap ? ' brief-swap' : ''}`, 'aria-label': 'Brief' },
    h('div', { class: 'brief-head' }, h('h3', null, 'Brief'), src, rewrite),
    h('ul', { class: 'brief-list' }, (brief.bullets || []).map((b) =>
      h('li', { class: `brief-item${b.label === 'Watch' ? ' watch' : b.label === 'Next' ? ' next' : ''}` },
        h('span', { class: 'brief-label' }, b.label), h('span', { class: 'brief-text' }, b.text)))));
}

// ---------------------------------------------------------------------------- ticket detail sections
const ACTION_LABEL = {
  find_vendor_by_contact: 'Vendor by sender email', find_vendors_by_domain: 'Vendors by email domain', get_vendor: 'Vendor record',
  find_employee_by_email: 'Employee by email', find_bills_by_tranId: 'Vendor bill by invoice number',
  find_payments_for_bill: 'Payments applied to bill', find_runs_for_bill: 'Payment runs for bill', get_user: 'Requester profile',
  get_linked_ticket: 'Linked ticket',
};
const PLATFORM = { netsuite: 'NetSuite', payment_system: 'Payment system', zendesk: 'Zendesk' };

export function originalTicket(t, { open = true, asSection = true } = {}) {
  const attachments = (t.attachments || []).map((a) => h('span', { class: 'attach' }, icon('clip', 'icon-sm'), a));
  const cc = (t.cc || []).map((c) => c.name || c.email).filter(Boolean).join(', ');
  const kv = h('dl', { class: 'kv' },
    h('dt', null, 'From'), h('dd', null, [t.sender_name, t.sender_email && h('span', { class: 'mono faint' }, ` <${t.sender_email}>`)]),
    t.to ? [h('dt', null, 'To'), h('dd', { class: 'mono' }, t.to)] : null,
    h('dt', null, 'Received'), h('dd', null, fmtDate(t.received_at)),
    cc ? [h('dt', null, 'Cc'), h('dd', null, cc)] : null,
    attachments.length ? [h('dt', null, 'Files'), h('dd', { class: 'row-wrap' }, attachments)] : null,
    (t.linked_ticket_ids || []).length ? [h('dt', null, 'Linked'), h('dd', { class: 'mono' }, t.linked_ticket_ids.map((i) => `#${i}`).join(', '))] : null);
  const body = h('div', { class: 'stack-sm' }, kv, h('div', { class: 'email-body' }, t.body || ''));
  if (!asSection) return body;
  return h('details', { class: 'section', open }, h('summary', null, icon('mail'), 'Original ticket', icon('chev-down', 'chev')), h('div', { class: 'section-body' }, body));
}

export function dataTrail(trace) {
  const groups = new Map();
  for (const ev of trace || []) {
    if (!groups.has(ev.platform)) groups.set(ev.platform, []);
    groups.get(ev.platform).push(ev);
  }
  const body = groups.size
    ? [...groups].map(([platform, evs]) => h('div', { class: 'trail-group' },
      h('div', { class: 'trail-title' }, icon('database', 'icon-sm'), PLATFORM[platform] || platform, h('span', { class: 'faint', style: { fontWeight: 400 } }, `${evs.length} lookup${evs.length === 1 ? '' : 's'}`)),
      evs.map((ev) => h('div', { class: 'trail-row' },
        h('div', null, ACTION_LABEL[ev.action] || humanize(ev.action), h('span', { class: 'ep' }, ev.endpoint)),
        ev.result_count ? h('span', { class: 'badge badge-success' }, icon('check'), `${ev.result_count} found`) : h('span', { class: 'badge badge-quiet' }, icon('circle-dash'), 'No match'),
        h('span', { class: 'faint num', style: { fontSize: 'var(--fs-xs)', minWidth: '44px', textAlign: 'right' } }, fmtMs(ev.ms))))))
    : h('p', { class: 'muted' }, 'No records were looked up for this ticket.');
  return h('details', { class: 'section', open: true }, h('summary', null, icon('database'), 'Data trail', h('span', { class: 'faint', style: { fontWeight: 400 } }, `${(trace || []).length} lookups`), icon('chev-down', 'chev')), h('div', { class: 'section-body' }, body));
}

export function decisionBlock(d) {
  const dec = d.bundle.decision || {};
  const model = d.bundle.model;
  const info = model?.info || {};
  const notes = model?.notes || {};
  const modelLine = model ? (notes.used ? `${info.model} · ${fmtMs(info.ms)} · read as “${humanize(notes.intent || '')}”, safety ${notes.safety}` : `Model unavailable (${info.error || 'no reading'}); regex reader used`) : 'Local model was not used for this ticket';
  return h('details', { class: 'section', open: true }, h('summary', null, icon('layers'), 'Decision', icon('chev-down', 'chev')),
    h('div', { class: 'section-body' }, h('dl', { class: 'kv' },
      h('dt', null, 'Rule'), h('dd', { class: 'mono' }, dec.rule),
      h('dt', null, 'Why'), h('dd', null, dec.why),
      dec.act_by && [h('dt', null, 'Acts'), h('dd', null, dec.act_by)],
      d.row.reason_tag && [h('dt', null, 'Reason'), h('dd', null, humanize(d.row.reason_tag))],
      h('dt', null, 'Reader'), h('dd', null, modelLine),
      d.bundle.advisory && [h('dt', null, 'Advisory'), h('dd', null, d.bundle.advisory)],
      d.bundle.error && [h('dt', null, 'Error'), h('dd', { style: { color: 'var(--danger)' } }, d.bundle.error)])));
}

export function pipelineTimeline(stages) {
  return h('details', { class: 'section' }, h('summary', null, icon('run'), 'Pipeline timeline', h('span', { class: 'faint', style: { fontWeight: 400 } }, `${(stages || []).length} stages`), icon('chev-down', 'chev')),
    h('div', { class: 'section-body' }, h('ol', { class: 'timeline' }, (stages || []).map((s, i) =>
      h('li', { class: 'tl-item' }, h('span', { class: 'tl-dot' }, i + 1),
        h('div', null, h('div', { class: 'tl-name' }, humanize(s.name), h('span', { class: 'mod' }, s.module)), h('div', { class: 'tl-sum' }, s.summary)))))));
}

export function emptyState({ iconName = 'inbox', title, text, action }) {
  return h('div', { class: 'empty' }, h('div', { class: 'icon-wrap' }, icon(iconName, 'icon-lg')), h('h2', null, title), text && h('p', null, text), action);
}

export { mount };
