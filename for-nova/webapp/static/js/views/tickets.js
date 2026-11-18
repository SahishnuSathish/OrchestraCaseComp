// Tickets view: list + detail. The URL query is the single source of truth for filters, search, sort and the open ticket.
import { h, icon, mount as fill, debounce, isTyping, fmtInt, fmtDate, humanize } from '../lib.js';
import { api } from '../api.js';
import { S, on, viewState, isActive } from '../state.js';
import { href, navigate } from '../router.js';
import { briefCard, originalTicket, dataTrail, decisionBlock, pipelineTimeline, outputBadge, flagBadges, reviewBadge, emptyState, backLink, panel, toast } from '../ui.js';

const PAGE = 200;
const BRIEF_WAIT_MS = 120000;
const SORTS = {
  seq: (a, b) => a.seq - b.seq,
  subject: (a, b) => (a.subject || '').localeCompare(b.subject || ''),
  vendor: (a, b) => (a.vendor || '').localeCompare(b.vendor || ''),
  rule: (a, b) => (a.rule || '').localeCompare(b.rule || ''),
  output: (a, b) => (a.output_type || '').localeCompare(b.output_type || ''),
  review: (a, b) => (a.review_state || '').localeCompare(b.review_state || ''),
};
const SORT_LABELS = { seq: 'Ticket', subject: 'Subject', vendor: 'Vendor', rule: 'Rule', output: 'Output', review: 'Review' };
const OUTPUTS = [['all', 'All'], ['draft_reply', 'Reply'], ['internal_action_note', 'Internal note'], ['no_draft', 'No reply'], ['error', 'Failed']];
const REVIEWS = [['all', 'All states'], ['pending', 'To review'], ['approved', 'Approved'], ['sent', 'Sent'], ['returned', 'Returned'], ['acknowledged', 'Acknowledged'], ['closed', 'Closed']];
const REVIEW_TEXT = { pending: 'To review', approved: 'Approved', sent: 'Sent', returned: 'Returned', acknowledged: 'Acknowledged', closed: 'Closed' };

const mqNarrow = window.matchMedia('(max-width: 900px)'); // window scrolls
const mqReplace = window.matchMedia('(max-width: 1279px)'); // detail replaces the list

// ---------------------------------------------------------------- URL <-> state
function parseState(q = {}) {
  const has = (list, v) => list.some(([k]) => k === v);
  return {
    q: String(q.q || '').trim(),
    output: has(OUTPUTS, q.output) && q.output !== 'all' ? q.output : 'all',
    flagged: String(q.flagged) === '1' || q.flagged === true,
    priority: String(q.priority) === '1' || q.priority === true,
    review: has(REVIEWS, q.review) && q.review !== 'all' ? q.review : 'all',
    sort: SORTS[q.sort] ? q.sort : 'seq',
    dir: q.dir === 'desc' ? -1 : 1,
    from: q.from === 'review' ? 'review' : '',
  };
}
function queryOf(st, { from = false } = {}) {
  return {
    q: st.q || undefined, output: st.output === 'all' ? undefined : st.output, flagged: st.flagged ? 1 : undefined,
    priority: st.priority ? 1 : undefined, review: st.review === 'all' ? undefined : st.review,
    sort: st.sort, dir: st.dir < 0 ? 'desc' : undefined, from: from && st.from ? st.from : undefined,
  };
}
const keyOf = (st) => JSON.stringify(queryOf(st, { from: true }));
const listKeyOf = (st) => JSON.stringify(queryOf(st));

