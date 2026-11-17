// Review view: the employee's approval queue for drafted replies. Three panes: queue | brief + draft | original ticket.
// The draft is always editable (autosaved). Approving records a decision; Send hands the approved reply to the mail
// adapter on the server (simulated outbox by default, Orchestra's SMTP relay when configured).
// The selected tab and ticket live in the URL (`tab`, ticket id, `from=tickets`) and are remembered per run in viewState.
import { h, icon, mount as fill, isTyping, fmtInt, domainOf, humanize, relTime, ls } from '../lib.js';
import { api } from '../api.js';
import { S, on, patchRow, emit, viewState } from '../state.js';
import { href, navigate } from '../router.js';
import { briefCard, originalTicket, outputBadge, flagBadges, reviewBadge, emptyState, toast, confirmDialog, openDialog, tabList, backLink, shortcutsDialog } from '../ui.js';

const TABS = [['todo', 'To review'], ['approved', 'Approved'], ['returned', 'Returned'], ['notes', 'Notes']];
const TAB_KEYS = TABS.map(([k]) => k);
const TAB_TITLES = { notes: 'Internal notes and tickets with no reply', approved: 'Approved and sent replies' };
const NARROW = () => window.matchMedia('(max-width: 900px)').matches;
const WIDE = () => window.matchMedia('(min-width: 1440px)').matches;
const DONE = ['approved', 'sent', 'acknowledged', 'closed'];
const BRIEF_WAIT_MS = 120000;

const SHORTCUTS = [
  { keys: ['J', 'K'], label: 'Next and previous ticket' },
  { keys: 'A', label: 'Approve, acknowledge or close' },
  { keys: 'S', label: 'Send an approved reply' },
  { keys: 'E', label: 'Edit the reply' },
  { keys: 'R', label: 'Return to AP' },
  { keys: 'O', label: 'Show or hide the original ticket' },
  { keys: 'Z', label: 'Undo the last decision' },
  { keys: ['Ctrl', 'Enter'], label: 'Approve while editing' },
  { keys: '?', label: 'Show this list' },
];

function tabOf(r) {
  if (r.output_type !== 'draft_reply') return 'notes'; // includes tickets the pipeline failed on: a person must handle them
  return r.review_state === 'approved' || r.review_state === 'sent' ? 'approved' : r.review_state === 'returned' ? 'returned' : 'todo';
}
const rank = (r) => ((r.flags || []).length ? 0 : r.priority ? 1 : 2);
const isClean = (r) => r.output_type === 'draft_reply' && r.review_state === 'pending' && !(r.flags || []).length && !r.priority && !r.act_by;

