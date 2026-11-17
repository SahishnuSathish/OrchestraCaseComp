// Tickets view: every processed ticket with its brief, data trail, decision and pipeline timeline.
import { h, icon, mount as fill, go, debounce, isTyping, fmtInt, fmtDate, domainOf, humanize } from '../lib.js';
import { api } from '../api.js';
import { S, on } from '../state.js';
import { briefCard, originalTicket, dataTrail, decisionBlock, pipelineTimeline, outputBadge, flagBadges, reviewBadge, emptyState, toast } from '../ui.js';

const PAGE = 200;
const SORTS = {
  seq: (a, b) => a.seq - b.seq,
  subject: (a, b) => (a.subject || '').localeCompare(b.subject || ''),
  vendor: (a, b) => (a.vendor || '').localeCompare(b.vendor || ''),
  rule: (a, b) => (a.rule || '').localeCompare(b.rule || ''),
  output: (a, b) => (a.output_type || '').localeCompare(b.output_type || ''),
  review: (a, b) => (a.review_state || '').localeCompare(b.review_state || ''),
};
const OUTPUTS = [['all', 'All'], ['draft_reply', 'Reply'], ['internal_action_note', 'Internal note'], ['no_draft', 'No reply']];

export function mount(root, params) {
  if (!S.runId) {
    fill(root, h('div', { class: 'page' }, emptyState({
      iconName: 'tickets', title: 'No run open', text: 'Run the pipeline on a dataset, or open a recent run, to see its tickets here.',
      action: h('button', { class: 'btn btn-primary', type: 'button', onclick: () => go('#/run') }, icon('run'), 'Go to Run'),
    })));
    return {};
  }

  const f = { q: '', output: 'all', flagged: false, priority: false, review: 'all' };
  const sort = { key: 'seq', dir: 1 };
  let limit = PAGE;
  let selected = params.id;
  const cache = new Map();
  let detailToken = 0;
  const off = [];

  // ------------------------------------------------------------------ list pane
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search id, subject, vendor, rule…', 'aria-label': 'Search tickets', autocomplete: 'off' });
  const outputChips = h('div', { class: 'chip-group', role: 'group', 'aria-label': 'Filter by output' });
  const extraChips = h('div', { class: 'chip-group', role: 'group', 'aria-label': 'Other filters' });
  const reviewSel = h('select', { class: 'select', 'aria-label': 'Filter by review state', style: { width: 'auto', minHeight: '28px', fontSize: 'var(--fs-sm)' } },
    [['all', 'Any review state'], ['pending', 'To review'], ['approved', 'Approved'], ['returned', 'Returned']].map(([v, l]) => h('option', { value: v }, l)));
  const toolbar = h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('search'), search), outputChips, extraChips, h('span', { class: 'grow' }), reviewSel);
  const thead = h('thead');
  const tbody = h('tbody');
  const table = h('table', { class: 'tbl' }, thead, tbody);
  const tableWrap = h('div', { class: 'table-wrap' }, table);
  const foot = h('div', { class: 'table-foot', 'aria-live': 'polite' });
  const listPane = h('div', { class: 'list-pane' }, toolbar, tableWrap, foot);
  const detailPane = h('aside', { class: 'detail-pane', 'aria-label': 'Ticket detail' });
  const split = h('div', { class: 'split' }, listPane, detailPane);
  fill(root, split);

  const onSearch = debounce(() => { f.q = search.value.trim().toLowerCase(); limit = PAGE; renderTable(); }, 120);
  search.addEventListener('input', onSearch);
  reviewSel.addEventListener('change', () => { f.review = reviewSel.value; limit = PAGE; renderTable(); });

  function filtered() {
    const q = f.q;
    let rows = S.rows.filter((r) => {
      if (f.output !== 'all' && r.output_type !== f.output) return false;
      if (f.flagged && !(r.flags || []).length) return false;
      if (f.priority && !r.priority) return false;
      if (f.review !== 'all' && r.review_state !== f.review) return false;
      if (q) {
        const hay = `${r.ticket_id} ${r.subject} ${r.vendor} ${r.sender_name} ${r.sender_email} ${r.rule} ${r.reason_tag} ${r.recipient}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    rows = rows.slice().sort((a, b) => sort.dir * SORTS[sort.key](a, b) || a.seq - b.seq);
    return rows;
  }

  function renderChips() {
    const count = (fn) => S.rows.filter(fn).length;
    fill(outputChips, OUTPUTS.map(([v, l]) => {
      const n = v === 'all' ? S.rows.length : count((r) => r.output_type === v);
      return h('button', { class: 'chip', type: 'button', 'aria-pressed': String(f.output === v), onclick: () => { f.output = v; limit = PAGE; renderChips(); renderTable(); } }, l, h('span', { class: 'chip-count' }, fmtInt(n)));
    }));
    fill(extraChips,
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(f.flagged), onclick: () => { f.flagged = !f.flagged; renderChips(); renderTable(); } }, icon('shield-alert', 'icon-sm'), 'Flagged', h('span', { class: 'chip-count' }, count((r) => (r.flags || []).length))),
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(f.priority), onclick: () => { f.priority = !f.priority; renderChips(); renderTable(); } }, icon('flag', 'icon-sm'), 'Priority', h('span', { class: 'chip-count' }, count((r) => r.priority))));
  }

  const COLS = [['seq', 'Ticket', ''], ['subject', 'Subject', ''], ['vendor', 'Vendor', 'hide-md'], ['rule', 'Rule', 'hide-md'], ['output', 'Output', ''], [null, 'Flags', 'hide-sm col-flags'], ['review', 'Review', 'hide-sm']];
  function renderHead() {
    fill(thead, h('tr', null, COLS.map(([key, label, cls]) => h('th', { scope: 'col', class: cls, 'aria-sort': key && sort.key === key ? (sort.dir > 0 ? 'ascending' : 'descending') : null },
      key ? h('button', { type: 'button', onclick: () => { sort.dir = sort.key === key ? -sort.dir : 1; sort.key = key; renderHead(); renderTable(); } }, label, icon('sort')) : label))));
  }

  function renderTable() {
    const rows = filtered();
    const shown = rows.slice(0, limit);
    fill(tbody, shown.map((r) => h('tr', { dataset: { id: r.ticket_id }, 'aria-selected': String(r.ticket_id === selected), onclick: (e) => { if (!e.target.closest('a')) go(`#/tickets/${r.ticket_id}`); } },
      h('td', { class: 'id' }, h('a', { href: `#/tickets/${r.ticket_id}`, 'aria-label': `Open ticket ${r.ticket_id}` }, `#${r.ticket_id}`)),
      h('td', { class: 'col-subject' }, h('div', { class: 'cell-2' }, h('span', { class: 'a truncate' }, r.subject || '(no subject)'), h('span', { class: 'b truncate' }, r.sender_name || r.sender_email || ''))),
      h('td', { class: 'hide-md' }, h('span', { class: 'truncate', style: { display: 'block', maxWidth: '180px' } }, r.vendor || h('span', { class: 'faint' }, '–'))),
      h('td', { class: 'hide-md' }, h('div', { class: 'cell-2' }, h('span', { class: 'rule' }, r.rule), r.reason_tag && h('span', { class: 'b' }, humanize(r.reason_tag)))),
      h('td', null, outputBadge(r.output_type)),
      h('td', { class: 'hide-sm col-flags' }, h('div', { class: 'flags' }, flagBadges(r))),
      h('td', { class: 'hide-sm' }, reviewBadge(r)))));
    if (!rows.length) tbody.append(h('tr', null, h('td', { colspan: COLS.length, style: { height: 'auto' } }, emptyState({ title: S.rows.length ? 'No tickets match' : 'No tickets yet', text: S.rows.length ? 'Try clearing a filter or the search.' : 'Tickets appear here as the pipeline finishes them.' }))));
    if (rows.length > limit) tbody.append(h('tr', null, h('td', { colspan: COLS.length, style: { textAlign: 'center' } }, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { limit += PAGE; renderTable(); } }, `Show ${Math.min(PAGE, rows.length - limit)} more`))));
    foot.textContent = `${fmtInt(rows.length)} of ${fmtInt(S.rows.length)} tickets${S.progress.status === 'running' ? ' · run in progress' : ''}`;
  }

  // ------------------------------------------------------------------ detail pane
  function setSplit() { split.classList.toggle('has-detail', !!selected); }

  async function loadDetail(id, { refresh = false } = {}) {
    if (!id) { fill(detailPane); return; }
    const token = ++detailToken;
    if (!refresh && cache.has(id)) renderDetail(cache.get(id), { swap: false });
    else fill(detailPane, h('div', { class: 'detail-inner' }, h('div', { class: 'skeleton', style: { height: '28px', width: '60%' } }), briefCard({ brief: null })));
    try {
      const d = await api.ticket(S.runId, id);
      cache.set(id, d);
      if (token === detailToken) renderDetail(d, { swap: refresh });
    } catch (e) {
      if (token === detailToken) fill(detailPane, h('div', { class: 'detail-inner' }, emptyState({ iconName: 'circle-alert', title: 'Could not load this ticket', text: e.message })));
    }
  }

  function renderDetail(d, { swap }) {
    const r = { ...d.row, review_state: S.byId.get(d.row.ticket_id)?.review_state ?? d.review.state };
    const t = d.ticket;
    const rows = filtered();
    const idx = rows.findIndex((x) => x.ticket_id === r.ticket_id);
    const canRewrite = !!S.model?.usable;
    const brief = briefCard({
      brief: d.brief, canRewrite, swap,
      onRewrite: async (btn) => {
        btn.disabled = true;
        try { await api.regenBrief(S.runId, r.ticket_id); toast({ message: 'Rewriting the brief with the local model…', duration: 2500 }); }
        catch (e) { toast({ message: e.message }); btn.disabled = false; }
      },
    });
    brief.dataset.slot = 'brief';
    fill(detailPane, h('div', { class: 'detail-inner' },
      h('div', { class: 'detail-nav' },
        h('button', { class: 'btn btn-sm back-only', type: 'button', onclick: () => go('#/tickets') }, icon('chev-left'), 'All tickets'),
        h('span', { style: { flex: 1 } }),
        h('span', { class: 'pager' }, idx >= 0 ? `${idx + 1} of ${rows.length}` : ''),
        h('button', { class: 'btn btn-sm btn-icon', type: 'button', 'aria-label': 'Previous ticket', disabled: idx <= 0, onclick: () => step(-1) }, icon('chev-up')),
        h('button', { class: 'btn btn-sm btn-icon', type: 'button', 'aria-label': 'Next ticket', disabled: idx < 0 || idx >= rows.length - 1, onclick: () => step(1) }, icon('chev-down')),
        h('button', { class: 'btn btn-sm btn-icon hide-narrow', type: 'button', 'aria-label': 'Close detail', onclick: () => go('#/tickets') }, icon('x'))),
      h('div', { class: 'detail-head' },
        h('div', { class: 'meta' }, h('span', { class: 'mono' }, `#${r.ticket_id}`), outputBadge(r.output_type), flagBadges(r), reviewBadge(r)),
        h('h2', null, t.subject || '(no subject)'),
        h('div', { class: 'meta' }, [t.sender_name, r.vendor && `· ${r.vendor}`, t.received_at && `· ${fmtDate(t.received_at)}`].filter(Boolean).join(' '))),
      brief,
      d.draft.output_type === 'draft_reply' || d.draft.output_type === 'internal_action_note'
        ? h('div', { class: 'row-wrap' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => go(`#/review/${r.ticket_id}`) }, icon('review'), d.draft.output_type === 'draft_reply' ? 'Open draft in Review' : 'Open note in Review')) : null,
      originalTicket(t), dataTrail(d.bundle.trace), decisionBlock(d), pipelineTimeline(d.bundle.stages)));
    detailPane.scrollTop = 0;
  }

  function step(delta) {
    const rows = filtered();
    const i = rows.findIndex((x) => x.ticket_id === selected);
    const next = rows[i < 0 ? (delta > 0 ? 0 : rows.length - 1) : i + delta];
    if (next) go(`#/tickets/${next.ticket_id}`);
  }

  // ------------------------------------------------------------------ events
  let raf = 0;
  const later = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { renderChips(); renderTable(); }); };
  off.push(on((kind, data) => {
    if (kind === 'ticket' || kind === 'review') later();
    if (kind === 'brief' && data.ticket_id === selected && data.source === 'model') loadDetail(selected, { refresh: true });
  }));

  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/' && !isTyping(e.target)) { e.preventDefault(); search.focus(); return; }
    if (isTyping(e.target)) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Escape' && selected) go('#/tickets');
  };
  document.addEventListener('keydown', onKey);

  renderHead(); renderChips(); renderTable(); setSplit();
  if (selected) loadDetail(selected);

  return {
    update({ id }) {
      selected = id;
      setSplit();
      for (const tr of tbody.querySelectorAll('tr[data-id]')) tr.setAttribute('aria-selected', String(Number(tr.dataset.id) === selected));
      tbody.querySelector('tr[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
      loadDetail(selected);
    },
    destroy() { off.forEach((x) => x()); document.removeEventListener('keydown', onKey); cancelAnimationFrame(raf); },
  };
}

