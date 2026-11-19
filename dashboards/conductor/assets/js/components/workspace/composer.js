// The inline reply composer (already holding Conductor's draft), the internal-note panel and the CFO's Decide panel.
// Recipients come from records and are read-only. The draft autosaves; nothing is sent from here without a click on
// an action the view supplies. The composer never builds wording of its own.
import { h, icon } from '../../lib.js';
import { button, iconButton, setBusy } from '../controls.js';
import { chip, badge, avatar } from '../badges.js';
import { notice } from '../data.js';
import { menu } from '../overlays.js';
import { maskSensitive, personName } from './format.js';

/** An action bar: primary buttons, then a More menu. spec: [{ id, label, icon, variant, onClick, disabled, title }] */
export function wsActionBar(buttons = [], { more = null, status = null, label = 'Actions' } = {}) {
  const nodes = buttons.filter(Boolean).map((b) => {
    const btn = button({ label: b.label, icon: b.icon, variant: b.variant || 'secondary', disabled: b.disabled, title: b.title, attrs: { 'data-action': b.id } });
    if (b.onClick) btn.addEventListener('click', () => b.onClick(btn));
    return btn;
  });
  const moreBtn = more && more.length ? menu({ label: 'More', icon: 'more', items: more, align: 'end', variant: 'secondary' }) : null;
  const err = h('div', { class: 'ws-actions-error', role: 'alert', hidden: true });
  const bar = h('div', { class: 'ws-actions', role: 'group', 'aria-label': label },
    h('div', { class: 'ws-actions-buttons' }, nodes, moreBtn),
    status ? h('div', { class: 'ws-actions-status' }, status) : null, err);
  bar.showError = (msg) => {
    err.hidden = !msg;
    err.replaceChildren(...(msg ? [icon('circle-alert'), h('span', null, msg)] : []));
  };
  return bar;
}

/**
 * wsComposer({ thread, editable, onSave, onRestore, attachments, attach, actions, lead })
 * onSave({ text, subject }) -> Promise<{ problems, edited }>. attach: { items: menu items, onRemove(att), onPreview(att) } | null.
 * Returns the element with .flush() (waits for a pending save), .text(), .subject(), .dirty(), .setReadOnly(bool).
 */
