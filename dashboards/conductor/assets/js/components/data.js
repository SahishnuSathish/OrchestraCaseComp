// Data display: tables, stat tiles, timelines, skeleton placeholders and empty states.
import { h, icon } from '../lib.js';

const money = new Map();
/** fmtMoney(1234.5, 'USD') -> '$1,234.50'. Always two decimals; render inside .money for tabular figures. */
export function fmtMoney(amount, currency = 'USD') {
  if (amount == null || amount === '' || Number.isNaN(Number(amount))) return '';
  if (!money.has(currency)) {
    try { money.set(currency, new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 })); }
    catch { money.set(currency, new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })); }
  }
  return money.get(currency).format(Number(amount));
}

/**
 * table({ columns, rows, rowKey, caption, dense, selectedKey, onRowClick, empty, rowLabel })
 * column: { key, label, align: 'start' | 'end', kind: 'text' | 'money' | 'mono' | 'num', width, render(row) -> node|string, currencyKey }
 * Rows with onRowClick are focusable and open on Enter. Money columns are right-aligned with tabular figures.
 */
export function table({ columns, rows = [], rowKey = (r, i) => i, caption, dense = false, selectedKey = null, onRowClick, empty, rowLabel, sticky = true } = {}) {
  const head = h('thead', null, h('tr', null, columns.map((c) => h('th', {
    scope: 'col', class: cellClass(c), style: c.width ? { width: typeof c.width === 'number' ? `${c.width}px` : c.width } : null,
  }, c.label))));
  const body = h('tbody', null, rows.map((r, i) => {
    const key = rowKey(r, i);
    const tr = h('tr', {
      class: onRowClick ? 'is-clickable' : null, 'aria-selected': selectedKey != null ? String(key === selectedKey) : null,
      tabindex: onRowClick ? '0' : null, 'aria-label': onRowClick && rowLabel ? rowLabel(r) : null,
      onclick: onRowClick ? (e) => { if (!e.target.closest('a, button, input, select, textarea')) onRowClick(r, e); } : null,
      onkeydown: onRowClick ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(r, e); } : null,
    }, columns.map((c) => h('td', { class: cellClass(c) }, cellValue(c, r))));
    tr.dataset.key = key;
    return tr;
  }));
  const tbl = h('table', { class: `c-table${dense ? ' c-table-dense' : ''}${sticky ? ' c-table-sticky' : ''}` },
    caption ? h('caption', { class: 'sr-only' }, caption) : null, head, body);
  const wrap = h('div', { class: 'c-table-wrap' }, tbl);
  if (!rows.length && empty) wrap.append(empty);
  return wrap;
}
function cellClass(c) {
  const align = c.align || (c.kind === 'money' || c.kind === 'num' ? 'end' : 'start');
  return [`is-${align}`, c.kind === 'money' && 'money', c.kind === 'mono' && 'mono', c.kind === 'num' && 'num'].filter(Boolean).join(' ');
}
function cellValue(c, r) {
  if (c.render) return c.render(r);
  const v = r[c.key];
  if (c.kind === 'money') return fmtMoney(v, (c.currencyKey && r[c.currencyKey]) || 'USD');
  return v == null ? '' : String(v);
}

/**
 * stat({ label, value, unit, context, source, tone, href, icon })
 * A headline number: label on top, the value, one line of context, and where the number came from.
 * tone is for status only (risk | waiting | settled); omit it for an ordinary count.
 */
export function stat({ label, value, unit, context, source, tone, href, icon: iconName } = {}) {
  const kids = [
    h('span', { class: 'c-stat-label' }, iconName ? icon(iconName) : null, h('span', null, label)),
    h('span', { class: 'c-stat-value' }, value, unit ? h('span', { class: 'c-stat-unit' }, unit) : null),
    context ? h('span', { class: 'c-stat-context' }, context) : null,
    source ? h('span', { class: 'c-stat-source' }, source) : null,
  ];
  const cls = `c-stat${tone ? ` c-stat-${tone}` : ''}`;
  return href ? h('a', { class: `${cls} is-interactive`, href }, ...kids) : h('div', { class: cls }, ...kids);
}

/**
 * timeline({ items, label }) - item: { title, at, detail, state: 'done' | 'current' | 'upcoming' | 'risk', actor }
 * A vertical list of steps; finished steps are ticked, the current one is ringed.
 */
