// Ticket chat panel ("Ask about this ticket"). Mounted into the inbox evidence panel by views/inbox.js.
// The views re-render their detail often, so one panel element per run+ticket lives in a module-level cache and is
// re-appended into each fresh slot. Its stream, draft text and history survive. A stream stops only on Stop or Clear.
// The chat is read-only: it cannot approve, edit or send. The server builds the context; we send only the question.
import { h, icon } from './lib.js';
import { chatApi } from './api-chat.js';

const MAX_LEN = 2000;
const MAX_PANELS = 30;
const SUGGESTIONS = ['What is this ticket asking for?', 'Why did this rule apply?', 'What does the draft promise?'];

// ---------------------------------------------------------------------------- pure helpers (tested in node)
export const chatKey = (ctx) => `${ctx?.runId}:${ctx?.ticketId}`;

export function toMessages(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && (r.role === 'user' || r.role === 'assistant') && typeof r.content === 'string')
    .map((r) => ({ id: r.id ?? null, role: r.role, text: r.content }));
}

export const cleanQuestion = (s) => String(s ?? '').trim().slice(0, MAX_LEN);
export const canSend = (text, busy) => !busy && cleanQuestion(text).length > 0;

// Join streamed token text. Tokens are appended as received; nothing is parsed.
export const appendToken = (acc, d) => acc + (typeof d?.text === 'string' ? d.text : '');

export function errorText(kind, message) {
  const m = message || 'The chat could not be completed.';
  if (kind === 'model_missing') return { message: m, hint: 'Open Settings to pick an installed model.' };
  if (kind === 'unreachable') return { message: m, hint: 'Check the model connection in Settings.' };
  return { message: m, hint: null };
}

// Drop the oldest idle entries once the cache is over its limit. Never drops a panel that is still streaming.
export function evictIdle(map, limit, isBusy) {
  for (const [k, v] of map) {
    if (map.size <= limit) break;
    if (!isBusy(v)) map.delete(k);
  }
  return map;
}

// ---------------------------------------------------------------------------- panel
const panels = new Map();

export function mountChat(el, ctx) {
  if (!el || ctx?.runId == null || ctx?.ticketId == null) return;
  const key = chatKey(ctx);
  let p = panels.get(key);
  if (!p) {
    p = createPanel(ctx);
    panels.set(key, p);
    evictIdle(panels, MAX_PANELS, (x) => x.busy());
  } else {
    panels.delete(key); panels.set(key, p); // most recently used last
    p.ensureLoaded();
  }
  el.replaceChildren(p.el);
}

