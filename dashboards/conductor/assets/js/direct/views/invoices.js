// Home: the vendor's own invoices, with search and a status filter.
// Client rule: no totals, no counts across invoices and no aggregate figures anywhere on this page.
import { h, debounce } from '../../lib.js';
import { field, button, empty, notice } from '../../components/index.js';
import * as direct from '../../api-direct.js';
import { STATUS_FILTERS, statusFilterLabel } from '../format.js';
import { format } from '../routes.js';
import { pageHead } from '../components/page.js';
import { invoiceList, invoiceListSkeleton } from '../components/invoice-list.js';

const PAGE = 25;

export function mount(root, { route, ctx }) {
  let q = route.query.q || '';
  let status = STATUS_FILTERS.some((s) => s.value === route.query.status) ? route.query.status : '';
  let rows = [];
  let shown = PAGE;
  let seq = 0;
  let loadedOnce = false;

  const head = pageHead({ title: 'Invoices', sub: 'Check where an invoice stands, straight from our records.' });

  const search = field({
    label: 'Search by invoice number', type: 'search', value: q, placeholder: 'INV-3181', prefix: 'search',
    attrs: { autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search', inputmode: 'search' },
    onInput: (e) => { q = e.target.value.trim(); sync(); debounced(); },
  });
  search.classList.add('dx-search');
  search.control.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.control.value) { e.preventDefault(); search.control.value = ''; q = ''; sync(); debounced.cancel(); load(); }
    if (e.key === 'Enter') { e.preventDefault(); debounced.cancel(); load(); }
  });
  const filter = field({
    label: 'Status', type: 'select', value: status, options: STATUS_FILTERS,
    onChange: (e) => { status = e.target.value; sync(); load(); },
  });
  filter.classList.add('dx-filter');

  const resultLine = h('p', { class: 'dx-result', role: 'status', 'aria-live': 'polite' });
  const listSlot = h('div', { class: 'dx-list-slot' }, invoiceListSkeleton());
  const more = h('div', { class: 'dx-more' });
  const source = h('p', { class: 'dx-source' });

  // The W-9 reminder comes from me(); it slots in above the toolbar when that answer arrives.
  const w9Slot = h('div', { class: 'dx-w9-slot' });
  function showW9(me) {
    const w9 = me?.w9;
    if (!w9 || (w9.status !== 'missing' && w9.status !== 'expired')) { w9Slot.replaceChildren(); return; }
    w9Slot.replaceChildren(notice({
      tone: 'waiting',
      title: w9.status === 'expired' ? 'Please send us an updated W-9' : 'We need a W-9 from you',
      text: 'Upload a signed W-9 form as a PDF. It takes a minute.',
      actions: button({ label: 'Upload W-9', icon: 'upload', size: 'sm', variant: 'secondary', href: format({ section: 'documents' }) }),
    }));
  }
  if (ctx.me) showW9(ctx.me); else ctx.mePromise?.then(showW9);

  root.replaceChildren(h('div', { class: 'dx-page dx-home' },
    head, w9Slot,
    h('div', { class: 'dx-toolbar', role: 'search', 'aria-label': 'Find an invoice' }, search, filter),
    resultLine, listSlot, more, source));

  const debounced = debounce(() => load(), 220);

  function sync() {
    const hash = format({ section: 'invoices', query: { q, status } });
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function describe() {
    const parts = [];
    if (q) parts.push(`matching “${q}”`);
    if (status) parts.push(`with the status ${statusFilterLabel(status)}`);
    return parts.length ? `Showing invoices ${parts.join(' ')}.` : '';
  }

  function clearAll() {
    q = ''; status = '';
    search.control.value = ''; filter.control.value = '';
    sync(); load();
    search.control.focus();
  }

  function render() {
    listSlot.removeAttribute('aria-busy');
    listSlot.classList.remove('is-refreshing');
    if (!rows.length) {
      const filtered = q || status;
      listSlot.replaceChildren(h('div', { class: 'dx-panel' }, filtered
        ? empty({
          icon: 'search', title: 'No invoices match.',
          text: q ? 'Check the invoice number, or try part of it, such as the last few digits.' : 'Try another status, or show all invoices.',
          actions: button({ label: 'Clear search', variant: 'secondary', onClick: clearAll }),
        })
        : empty({
          icon: 'file', title: 'No invoices yet.',
          text: 'When we receive an invoice from you, it appears here with its status.',
        })));
      more.replaceChildren();
      resultLine.textContent = filtered ? describe() : '';
      return;
    }
    listSlot.replaceChildren(invoiceList({ rows: rows.slice(0, shown) }));
    resultLine.textContent = describe();
    more.replaceChildren(shown < rows.length
      ? button({ label: 'Show more invoices', variant: 'secondary', icon: 'chev-down', onClick: showMore })
      : null);
  }

  function showMore() {
    const firstNew = shown;
    shown += PAGE;
    render();
    // keep the keyboard where the new invoices begin
    const links = listSlot.querySelectorAll(window.matchMedia('(min-width: 768px)').matches ? '.dx-table .dx-ref' : '.dx-card');
    links[firstNew]?.focus();
  }

  async function load() {
    const mine = ++seq;
    if (loadedOnce) { listSlot.setAttribute('aria-busy', 'true'); listSlot.classList.add('is-refreshing'); }
    try {
      const r = await direct.invoices({ q, status });
      if (mine !== seq) return;
      rows = r.rows || [];
      shown = PAGE;
      loadedOnce = true;
      source.textContent = `Source: Orchestra accounts payable records, updated ${r.updated || ''}`.trim();
      render();
    } catch (e) {
      if (mine !== seq) return;
      listSlot.removeAttribute('aria-busy');
      listSlot.classList.remove('is-refreshing');
      listSlot.replaceChildren(h('div', { class: 'dx-panel' }, empty({
        icon: 'circle-alert', title: "We couldn't load your invoices.",
        text: 'Please try again in a moment.',
        actions: button({ label: 'Try again', icon: 'refresh', onClick: () => load() }),
      })));
    }
  }

  load();

  return {
    heading: head.heading,
    update({ route: next }) {
      const nq = next.query.q || '';
      const ns = STATUS_FILTERS.some((s) => s.value === next.query.status) ? next.query.status : '';
      if (nq === q && ns === status) return;
      q = nq; status = ns;
      search.control.value = q; filter.control.value = status;
      load();
    },
    destroy() { debounced.cancel(); seq += 1; },
  };
}
