// Leadership views: small shared helpers (app clock, wording, page head, review state). DOM nodes come from lib.js's h().
// Owner: p3/leadership-ui. Every helper here is plain and reusable; nothing calls fetch.
import { h, icon } from '../../lib.js';
import { badge } from '../badges.js';
import { mark } from '../marks.js';

// ---------------------------------------------------------------------------- the app clock
// The product runs on the snapshot date, Friday Nov 13, 2026, with the real time of day (CONTRACTS section 4).
// Ages and "since" figures read this, never the browser's own date.
export function appNow() {
  const d = new Date();
  d.setFullYear(2026, 10, 13);
  return d;
}
export const APP_TODAY = '2026-11-13';

function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  const s = String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "just now", "14 min", "3 h", "8 days" - how long ago, against the app clock. */
export function ago(v) {
  const d = toDate(v);
  if (!d) return '';
  const s = Math.max(0, (appNow() - d) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.floor(s / 86400);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
/** Whole days between a date and the app's today. */
export function daysSince(v) {
  const d = toDate(v);
  if (!d) return null;
  return Math.max(0, Math.floor((appNow() - d) / 86400000));
}
/** "Nov 5" (adds the year when it is not 2026). */
export function fmtDay(v, { year = false } = {}) {
  const d = toDate(v);
  if (!d) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(year || d.getFullYear() !== 2026 ? { year: 'numeric' } : {}) });
}
/** "Nov 13, 10:42" */
export function fmtWhen(v) {
  const d = toDate(v);
  if (!d) return '';
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}
/** "10:42" */
export function fmtTime(v) {
  const d = toDate(v);
  return d ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
}
/** A server timestamp taken from the real clock (epoch seconds), moved onto the app's calendar so dates agree. */
export function onAppCalendar(epochSec) {
  if (!epochSec) return null;
  return new Date(epochSec * 1000 + (appNow() - Date.now()));
}

/** <time> element with a full date in its title. */
export function timeEl(v, text) {
  const d = toDate(v);
  return h('time', { datetime: d ? d.toISOString() : null, title: d ? d.toLocaleString('en-US') : null }, text ?? fmtWhen(v));
}

// ---------------------------------------------------------------------------- people
const STAFF_NAMES = {
  'ulla.abernathy@orchestra-mock.example': 'Ulla Abernathy',
  'omar.calloway@orchestra-mock.example': 'Omar Calloway',
  'elena.lockhart@orchestra-mock.example': 'Elena Lockhart',
};
/** A person's name from their work email ("ben.merriweather@..." -> "Ben Merriweather"). */
export function nameOf(email) {
  if (!email) return '';
  const e = String(email).toLowerCase();
  if (STAFF_NAMES[e]) return STAFF_NAMES[e];
  const local = e.split('@')[0];
  if (!/^[a-z]+(\.[a-z]+)+$/.test(local)) return email;
  return local.split('.').map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
}
export const firstName = (nameOrEmail) => String(nameOf(nameOrEmail) || nameOrEmail || '').split(' ')[0];

// ---------------------------------------------------------------------------- wording
export const REASONS = {
  legal: 'Legal threat', exec: 'Executive copied', fraud: 'Fraud', bank_change: 'Bank change', returned: 'Returned payment',
  early_payment: 'Early payment', late_fee: 'Late fee', conflict: 'Record conflict', other: 'Other', signoff: 'Sign-off requested',
};
export const CATEGORIES = {
  priority: 'Priority reply', fraud: 'Fraud or bank change', returned: 'Returned payment', early_or_late_fee: 'Early payment or late fee',
};
export const STATES = {
  open: 'Open', escalated: 'Escalated', signoff_requested: 'Sign-off requested', returned: 'Returned with guidance',
  signed_off: 'Signed off', decided: 'Decided', sent: 'Sent', closed: 'Closed',
};

/** The state badge for a workflow state. */
export function stateBadge(state) {
  const map = {
    escalated: { tone: 'waiting', icon: 'escalations' }, signoff_requested: { tone: 'waiting', icon: 'clock' },
    returned: { tone: 'neutral', icon: 'arrow-left' }, signed_off: { tone: 'settled', icon: 'circle-check' },
    decided: { tone: 'settled', icon: 'circle-check' }, sent: { tone: 'settled', icon: 'send' }, closed: { tone: 'neutral', icon: 'circle-dash' },
    open: { tone: 'neutral', icon: 'circle-dash' },
  };
  const m = map[state] || map.open;
  return badge({ label: STATES[state] || state || 'Open', ...m });
}