export function wsComposer({ thread: t, editable = true, onSave, attachments = [], attach = null, actions = null, lead = null, readOnlyReason = null } = {}) {
  const d = t.review?.draft || {};
  const ev = t.evidence || {};
  const toName = ev.requester?.email && ev.requester.email.toLowerCase() === String(d.to || '').toLowerCase() ? ev.requester.name : t.from_name;
  let saveTimer = 0;
  let saving = null;
  let dirty = false;
  let lastSaved = { text: d.text || '', subject: d.subject || '' };

  const subject = h('input', { class: 'ws-comp-subject-input', type: 'text', value: d.subject || '', maxlength: '200', 'aria-label': 'Subject', readonly: editable ? null : true, oninput: changed });
  const body = h('textarea', { class: 'ws-comp-body', 'aria-label': `Reply to ${toName || d.to || 'the sender'}`, spellcheck: 'true', readonly: editable ? null : true, oninput: changed });
  body.value = d.text || '';
  const saveState = h('span', { class: 'ws-comp-save', 'aria-live': 'polite' });
  const problemsEl = h('div', { class: 'ws-comp-problems' });
  const edited = () => body.value !== (d.original_text || '') || (subject.value || '') !== (d.default_subject || '');

  function paintSave(state) {
    const words = { saved: edited() ? 'Edited · saved' : "Conductor's draft", saving: 'Saving…', unsaved: 'Edited', error: 'Not saved' };
    saveState.textContent = words[state] || '';
    saveState.dataset.state = state;
  }
  function paintProblems(problems) {
    problemsEl.replaceChildren(...(problems?.length ? [notice({ tone: 'waiting', title: 'This edit adds something the records do not support', text: `${problems.join('; ')}. Remove it before you approve.` })] : []));
  }
  function changed() {
    dirty = true;
    paintSave('unsaved');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 700);
    autosize();
  }
  async function save() {
    clearTimeout(saveTimer);
    if (!onSave || !editable) return;
    const next = { text: body.value, subject: subject.value };
    if (next.text === lastSaved.text && next.subject === lastSaved.subject) { dirty = false; paintSave('saved'); return; }
    paintSave('saving');
    const run = (async () => {
      try {
        const res = await onSave(next);
        lastSaved = next;
        if (body.value === next.text && subject.value === next.subject) { dirty = false; paintSave('saved'); }
        paintProblems(res?.problems || []);
      } catch (e) {
        paintSave('error');
        paintProblems([e.message || 'The draft could not be saved']);
        throw e;
      }
    })();
    saving = run;
    try { await run; } finally { if (saving === run) saving = null; }
  }
  function autosize() {
    body.style.height = 'auto';
    body.style.height = `${Math.min(Math.max(body.scrollHeight + 2, 180), 560)}px`;
  }

  // Formatting for a plain-text email: lists, and putting Conductor's draft back. Bold or colour would not survive
  // a plain-text reply, so they are not offered.
  function prefixLines(numbered) {
    if (!editable) return;
    const v = body.value;
    let s = body.selectionStart;
    let e = body.selectionEnd;
    s = v.lastIndexOf('\n', s - 1) + 1;
    const endNl = v.indexOf('\n', e);
    e = endNl < 0 ? v.length : endNl;
    const lines = v.slice(s, e).split('\n');
    const already = lines.every((l) => (numbered ? /^\d+\. /.test(l) : /^- /.test(l)));
    const next = lines.map((l, i) => (already ? l.replace(numbered ? /^\d+\. / : /^- /, '') : `${numbered ? `${i + 1}. ` : '- '}${l.replace(/^(- |\d+\. )/, '')}`)).join('\n');
    body.setRangeText(next, s, e, 'select');
    body.focus();
    changed();
  }
  function restore() {
    body.value = d.original_text || '';
    subject.value = d.default_subject || '';
    changed();
    save().catch(() => {});
  }
  const toolbar = h('div', { class: 'ws-comp-toolbar', role: 'toolbar', 'aria-label': 'Formatting' },
    iconButton({ icon: 'list', label: 'Bulleted list', size: 'sm', onClick: () => prefixLines(false), disabled: !editable }),
    iconButton({ icon: 'list-ordered', label: 'Numbered list', size: 'sm', onClick: () => prefixLines(true), disabled: !editable }),
    h('span', { class: 'ws-comp-sep', 'aria-hidden': 'true' }),
    button({ label: "Restore Conductor's draft", icon: 'undo', variant: 'quiet', size: 'sm', onClick: restore, disabled: !editable }),
    h('span', { class: 'ws-comp-spacer' }),
    h('span', { class: 'ws-comp-plain' }, 'Plain text'),
    saveState);
  body.addEventListener('keydown', (e) => { if (e.key === 'Escape') body.blur(); });

  const recips = h('div', { class: 'ws-comp-row' },
    h('span', { class: 'ws-comp-label', id: `ws-to-${t.ticket_id}` }, 'To'),
    h('div', { class: 'ws-comp-recips', role: 'list', 'aria-labelledby': `ws-to-${t.ticket_id}` },
      d.to ? h('span', { class: 'ws-recip', role: 'listitem', title: 'From the vendor record. Recipients cannot be changed.' },
        avatar({ name: toName || d.to, size: 'sm' }), h('span', null, toName || d.to), h('span', { class: 'ws-recip-email' }, d.to), icon('lock', 'ws-recip-lock')) : h('span', { class: 'ws-muted' }, 'No recipient on record')),
    h('span', { class: 'ws-comp-from', title: 'Recipients come from records and cannot be edited' }, 'From records'));
  const subj = h('div', { class: 'ws-comp-row' }, h('label', { class: 'ws-comp-label', for: subject.id || null }, 'Subject'), subject);
  subject.id = `ws-subj-${t.ticket_id}`;
  subj.firstChild.setAttribute('for', subject.id);

  const attRow = attach || attachments.length ? h('div', { class: 'ws-comp-atts', 'aria-label': 'Attachments' },
    icon('clip', 'ws-comp-atts-icon'),
    attachments.map((a) => {
      const c = chip({ label: a.filename, icon: 'file', onRemove: attach?.onRemove && editable ? () => attach.onRemove(a) : null, removeLabel: `Remove ${a.filename}` });
      if (attach?.onPreview) {
        const pv = h('button', { class: 'ws-att-preview', type: 'button', 'aria-label': `Preview ${a.filename}`, title: 'Preview', onclick: () => attach.onPreview(a) }, icon('eye'));
        c.insertBefore(pv, c.querySelector('.c-chip-remove'));
      }
      return c;
    }),
    attach?.items?.length && editable ? menu({ label: 'Attach document', icon: 'plus', items: attach.items, variant: 'quiet', size: 'sm' }) : null,
    !attachments.length && !(attach?.items?.length && editable) ? h('span', { class: 'ws-muted' }, 'No attachments') : null) : null;

  const el = h('section', { class: `ws-composer${editable ? '' : ' is-readonly'}`, 'aria-label': 'Reply' },
    h('header', { class: 'ws-comp-head' }, icon('reply'), h('span', null, 'Reply'), lead || null),
    readOnlyReason ? h('div', { class: 'ws-comp-ro' }, icon('lock'), h('span', null, readOnlyReason)) : null,
    recips, subj, toolbar, body, problemsEl, attRow, actions);

  paintSave('saved');
  requestAnimationFrame(autosize);
  el.flush = async () => { if (dirty) await save(); else if (saving) await saving; };
  el.text = () => body.value;
  el.subject = () => subject.value;
  el.dirty = () => dirty;
  el.focusBody = () => body.focus();
  el.ticketId = t.ticket_id;
  return el;
}

