// questionForm({ invoice }) - a short question about one invoice. It becomes a ticket in the staff inbox;
// a person approves the answer, which then appears in Messages and by email. Nothing reaches the vendor without a person.
import { h, icon } from '../../lib.js';
import { field, button, setBusy, setFieldError } from '../../components/index.js';
import * as direct from '../../api-direct.js';
import { format } from '../routes.js';

const MAX = 2000;
const fmt = (n) => n.toLocaleString('en-US');

export function questionForm({ invoice } = {}) {
  const live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const wrap = h('div', { class: 'dx-question' });

  function showForm(initial = '') {
    const text = field({
      label: 'Your question', type: 'textarea', rows: 4, value: initial,
      help: 'Please do not include bank details. Bank changes are handled by phone with our team.',
      attrs: { maxlength: String(MAX), autocomplete: 'off' },
      onInput: () => { count(); if (text.classList.contains('has-error')) setFieldError(text, null); },
    });
    const counter = h('span', { class: 'dx-counter num', id: `${text.control.id}-count` });
    text.control.setAttribute('aria-describedby', `${text.control.getAttribute('aria-describedby') || ''} ${counter.id}`.trim());
    const send = button({ label: 'Send question', variant: 'primary', type: 'submit', icon: 'send' });
    const form = h('form', { class: 'dx-question-form', novalidate: true },
      text,
      h('div', { class: 'dx-question-foot' }, counter, send));

    function count() {
      const n = text.control.value.length;
      counter.textContent = `${fmt(n)} of ${fmt(MAX)} characters`;
      counter.classList.toggle('is-near', n > MAX - 200);
    }
    count();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = text.control.value.trim();
      if (!value) { setFieldError(text, 'Please write your question.'); text.control.focus(); return; }
      if (value.length > MAX) { setFieldError(text, `Please keep your question under ${fmt(MAX)} characters.`); text.control.focus(); return; }
      setBusy(send, true);
      try {
        const r = await direct.askQuestion(invoice, value);
        showDone(r?.message || 'Thanks. Our team will reply here and by email.');
      } catch (err) {
        setBusy(send, false);
        setFieldError(text, err?.status === 404 ? "We couldn't find that invoice." : (typeof err?.detail === 'string' ? err.detail : "Your question wasn't sent. Please try again."));
        text.control.focus();
      }
    });
    wrap.replaceChildren(form, live);
  }

  function showDone(message) {
    const again = button({ label: 'Ask another question', variant: 'quiet', size: 'sm', onClick: () => { showForm(); wrap.querySelector('textarea')?.focus(); } });
    const done = h('div', { class: 'dx-question-done', tabindex: '-1' },
      icon('circle-check', 'dx-question-done-icon'),
      h('div', null,
        h('p', { class: 'dx-question-done-title' }, message),
        h('p', { class: 'dx-muted' }, 'A person on our team will check the answer before it is sent. You will find it in ',
          h('a', { href: format({ section: 'messages' }) }, 'Messages'), '.'),
        again));
    wrap.replaceChildren(done, live);
    live.textContent = message;
    done.focus({ preventScroll: true });
  }

  showForm();
  wrap.destroy = () => {};
  return wrap;
}