const REVIEW = {
  pending: { label: 'To review', tone: 'neutral', icon: 'circle-dash' },
  approved: { label: 'Approved', tone: 'scheduled', icon: 'circle-check' },
  skipped: { label: 'Skipped', tone: 'neutral', icon: 'x' },
  sent: { label: 'Sent', tone: 'settled', icon: 'send' },
};
/** Review state of an outbound item (notice, digest, W-9 request, chase). */
export function reviewBadge(state) { return badge(REVIEW[state] || REVIEW.pending); }

export const plural = (n, one, many = `${one}s`) => `${Number(n || 0).toLocaleString('en-US')} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------- page head
/**
 * pageHead({ title, lede, actions, product, meta }) - the top of a leadership page: a display title, one plain line
 * about what the page is for, and the page's own actions. Every leadership page uses it inside the standard `.page`
 * container, so the title's left edge is the same everywhere. `product: 'ahead'` adds a small brand line above the
 * title (never beside it). `meta` is the quiet line under the lede, for example dataAsOf(). `meta` may be a node.
 */
export function pageHead({ title, lede, actions, product, meta, id } = {}) {
  const brand = product === 'ahead' ? 'Conductor: Ahead' : product === 'direct' ? 'Conductor: Direct' : null;
  return h('header', { class: `lv-head${product ? ` lv-head-${product}` : ''}` },
    h('div', { class: 'lv-head-main' },
      h('div', { class: 'lv-head-titles' },
        brand ? h('p', { class: 'lv-eyebrow' }, mark({ product, size: 20 }), h('span', null, brand)) : null,
        h('h1', { class: 'lv-title', id }, title),
        lede ? h('p', { class: 'lv-lede' }, lede) : null,
        meta ? (meta instanceof Node ? meta : h('p', { class: 'lv-meta' }, meta)) : null)),
    actions ? h('div', { class: 'lv-head-actions' }, actions) : null);
}

/** "Data as of Nov 13, 10:49 AM": the one freshness line by a page title (the app clock when no time is given). */
export function dataAsOf(at) {
  return `Data as of ${fmtWhen(at || appNow())}`;
}

// A source the server sends is shown as given, except the old blanket "practice data, snapshot" wording: the page's
// "Data as of" line carries that once, by the title.
const GENERIC_SOURCE = /practice data|snapshot/i;
/** The source text worth showing, or null. */
export function sourceText(text) {
  const t = String(text || '').trim();
  return t && !GENERIC_SOURCE.test(t) ? t : null;
}

/** A small "where this number came from" line: "Source: past replies in Zendesk", or "Since this morning" as is. */
export function sourceLine(text) {
  const t = sourceText(text);
  if (!t) return null;
  const shown = /^(source:|since\b)/i.test(t) ? t[0].toUpperCase() + t.slice(1) : `Source: ${t}`;
  return h('p', { class: 'lv-source' }, icon('database', 'icon-sm'), h('span', null, shown));
}

/** A labelled key/value list. rows: [[label, value], ...] (null rows are skipped). */
export function kv(rows, cls = '') {
  return h('dl', { class: `lv-kv ${cls}`.trim() }, rows.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v ?? '')]));
}

/** Errors in plain words. */
export function errText(e, fallback = 'Something went wrong. Try again.') {
  if (!e) return fallback;
  if (e.status === 403) return 'You don’t have access to that.';
  return e.message || fallback;
}

/** A section heading with an optional count and actions. */
export function sectionHead({ title, count, sub, actions, id, level = 2 } = {}) {
  return h('div', { class: 'lv-section-head' },
    h('div', { class: 'lv-section-titles' },
      h(`h${level}`, { class: 'lv-section-title', id }, title, count != null ? h('span', { class: 'lv-count' }, count) : null),
      sub ? h('p', { class: 'lv-section-sub' }, sub) : null),
    actions ? h('div', { class: 'lv-section-actions' }, actions) : null);
}

/** A polite live region a view can speak through. */
export function liveRegion() {
  return h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
}
export function say(region, text) {
  if (!region) return;
  region.textContent = '';
  setTimeout(() => { region.textContent = text; }, 30);
}