/** The internal note: who should act and why, then the note itself. Never a compose box (decision 6). */
export function wsNotePanel(t, { actions = null, decide = null } = {}) {
  const keep = t.invoice_refs || [];
  const text = maskSensitive(t.review?.draft?.text || t.result?.text || '', keep);
  const who = /Action for:\s*(.+)/.exec(text)?.[1]?.trim() || (t.decision?.act_by ? personName(t.decision.act_by) : 'Accounts Payable');
  const what = /What to do:\s*(.+)/.exec(text)?.[1]?.trim() || null;
  return h('section', { class: 'ws-note', 'aria-label': 'Internal note' },
    h('header', { class: 'ws-note-head' }, icon('lock'), h('span', null, 'Internal note'), h('span', { class: 'ws-note-sub' }, 'Nothing goes to the sender. Conductor never writes a vendor reply on this ticket.')),
    h('dl', { class: 'ws-note-facts' },
      h('dt', null, 'Who should act'), h('dd', null, who, t.decision?.act_by ? h('span', { class: 'ws-note-email' }, ` (${t.decision.act_by})`) : null),
      what ? [h('dt', null, 'What to do'), h('dd', null, what)] : null,
      t.decision?.why ? [h('dt', null, 'Why'), h('dd', null, sentence(t.decision.why))] : null),
    h('details', { class: 'ws-note-full' }, h('summary', null, 'Full note'), h('pre', { class: 'ws-note-text' }, text)),
    decide, actions);
}
const sentence = (s) => { const x = String(s || '').trim(); return x ? x[0].toUpperCase() + x.slice(1) + (/[.!?]$/.test(x) ? '' : '.') : ''; };