export function mount(root, { route }) {
  const runId = route.runId;

  let ready = false;          // false while mount() runs: URL fixes are deferred until the shell has registered this view
  let tab = 'todo';
  let selected = null;
  let fromId = null;          // the ticket the user arrived with from the ticket page (`from=tickets`)
  let detail = null;          // current ticket detail (also the cache entry, so local edits survive switching tickets)
  let loadError = null;
  let returning = false;
  let loadToken = 0;
  let deciding = false;
  let sending = false;
  let sendError = null;       // { id, message }
  let originalOpen = ls('ap.orig') !== 'closed';
  const cache = new Map();
  const undo = [];            // { ids, prev: [{tid, state}] }
  const off = [];
  const briefBusy = new Map(); // ticket id -> timer waiting for the `brief` event
  const briefNotes = new Map();

  // draft editing
  let textarea = null, subjectInput = null, problemsEl = null, saveEl = null, editedEl = null;
  let saveState = 'saved';    // saved | unsaved | saving | error
  let problems = [];
  let saveTimer = null;

  // ------------------------------------------------------------------ urls
  const urlFor = (id, t = tab) => href('review', { runId, ticketId: id || undefined, query: { tab: t, from: id && id === fromId ? 'tickets' : undefined } });
  const listUrl = (t = tab) => urlFor(null, t);
  const replaceTo = (url) => { if (ready) navigate(url, { replace: true }); else queueMicrotask(() => navigate(url, { replace: true })); };
  const remember = () => viewState.set(runId, 'review', { query: { tab }, ticketId: selected });

  // ------------------------------------------------------------------ skeleton
  const progressText = h('span');
  const progressBar = h('div', { class: 'bar-fill' });
  const tabsEl = tabList({ label: 'Queue', variant: 'stacked', selected: tab, items: TABS.map(([key, label]) => ({ key, label, count: 0, title: TAB_TITLES[key] })), onSelect: (k) => setTab(k) });
  const listEl = h('div', { class: 'queue-list' });
  const bulkSlot = h('div');
  const shortcutsBtn = h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => openShortcuts() }, icon('keyboard'), 'Shortcuts');
  const queue = h('section', { class: 'pane queue', 'aria-label': 'Review queue' },
    h('div', { class: 'queue-top' }, h('div', { class: 'review-progress' }, progressText, h('div', { class: 'bar' }, progressBar)), tabsEl),
    listEl,
    h('div', { class: 'queue-foot' }, bulkSlot, shortcutsBtn));
  const centerScroll = h('div', { class: 'center-scroll' });
  const returnSlot = h('div');
  const actionSlot = h('div');
  const center = h('section', { class: 'pane center', 'aria-label': 'Draft reply' }, centerScroll, h('div', { class: 'center-foot' }, returnSlot, actionSlot));
  const originalEl = h('aside', { class: 'pane original', 'aria-label': 'Original ticket' });
  const review = h('div', { class: `review${originalOpen ? '' : ' orig-closed'}` }, queue, center, originalEl);
  review.dataset.pane = 'draft';
  fill(root, h('h1', { class: 'sr-only' }, 'Review'), review);

  function openShortcuts() { shortcutsDialog('Keyboard shortcuts', SHORTCUTS); }

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
  const queueRows = (t = tab) => S.rows.filter((r) => tabOf(r) === t).sort((a, b) => rank(a) - rank(b) || a.seq - b.seq);

  function setTab(k) {
    if (!TAB_KEYS.includes(k)) return;
    flushDraft();
    const first = NARROW() ? null : queueRows(k)[0];
    navigate(first ? urlFor(first.ticket_id, k) : listUrl(k), { replace: true });
  }

  function renderQueue() {
    const counts = Object.fromEntries(TAB_KEYS.map((k) => [k, S.rows.filter((r) => tabOf(r) === k).length]));
    tabsEl.update({ items: TABS.map(([key, label]) => ({ key, label, count: counts[key], title: TAB_TITLES[key] })), selected: tab });
    const drafts = S.rows.filter((r) => r.output_type === 'draft_reply');
    const done = drafts.filter((r) => r.review_state !== 'pending').length;
    fill(progressText);
    progressText.append(h('b', null, `${fmtInt(done)} of ${fmtInt(drafts.length)}`), ' drafts reviewed');
    progressBar.style.transform = `scaleX(${drafts.length ? done / drafts.length : 0})`;

    const rows = queueRows();
    const top = listEl.scrollTop;
    if (rows.length) {
      fill(listEl, h('ul', { class: 'q-list', 'aria-label': `${TABS.find(([k]) => k === tab)[1]}: ${rows.length} tickets` }, rows.map((r) => h('li', null,
        h('a', { class: 'q-item', href: urlFor(r.ticket_id), 'aria-current': r.ticket_id === selected ? 'true' : null, dataset: { id: r.ticket_id }, onclick: onItemClick },
          h('span', { class: 'q-top' }, h('span', { class: 'id' }, `#${r.ticket_id}`), h('span', { class: 'badges' }, flagBadges(r), tab === 'notes' || tab === 'approved' ? reviewBadge(r) : null)),
          h('span', { class: 'q-subject truncate' }, r.subject || '(no subject)'),
          h('span', { class: 'q-sub truncate' }, r.output_type === 'draft_reply' ? `To ${domainOf(r.recipient) || r.sender_name || 'requester'}${r.reason_tag ? ` · ${humanize(r.reason_tag)}` : ''}` : `${humanize(r.rule)}${r.act_by ? ` · for ${r.act_by.split('@')[0]}` : ''}`))))));
    } else if (tab === 'todo') {
      fill(listEl, emptyState({
        iconName: 'circle-check', title: 'Nothing left to review', text: 'Every drafted reply has been approved or returned.',
        actions: [h('a', { class: 'btn btn-sm', href: href('overview', { runId }) }, 'Run overview'),
          counts.approved ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => setTab('approved') }, 'See approved replies') : null],
      }));
    } else {
      fill(listEl, emptyState({ iconName: 'inbox', title: 'Nothing here', text: 'Tickets that land here will be listed.' }));
    }
    listEl.scrollTop = top;

    const clean = S.rows.filter(isClean);
    fill(bulkSlot, tab === 'todo' && clean.length > 1 ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => bulkApprove(clean), title: 'Approve every draft with no flags, no priority and no internal follow-up' }, icon('layers'), `Approve ${clean.length} clean drafts…`) : null);
  }

  function onItemClick(e) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    flushDraft();
    viewState.set(runId, 'review', { scrollTop: NARROW() ? window.scrollY : listEl.scrollTop });
  }

  function selectFirst() {
    const rows = queueRows();
    if (rows.length && !NARROW()) replaceTo(urlFor(rows[0].ticket_id));
  }

  function step(delta) {
    const rows = queueRows();
    const i = rows.findIndex((r) => r.ticket_id === selected);
    const next = rows[i < 0 ? 0 : i + delta];
    if (next) { flushDraft(); navigate(urlFor(next.ticket_id), { replace: true }); }
  }

  // ------------------------------------------------------------------ detail loading
  async function open(id) {
    const token = ++loadToken;
    returning = false; problems = []; loadError = null; sendError = null;
    const hit = cache.get(id);
    saveState = hit?.__dirty ? 'error' : 'saved';
    if (hit) { detail = hit; renderCenter(); }
    else {
      detail = null;
      fill(centerScroll, h('div', { class: 'center-inner' }, h('div', { class: 'skeleton', style: { height: '28px', width: '55%' } }), briefCard({ brief: null }), h('div', { class: 'skeleton', style: { height: '220px' } })));
      fill(actionSlot); fill(returnSlot); fill(originalEl);
    }
    try {
      const d = await api.ticket(S.runId, id);
      if (token !== loadToken) { if (!cache.has(id)) cache.set(id, d); return; }
      if (hit && (hit.__dirty || saveState !== 'saved' || saveTimer)) return; // keep what the person is editing
      const changed = !hit || JSON.stringify(d) !== JSON.stringify(hit);
      cache.set(id, d);
      detail = d;
      remember();
      if (changed) renderCenter();
    } catch (e) {
      if (token !== loadToken) return;
      if (hit) return; // a cached copy is already showing
      detail = null;
      loadError = { id, status: e.status, message: e.message };
      viewState.set(runId, 'review', { ticketId: null });
      renderLoadError();
    }
  }

  function renderLoadError() {
    const { id, status, message } = loadError;
    fill(actionSlot); fill(returnSlot); fill(originalEl);
    fill(centerScroll, h('div', { class: 'center-inner' }, emptyState({
      iconName: 'circle-alert', title: status === 404 ? `Ticket #${id} is not in this run` : `Could not load ticket #${id}`,
      text: status === 404 ? 'The link may be from another run, or the ticket was removed.' : message,
      actions: [status === 404 ? null : h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { cache.delete(id); open(id); } }, icon('rotate'), 'Retry'),
        h('a', { class: status === 404 ? 'btn btn-primary' : 'btn', href: listUrl(), onclick: () => flushDraft() }, 'Back to queue')],
    })));
  }

  // ------------------------------------------------------------------ center + original
  const currentRow = () => (detail ? S.byId.get(detail.row.ticket_id) || detail.row : null);
  const isReply = () => detail?.draft.output_type === 'draft_reply';
  const isNote = () => detail?.draft.output_type === 'internal_action_note';
  const flaggedNow = () => (currentRow()?.flags || []).length > 0;
  const editableNow = () => isReply() && ['pending', 'returned'].includes(currentRow().review_state) && !flaggedNow();

  function makeBrief(d, r, swap = false) {
    const id = r.ticket_id;
    const el = briefCard({ brief: d.brief, canRewrite: !!S.model?.usable, onRewrite: () => rewriteBrief(id), swap, busy: briefBusy.has(id), note: briefNotes.get(id) || null });
    el.dataset.slot = 'brief';
    return el;
  }
  function paintBrief(swap = false) {
    const slot = centerScroll.querySelector('[data-slot="brief"]');
    if (slot && detail) slot.replaceWith(makeBrief(detail, currentRow(), swap));
  }
  function endBriefWait(id) { clearTimeout(briefBusy.get(id)); briefBusy.delete(id); }
  async function rewriteBrief(id) {
    if (briefBusy.has(id)) return;
    briefNotes.delete(id);
    briefBusy.set(id, setTimeout(() => {
      briefBusy.delete(id);
      briefNotes.set(id, 'The local model did not answer in time. This brief is generated from the records.');
      if (detail?.row.ticket_id === id) paintBrief();
    }, BRIEF_WAIT_MS));
    paintBrief();
    try { await api.regenBrief(S.runId, id); }
    catch (e) { endBriefWait(id); toast({ message: e.message || 'Could not start the rewrite' }); if (detail?.row.ticket_id === id) paintBrief(); }
  }

  function renderCenter() {
    textarea = null; subjectInput = null; problemsEl = null; saveEl = null; editedEl = null;
    if (loadError && !detail) { renderLoadError(); return; }
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

    const banners = [];
    if (flagged) banners.push(h('div', { class: 'banner banner-danger', role: 'alert' }, icon('shield-alert'), h('div', { class: 'banner-body' }, h('strong', null, `Flagged: ${r.flags.map(humanize).join(', ').toLowerCase()}`), h('span', null, 'This ticket cannot be approved or sent from here. A person should confirm with the vendor through a contact already on file.'))));
    if (injection) banners.push(h('div', { class: 'banner banner-warning', role: 'alert' }, icon('alert'), h('div', { class: 'banner-body' }, h('strong', null, 'The message contains instructions aimed at an automated system'), h('span', null, 'Read the original before acting.'))));
    if (d.bundle.advisory && !flagged) banners.push(h('div', { class: 'banner banner-warning' }, icon('alert'), h('div', { class: 'banner-body' }, h('strong', null, 'Advisory'), h('span', null, d.bundle.advisory))));

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
      saveEl = h('span', { class: 'save-flag', role: 'status', 'aria-live': 'polite' });
      editedEl = h('span', { class: 'edited-slot' });
      doc = h('div', { class: 'doc' },
        h('dl', { class: 'doc-meta' }, h('dt', null, 'To'), h('dd', { class: 'mono' }, d.draft.to || ''), h('dt', null, 'Subject'), metaSubject),
        body,
        h('div', { class: 'doc-foot' },
          editable ? [icon('pencil', 'icon-sm'), 'Click the reply to edit it. Changes save automatically.'] : [icon('send-off', 'icon-sm'), r.review_state === 'sent' ? 'Sent.' : 'Not sent yet.'],
          editedEl,
          saveEl));
      problemsEl = h('div', { class: 'banner banner-danger', role: 'alert', hidden: true });
    } else {
      doc = h('div', { class: 'doc' },
        h('div', { class: 'doc-title' }, icon(isNote() ? 'file' : 'circle-dash'), isNote() ? 'Internal action note' : 'No reply drafted', h('span', { class: 'faint', style: { fontWeight: 400 } }, isNote() ? 'Never sent to the requester' : 'Nothing goes to the requester')),
        h('div', { class: 'doc-body' }, d.draft.text || d.bundle.decision?.why || ''));
    }

    // header row 1: ways back, then the pager. Row 2: the subject and what it is.
    const queueBack = backLink({ label: 'Queue', href: listUrl() });
    queueBack.classList.add('nav-queue');
    queueBack.addEventListener('click', () => { flushDraft(); });
    const ticketBack = fromId === r.ticket_id ? backLink({ label: 'Back to ticket', href: href('tickets', { runId, ticketId: r.ticket_id }) }) : null;
    ticketBack?.classList.add('nav-ticket');
    ticketBack?.addEventListener('click', () => { flushDraft(); });
    const nav = h('div', { class: 'center-nav' }, queueBack, ticketBack, h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm show-orig', type: 'button', title: 'Show the original ticket (O)', onclick: openOriginal }, icon('panel-right-open'), 'Original ticket'),
      h('div', { class: 'pager' },
        idx >= 0 ? `${idx + 1} of ${rows.length}` : '',
        h('button', { class: 'btn btn-sm btn-icon', type: 'button', 'aria-label': 'Previous ticket', title: 'Previous (K)', disabled: idx <= 0 && idx >= 0, onclick: () => step(-1) }, icon('chev-up')),
        h('button', { class: 'btn btn-sm btn-icon', type: 'button', 'aria-label': 'Next ticket', title: 'Next (J)', disabled: idx >= 0 && idx >= rows.length - 1, onclick: () => step(1) }, icon('chev-down'))));

    const paneSwitch = tabList({ label: 'Show', selected: review.dataset.pane, items: [{ key: 'draft', label: 'Draft' }, { key: 'original', label: 'Original ticket' }], onSelect: (k) => { review.dataset.pane = k; renderCenter(); } });

    fill(centerScroll, h('div', { class: 'center-inner' },
      nav,
      h('div', { class: 'center-head' },
        h('h2', null, t.subject || '(no subject)'),
        h('div', { class: 'meta' }, h('span', { class: 'mono' }, `#${r.ticket_id}`), outputBadge(r.output_type), flagBadges(r), reviewBadge(r), h('span', { class: 'meta-who' }, [t.sender_name, r.vendor && `· ${r.vendor}`].filter(Boolean).join(' ')))),
      h('div', { class: 'orig-tabs' }, paneSwitch),
      banners, makeBrief(d, r), doc, problemsEl));

    fill(originalEl,
      h('div', { class: 'orig-head' }, h('h3', null, 'Original ticket'),
        h('button', { class: 'btn btn-quiet btn-sm btn-icon', type: 'button', 'aria-label': 'Close original ticket panel', title: 'Close (O)', onclick: closeOriginal }, icon('panel-right-close'))),
      h('div', { class: 'original-scroll' },
        h('div', { class: 'subject' }, t.subject),
        originalTicket(t, { asSection: false }),
        h('a', { href: href('tickets', { runId, ticketId: r.ticket_id, query: { from: 'review' } }), class: 'row data-trail-link', onclick: () => flushDraft() }, icon('database', 'icon-sm'), 'See the data trail and pipeline timeline', icon('chev-right', 'icon-sm'))));

    renderActions();
    renderReturnBox();
    if (textarea) autosize();
    paintSave(); paintProblems(); paintEdited();
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
    detail.__dirty = true;
    saveState = 'unsaved';
    paintSave(); autosize(); renderActions();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 800);
  }

  function paintSave() {
    if (!saveEl) return;
    fill(saveEl);
    if (saveState === 'error') {
      saveEl.append(h('span', { class: 'save-error' }, icon('circle-alert', 'icon-sm'), 'Could not save'), h('button', { class: 'link-btn', type: 'button', onclick: () => saveDraft() }, 'Retry'));
    } else {
      saveEl.append({ saved: '', unsaved: 'Unsaved changes', saving: 'Saving…' }[saveState] || '');
    }
  }

  function paintEdited() {
    if (!editedEl || !detail) return;
    const edited = detail.draft.edited || detail.draft.subject_edited;
    fill(editedEl, edited ? [h('span', { class: 'badge badge-accent' }, icon('pencil'), 'Edited'), editableNow() ? h('button', { class: 'link-btn', type: 'button', onclick: resetDraft }, 'Reset to original') : null] : null);
  }

  function paintProblems() {
    if (!problemsEl) return;
    problemsEl.hidden = !problems.length;
    fill(problemsEl);
    if (problems.length) problemsEl.append(icon('shield-alert'), h('div', { class: 'banner-body' }, h('strong', null, "This edit can't be approved or sent yet"), h('span', null, `It adds: ${problems.join('; ')}. Remove that to continue.`)));
  }

  async function saveDraft() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!detail || !textarea) return;
    const d = detail, id = d.row.ticket_id;
    const body = { text: textarea.value, subject: subjectInput ? subjectInput.value : undefined };
    saveState = 'saving'; paintSave(); renderActions();
    try {
      const res = await api.saveDraft(S.runId, id, body);
      const stillHere = detail === d;
      d.draft.edited = res.edited; d.draft.subject_edited = res.subject_edited;
      if (!stillHere) { d.__dirty = false; return; }
      problems = res.problems || [];
      const same = textarea && textarea.value === body.text && (!subjectInput || subjectInput.value === body.subject);
      saveState = same ? 'saved' : 'unsaved';
      if (same) d.__dirty = false;
    } catch (e) {
      d.__dirty = true;
      if (detail !== d) { toast({ message: `Could not save your edit to #${id}: ${e.message || 'try again'}. It is kept and will be retried when you reopen it.`, duration: 8000 }); return; }
      saveState = 'error';
    }
    paintSave(); paintProblems(); paintEdited(); renderActions();
  }

  async function flushDraft() {
    if (saveState === 'unsaved' || saveTimer) await saveDraft();
  }

  async function resetDraft() {
    if (!detail) return;
    try {
      const res = await api.saveDraft(S.runId, detail.row.ticket_id, { text: detail.draft.original_text, subject: detail.draft.default_subject });
      detail.draft.text = detail.draft.original_text; detail.draft.subject = detail.draft.default_subject;
      detail.draft.edited = false; detail.draft.subject_edited = false; detail.__dirty = false;
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
    const busy = deciding || sending;
    const failed = sendError && sendError.id === r.ticket_id ? sendError.message : null;
    const status = failed ? h('span', { class: 'status-error', role: 'alert' }, icon('circle-alert', 'icon-sm'), `Could not send: ${failed}`)
      : saveState === 'error' && editable ? h('span', { class: 'status-error' }, icon('circle-alert', 'icon-sm'), 'Could not save your edit', h('button', { class: 'link-btn', type: 'button', onclick: () => saveDraft() }, 'Retry'))
      : state === 'sent'
        ? h('span', null, icon('send', 'icon-sm'), `Sent ${relTime(rv.sent_at)}${mode === 'simulated' ? ' (simulated: saved to the outbox)' : ''}`)
        : resolved ? h('span', null, icon('check', 'icon-sm'), `${humanize(state)}${rv.decided_at ? ` · ${relTime(rv.decided_at)}` : ''}`)
          : state === 'returned' ? h('span', null, icon('undo', 'icon-sm'), `Returned to AP${rv.note ? `: ${rv.note}` : ''}`)
            : h('span', null, flagged ? 'Cannot be approved here' : reply ? 'Waiting for your decision' : 'Open');
    const buttons = [];
    if (state !== 'sent' && (resolved || state === 'returned')) {
      buttons.push(h('button', { class: 'btn', type: 'button', disabled: busy, onclick: () => setState('pending', { undoable: true }) }, icon('undo'), 'Reopen'));
    }
    if (reply && editable) {
      buttons.push(h('button', { class: 'btn btn-danger', type: 'button', disabled: busy, onclick: () => { returning = true; renderCenter(); }, 'aria-pressed': String(returning) }, icon('undo'), 'Return to AP', h('span', { class: 'kbd' }, 'R')));
    }
    if (!resolved && !(reply && flagged) && (!reply || editable)) {
      const blocked = problems.length > 0;
      const unsavable = saveState === 'error';
      buttons.push(h('button', { class: 'btn btn-primary', type: 'button', disabled: blocked || unsavable || saveState === 'saving' || busy, title: blocked ? 'Remove what the edit adds first' : unsavable ? 'Your edit has not been saved: use Retry first' : null, onclick: approve },
        icon('check'), reply ? 'Approve' : isNote() ? 'Acknowledge' : 'Close', h('span', { class: 'kbd' }, 'A')));
    }
    if (state === 'approved' && reply && rv.can_send) {
      buttons.push(h('button', { class: 'btn btn-primary', type: 'button', disabled: busy, onclick: sendReply }, sending ? h('span', { class: 'spinner spinner-sm' }) : icon('send'), sending ? 'Sending…' : 'Send reply', sending ? null : h('span', { class: 'kbd' }, 'S')));
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
        h('button', { class: 'btn btn-sm btn-danger', type: 'button', disabled: deciding, onclick: async () => { if (!reason.value.trim()) { reason.setAttribute('aria-invalid', 'true'); reason.focus(); return; } await flushDraft(); await setState('returned', { note: reason.value.trim(), undoable: true }); } }, 'Return reply'))));
    reason.focus({ preventScroll: false });
  }

  async function approve() {
    if (!detail || problems.length || deciding) return;
    const state = isReply() ? 'approved' : isNote() ? 'acknowledged' : 'closed';
    if (state === 'approved') {
      if (saveState === 'error') await saveDraft();
      else await flushDraft();
      if (saveState === 'error') { toast({ message: 'Your edit has not been saved yet. Use Retry first.', duration: 5000 }); return; }
    }
    if (problems.length) return; // the save just reported something the edit adds
    await setState(state, { undoable: true });
  }

  async function setState(state, { note, undoable = false } = {}) {
    if (!detail || deciding) return;
    const id = detail.row.ticket_id;
    const prev = S.byId.get(id)?.review_state || 'pending';
    clearTimeout(saveTimer); saveTimer = null;
    deciding = true; renderActions();
    try {
      const d = await api.review(S.runId, id, { state, note });
      deciding = false;
      cache.set(id, d);
      if (selected !== id) { patchRow(id, { review_state: d.review.state }); emit('review'); renderQueue(); return; }
      // The decision is saved: drop the editor so nothing can autosave over it.
      textarea = null; subjectInput = null; returning = false; problems = []; saveState = 'saved'; sendError = null; detail = d;
      patchRow(id, { review_state: d.review.state });
      emit('review');
      if (undoable) undo.push({ ids: [id], prev: [{ tid: id, state: prev }] });
      const verbs = { approved: 'Approved', returned: 'Returned', acknowledged: 'Acknowledged', closed: 'Closed', pending: 'Reopened' };
      toast({ message: `${verbs[state]} #${id}`, actionLabel: state === 'pending' ? undefined : 'Undo', onAction: () => undoLast(), duration: 6000 });
      renderQueue();
      // After approving a reply stay on it so Send is right there; other decisions move on.
      if (state === 'pending') {
        const nt = tabOf(S.byId.get(id));
        if (nt && nt !== tab) { renderCenter(); navigate(urlFor(id, nt), { replace: true }); return; }
        renderCenter();
      } else if (state !== 'approved' && !queueRows().some((x) => x.ticket_id === id)) advanceFrom(id);
      else renderCenter();
    } catch (e) {
      deciding = false;
      toast({ message: e.message || 'Could not save that decision', duration: 6000 });
      renderActions();
    }
  }

  function advanceFrom(id) {
    const rows = queueRows();
    const next = rows.find((r) => r.seq > (S.byId.get(id)?.seq ?? 0)) || rows[rows.length - 1];
    if (next && !NARROW()) navigate(urlFor(next.ticket_id), { replace: true });
    else navigate(listUrl(), { replace: true });
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
      const nt = tabOf(S.byId.get(first)) || tab;
      if (first === selected) { detail = cache.get(first); returning = false; problems = []; saveState = 'saved'; }
      renderQueue();
      if (last.ids.length > 1 && NARROW()) return;
      navigate(urlFor(first, nt), { replace: true });
      if (first === selected) renderCenter();
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
            h('div', { class: 'banner-body' }, h('strong', null, simulated ? 'Simulated send' : 'This sends a real email'),
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
    if (!detail || !detail.review?.can_send || sending || deciding) return;
    const d = detail, id = d.row.ticket_id;
    if (!(await sendDialog(d))) return;
    sending = true; sendError = null; renderActions();
    try {
      const nd = await api.send(S.runId, id);
      sending = false;
      cache.set(id, nd);
      patchRow(id, { review_state: 'sent' });
      if (detail && detail.row.ticket_id === id) detail = nd;
      emit('review');
      toast({ message: nd.mail?.mode === 'simulated' ? `Sent #${id} (simulated outbox)` : `Sent #${id} to ${nd.draft.to}`, duration: 6000 });
      renderQueue(); if (selected === id) renderCenter();
    } catch (e) {
      sending = false;
      sendError = { id, message: e.message || 'The server did not accept it' };
      toast({ message: `Could not send #${id}: ${sendError.message}`, duration: 8000 });
      if (detail && detail.row.ticket_id === id) renderActions();
    }
  }

  async function bulkApprove(clean) {
    const ok = await confirmDialog({ title: `Approve ${clean.length} clean drafts?`, message: `These drafts have no fraud flag, are not priority, and need no internal follow-up. Approving does not send them. You can still undo this right after.`, confirmLabel: `Approve ${clean.length}` });
    if (!ok) return;
    const ids = clean.map((r) => r.ticket_id);
    try {
      const res = await api.bulk(S.runId, ids, 'approved');
      for (const id of res.done) { patchRow(id, { review_state: 'approved' }); cache.delete(id); }
      if (res.done.length) undo.push({ ids: res.done, prev: res.done.map((tid) => ({ tid, state: 'pending' })) });
      emit('review'); renderQueue();
      const skipped = res.skipped || [];
      toast({ message: `Approved ${res.done.length} drafts${skipped.length ? `, skipped ${skipped.length}` : ''}`, actionLabel: res.done.length ? 'Undo' : undefined, onAction: () => undoLast(), duration: 8000 });
      if (skipped.length) showSkipped(skipped);
      if (selected && !queueRows().some((r) => r.ticket_id === selected) && res.done.includes(selected)) { if (WIDE() || !NARROW()) selectFirst(); else { cache.delete(selected); open(selected); } }
    } catch (e) { toast({ message: e.message }); }
  }

  function showSkipped(skipped) {
    openDialog({
      title: skipped.length === 1 ? '1 draft was not approved' : `${skipped.length} drafts were not approved`, width: 480,
      body: () => h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'These stay in To review. Open each one to decide.'),
        h('ul', { class: 'skip-list' }, skipped.map((s) => h('li', null, h('a', { class: 'mono', href: urlFor(s.ticket_id, 'todo'), onclick: () => document.querySelector('dialog[open]')?.close() }, `#${s.ticket_id}`), `: ${s.reason}`)))),
      actions: (dlg) => [h('button', { class: 'btn btn-primary', type: 'button', autofocus: true, onclick: () => dlg.close() }, 'Close')],
    });
  }

  // ------------------------------------------------------------------ events + keys
  off.push(on(async (kind, d) => {
    if (kind === 'ticket') renderQueue();
    if (kind === 'review') {
      renderQueue();
      if (d?.ticket_id != null) {
        cache.delete(d.ticket_id);
        if (d.ticket_id === selected && detail && detail.review?.state !== d.state && saveState === 'saved' && !saveTimer && !deciding) {
          const id = selected;
          try {
            const nd = await api.ticket(S.runId, id);
            if (selected !== id || saveState !== 'saved' || saveTimer) return;
            cache.set(id, nd); detail = nd; returning = false; renderCenter();
          } catch { /* keep what is shown */ }
        }
      }
    }
    if (kind === 'brief') {
      const id = d.ticket_id;
      const waiting = briefBusy.has(id);
      endBriefWait(id);
      if (d.source === 'model') briefNotes.delete(id);
      else if (waiting) briefNotes.set(id, `The local model's version was not used${d.error ? ` (${d.error})` : ''}. This brief is generated from the records.`);
      cache.delete(id);
      if (id === selected && detail && (d.source === 'model' || waiting)) {
        try {
          const nd = await api.ticket(S.runId, id);
          if (detail && detail.row.ticket_id === id) { detail.brief = nd.brief; paintBrief(true); }
        } catch { paintBrief(); }
      }
    }
    if (kind === 'model' && detail) paintBrief();
  }));

  const onKey = (e) => {
    if (e.metaKey && !e.ctrlKey) return;
    if (e.defaultPrevented) return;
    if (document.querySelector('dialog[open]') || document.querySelector('.menu') || root.closest('[inert]')) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && textarea && e.target === textarea) { e.preventDefault(); approve(); return; }
    if (e.ctrlKey || e.altKey) return;
    if (isTyping(e.target)) { if (e.key === 'Escape') { if (returning && e.target.id === 'return-reason') { returning = false; renderCenter(); } else e.target.blur(); } return; }
    const r = detail ? currentRow() : null;
    if (e.key === '?') { e.preventDefault(); openShortcuts(); return; }
    switch (e.key.toLowerCase()) {
      case 'j': case 'arrowdown': e.preventDefault(); step(1); break;
      case 'k': case 'arrowup': e.preventDefault(); step(-1); break;
      case 'a': if (r && !flaggedNow() && !DONE.includes(r.review_state) && (!isReply() || editableNow())) { e.preventDefault(); approve(); } break;
      case 's': if (r && detail.review?.can_send && r.review_state === 'approved') { e.preventDefault(); sendReply(); } break;
      case 'e': if (textarea) { e.preventDefault(); textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length); } break;
      case 'r': if (r && editableNow() && !deciding) { e.preventDefault(); returning = true; renderCenter(); } break;
      case 'o': e.preventDefault(); toggleOriginal(); break;
      case 'z': e.preventDefault(); undoLast(); break;
      case 'escape': if (returning) { returning = false; renderCenter(); } break;
      default:
    }
  };
  document.addEventListener('keydown', onKey);

  // ------------------------------------------------------------------ routing
  // Reads tab / ticket / from out of the route. When the ticket belongs to another tab the URL is replaced and
  // nothing is changed here: the update that follows does the work. Returns true in that case.
  function readRoute(r) {
    const q = r.query || {};
    const nTab = TAB_KEYS.includes(q.tab) ? q.tab : 'todo';
    const nSel = r.ticketId ?? null;
    const nFrom = q.from === 'tickets' && nSel ? nSel : null;
    if (nSel) {
      const row = S.byId.get(nSel);
      const t = row && tabOf(row);
      if (t && t !== nTab) { fromId = nFrom; replaceTo(urlFor(nSel, t)); return true; }
    }
    tab = nTab; selected = nSel; fromId = nFrom;
    return false;
  }

  function applyRoute(next, initial = false) {
    const prevSel = initial ? undefined : selected, prevTab = tab, prevFrom = fromId;
    if (!initial) flushDraft();
    if (readRoute(next)) { if (initial) renderQueue(); return true; }
    review.classList.toggle('has-detail', !!selected);
    remember();
    renderQueue();
    if (selected !== prevSel) {
      if (selected) {
        if (!initial && NARROW()) window.scrollTo(0, 0);
        open(selected).then(() => { centerScroll.scrollTop = 0; });
        listEl.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
      } else {
        ++loadToken; detail = null; loadError = null; returning = false;
        renderCenter();
        if (NARROW()) { const y = viewState.get(runId, 'review').scrollTop; requestAnimationFrame(() => window.scrollTo(0, y || 0)); }
      }
    } else if (tab !== prevTab || fromId !== prevFrom) renderCenter();
    return false;
  }

  // ------------------------------------------------------------------ start
  const redirected = applyRoute(route, true);
  if (!redirected && !selected && !NARROW()) selectFirst();
  ready = true;

  return {
    update({ route: next }) { applyRoute(next); },
    destroy() { flushDraft(); off.forEach((x) => x()); document.removeEventListener('keydown', onKey); clearTimeout(saveTimer); for (const t of briefBusy.values()) clearTimeout(t); },
  };
}
