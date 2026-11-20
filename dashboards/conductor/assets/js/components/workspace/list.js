// Inbox left and middle panes: the queue list, one message row per thread, and the "While you were away" card.
import { h, icon, fmtInt } from '../../lib.js';
import { badge, riskBadges, contactBadge, chip, avatar } from '../badges.js';
import { maskSensitive, listTime, isPriority } from './format.js';

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
 * wsMessageRow(row, { selected, opened, selectMode, checked, onOpen, onCheck, href, queue }) - one thread, Outlook style.
 * Sender and company, time, subject, snippet and the Zendesk id. Chips show only what is out of the ordinary: a state
 * change, a risk, a sender not on file, "Action needed", "Needs sign-off" and web questions from Conductor: Direct.
 * The routine ones ("Draft ready", "Verified contact", "Outlook") stay in the reading pane.
 */
export function wsMessageRow(r, { selected = false, opened = false, selectMode = false, checked = false, onCheck, href, onOpen, isNew = false, queue = null } = {}) {
  const unread = !opened && r.review_state === 'pending' && r.workflow_state !== 'sent';
  const direct = r.source === 'Conductor: Direct';
  const label = `${r.from_name || r.from_email || 'Unknown sender'}${r.company ? `, ${r.company}` : ''}. ${r.subject || 'No subject'}. ${r.reading ? 'Reading' : ''}`;
  const status = r.reading
    ? h('span', { class: 'c-reading ws-row-reading' }, h('span', { class: 'c-spinner', 'aria-hidden': 'true' }), h('span', null, 'Reading…'))
    : rowStatus(r, queue);
  const chips = [
    status,
    ...riskBadges(r.flags || []),
    r.reading || r.sender_verified ? null : contactBadge(false),
    direct ? h('span', { class: 'ws-source is-direct', title: 'Arrived through Conductor: Direct' }, icon('building'), 'Conductor: Direct') : null,
    r.group_size > 1 ? chip({ label: `${r.group_size} in group`, icon: 'link', title: 'Same invoice or a follow-up of another thread' }) : null,
  ].filter(Boolean);
  const el = h('li', {
    role: 'none',
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
      r.company && r.company !== r.from_name ? h('span', { class: 'ws-row-company' }, r.company) : null,
      h('time', { class: 'ws-row-time', datetime: r.received_at || null }, listTime(r.received_at))),
    h('span', { class: 'ws-row-line' },
      h('span', { class: 'ws-row-subject' }, r.subject || 'No subject'),
      h('span', { class: 'ws-row-id mono', title: `Zendesk ticket #${r.ticket_id}` }, `#${r.ticket_id}`)),
    h('span', { class: 'ws-row-snippet' }, maskSensitive(r.snippet || '', r.invoice_refs)),
    chips.length ? h('span', { class: 'ws-row-badges' }, chips) : null)));
  return el;
}

// A row's state chip, or null when the state is the ordinary one for its queue (a draft waiting in Needs reply, a sent
// reply in Sent). Search results span every queue, so they always say where a thread stands.
function rowStatus(r, queue) {
  const here = (q) => queue === q;
  if (r.review_state === 'sent' || r.workflow_state === 'sent') return here('sent') ? null : badge({ label: 'Sent', tone: 'settled', icon: 'send' });
  if (r.workflow_state === 'signoff_requested') return badge({ label: 'Sign-off requested', tone: 'waiting', icon: 'escalations' });
  if (r.workflow_state === 'escalated') return here('escalated') ? null : badge({ label: 'Escalated', tone: 'waiting', icon: 'escalations' });
  if (r.workflow_state === 'signed_off') return badge({ label: 'Signed off', tone: 'scheduled', icon: 'circle-check' });
  if (r.workflow_state === 'returned') return here('returned') ? null : badge({ label: 'Returned', tone: 'waiting', icon: 'arrow-left' });
  if (r.review_state === 'approved') return badge({ label: 'Approved', tone: 'scheduled', icon: 'check' });
  if (['acknowledged', 'closed'].includes(r.review_state) || ['decided', 'closed'].includes(r.workflow_state)) return here('closed') ? null : badge({ label: 'Closed', tone: 'neutral', icon: 'circle-check' });
  if (r.outcome === 'draft_ready' && isPriority(r)) return badge({ label: 'Needs sign-off', tone: 'waiting', icon: 'escalations', title: 'The CFO signs off this reply before it goes out' });
  if (r.outcome === 'action_needed') return badge({ label: 'Action needed', tone: 'waiting', icon: 'circle-alert' });
  return null;
}

/**
 * The "While you were away" card: what Conductor read before this person opened the inbox. card.update(summary) keeps
 * its figures and the "still arriving" line current as new mail comes in, without moving focus.
 */
export function wsAwayCard(s, { onDismiss, onOpenQueue } = {}) {
  const part = (label, queue) => {
    const n = h('span', { class: 'ws-away-n' });
    const l = h('span', { class: 'ws-away-l' });
    const el = h('button', { class: 'ws-away-fig', type: 'button', onclick: () => onOpenQueue?.(queue) }, n, l);
    return { el, set: (count, words) => { n.textContent = fmtInt(count || 0); l.textContent = words(count || 0); } };
  };
  const text = h('p', { class: 'ws-away-text' });
  const drafts = part('drafts ready', 'needs_reply');
  const action = part('need action', 'needs_action');
  const quiet = part('need no reply', 'closed');
  const foot = h('p', { class: 'ws-away-foot', 'aria-live': 'polite' });
  const card = h('section', { class: 'ws-away', 'aria-labelledby': 'ws-away-title' },
    h('div', { class: 'ws-away-head' },
      h('h2', { class: 'ws-away-title', id: 'ws-away-title' }, 'While you were away'),
      h('button', { class: 'c-btn c-btn-quiet c-btn-icon c-btn-sm', type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss', onclick: onDismiss }, icon('x'))),
    text,
    h('div', { class: 'ws-away-figs' }, drafts.el, action.el, quiet.el),
    foot);
  card.update = (x) => {
    text.textContent = `Conductor read ${fmtInt(x.read)} ${x.read === 1 ? 'email' : 'emails'} from Zendesk and Outlook.`;
    drafts.set(x.drafts_ready, (n) => (n === 1 ? 'draft ready' : 'drafts ready'));
    action.set(x.action_needed, () => 'need action');
    quiet.set(x.no_reply, () => 'need no reply');
    const left = x.held_back || 0;
    foot.replaceChildren(icon(left ? 'clock' : 'circle-check'),
      h('span', null, left ? `${left} more ${left === 1 ? 'email is' : 'emails are'} still arriving.` : 'All new email is in.'));
  };
  card.update(s);
  return card;
}
