// Inbox left and middle panes: the queue list, one message row per thread, and the "While you were away" card.
import { h, icon, fmtInt } from '../../lib.js';
import { badge, outcomeBadge, riskBadges, contactBadge, chip, avatar } from '../badges.js';
import { maskSensitive, listTime } from './format.js';

export const QUEUE_ICONS = {
  needs_reply: 'reply', needs_action: 'circle-alert', escalated: 'escalations', returned: 'arrow-left', waiting_approver: 'approver',
  waiting_vendor: 'clock', scheduled: 'calendar', sent: 'send', closed: 'circle-check',
};
export const QUEUE_LABELS = {
  needs_reply: 'Needs reply', needs_action: 'Needs action', escalated: 'Escalated', returned: 'Returned to me',
  waiting_approver: 'Waiting on approver', waiting_vendor: 'Waiting on vendor', scheduled: 'Scheduled', sent: 'Sent', closed: 'Closed',
};
// Queues that are work to do: their counts read as a call to act. The rest are folders.
const WORK = new Set(['needs_reply', 'needs_action', 'escalated', 'returned']);

/** wsQueues({ queues, selected, onSelect, loading }) - the folder list (a nav of buttons, with counts). */
export function wsQueues({ queues = [], selected, loading = false, onSelect } = {}) {
  if (loading && !queues.length) {
    return h('div', { class: 'ws-queues', role: 'status', 'aria-label': 'Loading queues' },
      Object.keys(QUEUE_LABELS).map(() => h('div', { class: 'ws-queue is-skeleton' }, h('span', { class: 'c-skeleton', style: { width: '70%', height: '10px' } }))));
  }
  const groups = [queues.filter((q) => WORK.has(q.id)), queues.filter((q) => !WORK.has(q.id))];
  return h('nav', { class: 'ws-queues', 'aria-label': 'Queues' },
    groups.map((list, gi) => h('ul', { class: `ws-queue-group${gi ? ' is-folders' : ''}` }, list.map((q) => h('li', null,
      h('button', {
        class: 'ws-queue', type: 'button', 'aria-current': q.id === selected ? 'true' : null, dataset: { queue: q.id },
        'aria-label': `${q.label}, ${q.count} ${q.count === 1 ? 'thread' : 'threads'}`, onclick: () => onSelect?.(q.id),
      },
      icon(QUEUE_ICONS[q.id] || 'inbox'),
      h('span', { class: 'ws-queue-label' }, q.label),
      h('span', { class: `ws-queue-count${WORK.has(q.id) && q.count ? ' is-work' : ''}`, dataset: { count: q.id } }, q.count ? fmtInt(q.count) : '')))))));
}

/** A small select for narrow screens, where the folder list does not fit beside the messages. */
export function wsQueuePicker({ queues = [], selected, onSelect } = {}) {
  const sel = h('select', { class: 'c-input c-select ws-queue-select', 'aria-label': 'Queue', onchange: (e) => onSelect?.(e.target.value) },
    queues.map((q) => h('option', { value: q.id, selected: q.id === selected ? true : null }, `${q.label}${q.count ? ` (${q.count})` : ''}`)));
  return sel;
}

/**
 * wsMessageRow(row, { selected, opened, selectMode, checked, onOpen, onCheck, href }) - one thread, Outlook style.
 * Sender and company, time, subject, snippet, the Zendesk id and source, outcome, risks and the verified-sender badge.
 */