function createPanel({ runId, ticketId }) {
  let msgs = [];            // saved and in-flight: { role, text, pending? }
  let loaded = false, loading = false, loadErr = null;
  let ctl = null, seq = 0, busy = false;
  let err = null;

  const list = h('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite', 'aria-label': 'Chat about this ticket' });
  const errBox = h('div', { class: 'chat-err' });
  const input = h('textarea', {
    class: 'c-input c-textarea chat-input', rows: '2', maxlength: String(MAX_LEN), placeholder: 'Ask about this ticket',
    'aria-label': 'Question about this ticket',
  });
  const sendBtn = h('button', { class: 'c-btn c-btn-primary c-btn-sm', type: 'submit' }, icon('send'), h('span', { class: 'c-btn-label' }, 'Ask'));
  const stopBtn = h('button', { class: 'c-btn c-btn-secondary c-btn-sm', type: 'button', hidden: true }, icon('stop'), h('span', { class: 'c-btn-label' }, 'Stop'));
  const clearBtn = h('button', { class: 'c-btn c-btn-quiet c-btn-sm chat-clear', type: 'button', title: 'Delete the chat history for this ticket' }, icon('trash'), h('span', { class: 'c-btn-label' }, 'Clear'));
  const form = h('form', { class: 'chat-form' }, input, h('div', { class: 'chat-actions' }, sendBtn, stopBtn));
  const el = h('section', { class: 'chat', 'aria-label': 'Ask about this ticket' },
    h('div', { class: 'chat-head' },
      h('div', null, h('h3', { class: 'chat-title' }, icon('sparkles'), 'Ask about this ticket'),
        h('p', { class: 'chat-note' }, 'Answers come from this ticket and its records only. Chat cannot approve, edit or send.')),
      clearBtn),
    list, errBox, form);

  function bubble(m) {
    return h('div', { class: `chat-msg chat-${m.role}${m.pending ? ' is-pending' : ''}` },
      h('span', { class: 'chat-who' }, m.role === 'user' ? 'You' : 'Local model'),
      h('div', { class: 'chat-text' }, m.text || (m.pending ? 'Reading the records…' : '')));
  }

  function renderList() {
    if (loading && !msgs.length) { list.replaceChildren(h('p', { class: 'chat-empty' }, 'Loading the chat…')); return; }
    if (!msgs.length) {
      list.replaceChildren(...[
        loadErr ? h('p', { class: 'chat-empty' }, loadErr) : null,
        h('div', { class: 'chat-suggest' }, SUGGESTIONS.map((s) =>
          h('button', { class: 'c-chip is-interactive', type: 'button', onclick: () => { input.value = s; ask(); } }, s))),
      ].filter(Boolean));
      return;
    }
    list.replaceChildren(...msgs.map(bubble));
    list.scrollTop = list.scrollHeight;
  }

  function renderErr() {
    if (!err) { errBox.replaceChildren(); return; }
    const t = errorText(err.kind, err.message);
    errBox.replaceChildren(h('div', { class: 'c-notice c-notice-risk', role: 'alert' }, icon('circle-alert'),
      h('div', { class: 'c-notice-body' }, h('strong', null, t.message), t.hint ? h('span', null, t.hint) : null)));
  }

  function setBusy(b) {
    busy = b;
    sendBtn.disabled = b; input.readOnly = b; stopBtn.hidden = !b;
    el.classList.toggle('is-busy', b);
  }

  async function ensureLoaded() {
    if (loaded || loading || busy) return;
    loading = true; renderList();
    try {
      const d = await chatApi.history(runId, ticketId);
      if (!busy) msgs = toMessages(d?.messages);
      loaded = true; loadErr = null;
    } catch {
      loadErr = 'The chat history could not be loaded.';
    }
    loading = false; renderList();
  }

  // Nothing is saved for a failed or stopped question, so take both lines out and hand the question back.
  function rollback(q) {
    msgs = msgs.slice(0, -2);
    input.value = q;
  }

  async function ask() {
    const q = cleanQuestion(input.value);
    if (!canSend(q, busy)) return;
    err = null; renderErr();
    input.value = '';
    const mine = ++seq;
    ctl = new AbortController();
    const myCtl = ctl;
    const answer = { role: 'assistant', text: '', pending: true };
    msgs = [...msgs, { role: 'user', text: q }, answer];
    setBusy(true); renderList();
    let ended = false, raf = 0;
    const paint = () => { raf = 0; if (mine === seq) renderList(); };
    try {
      await chatApi.send(runId, ticketId, q, { signal: myCtl.signal, onEvent: (type, d) => {
        if (mine !== seq || ended) return;
        if (type === 'token') {
          answer.text = appendToken(answer.text, d);
          if (!raf) raf = requestAnimationFrame(paint);
        } else if (type === 'done') {
          ended = true; answer.text = typeof d?.text === 'string' ? d.text : answer.text; answer.pending = false;
        } else if (type === 'error') {
          ended = true; rollback(q); err = { kind: d?.kind, message: d?.message };
        }
      } });
      if (mine === seq && !ended) { rollback(q); err = { kind: 'http', message: 'The connection ended before the answer finished.' }; }
    } catch (e) {
      if (mine !== seq || e?.name === 'AbortError') return;
      rollback(q); err = { kind: e?.kind, message: e?.message };
    }
    if (mine !== seq) return;
    if (raf) cancelAnimationFrame(raf);
    setBusy(false); renderList(); renderErr();
  }

  function stop() {
    if (!busy) return;
    const q = msgs.length >= 2 ? msgs[msgs.length - 2].text : '';
    seq++; ctl?.abort();
    rollback(q);
    setBusy(false); renderList(); input.focus();
  }

  async function clear() {
    seq++; ctl?.abort();
    setBusy(false); err = null; renderErr();
    msgs = []; renderList();
    try { await chatApi.clear(runId, ticketId); loaded = true; }
    catch { err = { kind: 'http', message: 'The chat could not be cleared.' }; loaded = false; renderErr(); }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); ask(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); } });
  stopBtn.addEventListener('click', stop);
  clearBtn.addEventListener('click', clear);

  renderList();
  ensureLoaded();
  return { el, busy: () => busy, ensureLoaded };
}
