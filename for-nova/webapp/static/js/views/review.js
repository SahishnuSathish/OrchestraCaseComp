// Review view: the employee's approval queue for drafted replies. Three panes: queue | brief + draft | original ticket.
// The draft is always editable (autosaved). Approving records a decision; Send hands the approved reply to the mail
// adapter on the server (simulated outbox by default, Orchestra's SMTP relay when configured).
import { h, icon, mount as fill, isTyping, fmtInt, domainOf, humanize, relTime, ls } from '../lib.js';
import { api } from '../api.js';
import { S, on, patchRow, emit } from '../state.js';
import { href, navigate } from '../router.js';
import { briefCard, originalTicket, outputBadge, flagBadges, reviewBadge, emptyState, toast, confirmDialog, openDialog } from '../ui.js';

const TABS = [['todo', 'To review'], ['approved', 'Approved'], ['returned', 'Returned'], ['notes', 'Notes']];
const NARROW = () => window.matchMedia('(max-width: 900px)').matches;
const WIDE = () => window.matchMedia('(min-width: 1440px)').matches;
const DONE = ['approved', 'sent', 'acknowledged', 'closed'];

function tabOf(r) {
  if (r.output_type !== 'draft_reply') return 'notes'; // includes tickets the pipeline failed on: a person must handle them
  return r.review_state === 'approved' || r.review_state === 'sent' ? 'approved' : r.review_state === 'returned' ? 'returned' : 'todo';
}
const rank = (r) => ((r.flags || []).length ? 0 : r.priority ? 1 : 2);
const isClean = (r) => r.output_type === 'draft_reply' && r.review_state === 'pending' && !(r.flags || []).length && !r.priority && !r.act_by;