export function wsMessageRow(r, { selected = false, opened = false, selectMode = false, checked = false, onCheck, href, onOpen, isNew = false } = {}) {
  const unread = !opened && r.review_state === 'pending' && r.workflow_state !== 'sent';
  const source = r.source === 'Conductor: Direct' ? 'Conductor: Direct' : 'Outlook';
  const label = `${r.from_name || r.from_email || 'Unknown sender'}${r.company ? `, ${r.company}` : ''}. ${r.subject || 'No subject'}. ${r.reading ? 'Reading' : ''}`;
  const status = r.reading
    ? h('span', { class: 'c-reading ws-row-reading' }, h('span', { class: 'c-spinner', 'aria-hidden': 'true' }), h('span', null, 'Reading…'))
    : rowStatus(r);
  const el = h('li', {
    class: ['ws-row', selected && 'is-selected', unread && 'is-unread', r.reading && 'is-reading', isNew && 'is-new', checked && 'is-checked'].filter(Boolean).join(' '),
    dataset: { id: r.ticket_id },
  },
  selectMode ? h('label', { class: 'ws-row-check' },
    h('input', { type: 'checkbox', class: 'c-check-input', checked: checked || null, 'aria-label': `Select #${r.ticket_id}`, onchange: (e) => onCheck?.(r, e.target.checked) }),
    h('span', { class: 'c-check-box', 'aria-hidden': 'true' }, icon('check'))) : null,
  h('a', {
    class: 'ws-row-link', href, role: 'option', 'aria-selected': String(selected), tabindex: selected ? '0' : '-1', 'aria-label': label,
    onclick: (e) => { if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return; e.preventDefault(); onOpen?.(r, e); },
  },
  avatar({ name: r.from_name || r.from_email || '?', size: 'sm' }),
  h('span', { class: 'ws-row-main' },
    h('span', { class: 'ws-row-line' },
      h('span', { class: 'ws-row-from' }, r.from_name || r.from_email || 'Unknown sender'),
      r.company ? h('span', { class: 'ws-row-company' }, r.company) : null,
      h('time', { class: 'ws-row-time', datetime: r.received_at || null }, listTime(r.received_at))),
    h('span', { class: 'ws-row-line' },
      h('span', { class: 'ws-row-subject' }, r.subject || 'No subject'),
      h('span', { class: 'ws-row-id mono', title: `Zendesk ticket #${r.ticket_id}` }, `#${r.ticket_id}`)),
    h('span', { class: 'ws-row-snippet' }, maskSensitive(r.snippet || '', r.invoice_refs)),
    h('span', { class: 'ws-row-badges' },
      status,
      ...riskBadges(r.flags || []),
      r.reading ? null : contactBadge(r.sender_verified),
      h('span', { class: `ws-source${source === 'Outlook' ? '' : ' is-direct'}`, title: `Arrived through ${source}` }, icon(source === 'Outlook' ? 'mail' : 'building'), source),
      r.group_size > 1 ? chip({ label: `${r.group_size} in group`, icon: 'link', title: 'Same invoice or a follow-up of another thread' }) : null))));
  return el;
}

function rowStatus(r) {
  if (r.review_state === 'sent' || r.workflow_state === 'sent') return badge({ label: 'Sent', tone: 'settled', icon: 'send' });
  if (r.workflow_state === 'signoff_requested') return badge({ label: 'Sign-off requested', tone: 'waiting', icon: 'escalations' });
  if (r.workflow_state === 'escalated') return badge({ label: 'Escalated', tone: 'waiting', icon: 'escalations' });
  if (r.workflow_state === 'signed_off') return badge({ label: 'Signed off', tone: 'scheduled', icon: 'circle-check' });
  if (r.workflow_state === 'returned') return badge({ label: 'Returned', tone: 'waiting', icon: 'arrow-left' });
  if (r.review_state === 'approved') return badge({ label: 'Approved', tone: 'scheduled', icon: 'check' });
  if (['acknowledged', 'closed'].includes(r.review_state) || ['decided', 'closed'].includes(r.workflow_state)) return badge({ label: 'Closed', tone: 'neutral', icon: 'circle-check' });
  return outcomeBadge(r.outcome);
}

/** The "While you were away" card: what Conductor read before this person opened the inbox. */
export function wsAwayCard(s, { onDismiss, onOpenQueue } = {}) {
  const part = (n, label, queue) => h('button', { class: 'ws-away-fig', type: 'button', onclick: () => onOpenQueue?.(queue) },
    h('span', { class: 'ws-away-n' }, fmtInt(n)), h('span', { class: 'ws-away-l' }, label));
  return h('section', { class: 'ws-away', 'aria-labelledby': 'ws-away-title' },
    h('div', { class: 'ws-away-head' },
      h('h2', { class: 'ws-away-title', id: 'ws-away-title' }, 'While you were away'),
      h('button', { class: 'c-btn c-btn-quiet c-btn-icon c-btn-sm', type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss', onclick: onDismiss }, icon('x'))),
    h('p', { class: 'ws-away-text' }, `Conductor read ${fmtInt(s.read)} emails from Zendesk and Outlook.`),
    h('div', { class: 'ws-away-figs' },
      part(s.drafts_ready, s.drafts_ready === 1 ? 'draft ready' : 'drafts ready', 'needs_reply'),
      part(s.action_needed, 'need action', 'needs_action'),
      part(s.no_reply, 'need no reply', 'closed')),
    s.held_back ? h('p', { class: 'ws-away-foot' }, icon('clock'), `${s.held_back} more ${s.held_back === 1 ? 'email is' : 'emails are'} still arriving.`) : null);
}