export function timeline({ items = [], label = 'Timeline' } = {}) {
  const glyph = { done: 'check', risk: 'alert', current: null, upcoming: null };
  return h('ol', { class: 'c-timeline', 'aria-label': label }, items.map((it) => {
    const state = it.state || 'done';
    return h('li', { class: `c-timeline-item is-${state}`, 'aria-current': state === 'current' ? 'step' : null },
      h('span', { class: 'c-timeline-node', 'aria-hidden': 'true' }, glyph[state] ? icon(glyph[state]) : null),
      h('div', { class: 'c-timeline-body' },
        h('div', { class: 'c-timeline-head' }, h('span', { class: 'c-timeline-title' }, it.title),
          it.at ? h('time', { class: 'c-timeline-at' }, it.at) : null),
        it.actor ? h('div', { class: 'c-timeline-actor' }, it.actor) : null,
        it.detail ? h('div', { class: 'c-timeline-detail' }, it.detail) : null,
        state === 'upcoming' ? h('span', { class: 'sr-only' }, 'Not yet') : null));
  }));
}

/** skeleton({ width, height, label }) - one placeholder block. Static, no shimmer. */
export function skeleton({ width = '100%', height = 12, inline = false } = {}) {
  return h('span', { class: `c-skeleton${inline ? ' is-inline' : ''}`, 'aria-hidden': 'true', style: { width: typeof width === 'number' ? `${width}px` : width, height: `${height}px` } });
}

/** skeletonRows({ rows, avatar, lines, label }) - list placeholders that match a message row's height, so nothing jumps. */
export function skeletonRows({ rows = 6, avatar = true, lines = 2, label = 'Loading' } = {}) {
  const widths = ['62%', '48%', '71%', '55%', '66%', '44%', '58%'];
  return h('div', { class: 'c-skeleton-rows', role: 'status', 'aria-busy': 'true', 'aria-label': label },
    Array.from({ length: rows }, (_, i) => h('div', { class: 'c-skeleton-row' },
      avatar ? skeleton({ width: 28, height: 28 }) : null,
      h('div', { class: 'c-skeleton-lines' },
        skeleton({ width: widths[i % widths.length], height: 12 }),
        lines > 1 ? skeleton({ width: widths[(i + 3) % widths.length], height: 10 }) : null,
        lines > 2 ? skeleton({ width: '35%', height: 10 }) : null),
      skeleton({ width: 44, height: 10 }))));
}

/** skeletonText({ lines, label }) - paragraph placeholder. */
export function skeletonText({ lines = 3, label = 'Loading' } = {}) {
  return h('div', { class: 'c-skeleton-text', role: 'status', 'aria-busy': 'true', 'aria-label': label },
    Array.from({ length: lines }, (_, i) => skeleton({ width: i === lines - 1 ? '58%' : '100%', height: 12 })));
}

/** reading({ text }) - the inline "Conductor is reading…" state while a draft or brief is built. */
export function reading({ text = 'Conductor is reading…' } = {}) {
  return h('div', { class: 'c-reading', role: 'status' }, h('span', { class: 'c-spinner', 'aria-hidden': 'true' }), h('span', null, text));
}

/** empty({ icon, title, text, actions, compact }) - an empty state that says what to do next. */
export function empty({ icon: iconName = 'inbox', title, text, actions = [], compact = false } = {}) {
  return h('div', { class: `c-empty${compact ? ' is-compact' : ''}` },
    h('span', { class: 'c-empty-icon', 'aria-hidden': 'true' }, icon(iconName)),
    h('h2', { class: 'c-empty-title' }, title),
    text ? h('p', { class: 'c-empty-text' }, text) : null,
    [].concat(actions).filter(Boolean).length ? h('div', { class: 'c-empty-actions' }, actions) : null);
}

/** notice({ tone, title, text, actions }) - an inline message strip (info | settled | waiting | risk). */
export function notice({ tone = 'info', title, text, actions, role } = {}) {
  const ic = { info: 'info', settled: 'circle-check', waiting: 'clock', risk: 'alert', neutral: 'info' }[tone] || 'info';
  return h('div', { class: `c-notice c-notice-${tone}`, role: role || (tone === 'risk' ? 'alert' : null) },
    icon(ic), h('div', { class: 'c-notice-body' }, title ? h('strong', null, title) : null, text ? h('span', null, text) : null),
    actions ? h('div', { class: 'c-notice-actions' }, actions) : null);
}
