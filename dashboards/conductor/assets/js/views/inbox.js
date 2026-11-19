// The staff Inbox (#/inbox[/:ticketId]): queues | message list | reading pane | evidence, Outlook and Zendesk familiar.
// A thread id is the Zendesk ticket id; review, draft, send, schedule and chat use the inbox run's routes
// (/api/runs/{inbox_run_id}/...). Decision 6 is enforced by the server; the buttons here follow workflow.can_approve so
// they never offer what the server would refuse, and any 409 or 422 reason is shown as the server wrote it.
import { h, icon, mount as fill, isTyping, fmtInt, ls, debounce } from '../lib.js';
import { api } from '../api.js';
import * as inboxApi from '../api-inbox.js';
import * as wf from '../api-workflow.js';
import * as live from '../api-live.js';
import { href, navigate, rememberInboxRunId } from '../router.js';
import { onSearch, setSearchValue } from '../shell.js';
import { mountChat } from '../chat.js';
import { mountSchedule, resetScheduleCache } from '../schedule.js';
import { button, iconButton, setBusy, field, setFieldError } from '../components/controls.js';
import { badge } from '../components/badges.js';
import { skeletonRows, skeletonText, empty, notice } from '../components/data.js';
import { tabs as tabsComp } from '../components/layout.js';
import { modal, toast } from '../components/overlays.js';
import { ensureWorkspaceIcons } from '../components/workspace/icons.js';
import { wsQueues, wsQueuePicker, wsMessageRow, wsAwayCard, QUEUE_LABELS } from '../components/workspace/list.js';
import { wsSubjectBar, wsBadgeRow, wsInsight, wsFraudBanner, wsWorkflowNotices, wsThread, wsReceipt } from '../components/workspace/reading.js';
import { wsEvidence } from '../components/workspace/evidence.js';
import { wsComposer, wsActionBar, wsNotePanel, wsDecidePanel, wsFeedback } from '../components/workspace/composer.js';
import { ticketTabs } from '../components/workspace/tabs-store.js';
import {
  mode as threadMode, replyHash, syncAppClock, personName, firstName, ESCALATE_REASONS, suggestedReason, SPECIALISTS, isFraud, maskSensitive,
} from '../components/workspace/format.js';

const DEFAULT_QUEUE = 'needs_reply';
const NARROW = () => window.matchMedia('(max-width: 1023px)').matches;
const CATEGORY_WHY = {
  priority: 'it is a priority ticket (a legal threat or a copied executive)', fraud: 'it may be fraud', returned: 'it is about a returned payment',
  early_or_late_fee: 'it asks for early payment or a late fee',
};
const ALL_FEEDBACK = ['tone', 'facts', 'missing_info', 'other'];

