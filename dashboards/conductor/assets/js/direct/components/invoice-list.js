// invoiceList({ rows }) - the vendor's invoices: a table from 768 px up, stacked cards below.
// Both views are in the DOM; CSS shows one (display: none keeps the other out of the accessibility tree).
// Each invoice number is a real link, so the list works with the keyboard and with back and forward.
// invoiceListSkeleton() is the matching placeholder, the same height as real rows so nothing jumps.
import { h, icon } from '../../lib.js';
import { table, statusBadge, skeleton } from '../../components/index.js';
import { fmtDay, money } from '../format.js';
import { invoiceHref } from '../routes.js';

const balanceCell = (r) => (r.balance == null
  ? h('span', { class: 'dx-na', title: 'Our team will confirm the balance' }, h('span', { 'aria-hidden': 'true' }, '–'), h('span', { class: 'sr-only' }, 'To be confirmed'))
  : money(r.balance, r.currency));

export function invoiceList({ rows = [] } = {}) {
  const tbl = table({
    caption: 'Your invoices',
    sticky: false,
    rowKey: (r) => r.invoice,
    rows,
    columns: [
      { key: 'invoice', label: 'Invoice', render: (r) => h('a', { class: 'dx-ref', href: invoiceHref(r.invoice) }, r.invoice) },
      { key: 'date', label: 'Invoice date', render: (r) => h('span', { class: 'num' }, fmtDay(r.date)) },
      { key: 'amount', label: 'Amount', kind: 'money', render: (r) => money(r.amount, r.currency) },
      { key: 'balance', label: 'Open balance', kind: 'money', render: balanceCell },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
      { key: 'go', label: h('span', { class: 'sr-only' }, 'Open'), width: 40, render: () => icon('chev-right', 'dx-row-chev') },
    ],
  });
  tbl.classList.add('dx-table');
  // A click anywhere on a row opens it; the link inside stays the keyboard target.
  tbl.addEventListener('click', (e) => {
    const tr = e.target.closest('tbody tr');
    if (!tr || e.target.closest('a, button')) return;
    if (window.getSelection()?.toString()) return;
    location.hash = invoiceHref(tr.dataset.key);
  });

  const cards = h('ul', { class: 'dx-cards', 'aria-label': 'Your invoices' }, rows.map((r) => h('li', null,
    h('a', { class: 'dx-card', href: invoiceHref(r.invoice) },
      h('div', { class: 'dx-card-top' },
        h('span', { class: 'dx-card-ref' }, r.invoice),
        h('span', { class: 'dx-card-date num' }, fmtDay(r.date))),
      h('div', { class: 'dx-card-status' }, statusBadge(r.status)),
      h('dl', { class: 'dx-card-figs' },
        h('div', null, h('dt', null, 'Amount'), h('dd', { class: 'money' }, money(r.amount, r.currency))),
        h('div', null, h('dt', null, 'Open balance'), h('dd', { class: 'money' }, balanceCell(r)))),
      icon('chev-right', 'dx-card-chev')))));

  return h('div', { class: 'dx-list' }, tbl, cards);
}

export function invoiceListSkeleton({ rows = 6 } = {}) {
  const w = ['72px', '64px', '80px', '58px', '76px', '68px'];
  const table = h('div', { class: 'dx-skel-table', 'aria-hidden': 'true' },
    h('div', { class: 'dx-skel-head' }),
    Array.from({ length: rows }, (_, i) => h('div', { class: 'dx-skel-row' },
      skeleton({ width: w[i % w.length], height: 12 }), skeleton({ width: 84, height: 12 }),
      skeleton({ width: 74, height: 12 }), skeleton({ width: 74, height: 12 }), skeleton({ width: i % 2 ? 150 : 190, height: 20 }))));
  const cards = h('div', { class: 'dx-skel-cards', 'aria-hidden': 'true' },
    Array.from({ length: Math.min(rows, 4) }, (_, i) => h('div', { class: 'dx-card is-skeleton' },
      h('div', { class: 'dx-card-top' }, skeleton({ width: w[i % w.length], height: 14 }), skeleton({ width: 80, height: 12 })),
      h('div', { class: 'dx-card-status' }, skeleton({ width: i % 2 ? 150 : 210, height: 22 })),
      h('div', { class: 'dx-card-figs' }, h('div', null, skeleton({ width: 50, height: 10 }), skeleton({ width: 84, height: 14 })),
        h('div', null, skeleton({ width: 70, height: 10 }), skeleton({ width: 84, height: 14 }))))));
  return h('div', { class: 'dx-list is-loading', role: 'status', 'aria-busy': 'true', 'aria-label': 'Loading your invoices' }, table, cards);
}