export function mount(root, { route }) {
  const runId = route.runId;
  const toTicket = (id, opts) => navigate(href('review', { runId, ticketId: id }), opts);
  const toQueue = () => navigate(href('review', { runId }));

  let tab = 'todo';
  let selected = route.ticketId ?? null;
  let detail = null;          // current ticket detail (also the cache entry, so local edits survive switching tickets)
  let returning = false;
  let loadToken = 0;
  let originalOpen = ls('ap.orig') !== 'closed';
  const cache = new Map();
  const undo = [];            // { ids, prev: [{tid, state}] }
  const off = [];

  // draft editing
  let textarea = null, subjectInput = null, problemsEl = null;
  let saveState = 'saved';    // saved | unsaved | saving | error
  let problems = [];
  let saveTimer = null;

  // ------------------------------------------------------------------ skeleton
  const progressText = h('span');
  const progressBar = h('div', { class: 'bar-fill' });
  const exportBtn = h('button', { class: 'btn btn-sm', type: 'button', title: 'Export approved, sent and acknowledged results as results.json', onclick: exportResults }, icon('download'), 'Export');
  const tabsEl = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Queue' });
  const listEl = h('div', { class: 'queue-list', role: 'listbox', 'aria-label': 'Tickets in this queue' });
  const bulkSlot = h('div');
  const queue = h('section', { class: 'pane queue', 'aria-label': 'Review queue' },
    h('div', { class: 'queue-top' },
      h('div', { class: 'review-progress' }, progressText, h('div', { class: 'bar' }, progressBar), exportBtn), tabsEl),
    listEl,
    h('div', { class: 'queue-foot' }, bulkSlot,
      h('div', { class: 'hints', 'aria-label': 'Keyboard shortcuts' },
        h('span', null, h('span', { class: 'kbd' }, 'J'), h('span', { class: 'kbd' }, 'K'), 'move'), h('span', null, h('span', { class: 'kbd' }, 'A'), 'approve'),
        h('span', null, h('span', { class: 'kbd' }, 'S'), 'send'), h('span', null, h('span', { class: 'kbd' }, 'E'), 'edit'),
        h('span', null, h('span', { class: 'kbd' }, 'R'), 'return'), h('span', null, h('span', { class: 'kbd' }, 'O'), 'original'), h('span', null, h('span', { class: 'kbd' }, 'Z'), 'undo'))));
  const centerScroll = h('div', { class: 'center-scroll' });
  const returnSlot = h('div');
  const actionSlot = h('div');
  const center = h('section', { class: 'pane center', 'aria-label': 'Draft reply' }, centerScroll, returnSlot, actionSlot);
  const originalEl = h('aside', { class: 'pane original', 'aria-label': 'Original ticket' });
  const review = h('div', { class: `review${originalOpen ? '' : ' orig-closed'}` }, queue, center, originalEl);
  review.dataset.pane = 'draft';
  fill(root, review);

  // ------------------------------------------------------------------ original ticket panel (closable)
  function closeOriginal() {
    if (WIDE()) { originalOpen = false; ls('ap.orig', 'closed'); review.classList.add('orig-closed'); document.querySelector('.show-orig')?.focus(); }
    else { review.dataset.pane = 'draft'; renderCenter(); }
  }
  function openOriginal() {
    if (WIDE()) { originalOpen = true; ls('ap.orig', 'open'); review.classList.remove('orig-closed'); }
    else { review.dataset.pane = 'original'; renderCenter(); }
  }
  const toggleOriginal = () => (WIDE() ? (originalOpen ? closeOriginal() : openOriginal()) : (review.dataset.pane === 'original' ? closeOriginal() : openOriginal()));

  // ------------------------------------------------------------------ queue
  const queueRows = () => S.rows.filter((r) => tabOf(r) === tab).sort((a, b) => rank(a) - rank(b) || a.seq - b.seq);

  function renderQueue() {
    const counts = Object.fromEntries(TABS.map(([k]) => [k, S.rows.filter((r) => tabOf(r) === k).length]));
    fill(tabsEl, TABS.map(([k, label]) => h('button', { class: 'tab', role: 'tab', type: 'button', title: k === 'notes' ? 'Internal notes and tickets with no reply' : k === 'approved' ? 'Approved and sent replies' : null, 'aria-selected': String(k === tab), onclick: () => { tab = k; renderQueue(); selectFirst(); } },
      label, h('span', { class: 'n' }, counts[k]))));
    const drafts = S.rows.filter((r) => r.output_type === 'draft_reply');
    const done = drafts.filter((r) => r.review_state !== 'pending').length;
    fill(progressText);
    progressText.append(h('b', null, `${fmtInt(done)} of ${fmtInt(drafts.length)}`), ' drafts reviewed');
    progressBar.style.transform = `scaleX(${drafts.length ? done / drafts.length : 0})`;

    const rows = queueRows();
    const top = listEl.scrollTop;
    fill(listEl, rows.length ? rows.map((r) => h('button', { class: 'q-item', type: 'button', role: 'option', dataset: { id: r.ticket_id }, 'aria-selected': String(r.ticket_id === selected), 'aria-current': String(r.ticket_id === selected), onclick: () => toTicket(r.ticket_id) },
      h('span', { class: 'q-top' }, h('span', { class: 'id' }, `#${r.ticket_id}`), h('span', { class: 'badges' }, flagBadges(r), tab === 'notes' || tab === 'approved' ? reviewBadge(r) : null)),
      h('span', { class: 'q-subject truncate' }, r.subject || '(no subject)'),
      h('span', { class: 'q-sub truncate' }, r.output_type === 'draft_reply' ? `To ${domainOf(r.recipient) || r.sender_name || 'requester'}${r.reason_tag ? ` · ${humanize(r.reason_tag)}` : ''}` : `${humanize(r.rule)}${r.act_by ? ` · for ${r.act_by.split('@')[0]}` : ''}`))) :
      emptyState({ iconName: tab === 'todo' ? 'circle-check' : 'inbox', title: tab === 'todo' ? 'Nothing left to review' : 'Nothing here', text: tab === 'todo' ? 'Every drafted reply has been approved or returned.' : 'Tickets that land here will be listed.' }));
    listEl.scrollTop = top;

    const clean = S.rows.filter(isClean);
    fill(bulkSlot, tab === 'todo' && clean.length > 1 ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => bulkApprove(clean), title: 'Approve every draft with no flags, no priority and no internal follow-up' }, icon('layers'), `Approve ${clean.length} clean drafts…`) : null);
    exportBtn.disabled = !S.rows.some((r) => DONE.includes(r.review_state));
  }

  function selectFirst() {
    const rows = queueRows();
    if (rows.length && !NARROW()) toTicket(rows[0].ticket_id, { replace: true });
    else if (!rows.length) { selected = null; detail = null; renderCenter(); }
  }

  function step(delta) {
    const rows = queueRows();
    const i = rows.findIndex((r) => r.ticket_id === selected);
    const next = rows[i < 0 ? 0 : i + delta];
    if (next) { flushDraft(); toTicket(next.ticket_id, { replace: true }); }
  }

  // ------------------------------------------------------------------ detail loading
  async function open(id, { quiet = false } = {}) {
    if (!id) { detail = null; renderCenter(); return; }
    const row = S.byId.get(id);
    if (row) { const t = tabOf(row); if (t && t !== tab) { tab = t; renderQueue(); } }
    const token = ++loadToken;
    returning = false; problems = []; saveState = 'saved';
    if (cache.has(id)) { detail = cache.get(id); renderCenter(); }
    else if (!quiet) { detail = null; fill(centerScroll, h('div', { class: 'center-inner' }, h('div', { class: 'skeleton', style: { height: '28px', width: '55%' } }), briefCard({ brief: null }), h('div', { class: 'skeleton', style: { height: '220px' } }))); fill(actionSlot); fill(returnSlot); fill(originalEl); }
    try {
      const d = await api.ticket(S.runId, id);
      if (token !== loadToken) { if (!cache.has(id)) cache.set(id, d); return; }
      cache.set(id, d);
      detail = d;
      renderCenter();
    } catch (e) {
      if (token === loadToken) fill(centerScroll, h('div', { class: 'center-inner' }, emptyState({ iconName: 'circle-alert', title: 'Could not load this ticket', text: e.message })));
    }
  }

  // ------------------------------------------------------------------ center + original
  const currentRow = () => (detail ? S.byId.get(detail.row.ticket_id) || detail.row : null);
  const isReply = () => detail?.draft.output_type === 'draft_reply';
  const isNote = () => detail?.draft.output_type === 'internal_action_note';
  const flaggedNow = () => (currentRow()?.flags || []).length > 0;
  const editableNow = () => isReply() && ['pending', 'returned'].includes(currentRow().review_state) && !flaggedNow();

  function renderCenter() {
    textarea = null; subjectInput = null; problemsEl = null;
    if (!detail) {
      fill(centerScroll, h('div', { class: 'center-inner' }, emptyState({ iconName: 'review', title: S.rows.some((r) => r.output_type === 'draft_reply') ? 'Pick a ticket to review' : 'No drafted replies yet', text: 'Each reply shows a short brief of the issue, where the data came from, and what the requester will be told.' })));
      fill(actionSlot); fill(returnSlot); fill(originalEl);
      return;
    }
    const d = detail, r = currentRow(), t = d.ticket;
    const rows = queueRows();
    const idx = rows.findIndex((x) => x.ticket_id === r.ticket_id);
    const flagged = flaggedNow();
    const injection = d.bundle.decision?.rule === 'injection_suspected';
    const editable = editableNow();

    const brief = briefCard({ brief: d.brief, canRewrite: !!S.model?.usable, onRewrite: async (btn) => { btn.disabled = true; try { await api.regenBrief(S.runId, r.ticket_id); toast({ message: 'Rewriting the brief with the local model…', duration: 2500 }); } catch (e) { toast({ message: e.message }); btn.disabled = false; } } });
    brief.dataset.slot = 'brief';

    const banners = [];
    if (flagged) banners.push(h('div', { class: 'banner banner-danger', role: 'alert' }, icon('shield-alert'), h('div', null, h('strong', null, `Flagged: ${r.flags.map(humanize).join(', ').toLowerCase()}`), h('span', null, 'This ticket cannot be approved or sent from here. A person should confirm with the vendor through a contact already on file.'))));
    if (injection) banners.push(h('div', { class: 'banner banner-warning', role: 'alert' }, icon('alert'), h('div', null, h('strong', null, 'The message contains instructions aimed at an automated system'), h('span', null, 'Read the original before acting.'))));
    if (d.bundle.advisory && !flagged) banners.push(h('div', { class: 'banner banner-warning' }, icon('alert'), h('div', null, h('strong', null, 'Advisory'), h('span', null, d.bundle.advisory))));

    let doc;
    if (isReply()) {
      let metaSubject = h('dd', null, d.draft.subject || '');
      let body;
      if (editable) {
        subjectInput = h('input', { class: 'input subject-input', type: 'text', value: d.draft.subject || '', maxlength: '200', 'aria-label': 'Subject', oninput: onEdit });
        textarea = h('textarea', { class: 'textarea doc-edit', 'aria-label': 'Reply body (editable)', spellcheck: 'true', value: d.draft.text, oninput: onEdit });
        metaSubject = h('dd', null, subjectInput);
        body = textarea;
      } else {
        body = h('div', { class: 'doc-body' }, d.draft.text);
      }
      const edited = d.draft.edited || d.draft.subject_edited;
      doc = h('div', { class: 'doc' },
        h('dl', { class: 'doc-meta' }, h('dt', null, 'To'), h('dd', { class: 'mono' }, d.draft.to || ''), h('dt', null, 'Subject'), metaSubject),
        body,
        h('div', { class: 'doc-foot' },
          editable ? [icon('pencil', 'icon-sm'), 'Click the reply to edit it. Changes save automatically.'] : [icon('send-off', 'icon-sm'), r.review_state === 'sent' ? 'Sent.' : 'Not sent yet.'],
          edited ? h('span', { class: 'badge badge-accent' }, icon('pencil'), 'Edited') : null,
          edited && editable ? h('button', { class: 'link-btn', type: 'button', onclick: resetDraft }, 'Reset to original') : null,
          h('span', { style: { marginLeft: 'auto' }, id: 'save-flag', 'aria-live': 'polite' })));
      problemsEl = h('div', { class: 'banner banner-danger', role: 'alert', hidden: true });
    } else {
      doc = h('div', { class: 'doc' },
        h('div', { class: 'doc-title' }, icon(isNote() ? 'file' : 'circle-dash'), isNote() ? 'Internal action note' : 'No reply drafted', h('span', { class: 'faint', style: { fontWeight: 400 } }, isNote() ? 'Never sent to the requester' : 'Nothing goes to the requester')),
        h('div', { class: 'doc-body' }, d.draft.text || d.bundle.decision?.why || ''));
    }

    fill(centerScroll, h('div', { class: 'center-inner' },
      h('div', { class: 'center-head' },
        h('button', { class: 'btn btn-sm btn-icon back-narrow', type: 'button', 'aria-label': 'Back to queue', onclick: () => { flushDraft(); toQueue(); } }, icon('chev-left')),
        h('div', { class: 'titles' },
          h('h2', null, t.subject || '(no subject)'),
          h('div', { class: 'meta' }, h('span', { class: 'mono' }, `#${r.ticket_id}`), outputBadge(r.output_type), flagBadges(r), reviewBadge(r), h('span', null, [t.sender_name, r.vendor && `· ${r.vendor}`].filter(Boolean).join(' ')))),
        h('div', { class: 'pager' },
          h('button', { class: 'btn btn-sm show-orig', type: 'button', title: 'Show the original ticket (O)', onclick: openOriginal }, icon('panel-right-open'), 'Original ticket'),
          idx >= 0 ? `${idx + 1} of ${rows.length}` : '',
          h('button', { class: 'btn btn-sm btn-icon', type: 'button', 'aria-label': 'Previous ticket', disabled: idx <= 0, onclick: () => step(-1) }, icon('chev-up')),
          h('button', { class: 'btn btn-sm btn-icon', type: 'button', 'aria-label': 'Next ticket', disabled: idx < 0 || idx >= rows.length - 1, onclick: () => step(1) }, icon('chev-down')))),
      h('div', { class: 'orig-tabs' }, h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Show' },
        ['draft', 'original'].map((p) => h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(review.dataset.pane === p), onclick: () => { review.dataset.pane = p; renderCenter(); } }, p === 'draft' ? 'Draft' : 'Original ticket')))),
      banners, brief, doc, problemsEl));

    fill(originalEl,
      h('div', { class: 'orig-head' }, h('h3', null, 'Original ticket'),
        h('button', { class: 'btn btn-quiet btn-sm btn-icon', type: 'button', 'aria-label': 'Close original ticket panel', title: 'Close (O)', onclick: closeOriginal }, icon('panel-right-close'))),
      h('div', { class: 'original-scroll' },
        h('div', { class: 'subject' }, t.subject),
        originalTicket(t, { asSection: false }),
        h('a', { href: href('tickets', { runId, ticketId: r.ticket_id }), class: 'row', style: { fontWeight: 550 } }, icon('database', 'icon-sm'), 'See the data trail and pipeline timeline', icon('chev-right', 'icon-sm'))));

    renderActions();
    renderReturnBox();
    if (textarea) autosize();
    paintSave(); paintProblems();
  }

  // ------------------------------------------------------------------ editing + autosave
  function autosize() {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.max(240, textarea.scrollHeight + 2)}px`;
  }

  function onEdit() {
    if (!detail || !textarea) return;
    detail.draft.text = textarea.value;
    detail.draft.subject = subjectInput ? subjectInput.value : detail.draft.subject;
    saveState = 'unsaved';
    paintSave(); autosize(); renderActions();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 800);
  }

  function paintSave() {
    const el = document.getElementById('save-flag');
    if (!el) return;
    el.textContent = { saved: '', unsaved: 'Unsaved changes', saving: 'Saving…', error: 'Could not save' }[saveState] || '';
    el.style.color = saveState === 'error' ? 'var(--danger)' : '';
  }

  function paintProblems() {
    if (!problemsEl) return;
    problemsEl.hidden = !problems.length;
    fill(problemsEl);
    if (problems.length) problemsEl.append(icon('shield-alert'), h('div', null, h('strong', null, "This edit can't be approved or sent yet"), h('span', null, `It adds: ${problems.join('; ')}. Remove that to continue.`)));
  }

  async function saveDraft() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!detail || !textarea) return;
    const id = detail.row.ticket_id;
    const body = { text: textarea.value, subject: subjectInput ? subjectInput.value : undefined };
    saveState = 'saving'; paintSave(); renderActions();
    try {
      const res = await api.saveDraft(S.runId, id, body);
      if (!detail || detail.row.ticket_id !== id) return;
      problems = res.problems || [];
      detail.draft.edited = res.edited; detail.draft.subject_edited = res.subject_edited;
      const same = textarea && textarea.value === body.text && (!subjectInput || subjectInput.value === body.subject);
      saveState = same ? 'saved' : 'unsaved';
    } catch (e) {
      saveState = 'error';
      toast({ message: e.message || 'Could not save your edit', duration: 6000 });
    }
    paintSave(); paintProblems(); renderActions();
  }

  async function flushDraft() {
    if (saveState === 'unsaved' || saveTimer) await saveDraft();
  }

  async function resetDraft() {
    if (!detail) return;
    try {
      const res = await api.saveDraft(S.runId, detail.row.ticket_id, { text: detail.draft.original_text, subject: detail.draft.default_subject });
      detail.draft.text = detail.draft.original_text; detail.draft.subject = detail.draft.default_subject;
      detail.draft.edited = false; detail.draft.subject_edited = false;
      problems = res.problems || []; saveState = 'saved';
      renderCenter();
    } catch (e) { toast({ message: e.message }); }
  }

  // ------------------------------------------------------------------ actions
  function renderActions() {
    if (!detail) { fill(actionSlot); return; }
    const r = currentRow();
    const state = r.review_state;
    const reply = isReply(), flagged = flaggedNow(), editable = editableNow();
    const resolved = DONE.includes(state);
    const rv = detail.review || {};
    const mode = detail.mail?.mode;
    const status = state === 'sent'
      ? h('span', null, icon('send', 'icon-sm'), `Sent ${relTime(rv.sent_at)}${mode === 'simulated' ? ' (simulated: saved to the outbox)' : ''}`)
      : resolved ? h('span', null, icon('check', 'icon-sm'), `${humanize(state)}${rv.decided_at ? ` · ${relTime(rv.decided_at)}` : ''}`)
        : state === 'returned' ? h('span', null, icon('undo', 'icon-sm'), `Returned to AP${rv.note ? `: ${rv.note}` : ''}`)
          : h('span', null, flagged ? 'Cannot be approved here' : reply ? 'Waiting for your decision' : 'Open');
    const buttons = [];
    if (state !== 'sent' && (resolved || state === 'returned')) {
      buttons.push(h('button', { class: 'btn', type: 'button', onclick: () => setState('pending', { undoable: true }) }, icon('undo'), 'Reopen'));
    }
    if (reply && editable) {
      buttons.push(h('button', { class: 'btn btn-danger', type: 'button', onclick: () => { returning = true; renderCenter(); }, 'aria-pressed': String(returning) }, icon('undo'), 'Return to AP', h('span', { class: 'kbd' }, 'R')));
    }
    if (!resolved && !(reply && flagged) && (!reply || editable)) {
      const blocked = problems.length > 0;
      buttons.push(h('button', { class: 'btn btn-primary', type: 'button', disabled: blocked || saveState === 'saving', title: blocked ? 'Remove what the edit adds first' : null, onclick: approve },
        icon('check'), reply ? 'Approve' : isNote() ? 'Acknowledge' : 'Close', h('span', { class: 'kbd' }, 'A')));
    }
    if (state === 'approved' && reply && rv.can_send) {
      buttons.push(h('button', { class: 'btn btn-primary', type: 'button', onclick: sendReply }, icon('send'), 'Send reply', h('span', { class: 'kbd' }, 'S')));
    }
    fill(actionSlot, h('div', { class: 'action-bar' }, h('div', { class: 'status' }, status), h('div', { class: 'actions' }, buttons)));
  }

  function renderReturnBox() {
    if (!returning) { fill(returnSlot); return; }
    const reason = h('textarea', { class: 'textarea', 'aria-label': 'Reason for returning', placeholder: 'What should AP fix before this goes out?', rows: '2' });
    fill(returnSlot, h('div', { class: 'return-box' },
      h('label', { class: 'label', for: 'return-reason' }, 'Reason for returning to AP'),
      (reason.id = 'return-reason', reason),
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { returning = false; renderCenter(); } }, 'Cancel'),
        h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: async () => { if (!reason.value.trim()) { reason.setAttribute('aria-invalid', 'true'); reason.focus(); return; } await flushDraft(); await setState('returned', { note: reason.value.trim(), undoable: true }); } }, 'Return reply'))));
    reason.focus();
  }

  async function approve() {
    if (!detail || problems.length) return;
    const state = isReply() ? 'approved' : isNote() ? 'acknowledged' : 'closed';
    if (state === 'approved') await flushDraft();
    if (problems.length) return; // the save just reported something the edit adds
    await setState(state, { undoable: true });
  }

  async function setState(state, { note, undoable = false } = {}) {
    if (!detail) return;
    const id = detail.row.ticket_id;
    const prev = S.byId.get(id)?.review_state || 'pending';
    clearTimeout(saveTimer); saveTimer = null;
    try {
      const d = await api.review(S.runId, id, { state, note });
      cache.set(id, d);
      // The decision is saved: drop the editor so nothing can autosave over it.
      textarea = null; subjectInput = null; returning = false; problems = []; saveState = 'saved'; detail = d;
      patchRow(id, { review_state: d.review.state });
      if (state === 'pending') { const nt = tabOf(S.byId.get(id)); if (nt) tab = nt; }
      emit('review');
      if (undoable) undo.push({ ids: [id], prev: [{ tid: id, state: prev }] });
      const verbs = { approved: 'Approved', returned: 'Returned', acknowledged: 'Acknowledged', closed: 'Closed', pending: 'Reopened' };
      toast({ message: `${verbs[state]} #${id}`, actionLabel: state === 'pending' ? undefined : 'Undo', onAction: () => undoLast(), duration: 6000 });
      renderQueue();
      // After approving a reply stay on it so Send is right there; other decisions move on.
      if (state !== 'pending' && state !== 'approved' && !queueRows().some((x) => x.ticket_id === id)) advanceFrom(id);
      else renderCenter();
    } catch (e) { toast({ message: e.message || 'Could not save that decision', duration: 6000 }); }
  }

  function advanceFrom(id) {
    const rows = queueRows();
    const next = rows.find((r) => r.seq > (S.byId.get(id)?.seq ?? 0)) || rows[rows.length - 1];
    if (next && !NARROW()) toTicket(next.ticket_id, { replace: true });
    else { selected = null; detail = null; if (NARROW()) navigate(href('review', { runId }), { replace: true }); renderCenter(); renderQueue(); }
  }

  async function undoLast() {
    const last = undo.pop();
    if (!last) { toast({ message: 'Nothing to undo', duration: 2000 }); return; }
    try {
      for (const p of last.prev) {
        const d = await api.review(S.runId, p.tid, { state: p.state });
        cache.set(p.tid, d); patchRow(p.tid, { review_state: d.review.state });
      }
      emit('review');
      const first = last.ids[0];
      { const nt = tabOf(S.byId.get(first)); if (nt) tab = nt; }
      if (first !== selected) toTicket(first, { replace: true }); else { detail = cache.get(first); renderCenter(); }
      renderQueue();
    } catch (e) { toast({ message: e.message }); }
  }

  // ------------------------------------------------------------------ send
  function sendDialog(d) {
    return new Promise((resolve) => {
      let sent = false;
      const m = d.mail || {};
      const simulated = m.mode === 'simulated';
      openDialog({
        title: 'Send this reply?', width: 560,
        body: () => h('div', { class: 'stack' },
          h('div', { class: simulated ? 'banner banner-info' : 'banner banner-warning' }, icon(simulated ? 'circle-alert' : 'alert'),
            h('div', null, h('strong', null, simulated ? 'Simulated send' : 'This sends a real email'),
              h('span', null, simulated ? `${m.label}. Connect Orchestra's mail relay to send for real (see webapp/mailer.py).` : `${m.label}. It can't be unsent.`))),
          h('dl', { class: 'kv' }, h('dt', null, 'From'), h('dd', { class: 'mono' }, m.from || ''), h('dt', null, 'To'), h('dd', { class: 'mono' }, d.draft.to || ''), h('dt', null, 'Subject'), h('dd', null, d.draft.subject || '')),
          h('div', { class: 'send-preview' }, d.draft.text)),
        actions: (dlg) => [
          h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
          h('button', { class: 'btn btn-primary', type: 'button', autofocus: true, onclick: () => { sent = true; dlg.close(); } }, icon('send'), simulated ? 'Send (simulated)' : 'Send now')],
        onClose: () => resolve(sent),
      });
    });
  }

  async function sendReply() {
    if (!detail || !detail.review?.can_send) return;
    const d = detail, id = d.row.ticket_id;
    if (!(await sendDialog(d))) return;
    const btn = actionSlot.querySelector('.btn-primary:last-child');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      const nd = await api.send(S.runId, id);
      cache.set(id, nd);
      patchRow(id, { review_state: 'sent' });
      if (detail && detail.row.ticket_id === id) detail = nd;
      emit('review');
      toast({ message: nd.mail?.mode === 'simulated' ? `Sent #${id} (simulated outbox)` : `Sent #${id} to ${nd.draft.to}`, duration: 6000 });
      renderQueue(); renderCenter();
    } catch (e) {
      toast({ message: e.message || 'Could not send', duration: 8000 });
      renderActions();
    }
  }

  async function bulkApprove(clean) {
    const ok = await confirmDialog({ title: `Approve ${clean.length} clean drafts?`, message: `These drafts have no fraud flag, are not priority, and need no internal follow-up. Approving does not send them. You can still undo this right after.`, confirmLabel: `Approve ${clean.length}` });
    if (!ok) return;
    const ids = clean.map((r) => r.ticket_id);
    try {
      const res = await api.bulk(S.runId, ids, 'approved');
      for (const id of res.done) { patchRow(id, { review_state: 'approved' }); cache.delete(id); }
      undo.push({ ids: res.done, prev: res.done.map((tid) => ({ tid, state: 'pending' })) });
      emit('review'); renderQueue();
      toast({ message: `Approved ${res.done.length} drafts${res.skipped.length ? `, skipped ${res.skipped.length}` : ''}`, actionLabel: 'Undo', onAction: () => undoLast(), duration: 8000 });
      if (!queueRows().some((r) => r.ticket_id === selected)) selectFirst();
    } catch (e) { toast({ message: e.message }); }
  }

  async function exportResults() {
    try { await api.download(`/api/runs/${S.runId}/export?scope=signed_off`, 'results.json'); toast({ message: 'Exported approved results', duration: 3000 }); }
    catch (e) { toast({ message: e.message }); }
  }

  // ------------------------------------------------------------------ events + keys
  off.push(on(async (kind, d) => {
    if (kind === 'ticket') renderQueue();
    if (kind === 'brief' && d.ticket_id === selected && d.source === 'model') {
      try {
        const nd = await api.ticket(S.runId, selected);
        if (detail && detail.row.ticket_id === selected) {
          detail.brief = nd.brief;
          const slot = centerScroll.querySelector('[data-slot="brief"]');
          if (slot) { const el = briefCard({ brief: nd.brief, canRewrite: !!S.model?.usable, swap: true }); el.dataset.slot = 'brief'; slot.replaceWith(el); }
        }
      } catch { /* leave the current brief */ }
    }
  }));

  const onKey = (e) => {
    if (e.metaKey && !e.ctrlKey) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && textarea) { e.preventDefault(); approve(); return; }
    if (e.ctrlKey || e.altKey) return;
    if (isTyping(e.target)) { if (e.key === 'Escape') { if (returning && e.target.id === 'return-reason') { returning = false; renderCenter(); } else e.target.blur(); } return; }
    if (document.querySelector('dialog[open]')) return;
    const r = detail ? currentRow() : null;
    switch (e.key.toLowerCase()) {
      case 'j': case 'arrowdown': e.preventDefault(); step(1); break;
      case 'k': case 'arrowup': e.preventDefault(); step(-1); break;
      case 'a': if (r && !flaggedNow() && !DONE.includes(r.review_state) && (!isReply() || editableNow())) { e.preventDefault(); approve(); } break;
      case 's': if (r && detail.review?.can_send && r.review_state === 'approved') { e.preventDefault(); sendReply(); } break;
      case 'e': if (textarea) { e.preventDefault(); textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length); } break;
      case 'r': if (r && editableNow()) { e.preventDefault(); returning = true; renderCenter(); } break;
      case 'o': e.preventDefault(); toggleOriginal(); break;
      case 'z': e.preventDefault(); undoLast(); break;
      case 'escape': if (returning) { returning = false; renderCenter(); } break;
      default:
    }
  };
  document.addEventListener('keydown', onKey);

  // ------------------------------------------------------------------ start
  review.classList.toggle('has-detail', !!selected);
  renderQueue();
  if (selected) open(selected);
  else if (!NARROW()) selectFirst();
  else renderCenter();

  return {
    update({ route: next }) {
      flushDraft();
      const id = next.ticketId ?? null;
      selected = id;
      review.classList.toggle('has-detail', !!id);
      renderQueue();
      listEl.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
      if (id) open(id, { quiet: true }); else { detail = null; renderCenter(); }
    },
    destroy() { flushDraft(); off.forEach((x) => x()); document.removeEventListener('keydown', onKey); clearTimeout(saveTimer); },
  };
}
