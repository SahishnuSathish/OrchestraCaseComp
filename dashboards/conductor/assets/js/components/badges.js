// Badges (read-only status), chips (references and filters), status dots and initials avatars.
// Color means status only: settled (green), scheduled (navy), waiting (peach), risk (crimson). Everything else is neutral.
// A badge always carries words, and an icon where the state matters, so color is never the only signal.
import { h, icon } from '../lib.js';

/** badge({ label, tone, icon, title }) - tone: neutral | settled | scheduled | waiting | risk | info. */
export function badge({ label, tone = 'neutral', icon: iconName, title, solid = false } = {}) {
  return h('span', { class: `c-badge c-badge-${tone}${solid ? ' c-badge-solid' : ''}`, title },
    iconName ? icon(iconName) : null, h('span', null, label));
}

const OUTCOMES = {
  draft_ready: { label: 'Draft ready', tone: 'settled', icon: 'mail-check' },
  action_needed: { label: 'Action needed', tone: 'waiting', icon: 'circle-alert' },
  no_reply: { label: 'No reply needed', tone: 'neutral', icon: 'circle-dash' },
};
/** outcomeBadge('draft_ready' | 'action_needed' | 'no_reply') - the outcome chip on a message row. */
export function outcomeBadge(outcome) {
  const o = OUTCOMES[outcome] || { label: outcome || 'Reading', tone: 'neutral' };
  return badge(o);
}

const RISKS = {
  fraud: { label: 'Fraud', icon: 'shield-alert' },
  legal: { label: 'Legal', icon: 'scale' },
  exec_cc: { label: "Exec cc'd", icon: 'briefcase' },
  injection: { label: 'Unusual content', icon: 'alert' },
  bank_change: { label: 'Bank change', icon: 'shield-alert' },
};
/** riskBadge('fraud' | 'legal' | 'exec_cc' | 'injection' | 'bank_change') */
export function riskBadge(flag) {
  const r = RISKS[flag] || { label: flag, icon: 'alert' };
  return badge({ ...r, tone: 'risk' });
}
/** riskBadges(['fraud', ...]) - several, in a fixed order. */
export function riskBadges(flags = []) {
  return Object.keys(RISKS).filter((f) => flags.includes(f)).map(riskBadge);
}

/** contactBadge(verified) - "Verified contact" (on the vendor's authorized list or an active employee) or "Not on file". */
export function contactBadge(verified) {
  return verified
    ? badge({ label: 'Verified contact', tone: 'settled', icon: 'shield-check', title: 'The sender is an authorized contact on the vendor record' })
    : badge({ label: 'Not on file', tone: 'neutral', icon: 'user-x', title: 'The sender is not an authorized contact on any vendor record' });
}

const PAYMENT = {
  received: { tone: 'neutral', icon: 'mail' },
  pending_approval: { tone: 'waiting', icon: 'clock' },
  approved: { tone: 'scheduled', icon: 'circle-check' },
  scheduled: { tone: 'scheduled', icon: 'calendar' },
  payment_sent: { tone: 'settled', icon: 'send' },
  paid: { tone: 'settled', icon: 'circle-check' },
  under_review: { tone: 'waiting', icon: 'info' },
};
/** statusBadge({ code, label }) - payment status in plain words (Direct codes, CONTRACTS section 9). */
export function statusBadge({ code, label }) {
  const s = PAYMENT[code] || { tone: 'neutral' };
  return badge({ label, ...s });
}

/**
 * chip({ label, icon, count, pressed, onClick, onRemove, removeLabel, title }) - a compact reference or filter.
 * With onClick it is a toggle button (aria-pressed when `pressed` is given). With onRemove it gets a remove button.
 */
export function chip({ label, icon: iconName, count, pressed, onClick, onRemove, removeLabel, title, tone } = {}) {
  const inner = [iconName ? icon(iconName) : null, h('span', { class: 'c-chip-label' }, label),
    count != null ? h('span', { class: 'c-chip-count' }, count) : null];
  const cls = `c-chip${tone ? ` c-chip-${tone}` : ''}`;
  if (onClick && !onRemove) {
    return h('button', { class: `${cls} is-interactive`, type: 'button', title, onclick: onClick, 'aria-pressed': pressed == null ? null : String(!!pressed) }, ...inner);
  }
  return h('span', { class: cls, title }, ...inner,
    onRemove ? h('button', { class: 'c-chip-remove', type: 'button', 'aria-label': removeLabel || `Remove ${label}`, onclick: onRemove }, icon('x')) : null);
}

function sourceIcon(label) {
  if (/^zendesk/i.test(label)) return 'tickets';
  if (/^payment run/i.test(label)) return 'calendar';
  if (/^outlook/i.test(label)) return 'mail';
  return 'database';
}
/** sourceChip({ label, href, onClick }) - where a fact came from: "NetSuite · bill 50000", "Payment run RUN-2026-11-19", "Zendesk #41249". */
export function sourceChip({ label, href, onClick, title } = {}) {
  const kids = [icon(sourceIcon(label)), h('span', { class: 'c-chip-label' }, label)];
  const t = title || `Source: ${label}`;
  if (href) return h('a', { class: 'c-chip c-chip-source is-interactive', href, title: t }, ...kids);
  if (onClick) return h('button', { class: 'c-chip c-chip-source is-interactive', type: 'button', title: t, onclick: onClick }, ...kids);
  return h('span', { class: 'c-chip c-chip-source', title: t }, ...kids);
}

/** dot({ tone, label, live }) - a status dot with words beside it (label is required: never color alone). */
export function dot({ tone = 'neutral', label, live = false } = {}) {
  return h('span', { class: 'c-dot-label' }, h('span', { class: `c-dot c-dot-${tone}${live ? ' is-live' : ''}`, 'aria-hidden': 'true' }), h('span', null, label));
}

/** initials('Elena Lockhart') -> 'EL'. */
export function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0][1] || '');
  return (first + last).toUpperCase();
}

/** avatar({ name, size, tone, label }) - square initials avatar. size: sm | md | lg. tone: default | chrome | direct. Decorative unless `label`. */
export function avatar({ name, size = 'md', tone = 'default', label = null } = {}) {
  return h('span', {
    class: `c-avatar c-avatar-${size} c-avatar-${tone}`,
    ...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' }),
  }, initials(name));
}