export function mount(root, { route }) {
  const runId = route.runId;
  const state = parseState(route.query);
  let selected = route.ticketId ?? null;
  let limit = PAGE;
  let view = []; // filtered + sorted rows currently shown (all pages)
  const off = [];
  const cache = new Map();
  let detail = null; // { id, data }
  let detailToken = 0;
  const briefBusy = new Map(); // ticket id -> timer
  const briefNote = new Map(); // ticket id -> note text

  const toTicket = (id, opts = {}) => href('tickets', { runId, ticketId: id, query: queryOf(state, opts) });
  const toList = () => href('tickets', { runId, query: queryOf(state) });
  const remember = () => viewState.set(runId, 'tickets', { query: queryOf(state), ticketId: selected });
  const listHidden = () => !!selected && mqReplace.matches;

  // ------------------------------------------------------------------ toolbar
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search id, subject, vendor, rule', 'aria-label': 'Search tickets', autocomplete: 'off', spellcheck: 'false', value: state.q });
  const reviewSel = h('select', { class: 'select tk-select', 'aria-label': 'Filter by review state' }, REVIEWS.map(([v, l]) => h('option', { value: v }, l)));
  const sortSel = h('select', { class: 'select tk-select tk-sort', 'aria-label': 'Sort tickets' }, Object.entries(SORT_LABELS).map(([v, l]) => h('option', { value: v }, l)));
  const dirBtn = h('button', { class: 'btn btn-icon tk-sort tk-dir', type: 'button', onclick: () => commit({ dir: -state.dir }) }, icon('arrow-up'));
  const clearBtn = h('button', { class: 'btn btn-quiet tk-clear', type: 'button', 'aria-label': 'Clear filters', title: 'Clear filters', onclick: clearAll }, icon('filter'), h('span', { class: 'tk-clear-text' }, 'Clear filters'));
  const row1 = h('div', { class: 'tk-row1' }, h('div', { class: 'search tk-search' }, icon('search'), search), reviewSel, sortSel, dirBtn, clearBtn);

  const chipEls = {};
  const mkChip = (key, label, ic, onclick) => {
    const n = h('span', { class: 'chip-count' }, '0');
    const el = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', onclick }, ic ? icon(ic, 'icon-sm') : null, label, n);
    chipEls[key] = { el, n };
    return el;
  };
  const sep = h('span', { class: 'chip-sep', 'aria-hidden': 'true' });
  const chipRow = h('div', { class: 'tk-chips', role: 'group', 'aria-label': 'Filters' },
    ...OUTPUTS.map(([v, l]) => mkChip(v, l, null, () => commit({ output: state.output === v ? 'all' : v }))),
    sep,
    mkChip('flagged', 'Flagged', 'shield-alert', () => commit({ flagged: !state.flagged })),
    mkChip('priority', 'Priority', 'flag', () => commit({ priority: !state.priority })));
  const chipWrap = h('div', { class: 'tk-chips-wrap' }, chipRow);
  const toolbar = h('div', { class: 'tk-toolbar' }, row1, chipWrap);

  function paintFade() {
    const more = chipRow.scrollWidth - chipRow.clientWidth - chipRow.scrollLeft > 2;
    chipWrap.classList.toggle('fade', more);
  }
  chipRow.addEventListener('scroll', paintFade, { passive: true });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(paintFade) : null;
  ro?.observe(chipRow);

  // ------------------------------------------------------------------ table
  const COLS = [
    ['seq', 'Ticket', 'c-id'], ['subject', 'Subject', 'c-subject'], ['vendor', 'Vendor', 'c-vendor'], ['rule', 'Rule', 'c-rule'],
    ['output', 'Output', 'c-output'], [null, 'Flags', 'c-flags'], ['review', 'Review', 'c-review'],
  ];
  const ths = new Map();
  const thead = h('thead', { role: 'rowgroup' }, h('tr', { role: 'row' }, COLS.map(([key, label, cls]) => {
    const th = h('th', { scope: 'col', role: 'columnheader', class: cls }, key
      ? h('button', { type: 'button', onclick: () => commit(state.sort === key ? { dir: -state.dir } : { sort: key, dir: 1 }) }, label, icon('sort'))
      : label);
    if (key) ths.set(key, th);
    return th;
  })));
  const tbody = h('tbody', { role: 'rowgroup' });
  const table = h('table', { class: 'tbl', role: 'table', 'aria-label': 'Tickets' }, thead, tbody);
  const tableWrap = h('div', { class: 'table-wrap' }, table);
  const foot = h('div', { class: 'table-foot', 'aria-live': 'polite' });
  const listPane = h('div', { class: 'list-pane' }, toolbar, tableWrap, foot);
  const detailPane = h('aside', { class: 'detail-pane', 'aria-label': 'Ticket detail' });
  const split = h('div', { class: 'split' }, listPane, detailPane);
  fill(root, h('h1', { class: 'sr-only' }, 'Tickets'), split);

  const rowEls = new Map();

  function filtered() {
    const q = state.q.toLowerCase();
    return S.rows.filter((r) => {
      if (state.output !== 'all' && r.output_type !== state.output) return false;
      if (state.flagged && !(r.flags || []).length) return false;
      if (state.priority && !r.priority) return false;
      if (state.review !== 'all' && r.review_state !== state.review) return false;
      if (q) {
        const hay = `${r.ticket_id} ${r.subject} ${r.vendor} ${r.sender_name} ${r.sender_email} ${r.rule} ${r.reason_tag} ${r.recipient}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => state.dir * SORTS[state.sort](a, b) || a.seq - b.seq);
  }

  const isFiltered = () => !!(state.q || state.output !== 'all' || state.flagged || state.priority || state.review !== 'all');

  function paintControls() {
    const count = (fn) => { let n = 0; for (const r of S.rows) if (fn(r)) n++; return n; };
    for (const [v] of OUTPUTS) {
      const n = v === 'all' ? S.rows.length : count((r) => r.output_type === v);
      const c = chipEls[v];
      c.n.textContent = fmtInt(n);
      c.el.setAttribute('aria-pressed', String(state.output === v));
      c.el.hidden = v === 'error' && n === 0 && state.output !== 'error';
    }
    chipEls.flagged.n.textContent = fmtInt(count((r) => (r.flags || []).length));
    chipEls.flagged.el.setAttribute('aria-pressed', String(state.flagged));
    chipEls.priority.n.textContent = fmtInt(count((r) => r.priority));
    chipEls.priority.el.setAttribute('aria-pressed', String(state.priority));
    reviewSel.value = state.review;
    sortSel.value = state.sort;
    dirBtn.setAttribute('aria-label', state.dir > 0 ? 'Sort ascending. Switch to descending' : 'Sort descending. Switch to ascending');
    dirBtn.title = state.dir > 0 ? 'Ascending' : 'Descending';
    dirBtn.firstElementChild.style.transform = state.dir > 0 ? '' : 'rotate(180deg)';
    clearBtn.hidden = !isFiltered();
    for (const [key, th] of ths) th.setAttribute('aria-sort', state.sort === key ? (state.dir > 0 ? 'ascending' : 'descending') : 'none');
    paintFade();
  }

  function rowEl(r) {
    const sub = [r.sender_name || r.sender_email || ''];
    return h('tr', {
      role: 'row', dataset: { id: r.ticket_id }, 'aria-selected': String(r.ticket_id === selected),
      onclick: (e) => { if (!e.target.closest('a') && !getSelection()?.toString()) choose(r.ticket_id); },
    },
      h('td', { role: 'cell', class: 'id c-id' }, h('a', { href: toTicket(r.ticket_id), 'aria-label': `Open ticket ${r.ticket_id}`, onclick: (e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) { e.preventDefault(); choose(r.ticket_id); } } }, `#${r.ticket_id}`)),
      h('td', { role: 'cell', class: 'c-subject' }, h('div', { class: 'cell-2' },
        h('span', { class: 'a truncate' }, r.subject || '(no subject)'),
        h('span', { class: 'b truncate' }, sub[0], r.vendor ? h('span', { class: 'sub-vendor' }, ` · ${r.vendor}`) : null,
          h('span', { class: 'rv-inline' }, ` · ${r.output_type === 'error' ? 'Failed' : REVIEW_TEXT[r.review_state] || 'To review'}`)))),
      h('td', { role: 'cell', class: 'c-vendor' }, h('span', { class: 'truncate tk-block' }, r.vendor || h('span', { class: 'faint' }, '–'))),
      h('td', { role: 'cell', class: 'c-rule' }, h('div', { class: 'cell-2' }, h('span', { class: 'rule truncate' }, r.rule), r.reason_tag ? h('span', { class: 'b truncate' }, humanize(r.reason_tag)) : null)),
      h('td', { role: 'cell', class: 'c-output' }, outputBadge(r.output_type)),
      h('td', { role: 'cell', class: 'c-flags' }, h('div', { class: 'flags' }, flagBadges(r))),
      h('td', { role: 'cell', class: 'c-review' }, reviewBadge(r)));
  }

  function renderTable() {
    view = filtered();
    const shown = view.slice(0, limit);
    rowEls.clear();
    const kids = shown.map((r) => { const tr = rowEl(r); rowEls.set(r.ticket_id, tr); return tr; });
    if (!view.length) {
      kids.push(h('tr', { role: 'row', class: 'tk-fill' }, h('td', { role: 'cell', colspan: COLS.length, class: 'tk-fill-cell' }, S.rows.length
        ? emptyState({ title: 'No tickets match', text: 'Try a different search or clear the filters.', action: h('button', { class: 'btn', type: 'button', onclick: clearAll }, 'Clear filters') })
        : emptyState({ title: 'No tickets yet', text: 'Tickets appear here as the pipeline finishes them.' }))));
    }
    if (view.length > limit) {
      kids.push(h('tr', { role: 'row', class: 'tk-fill' }, h('td', { role: 'cell', colspan: COLS.length, class: 'tk-fill-cell tk-more' },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { limit += PAGE; renderTable(); } }, `Show ${Math.min(PAGE, view.length - limit)} more`))));
    }
    tbody.replaceChildren(...kids);
    paintFoot();
    paintControls();
    updateBar();
  }

  function paintFoot() {
    const active = isActive(S.run) || S.progress.status === 'running';
    foot.textContent = `${fmtInt(Math.min(view.length, limit))} of ${fmtInt(S.rows.length)} tickets${isFiltered() ? ` (${fmtInt(view.length)} match)` : ''}${active ? ' · run in progress' : ''}`;
  }

  function markSelected({ reveal = false } = {}) {
    for (const [id, tr] of rowEls) tr.setAttribute('aria-selected', String(id === selected));
    if (reveal && selected && !listHidden()) rowEls.get(selected)?.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------------ state changes
  function writeUrl() {
    remember();
    navigate(href('tickets', { runId, ticketId: selected, query: queryOf(state, { from: true }) }), { replace: true });
  }
  function commit(patch) {
    Object.assign(state, patch);
    limit = PAGE;
    renderTable();
    markSelected();
    tableWrap.scrollTop = 0;
    viewState.set(runId, 'tickets', { scrollTop: 0 });
    writeUrl();
  }
  function clearAll() {
    onSearch.cancel();
    search.value = '';
    commit({ q: '', output: 'all', flagged: false, priority: false, review: 'all' });
  }
  function choose(id) {
    state.from = '';
    navigate(toTicket(id));
  }

  const onSearch = debounce(() => { const q = search.value.trim(); if (q !== state.q) commit({ q }); }, 150);
  search.addEventListener('input', onSearch);
  search.addEventListener('search', () => { onSearch.cancel(); const q = search.value.trim(); if (q !== state.q) commit({ q }); });
  reviewSel.addEventListener('change', () => commit({ review: reviewSel.value }));
  sortSel.addEventListener('change', () => commit({ sort: sortSel.value, dir: 1 }));

  // ------------------------------------------------------------------ scroll memory
  let scrollRaf = 0;
  const saveScroll = () => {
    scrollRaf = 0;
    if (listHidden()) return;
    viewState.set(runId, 'tickets', { scrollTop: mqNarrow.matches ? window.scrollY : tableWrap.scrollTop });
  };
  const queueSave = (wide) => () => { if (wide === mqNarrow.matches) return; if (!scrollRaf) scrollRaf = requestAnimationFrame(saveScroll); };
  const onWrapScroll = queueSave(true);
  const onWinScroll = queueSave(false);
  tableWrap.addEventListener('scroll', onWrapScroll, { passive: true });
  window.addEventListener('scroll', onWinScroll, { passive: true });

  function restoreScroll() {
    const vs = viewState.get(runId, 'tickets');
    const y = vs.scrollTop || 0;
    if (mqNarrow.matches) window.scrollTo(0, y); else tableWrap.scrollTop = y;
  }

  // ------------------------------------------------------------------ detail toolbar (persistent so focus survives stepping)
  const backList = backLink({ label: 'All tickets', href: toList() });
  backList.classList.add('tk-back-list');
  const backReview = backLink({ label: 'Back to review', href: '#' });
  backReview.classList.add('tk-back-review');
  const pagerEl = h('span', { class: 'pager', 'aria-live': 'polite' });
  const prevBtn = h('button', { class: 'btn btn-sm btn-icon', type: 'button', 'aria-label': 'Previous ticket', title: 'Previous (K)', onclick: () => step(-1) }, icon('chev-up'));
  const nextBtn = h('button', { class: 'btn btn-sm btn-icon', type: 'button', 'aria-label': 'Next ticket', title: 'Next (J)', onclick: () => step(1) }, icon('chev-down'));
  const closeBtn = h('button', { class: 'btn btn-sm btn-icon tk-close', type: 'button', 'aria-label': 'Close detail', title: 'Close (Esc)', onclick: () => navigate(toList()) }, icon('x'));
  const bar = h('div', { class: 'detail-bar' }, backList, backReview, h('span', { class: 'tk-grow' }), pagerEl, prevBtn, nextBtn, closeBtn);
  const body = h('div', { class: 'detail-inner' });
  detailPane.append(bar, body);

  function updateBar() {
    bar.hidden = !selected;
    if (!selected) return;
    backList.setAttribute('href', toList());
    const rv = state.from === 'review';
    backList.hidden = rv;
    backReview.hidden = !rv;
    backReview.setAttribute('href', href('review', { runId, ticketId: selected, query: viewState.get(runId, 'review').query }));
    const idx = view.findIndex((x) => x.ticket_id === selected);
    pagerEl.textContent = idx >= 0 ? `${fmtInt(idx + 1)} of ${fmtInt(view.length)}` : `${fmtInt(view.length)} shown`;
    prevBtn.disabled = idx === 0 || !view.length;
    nextBtn.disabled = (idx >= 0 && idx >= view.length - 1) || !view.length;
  }

  function step(delta) {
    if (!selected || !view.length) return;
    const i = view.findIndex((x) => x.ticket_id === selected);
    const next = view[i < 0 ? (delta > 0 ? 0 : view.length - 1) : i + delta];
    if (next) navigate(toTicket(next.ticket_id, { from: true }), { replace: true });
  }

  // ------------------------------------------------------------------ detail body
  function showSkeleton() {
    fill(body, h('div', { class: 'detail-head' }, h('div', { class: 'skeleton', style: { height: '22px', width: '40%' } }), h('div', { class: 'skeleton', style: { height: '28px', width: '75%' } })), briefCard({ brief: null }));
  }

  async function loadDetail(id, { refresh = false } = {}) {
    const token = ++detailToken;
    if (!id) { detail = null; fill(body); return; }
    const cached = cache.get(id);
    if (cached && !refresh) renderDetail(cached, { keepScroll: false }); else if (!refresh) showSkeleton();
    if (!refresh) detail = cached ? { id, data: cached } : null;
    try {
      const d = await api.ticket(S.runId, id);
      if (token !== detailToken) return;
      const same = cached && JSON.stringify(cached) === JSON.stringify(d);
      cache.set(id, d);
      if (!same) renderDetail(d, { keepScroll: !!cached || refresh });
    } catch (e) {
      if (token !== detailToken) return;
      cache.delete(id);
      detail = null;
      const missing = e.status === 404;
      fill(body, emptyState({
        iconName: 'circle-alert', title: `Could not load ticket #${id}`,
        text: missing ? 'This ticket is not in this run.' : e.message,
        actions: [
          missing ? null : h('button', { class: 'btn btn-primary', type: 'button', onclick: () => loadDetail(id) }, icon('refresh'), 'Retry'),
          h('a', { class: 'btn', href: state.from === 'review' ? backReview.getAttribute('href') : toList() }, state.from === 'review' ? 'Back to review' : 'All tickets'),
        ],
      }));
    }
  }

  let headMeta = null;
  let briefEl = null;

  function curRow(d) { return { ...d.row, review_state: S.byId.get(d.row.ticket_id)?.review_state ?? d.review?.state ?? d.row.review_state }; }

  function metaBadges(d) {
    const r = curRow(d);
    return [h('span', { class: 'mono' }, `#${r.ticket_id}`), outputBadge(r.output_type), flagBadges(r), reviewBadge(r)];
  }

  function paintBrief() {
    if (!detail) return;
    const d = detail.data, id = detail.id;
    const busy = briefBusy.has(id);
    const next = briefCard({
      brief: d.brief, canRewrite: !!S.model?.usable && !S.run?.model_free, swap: false, busy, note: briefNote.get(id) || null,
      onRewrite: (btn) => rewrite(id, btn),
    });
    if (briefEl?.isConnected) briefEl.replaceWith(next);
    briefEl = next;
  }

  async function rewrite(id, btn) {
    if (briefBusy.has(id)) return;
    briefNote.delete(id);
    briefBusy.set(id, setTimeout(() => {
      briefBusy.delete(id);
      briefNote.set(id, "The local model's version was not used (no answer after 2 minutes). This brief is generated from the records.");
      if (detail?.id === id) paintBrief();
    }, BRIEF_WAIT_MS));
    paintBrief();
    try { await api.regenBrief(S.runId, id); }
    catch (e) {
      clearTimeout(briefBusy.get(id)); briefBusy.delete(id);
      toast({ message: e.message });
      if (detail?.id === id) paintBrief();
    }
  }

  function onBriefEvent(d) {
    const id = d.ticket_id;
    if (!briefBusy.has(id)) { if (id === selected && d.source === 'model') loadDetail(id, { refresh: true }); return; }
    clearTimeout(briefBusy.get(id)); briefBusy.delete(id);
    if (d.kept) briefNote.set(id, `The model's new version was not used (${d.error || 'no reason given'}). The earlier brief written by the model is kept.`);
    else if (d.source === 'model') briefNote.delete(id);
    else briefNote.set(id, `The local model's version was not used (${d.error || 'no reason given'}). This brief is generated from the records.`);
    if (id === selected) { if (d.source === 'model') loadDetail(id, { refresh: true }); else paintBrief(); }
  }

  function outputPanel(d) {
    const dr = d.draft || {};
    const type = dr.output_type || d.row.output_type;
    if (type === 'draft_reply') {
      return panel({
        title: 'Drafted reply', icon: 'mail', class: 'tk-output',
        actions: dr.edited ? h('span', { class: 'badge badge-warning' }, icon('pencil'), 'Edited') : null,
        body: [
          h('dl', { class: 'kv tk-kv' }, h('dt', null, 'To'), h('dd', { class: 'mono' }, dr.to || ''), h('dt', null, 'Subject'), h('dd', null, dr.subject || '')),
          h('div', { class: 'tk-draft-text' }, dr.text || ''),
        ],
      });
    }
    if (type === 'internal_action_note') {
      return panel({
        title: 'Internal note', icon: 'file', class: 'tk-output',
        actions: dr.edited ? h('span', { class: 'badge badge-warning' }, icon('pencil'), 'Edited') : null,
        body: h('div', { class: 'tk-draft-text' }, dr.text || ''),
      });
    }
    const dec = d.bundle?.decision || {};
    const why = type === 'error' ? (d.bundle?.error || d.row.error) : dec.why;
    return panel({
      title: type === 'error' ? 'Pipeline error' : 'No reply drafted', icon: 'circle-dash', class: 'tk-output',
      body: h('dl', { class: 'kv tk-kv' },
        d.row.reason_tag ? [h('dt', null, 'Reason'), h('dd', null, humanize(d.row.reason_tag))] : null,
        why ? [h('dt', null, type === 'error' ? 'Error' : 'Why'), h('dd', null, why)] : null,
        !why && !d.row.reason_tag ? h('dd', { class: 'muted' }, 'No reply is needed for this ticket.') : null),
    });
  }

  function renderDetail(d, { keepScroll }) {
    const r = curRow(d);
    const t = d.ticket;
    detail = { id: r.ticket_id, data: d };
    const canReview = r.output_type === 'draft_reply' || r.output_type === 'internal_action_note';
    headMeta = h('div', { class: 'meta' }, metaBadges(d));
    const prevTop = detailPane.scrollTop;
    briefEl = null;
    const placeholder = h('div');
    fill(body,
      h('div', { class: 'detail-head' },
        h('div', { class: 'tk-head-top' }, headMeta,
          canReview ? h('a', { class: 'btn btn-primary btn-sm tk-open-review', href: href('review', { runId, ticketId: r.ticket_id, query: { from: 'tickets' } }) }, icon('review'), 'Open in Review') : null),
        h('h2', null, t.subject || '(no subject)'),
        h('div', { class: 'meta muted' }, [t.sender_name, r.vendor && `· ${r.vendor}`, t.received_at && `· ${fmtDate(t.received_at)}`].filter(Boolean).join(' '))),
      placeholder, outputPanel(d),
      originalTicket(t), dataTrail(d.bundle.trace), decisionBlock(d), pipelineTimeline(d.bundle.stages));
    briefEl = placeholder;
    paintBrief();
    detailPane.scrollTop = keepScroll ? prevTop : 0;
  }

  // ------------------------------------------------------------------ events
  let raf = 0;
  const later = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const ae = document.activeElement;
      const focusId = ae && tbody.contains(ae) ? ae.closest('tr')?.dataset.id : null;
      renderTable();
      markSelected();
      if (focusId) rowEls.get(Number(focusId))?.querySelector('a')?.focus({ preventScroll: true });
      if (detail && headMeta?.isConnected) headMeta.replaceChildren(...metaBadges(detail.data));
    });
  };
  off.push(on((kind, data) => {
    if (kind === 'ticket' || kind === 'review') later();
    else if (kind === 'progress' || kind === 'run') paintFoot();
    if (kind === 'brief') onBriefEvent(data);
    if (kind === 'model' && detail) paintBrief();
  }));

  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]') || document.documentElement.dataset.drawer === 'open') return;
    if (e.key === '/' && !isTyping(e.target)) { e.preventDefault(); search.focus(); search.select(); return; }
    if (isTyping(e.target)) { if (e.key === 'Escape' && e.target === search) search.blur(); return; }
    if (e.target.closest?.('[role="menu"]')) return;
    if (!selected) return;
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Escape') navigate(toList());
  };
  document.addEventListener('keydown', onKey);

  // ------------------------------------------------------------------ route sync
  function syncSplit() { split.classList.toggle('has-detail', !!selected); }

  paintControls();
  renderTable();
  syncSplit();
  remember();
  if (selected) loadDetail(selected);
  {
    const vs = viewState.get(runId, 'tickets');
    if (!listHidden() && vs.scrollTop && listKeyOf(state) === listKeyOf(parseState(vs.query))) restoreScroll();
  }
  if (selected) markSelected({ reveal: true });

  return {
    update({ route: next }) {
      const ns = parseState(next.query);
      const wasHidden = listHidden();
      const prev = selected;
      selected = next.ticketId ?? null;
      if (keyOf(ns) !== keyOf(state)) {
        onSearch.cancel();
        const qChanged = ns.q !== state.q;
        Object.assign(state, ns);
        limit = PAGE;
        if (qChanged && search.value.trim() !== ns.q) search.value = ns.q;
        renderTable();
      }
      syncSplit();
      markSelected({ reveal: selected !== prev });
      remember();
      updateBar();
      if (selected !== prev) {
        loadDetail(selected);
        detailPane.scrollTop = 0;
        if (selected && mqReplace.matches) window.scrollTo(0, 0);
      }
      if (wasHidden && !listHidden()) restoreScroll();
    },
    destroy() {
      off.forEach((x) => x());
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onWinScroll);
      cancelAnimationFrame(raf);
      cancelAnimationFrame(scrollRaf);
      onSearch.cancel();
      ro?.disconnect();
      for (const t of briefBusy.values()) clearTimeout(t);
    },
  };
}