export function mount(root, { route, session }) {
  ensureWorkspaceIcons();
  const role = session?.role;
  const me = (session?.email || '').toLowerCase();
  const isCfo = role === 'cfo';

  const S = {
    runId: null, queues: [], queuesLoading: true, queue: route.query?.queue || DEFAULT_QUEUE, q: route.query?.q || '',
    rows: [], rowsLoading: true, rowsError: null, selected: route.ticketId || null,
    thread: null, wfState: null, threadError: null,
    summary: null, opened: loadOpened(), fresh: new Set(), selectMode: false, checked: new Set(),
    evidenceOpen: ls('ws.evidence') !== 'closed', side: 'message', evTab: 'details',
    feedback: new Map(), scheduleOpen: new Set(), sync: null, bulkApproved: [],
  };
  let composer = null;
  let actionBar = null;
  let pendingRender = false;
  let destroyed = false;
  let rowsSeq = 0;
  let threadSeq = 0;
  const off = [];

  // ------------------------------------------------------------------ skeleton
  const liveRegion = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const syncBtn = button({ label: 'Sync now', icon: 'refresh', size: 'sm', variant: 'secondary', onClick: () => syncNow() });
  const syncNote = h('span', { class: 'ws-sync-note' });
  const header = h('header', { class: 'ws-head' },
    h('h1', { class: 'ws-head-title' }, 'Inbox'),
    h('span', { class: 'ws-head-conn' }, icon('mail'), h('span', { class: 'ws-head-mailbox' }, 'ap@orchestra-mock.example')),
    h('span', { class: 'ws-head-spacer' }),
    syncNote, syncBtn);
  const queuesEl = h('div', { class: 'ws-col ws-col-queues' });
  const listHead = h('div', { class: 'ws-list-head' });
  const awaySlot = h('div', { class: 'ws-away-slot' });
  const listEl = h('ul', { class: 'ws-list', role: 'listbox', 'aria-label': 'Messages' });
  const listBody = h('div', { class: 'ws-list-body' });
  const bulkBar = h('div', { class: 'ws-bulk', hidden: true });
  const listCol = h('section', { class: 'ws-col ws-col-list', 'aria-label': 'Message list' }, listHead, h('div', { class: 'ws-list-scroll' }, awaySlot, listBody), bulkBar);
  const readCol = h('section', { class: 'ws-col ws-col-read', 'aria-label': 'Reading pane', tabindex: '-1' });
  const evBody = h('div', { class: 'ws-ev-body' });
  const chatSlot = h('div', { class: 'ws-chat-slot', hidden: true });
  const evTabs = tabsComp({
    label: 'Ticket details', size: 'sm', selected: S.evTab,
    items: [{ id: 'details', label: 'Details', icon: 'database' }, { id: 'ask', label: 'Ask about this ticket', icon: 'sparkles' }],
    onSelect: (id) => { S.evTab = id; paintEvidenceTab(); },
  });
  const evCol = h('aside', { class: 'ws-col ws-col-ev', 'aria-label': 'Ticket details' },
    h('div', { class: 'ws-ev-tabs' }, evTabs,
      iconButton({ icon: 'x', label: 'Close details', size: 'sm', onClick: () => { if (window.matchMedia('(max-width: 1359px)').matches) { S.side = 'message'; paintLayout(); readCol.querySelector('.ws-side-toggle')?.select?.('message'); } else toggleEvidence(false); }, attrs: { class: 'c-btn c-btn-quiet c-btn-icon c-btn-sm ws-ev-hide' } })),
    h('div', { class: 'ws-ev-scroll' }, evBody, chatSlot));
  const shell = h('div', { class: 'ws-inbox' }, header, queuesEl, listCol, readCol, evCol, liveRegion);
  fill(root, shell);

  // ------------------------------------------------------------------ urls and layout
  const queryFor = () => ({ queue: S.q ? undefined : (S.queue !== DEFAULT_QUEUE ? S.queue : undefined), q: S.q || undefined });
  const urlFor = (id) => href('inbox', { ticketId: id || undefined, query: queryFor() });
  ticketTabs.attach({
    href: (id) => href('inbox', { ticketId: id, query: queryFor() }),
    closed: (id, wasActive, next) => { if (wasActive) navigate(next ? urlFor(next.id) : urlFor(null)); },
  });

  function paintLayout() {
    shell.dataset.pane = S.selected ? 'message' : 'list';
    shell.dataset.side = S.side;
    shell.dataset.evidence = S.evidenceOpen ? 'open' : 'closed';
    shell.dataset.select = S.selectMode ? 'on' : 'off';
  }
  function toggleEvidence(open) {
    S.evidenceOpen = open ?? !S.evidenceOpen;
    ls('ws.evidence', S.evidenceOpen ? 'open' : 'closed');
    if (!S.evidenceOpen && S.side === 'details') S.side = 'message';
    paintLayout();
    const t = readCol.querySelector('.ws-ev-toggle');
    if (t) { t.setAttribute('aria-pressed', String(S.evidenceOpen)); t.setAttribute('aria-label', S.evidenceOpen ? 'Hide details' : 'Show details'); t.title = t.getAttribute('aria-label'); }
  }
  paintLayout();

  // ------------------------------------------------------------------ queues
  async function loadQueues() {
    try {
      const r = await inboxApi.queues();
      if (destroyed) return;
      S.queues = r.queues || [];
    } catch {
      if (!S.queues.length) S.queues = Object.entries(QUEUE_LABELS).map(([id, label]) => ({ id, label, count: 0 }));
    }
    S.queuesLoading = false;
    paintQueues();
    paintListHead();
  }
  function paintQueues() {
    fill(queuesEl, wsQueues({ queues: S.queues, selected: S.q ? null : S.queue, loading: S.queuesLoading, onSelect: selectQueue }));
  }
  function selectQueue(id) {
    S.queue = id; S.q = ''; setSearchValue('');
    S.checked.clear(); S.selectMode = false;
    navigate(urlFor(NARROW() ? null : S.selected), { replace: true });
    loadRows();
    paintQueues();
  }
  const queueCount = (id) => S.queues.find((q) => q.id === id)?.count;

  // ------------------------------------------------------------------ the message list
  async function loadRows({ quiet = false } = {}) {
    const seq = ++rowsSeq;
    if (!quiet) { S.rowsLoading = true; S.rowsError = null; if (!S.rows.length || !quiet) S.rows = []; paintList(); }
    try {
      const r = await inboxApi.threads(S.q ? { q: S.q } : { queue: S.queue });
      if (destroyed || seq !== rowsSeq) return;
      S.rows = r.rows || [];
      S.rowsError = null;
    } catch (e) {
      if (seq !== rowsSeq) return;
      S.rowsError = e.message || 'The messages could not be loaded.';
    }
    S.rowsLoading = false;
    for (const id of [...S.checked]) if (!S.rows.some((r) => r.ticket_id === id)) S.checked.delete(id);
    paintList();
  }
  function paintListHead() {
    const title = S.q ? `Results for “${S.q}”` : (QUEUE_LABELS[S.queue] || 'Inbox');
    const n = S.q ? S.rows.length : (queueCount(S.queue) ?? S.rows.length);
    const canSelect = ['needs_reply', 'returned'].includes(S.queue) && !S.q;
    fill(listHead,
      h('div', { class: 'ws-list-titles' },
        S.queues.length ? wsQueuePicker({ queues: S.queues, selected: S.queue, onSelect: selectQueue }) : null,
        h('h2', { class: 'ws-list-title' }, title),
        h('span', { class: 'ws-list-count' }, S.rowsLoading && !S.rows.length ? '' : fmtInt(n))),
      S.q ? button({ label: 'Clear', size: 'sm', variant: 'quiet', icon: 'x', onClick: () => { S.q = ''; setSearchValue(''); navigate(urlFor(S.selected), { replace: true }); loadRows(); paintQueues(); } }) : null,
      canSelect ? button({
        label: S.selectMode ? 'Done' : 'Select', size: 'sm', variant: 'quiet', icon: S.selectMode ? 'check' : 'square-check',
        attrs: { 'aria-pressed': String(S.selectMode) }, onClick: () => { S.selectMode = !S.selectMode; S.checked.clear(); paintLayout(); paintList(); },
      }) : null);
  }
  function paintList() {
    paintListHead();
    paintAway();
    paintBulk();
    if (S.rowsLoading && !S.rows.length) { fill(listBody, skeletonRows({ rows: 8, label: 'Loading messages' })); return; }
    if (S.rowsError && !S.rows.length) {
      fill(listBody, empty({ icon: 'plug', title: 'The messages could not be loaded', text: S.rowsError, compact: true,
        actions: button({ label: 'Try again', icon: 'refresh', variant: 'primary', size: 'sm', onClick: () => loadRows() }) }));
      return;
    }
    if (!S.rows.length) {
      fill(listBody, S.q
        ? empty({ icon: 'search', title: 'No matches', text: 'Try a ticket number, a vendor, a sender or an invoice number.', compact: true })
        : empty({ icon: 'circle-check', title: emptyTitle(S.queue), text: emptyText(S.queue), compact: true }));
      return;
    }
    const scroller = listCol.querySelector('.ws-list-scroll');
    const top = scroller.scrollTop;
    const hadFocus = listEl.contains(document.activeElement) ? Number(document.activeElement.closest('.ws-row')?.dataset.id) : null;
    fill(listEl, S.rows.map((r) => wsMessageRow(r, {
      selected: r.ticket_id === S.selected, opened: S.opened.has(r.ticket_id), href: urlFor(r.ticket_id), isNew: S.fresh.has(r.ticket_id),
      selectMode: S.selectMode, checked: S.checked.has(r.ticket_id),
      onCheck: (row, on) => { if (on) S.checked.add(row.ticket_id); else S.checked.delete(row.ticket_id); listEl.querySelector(`.ws-row[data-id="${row.ticket_id}"]`)?.classList.toggle('is-checked', on); paintBulk(); },
      onOpen: (row) => openRow(row.ticket_id),
    })));
    if (!S.rows.some((r) => r.ticket_id === S.selected)) listEl.querySelector('.ws-row-link')?.setAttribute('tabindex', '0');
    if (listEl.parentNode !== listBody) fill(listBody, listEl);
    scroller.scrollTop = top;
    if (hadFocus) listEl.querySelector(`.ws-row[data-id="${hadFocus}"] .ws-row-link`)?.focus({ preventScroll: true });
  }
  const emptyTitle = (q) => ({
    needs_reply: 'Every reply is handled', needs_action: 'Nothing needs action', escalated: 'Nothing is escalated', returned: 'Nothing was returned to you',
    waiting_approver: 'No one is waiting on an approver', waiting_vendor: 'Not waiting on any vendor', scheduled: 'Nothing is scheduled', sent: 'Nothing sent yet', closed: 'Nothing closed yet',
  }[q] || 'Nothing here');
  const emptyText = (q) => ({
    needs_reply: 'New emails land here with a draft already written.', sent: 'Replies you send are filed here and in Outlook Sent items.',
    scheduled: 'Replies scheduled to send later are listed here.', returned: 'When the CFO sends a ticket back with guidance, it shows here.',
    escalated: 'Tickets sent to the CFO for a decision or a sign-off show here.',
  }[q] || 'Threads move here as their state changes.');

  function openRow(id) {
    if (id === S.selected && !NARROW()) return;
    navigate(urlFor(id));
  }
  // Up and Down move through the list, as in Outlook; Enter opens the message.
  listEl.addEventListener('keydown', (e) => {
    const links = [...listEl.querySelectorAll('.ws-row-link')];
    const i = links.indexOf(document.activeElement);
    if (i < 0) return;
    let j = null;
    if (e.key === 'ArrowDown') j = Math.min(links.length - 1, i + 1);
    else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = links.length - 1;
    else if (e.key === 'Enter') {
      e.preventDefault();
      const id = Number(links[i].closest('.ws-row').dataset.id);
      if (id !== S.selected) navigate(urlFor(id));
      if (!NARROW()) requestAnimationFrame(() => readCol.focus({ preventScroll: true }));
      return;
    } else if (e.key === ' ' && S.selectMode) { e.preventDefault(); links[i].closest('.ws-row').querySelector('input')?.click(); return; }
    if (j == null) return;
    e.preventDefault();
    links.forEach((l) => { l.tabIndex = -1; });
    links[j].tabIndex = 0;
    links[j].focus();
    links[j].scrollIntoView({ block: 'nearest' });
    if (!NARROW()) navigate(urlFor(Number(links[j].closest('.ws-row').dataset.id)), { replace: true });
  });

  // ------------------------------------------------------------------ "While you were away"
  const awayKey = () => `ws.away.${me}.${S.summary?.connected_at || ''}`;
  async function loadSummary() {
    try {
      S.summary = await inboxApi.summary();
      if (destroyed) return;
      S.runId = S.summary.run_id;
      rememberInboxRunId(S.runId);
      paintAway();
    } catch { /* the card is optional */ }
  }
  function paintAway() {
    const s = S.summary;
    if (!s || S.q || ls(awayKey()) === 'dismissed' || !s.read) { fill(awaySlot); return; }
    if (awaySlot.firstChild) return;
    fill(awaySlot, wsAwayCard(s, {
      onDismiss: () => { ls(awayKey(), 'dismissed'); fill(awaySlot); listEl.querySelector('.ws-row-link[tabindex="0"]')?.focus(); },
      onOpenQueue: (q) => selectQueue(q),
    }));
  }

  // ------------------------------------------------------------------ one thread
  async function openThread(id, { soft = false } = {}) {
    const seq = ++threadSeq;
    if (!soft) {
      S.threadError = null;
      if (S.thread?.ticket_id !== id) { S.thread = null; S.wfState = null; composer = null; }
      paintReading();
    }
    try {
      const [t, w] = await Promise.all([inboxApi.thread(id), wf.state(id).catch(() => null)]);
      if (destroyed || seq !== threadSeq) return;
      S.thread = t; S.wfState = w; S.threadError = null;
      if (t.run_id && !S.runId) { S.runId = t.run_id; rememberInboxRunId(t.run_id); }
      markOpened(id);
      ticketTabs.open(t);
      if (threadMode(t, role).primary === 'sent' && t.review?.draft?.edited && !S.feedback.has(id) && t.run_id) {
        wf.feedbackPrompt(t.run_id, id).then((p) => { if (p?.ask && S.selected === id) { S.feedback.set(id, p.categories || ALL_FEEDBACK); repaintSoon(); } }).catch(() => {});
      }
    } catch (e) {
      if (seq !== threadSeq) return;
      S.threadError = e.status === 404 ? 'This thread is not in the inbox.' : (e.message || 'The message could not be loaded.');
      if (!soft) S.thread = null;
    }
    if (soft && composer && composer.isConnected && (composer.dirty() || composer.contains(document.activeElement))) { pendingRender = true; return; }
    paintReading();
  }
  function repaintSoon() {
    if (composer && composer.isConnected && (composer.dirty() || composer.contains(document.activeElement))) { pendingRender = true; return; }
    paintReading();
  }
  function markOpened(id) {
    if (S.opened.has(id)) return;
    S.opened.add(id);
    try { sessionStorage.setItem('ws.opened', JSON.stringify([...S.opened].slice(-400))); } catch { /* storage blocked */ }
    listEl.querySelector(`.ws-row[data-id="${id}"]`)?.classList.remove('is-unread');
  }

  function paintReading() {
    pendingRender = false;
    paintLayout();
    const back = h('a', { class: 'c-btn c-btn-quiet c-btn-icon c-btn-sm ws-back', href: urlFor(null), 'aria-label': 'Back to the message list', title: 'Back to the list' }, icon('arrow-left'));
    if (!S.selected) {
      composer = null;
      document.title = 'Inbox · Conductor';
      fill(readCol, h('div', { class: 'ws-read-empty' }, empty({ icon: 'mail', title: 'Select a message to read it', text: 'The draft, the records behind it and every action are on the message. Use the up and down keys to move through the list.' })));
      fill(evBody, h('div', { class: 'ws-ev' }, h('p', { class: 'ws-ev-note' }, 'The requester, the vendor and the records for the open message show here.')));
      chatSlot.hidden = true;
      return;
    }
    if (S.threadError && !S.thread) {
      fill(readCol, h('div', { class: 'ws-read-empty' }, h('div', { class: 'ws-read-back' }, back), empty({ icon: 'circle-alert', title: 'This message could not be opened', text: S.threadError,
        actions: button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: () => openThread(S.selected) }) })));
      fill(evBody);
      return;
    }
    const t = S.thread;
    if (!t || t.ticket_id !== S.selected) {
      composer = null;
      fill(readCol, h('div', { class: 'ws-read-loading', role: 'status', 'aria-label': 'Loading the message' },
        h('div', { class: 'ws-subject' }, back, h('div', { class: 'ws-subject-main' }, h('span', { class: 'c-skeleton', style: { width: '55%', height: '18px' } }), h('span', { class: 'c-skeleton', style: { width: '35%', height: '10px', marginTop: '8px' } }))),
        h('div', { class: 'ws-read-scroll' }, h('div', { class: 'ws-insight' }, skeletonText({ lines: 3 })), h('div', { class: 'ws-thread' }, skeletonText({ lines: 6 })))));
      fill(evBody, h('div', { class: 'ws-ev' }, skeletonText({ lines: 8, label: 'Loading details' })));
      return;
    }
    const m = threadMode(t, role);
    const sideToggle = tabsComp({
      label: 'Show', variant: 'segmented', size: 'sm', selected: S.side,
      items: [{ id: 'message', label: 'Message' }, { id: 'details', label: 'Details' }],
      onSelect: (id) => { S.side = id; paintLayout(); paintEvidenceTab(); },
    });
    sideToggle.classList.add('ws-side-toggle');
    const evToggle = iconButton({ icon: 'panel-right', label: S.evidenceOpen ? 'Hide details' : 'Show details', size: 'sm', pressed: S.evidenceOpen, onClick: () => toggleEvidence(), attrs: { class: 'c-btn c-btn-quiet c-btn-icon c-btn-sm ws-ev-toggle' } });
    const work = buildWork(t, m);
    const scroll = readCol.querySelector('.ws-read-scroll');
    const keepTop = scroll && readCol.dataset.id === String(t.ticket_id) ? scroll.scrollTop : 0;
    fill(readCol,
      wsSubjectBar(t, { lead: back, actions: [sideToggle, evToggle] }),
      h('div', { class: 'ws-read-scroll' },
        wsBadgeRow(t),
        isFraud(t) ? wsFraudBanner(t) : null,
        wsInsight(t),
        wsWorkflowNotices(t, S.wfState, { role }),
        wsThread(t),
        work));
    readCol.dataset.id = String(t.ticket_id);
    readCol.querySelector('.ws-read-scroll').scrollTop = keepTop;
    composer?.addEventListener('focusout', () => setTimeout(() => { if (pendingRender && composer && !composer.dirty() && !composer.contains(document.activeElement)) paintReading(); }, 0));
    fill(evBody, wsEvidence(t));
    paintEvidenceTab();
    document.title = `${t.subject || `#${t.ticket_id}`} · Inbox · Conductor`;
  }
  function paintEvidenceTab() {
    evTabs.select(S.evTab);
    evBody.hidden = S.evTab !== 'details';
    chatSlot.hidden = S.evTab !== 'ask';
    const runId = S.runId || S.thread?.run_id;
    if (S.evTab === 'ask' && S.thread && runId) mountChat(chatSlot, { runId, ticketId: S.thread.ticket_id });
  }

  // ------------------------------------------------------------------ the work area under the thread
  function buildWork(t, m) {
    composer = null;
    actionBar = null;
    const id = t.ticket_id;
    if (m.kind === 'reply') {
      if (m.primary === 'sent') {
        const cats = S.feedback.get(id);
        return h('div', { class: 'ws-work' }, wsReceipt(t),
          S.feedback.has(id) ? wsFeedback({ categories: cats || ALL_FEEDBACK, onPick: async (c) => { await wf.sendFeedback(runFor(t), id, c); S.feedback.delete(id); } }) : null);
      }
      if (m.primary === 'blocked') {
        actionBar = wsActionBar([!isCfo && !['escalated', 'signoff_requested'].includes(t.workflow?.state) ? { id: 'escalate', label: 'Escalate to the CFO', icon: 'escalations', variant: 'primary', onClick: (b) => escalateDialog(t, b) } : null], { more: moreItems(t, m) });
        return h('div', { class: 'ws-work' }, notice({ tone: 'risk', title: 'This reply cannot be approved here', text: 'A person must handle it outside Conductor.' }), actionBar);
      }
      if (m.primary === 'none') {
        actionBar = wsActionBar([], { more: moreItems(t, m) });
        return h('div', { class: 'ws-work' }, notice({ tone: 'neutral', title: 'Closed', text: 'No reply will be sent from Conductor on this ticket.' }), actionBar);
      }
      actionBar = replyActions(t, m);
      const scheduleSlot = h('div', { class: 'ws-schedule-slot' });
      const approved = t.review?.review?.state === 'approved';
      const readOnlyReason = m.scheduled ? 'This reply is scheduled. Cancel the schedule to edit it.'
        : m.primary === 'waiting_signoff' ? 'Waiting for the CFO to sign off on this text, so it is locked.'
          : m.signedOff ? 'Signed off. Editing would cancel the sign-off, so the text is locked.'
            : approved ? 'Approved. To edit it again, choose More, then Back to draft.' : null;
      composer = wsComposer({
        thread: t, editable: m.editable && !approved, readOnlyReason, actions: h('div', { class: 'ws-comp-foot' }, actionBar, scheduleSlot),
        lead: m.priority ? badge({ label: m.signedOff ? 'Signed off' : 'Needs CFO sign-off', tone: m.signedOff ? 'settled' : 'waiting', icon: m.signedOff ? 'circle-check' : 'escalations' }) : null,
        onSave: (body) => api.saveDraft(runFor(t), id, body),
        attachments: t.attachments || [], attach: attachSpec(t),
      });
      if (approved && (S.scheduleOpen.has(id) || m.scheduled || t.schedule)) mountSchedule(scheduleSlot, { runId: runFor(t), ticketId: id, detail: t.review });
      return h('div', { class: 'ws-work' }, composer);
    }
    if (m.kind === 'note') {
      actionBar = noteActions(t, m);
      const decide = m.primary === 'decide'
        ? wsDecidePanel({ category: t.workflow?.category, onDecide: async (decision, action, note) => {
          await wf.decide(id, decision, action, note);
          toast({ title: decision === 'acknowledged' ? `Acknowledged #${id}` : `Closed #${id}`, message: 'Zendesk set to Pending with an internal note.', tone: 'settled' });
          await afterChange(id);
        } }) : null;
      const closedNote = m.primary === 'none' ? notice({ tone: 'settled', title: 'Handled', text: t.review?.review?.note || 'This note is closed.' }) : null;
      return h('div', { class: 'ws-work' }, wsNotePanel(t, { decide, actions: [closedNote, actionBar] }));
    }
    actionBar = wsActionBar([], { more: moreItems(t, m) });
    return h('div', { class: 'ws-work' }, h('section', { class: 'ws-note is-noreply', 'aria-label': 'No reply needed' },
      h('header', { class: 'ws-note-head' }, icon('circle-dash'), h('span', null, 'No reply needed'), h('span', { class: 'ws-note-sub' }, 'Conductor found nothing to answer.')),
      t.decision?.why ? h('p', { class: 'ws-note-why' }, maskSensitive(t.decision.why)) : null, actionBar));
  }

  function replyActions(t, m) {
    const approved = t.review?.review?.state === 'approved';
    const btns = [];
    if (m.primary === 'send') {
      btns.push({ id: 'send', label: approved ? 'Send' : 'Approve & send', icon: 'send', variant: 'primary', onClick: (b) => approveAndSend(t, b) });
      if (!m.scheduled) btns.push({ id: 'schedule', label: 'Schedule', icon: 'clock', onClick: (b) => openSchedule(t, b) });
    } else if (m.primary === 'request_signoff') {
      btns.push({ id: 'request', label: 'Request sign-off', icon: 'escalations', variant: 'primary', onClick: () => requestSignoffDialog(t) });
      btns.push({ id: 'schedule', label: 'Schedule', icon: 'clock', onClick: (b) => openSchedule(t, b) });
    } else if (m.primary === 'signoff') {
      btns.push({ id: 'signoff', label: 'Sign off', icon: 'pen-line', variant: 'primary', onClick: (b) => signOff(t, b) });
      if (m.canReturn) btns.push({ id: 'return', label: 'Return with guidance', icon: 'arrow-left', onClick: () => returnDialog(t) });
    }
    if (!isCfo && !m.priority && !['escalated', 'signoff_requested'].includes(t.workflow?.state)) btns.push({ id: 'escalate', label: 'Escalate', icon: 'escalations', onClick: (b) => escalateDialog(t, b) });
    const status = m.primary === 'waiting_signoff' ? badge({ label: 'Waiting for sign-off', tone: 'waiting', icon: 'clock' })
      : m.priority && !m.signedOff && !isCfo ? h('span', { class: 'ws-why' }, `The CFO signs off before this goes out, because ${CATEGORY_WHY.priority}.`)
        : m.priority && !m.signedOff && isCfo ? h('span', { class: 'ws-why' }, 'You sign off on this exact text. The specialist then sends it.') : null;
    return wsActionBar(btns, { more: moreItems(t, m), status, label: 'Reply actions' });
  }

  function noteActions(t, m) {
    const btns = [];
    const pending = String(t.decision?.rule || '').startsWith('pending');
    if (m.primary === 'handle') btns.push({ id: 'handle', label: 'Mark handled', icon: 'check', variant: 'primary', onClick: (b) => markHandled(t, b) });
    if (m.primary === 'escalate') btns.push({ id: 'escalate', label: 'Escalate to the CFO', icon: 'escalations', variant: 'primary', onClick: (b) => escalateDialog(t, b) });
    if (pending && m.primary !== 'none' && !t.workflow?.chased) btns.push({ id: 'chase', label: 'Chase approver', icon: 'bell', onClick: (b) => chase(t, b) });
    if (m.primary === 'handle' && !isCfo) btns.push({ id: 'escalate', label: 'Escalate', icon: 'escalations', onClick: (b) => escalateDialog(t, b) });
    const status = m.primary === 'waiting_decision' ? badge({ label: 'Waiting for the CFO to decide', tone: 'waiting', icon: 'clock' })
      : m.primary === 'escalate' ? h('span', { class: 'ws-why' }, `The CFO decides this note, because ${CATEGORY_WHY[m.category] || 'it needs sign-off'}.`) : null;
    return wsActionBar(btns, { more: moreItems(t, m), status, label: 'Note actions' });
  }

  function moreItems(t, m) {
    const id = t.ticket_id;
    const cat = t.workflow?.category;
    const st = t.workflow?.state || 'open';
    const items = [];
    for (const p of SPECIALISTS.filter((x) => x.email !== (t.assignee || '').toLowerCase())) {
      items.push({ label: p.email === me ? 'Assign to me' : `Assign to ${p.name}`, icon: 'user', onSelect: () => assign(t, p) });
    }
    if (m.kind === 'reply' && t.review?.review?.state === 'approved' && !m.sent && !m.scheduled) {
      items.push({ separator: true }, { label: 'Back to draft', icon: 'pen-line', onSelect: () => backToDraft(t) });
    }
    if (String(t.decision?.rule || '').startsWith('pending') && !m.closed && !m.sent) items.push({ label: t.workflow?.chased ? 'Chase approver again' : 'Chase approver', icon: 'bell', onSelect: () => chase(t, null) });
    if (!m.sent && !['closed', 'decided'].includes(st)) {
      const blocked = !!cat;
      items.push({ separator: true },
        { label: 'Forward to HR', icon: 'forward', hint: 'Quinn Ellsworth', disabled: blocked, onSelect: () => forwardDialog(t, 'hr') },
        { label: 'Forward to AR', icon: 'forward', hint: 'AR queue', disabled: blocked, onSelect: () => forwardDialog(t, 'ar') },
        { label: 'Mark no reply needed', icon: 'circle-dash', disabled: blocked, onSelect: () => noReplyDialog(t) });
      if (blocked) items.push({ node: h('p', { class: 'ws-menu-note' }, 'The CFO decides this ticket, so it cannot be forwarded or closed here.') });
    }
    items.push({ separator: true }, { label: `Copy link to #${id}`, icon: 'link', onSelect: () => copyLink(id) });
    return items;
  }

  function attachSpec(t) {
    const items = [];
    for (const it of (t.evidence?.items || []).filter((i) => i.bill)) {
      items.push({ label: `Invoice copy, ${it.bill.tranId}`, icon: 'file', onSelect: () => attach(t, 'invoice', it.bill.internalId) });
      if (it.payment && ['Settled', 'Released'].includes(it.payment.release_status)) items.push({ label: `Remittance advice, ${it.bill.tranId}`, icon: 'file', onSelect: () => attach(t, 'remittance', it.bill.internalId) });
    }
    if (!items.length) items.push({ label: 'No invoice on record for this ticket', icon: 'file', disabled: true });
    return { items, onRemove: (a) => detach(t, a), onPreview: (a) => preview(a) };
  }

  // ------------------------------------------------------------------ actions
  const runFor = (t) => S.runId || t.run_id;
  async function guarded(btn, fn) {
    actionBar?.showError(null);
    if (btn) setBusy(btn, true);
    try { return await fn(); }
    catch (e) {
      if (actionBar?.isConnected) actionBar.showError(e.message || 'That did not work.');
      else toast({ message: e.message || 'That did not work.', tone: 'risk' });
      return undefined;
    } finally { if (btn?.isConnected) setBusy(btn, false); }
  }
  async function afterChange(id) {
    await Promise.all([loadQueues(), loadRows({ quiet: true }), S.selected === id ? openThread(id, { soft: true }) : null]);
    if (S.selected === id && pendingRender) paintReading();
  }

  async function approveAndSend(t, btn) {
    const id = t.ticket_id;
    await guarded(btn, async () => {
      await composer?.flush();
      let ask = false;
      if (t.review?.review?.state !== 'approved') {
        const det = await api.review(runFor(t), id, { state: 'approved' });
        ask = !!det.feedback_prompt;
      }
      const sent = await api.send(runFor(t), id);
      ask = ask || !!sent.feedback_prompt;
      const to = t.evidence?.requester?.name || t.from_name || sent.draft?.to || 'the sender';
      toast({ title: `Sent to ${to}`, message: 'Zendesk updated · Outlook Sent items', tone: 'settled', duration: 6000 });
      liveRegion.textContent = `Reply to ${to} sent.`;
      S.scheduleOpen.delete(id);
      if (ask) S.feedback.set(id, ALL_FEEDBACK);
      await afterChange(id);
    });
  }

  async function openSchedule(t, btn) {
    const id = t.ticket_id;
    await guarded(btn, async () => {
      await composer?.flush();
      if (t.review?.review?.state !== 'approved') await api.review(runFor(t), id, { state: 'approved' });
      S.scheduleOpen.add(id);
      resetScheduleCache();
      await afterChange(id);
      setTimeout(() => readCol.querySelector('#schedule-at')?.focus(), 200);
    });
  }

  async function backToDraft(t) {
    await guarded(null, async () => {
      await api.review(runFor(t), t.ticket_id, { state: 'pending' });
      S.scheduleOpen.delete(t.ticket_id);
      await afterChange(t.ticket_id);
    });
  }

  async function markHandled(t, btn) {
    await guarded(btn, async () => {
      await api.review(runFor(t), t.ticket_id, { state: 'acknowledged' });
      toast({ message: `Marked #${t.ticket_id} as handled`, tone: 'settled' });
      await afterChange(t.ticket_id);
    });
  }

  async function signOff(t, btn) {
    const id = t.ticket_id;
    await guarded(btn, async () => {
      await composer?.flush();
      const d = t.review?.draft || {};
      let hash = await replyHash(d.to, composer ? composer.subject() : d.subject, composer ? composer.text() : d.text);
      if (!hash) hash = [...(S.wfState?.history || [])].reverse().find((a) => a.detail?.reply_hash)?.detail?.reply_hash;
      if (!hash) throw new Error('This browser cannot check the reply text. Sign off from another browser.');
      await wf.signoff(id, hash);
      toast({ title: `Signed off #${id}`, message: `${personName(t.assignee) || 'The specialist'} can now send it.`, tone: 'settled' });
      await afterChange(id);
    });
  }

  async function chase(t, btn) {
    await guarded(btn, async () => {
      const r = await wf.chase(t.ticket_id);
      const c = (r.chases || []).at(-1);
      toast({ title: c ? `Nudge drafted for ${c.name}` : 'Nudge drafted', message: 'Review and send it in Ahead, under Approver digests.', actionLabel: 'Open Ahead', onAction: () => { location.hash = '#/ahead'; } });
      await afterChange(t.ticket_id);
    });
  }

  async function assign(t, p) {
    await guarded(null, async () => {
      await wf.assign(t.ticket_id, p.email);
      toast({ message: p.email === me ? `#${t.ticket_id} is assigned to you` : `Assigned #${t.ticket_id} to ${p.name}` });
      await afterChange(t.ticket_id);
    });
  }

  async function attach(t, kind, billId) {
    await guarded(null, async () => {
      await composer?.flush();
      await inboxApi.addAttachment(t.ticket_id, kind, billId);
      toast({ message: kind === 'invoice' ? 'Invoice copy attached' : 'Remittance advice attached' });
      await openThread(t.ticket_id, { soft: true });
      if (pendingRender) paintReading();
    });
  }
  async function detach(t, a) {
    await guarded(null, async () => {
      await composer?.flush();
      await inboxApi.removeAttachment(t.ticket_id, a.id);
      await openThread(t.ticket_id, { soft: true });
      if (pendingRender) paintReading();
    });
  }
  async function preview(a) {
    let url = null;
    const body = h('div', { class: 'ws-doc' }, skeletonText({ lines: 8, label: 'Loading the document' }));
    const dl = button({ label: 'Download PDF', icon: 'download', onClick: async () => {
      try {
        const u = await inboxApi.documentBlobUrl(a.kind, a.bill_id, 'pdf');
        const link = h('a', { href: u, download: a.filename });
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(u), 2000);
      } catch (e) { toast({ message: e.message || 'The PDF could not be downloaded.', tone: 'risk' }); }
    } });
    modal({ title: a.filename, description: 'Rendered from records. Bank details show the last 4 digits only.', size: 'lg', body,
      actions: (dlg) => [dl, button({ label: 'Close', variant: 'primary', onClick: () => dlg.close() })], onClose: () => { if (url) URL.revokeObjectURL(url); } });
    try {
      url = await inboxApi.documentBlobUrl(a.kind, a.bill_id, 'html');
      fill(body, h('iframe', { class: 'ws-doc-frame', title: a.filename, src: url }));
    } catch (e) {
      fill(body, notice({ tone: 'risk', title: 'The document could not be shown', text: e.message }));
    }
  }

  function copyLink(id) {
    const url = `${location.origin}/app${href('inbox', { ticketId: id })}`;
    const done = () => toast({ message: `Link to #${id} copied` });
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => toast({ message: url }));
    else toast({ message: url });
  }

  // dialogs ----------------------------------------------------------
  function formDialog({ title, description, fields, submitLabel, danger = false, onSubmit }) {
    const err = h('div', { class: 'ws-dialog-error', role: 'alert', hidden: true });
    const submit = button({ label: submitLabel, variant: danger ? 'danger' : 'primary' });
    const form = h('form', { class: 'ws-dialog-form', novalidate: true }, fields, err);
    const dlg = modal({ title, description, size: 'sm', body: form, actions: (d) => [button({ label: 'Cancel', variant: 'secondary', onClick: () => d.close() }), submit] });
    let busy = false;
    const go = async (e) => {
      e?.preventDefault();
      if (busy) return;
      busy = true;
      err.hidden = true;
      setBusy(submit, true);
      try { await onSubmit(); dlg.close(); }
      catch (x) {
        if (x?.field) { setFieldError(x.field, x.message); x.field.control.focus(); }
        else { err.hidden = false; err.replaceChildren(icon('circle-alert'), h('span', null, x?.message || 'That did not work.')); }
      } finally { busy = false; if (submit.isConnected) setBusy(submit, false); }
    };
    form.addEventListener('submit', go);
    submit.addEventListener('click', go);
    setTimeout(() => form.querySelector('select, textarea, input')?.focus(), 30);
    return dlg;
  }
  const fieldError = (fieldNode, message) => Object.assign(new Error(message), { field: fieldNode });

  function escalateDialog(t) {
    const reason = field({ label: 'Reason', type: 'select', value: suggestedReason(t), options: ESCALATE_REASONS });
    const note = field({ label: 'Note for Elena', type: 'textarea', rows: 3, placeholder: 'What should the CFO know?', help: 'Required when the reason is something else.' });
    formDialog({
      title: `Escalate #${t.ticket_id}`, description: 'Elena Lockhart (CFO) gets it in Escalations. You can still read it here.',
      fields: [reason, note], submitLabel: 'Escalate',
      onSubmit: async () => {
        const r = reason.control.value;
        const n = note.control.value.trim();
        if (r === 'other' && !n) throw fieldError(note, 'Add a note when the reason is something else.');
        await wf.escalate(t.ticket_id, r, n);
        toast({ title: `Escalated #${t.ticket_id}`, message: 'Elena Lockhart has it in Escalations.' });
        await afterChange(t.ticket_id);
      },
    });
  }
  function requestSignoffDialog(t) {
    const note = field({ label: 'Note for Elena', type: 'textarea', rows: 3, placeholder: 'Optional' });
    formDialog({
      title: 'Request sign-off', description: 'Elena Lockhart signs off on this exact text. Once she has, you can send it.',
      fields: [notice({ tone: 'info', text: `This reply needs the CFO's sign-off because ${CATEGORY_WHY.priority}.` }), note], submitLabel: 'Request sign-off',
      onSubmit: async () => {
        await composer?.flush();
        await wf.requestSignoff(t.ticket_id, note.control.value.trim());
        toast({ title: 'Sign-off requested', message: `Elena Lockhart has #${t.ticket_id} in Escalations.` });
        await afterChange(t.ticket_id);
      },
    });
  }
  function returnDialog(t) {
    const g = field({ label: 'Guidance', type: 'textarea', rows: 4, required: true, placeholder: `What should ${firstName(personName(t.assignee)) || 'the specialist'} change?` });
    formDialog({
      title: `Return #${t.ticket_id} with guidance`, description: `${personName(t.assignee) || 'The specialist'} gets it back under Returned to me.`,
      fields: [g], submitLabel: 'Return',
      onSubmit: async () => {
        const v = g.control.value.trim();
        if (!v) throw fieldError(g, 'Write guidance for the specialist.');
        await wf.returnWithGuidance(t.ticket_id, v);
        toast({ message: `Returned #${t.ticket_id} to ${personName(t.assignee) || 'the specialist'}` });
        await afterChange(t.ticket_id);
      },
    });
  }
  function forwardDialog(t, to) {
    const note = field({ label: 'Note', type: 'textarea', rows: 3, placeholder: 'Optional' });
    const who = to === 'hr' ? 'Quinn Ellsworth (HR Generalist)' : 'the AR queue';
    formDialog({
      title: `Forward to ${to === 'hr' ? 'HR' : 'AR'}`, description: `Records that ${who} has this email and closes it here. Nothing is sent to the sender.`,
      fields: [note], submitLabel: 'Forward',
      onSubmit: async () => {
        const r = await wf.forward(t.ticket_id, to, note.control.value.trim());
        toast({ message: `Forwarded #${t.ticket_id} to ${r?.forwarded_to?.name || who}`, tone: 'settled' });
        await afterChange(t.ticket_id);
      },
    });
  }
  function noReplyDialog(t) {
    const note = field({ label: 'Note', type: 'textarea', rows: 3, placeholder: 'Optional. For example: a thank-you with no question.' });
    formDialog({
      title: 'Mark no reply needed', description: 'Closes the ticket without a reply.', fields: [note], submitLabel: 'Mark no reply needed',
      onSubmit: async () => {
        await wf.noReply(t.ticket_id, note.control.value.trim());
        toast({ message: `Closed #${t.ticket_id} with no reply`, tone: 'settled' });
        await afterChange(t.ticket_id);
      },
    });
  }

  // ------------------------------------------------------------------ bulk approve (multi-select)
  function paintBulk() {
    const n = S.checked.size;
    bulkBar.hidden = !S.selectMode;
    if (!S.selectMode) return;
    const approveBtn = button({ label: n ? `Approve ${n}` : 'Approve selected', icon: 'check', variant: 'primary', size: 'sm', disabled: !n, onClick: () => bulkApprove(approveBtn) });
    const allBtn = button({ label: 'Select all', size: 'sm', variant: 'quiet', onClick: () => { S.rows.forEach((r) => S.checked.add(r.ticket_id)); paintList(); } });
    const sendBtn = S.bulkApproved.length ? button({ label: `Send ${S.bulkApproved.length} approved`, icon: 'send', size: 'sm', variant: 'secondary', onClick: () => bulkSend(sendBtn) }) : null;
    fill(bulkBar, h('span', { class: 'ws-bulk-n', 'aria-live': 'polite' }, `${n} selected`), allBtn, h('span', { class: 'ws-head-spacer' }), sendBtn, approveBtn);
  }
  async function bulkApprove(btn) {
    const ids = [...S.checked];
    if (!ids.length || !S.runId) return;
    setBusy(btn, true);
    try {
      const r = await api.bulk(S.runId, ids, 'approved');
      S.bulkApproved = r.done || [];
      S.checked.clear();
      const skipped = r.skipped || [];
      if (skipped.length) {
        modal({
          title: `Approved ${r.done.length}, skipped ${skipped.length}`, description: 'Skipped replies stay in the list. Open each one to see what it needs.',
          body: h('ul', { class: 'ws-skipped' }, skipped.map((s) => h('li', null, h('a', { href: urlFor(s.ticket_id), class: 'mono' }, `#${s.ticket_id}`), h('span', null, typeof s.reason === 'string' ? s.reason : 'Not allowed')))),
          actions: (d) => button({ label: 'Close', variant: 'primary', onClick: () => d.close() }),
        });
      } else toast({ message: `Approved ${r.done.length} ${r.done.length === 1 ? 'reply' : 'replies'}. Send them when you are ready.`, tone: 'settled' });
      await Promise.all([loadQueues(), loadRows({ quiet: true })]);
    } catch (e) { toast({ message: e.message || 'The replies were not approved.', tone: 'risk' }); }
    finally { if (btn.isConnected) setBusy(btn, false); paintBulk(); }
  }
  async function bulkSend(btn) {
    const ids = [...S.bulkApproved];
    setBusy(btn, true);
    let sent = 0;
    const failed = [];
    for (const id of ids) {
      try { await api.send(S.runId, id); sent += 1; } catch (e) { failed.push(`#${id}: ${e.message}`); }
    }
    S.bulkApproved = [];
    toast({ title: `Sent ${sent} ${sent === 1 ? 'reply' : 'replies'}`, message: failed.length ? `Not sent: ${failed.join('; ')}` : 'Zendesk updated · Outlook Sent items', tone: failed.length ? 'risk' : 'settled', duration: 8000 });
    if (btn.isConnected) setBusy(btn, false);
    await Promise.all([loadQueues(), loadRows({ quiet: true })]);
    if (S.selected) openThread(S.selected, { soft: true });
  }

  // ------------------------------------------------------------------ sync and live updates
  async function syncNow() {
    setBusy(syncBtn, true);
    try {
      const r = await inboxApi.syncNow();
      if (!(r.arrived || []).length) toast({ message: 'No new email. Zendesk and Outlook are up to date.' });
      else { r.arrived.forEach((id) => S.fresh.add(id)); await Promise.all([loadQueues(), loadRows({ quiet: true })]); }
    } catch (e) { toast({ message: e.message || 'Sync did not finish.', tone: 'risk' }); }
    finally { setBusy(syncBtn, false); }
  }
  function paintSync() {
    const s = S.sync;
    if (!s) { syncNote.textContent = ''; return; }
    if (s.held_back === 0) { syncNote.textContent = 'Up to date'; return; }
    const next = Date.parse(s.next_at || '');
    const now = Date.parse(s.at || '');
    const secs = Number.isNaN(next) || Number.isNaN(now) ? null : Math.max(0, Math.round((next - now) / 1000));
    syncNote.textContent = secs == null ? 'Connected' : secs < 5 ? 'Checking for new email' : `Next check in about ${secs < 60 ? `${secs} s` : `${Math.round(secs / 60)} min`}`;
  }
  const refreshLists = debounce(() => { loadQueues(); loadRows({ quiet: true }); }, 250);
  off.push(live.subscribe((ev) => {
    if (destroyed || !ev) return;
    if (ev.at) syncAppClock(ev.at);
    switch (ev.type) {
      case 'sync.status': S.sync = ev; paintSync(); return;
      case 'queue.counts': loadQueues(); return;
      case 'ticket.arrived':
        S.fresh.add(ev.ticket_id);
        liveRegion.textContent = `New email from ${ev.from_name || 'a sender'}: ${ev.subject || ''}`;
        refreshLists();
        setTimeout(() => { S.fresh.delete(ev.ticket_id); listEl.querySelector(`.ws-row[data-id="${ev.ticket_id}"]`)?.classList.remove('is-new'); }, 8000);
        return;
      default:
        if (ev.ticket_id == null) return;
        refreshLists();
        if (ev.ticket_id === S.selected) openThread(ev.ticket_id, { soft: true });
    }
  }));
  off.push(onSearch((q) => {
    S.q = q || '';
    S.selectMode = false;
    navigate(urlFor(NARROW() ? null : S.selected), { replace: true });
    loadRows();
    paintQueues();
  }));
  if (S.q) setSearchValue(S.q);

  // Escape on narrow screens goes back to the list. ("/" is the shell's search.)
  const onKey = (e) => {
    if (e.key === 'Escape' && NARROW() && S.selected && !isTyping(e.target) && !document.querySelector('dialog[open], .c-menu')) navigate(urlFor(null));
  };
  document.addEventListener('keydown', onKey);

  // ------------------------------------------------------------------ start
  loadSummary();
  loadQueues();
  loadRows();
  if (S.selected) openThread(S.selected); else paintReading();

  return {
    update({ route: r }) {
      const q = r.query?.q || '';
      const queue = r.query?.queue || DEFAULT_QUEUE;
      const listChanged = q !== S.q || (!q && queue !== S.queue);
      S.q = q; S.queue = queue;
      if (listChanged) { setSearchValue(q); loadRows(); paintQueues(); }
      const next = r.ticketId || null;
      if (next !== S.selected) {
        S.selected = next;
        S.side = 'message';
        listEl.querySelectorAll('.ws-row').forEach((row) => {
          const on = Number(row.dataset.id) === next;
          row.classList.toggle('is-selected', on);
          const link = row.querySelector('.ws-row-link');
          link.setAttribute('aria-selected', String(on));
          if (!listEl.contains(document.activeElement)) link.tabIndex = on ? 0 : -1;
        });
        if (next) openThread(next); else { ticketTabs.setActive(null); paintReading(); }
      }
      paintLayout();
    },
    destroy() {
      destroyed = true;
      off.forEach((fn) => fn?.());
      document.removeEventListener('keydown', onKey);
      ticketTabs.detach();
    },
  };
}

function loadOpened() {
  try { return new Set(JSON.parse(sessionStorage.getItem('ws.opened') || '[]')); } catch { return new Set(); }
}