/** The CFO's Decide panel for a note: acknowledge with the action taken, or close. */
export function wsDecidePanel({ onDecide, category } = {}) {
  let choice = 'acknowledged';
  const name = `ws-decide-${Math.random().toString(36).slice(2, 8)}`;
  const action = h('textarea', { class: 'c-input c-textarea ws-decide-text', rows: '3', id: `${name}-a`, maxlength: '2000',
    placeholder: category === 'fraud' ? 'For example: called the vendor on the number in NetSuite; the request was not genuine.' : 'For example: approved the late fee waiver with the agency lead.' });
  const note = h('textarea', { class: 'c-input c-textarea ws-decide-text', rows: '2', id: `${name}-n`, maxlength: '2000', placeholder: 'Optional' });
  const err = h('p', { class: 'c-field-error', role: 'alert', hidden: true }, icon('circle-alert', 'icon-sm'), h('span'));
  const radio = (value, label, help) => h('label', { class: 'ws-decide-opt' },
    h('input', { type: 'radio', name, value, checked: value === choice ? true : null, onchange: () => { choice = value; paint(); } }),
    h('span', null, h('strong', null, label), h('span', { class: 'ws-decide-help' }, help)));
  const actionField = h('div', { class: 'c-field' }, h('label', { class: 'c-field-label', for: action.id }, 'Action taken', h('span', { class: 'c-field-req', 'aria-hidden': 'true' }, ' *')), action);
  const noteField = h('div', { class: 'c-field' }, h('label', { class: 'c-field-label', for: note.id }, 'Note'), note);
  const submit = button({ label: 'Record decision', variant: 'primary', icon: 'check' });
  function paint() { actionField.hidden = choice !== 'acknowledged'; submit.querySelector('.c-btn-label').textContent = choice === 'acknowledged' ? 'Acknowledge' : 'Close ticket'; }
  submit.addEventListener('click', async () => {
    const a = action.value.trim();
    if (choice === 'acknowledged' && !a) { err.hidden = false; err.lastChild.textContent = 'Say what action was taken.'; action.focus(); return; }
    err.hidden = true;
    setBusy(submit, true);
    try { await onDecide?.(choice, choice === 'acknowledged' ? a : '', note.value.trim()); }
    catch (e) { err.hidden = false; err.lastChild.textContent = e.message || 'The decision was not recorded.'; }
    finally { if (submit.isConnected) setBusy(submit, false); }
  });
  const el = h('section', { class: 'ws-decide', 'aria-label': 'Decide' },
    h('h3', { class: 'ws-decide-title' }, 'Decide'),
    h('div', { class: 'ws-decide-opts', role: 'radiogroup', 'aria-label': 'Decision' },
      radio('acknowledged', 'Acknowledge', 'Record what was done. Zendesk is set to Pending with an internal note.'),
      radio('closed', 'Close', 'Nothing more to do on this ticket.')),
    actionField, noteField, err, h('div', { class: 'ws-decide-foot' }, submit));
  paint();
  return el;
}

/** "What was off?" - one click after an edited draft is approved. */
export function wsFeedback({ onPick, categories } = {}) {
  const labels = { tone: 'Tone', facts: 'Facts', missing_info: 'Missing info', other: 'Other' };
  const cats = (categories && categories.length ? categories : Object.keys(labels)).filter((c) => labels[c]);
  const el = h('div', { class: 'ws-feedback', role: 'group', 'aria-label': 'What was off with the draft?' },
    h('span', { class: 'ws-feedback-q' }, icon('message-q'), 'You edited the draft. What was off?'),
    h('div', { class: 'ws-feedback-opts' }, cats.map((c) => button({
      label: labels[c], size: 'sm', variant: 'secondary',
      onClick: async (e) => {
        const btn = e.currentTarget;
        setBusy(btn, true);
        try {
          await onPick?.(c);
          el.replaceChildren(h('span', { class: 'ws-feedback-done', role: 'status' }, icon('circle-check'), 'Thanks. This helps Conductor write better drafts.'));
        } catch (err) { setBusy(btn, false); btn.title = err.message || 'Not saved'; }
      },
    }))));
  return el;
}

/** A plain status line inside the action bar. */
export const wsStatus = (text, tone = 'neutral') => badge({ label: text, tone });
