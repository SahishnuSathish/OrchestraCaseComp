// Buttons and form fields. Every control has a visible label or an aria-label.
import { h, icon } from '../lib.js';

let uid = 0;
export const nextId = (prefix = 'c') => `${prefix}-${++uid}`;

/**
 * button({ label, variant, size, icon, iconAfter, onClick, type, disabled, busy, href, title, attrs })
 * variant: primary | secondary | quiet | danger. size: sm | md | lg.
 * With `href` it renders a link styled as a button.
 */
export function button({
  label, variant = 'secondary', size = 'md', icon: iconName, iconAfter, onClick, type = 'button',
  disabled = false, busy = false, href, title, block = false, attrs = {},
} = {}) {
  const cls = ['c-btn', `c-btn-${variant}`, size !== 'md' && `c-btn-${size}`, block && 'c-btn-block', busy && 'is-busy'].filter(Boolean).join(' ');
  const kids = [
    busy ? h('span', { class: 'c-spinner', 'aria-hidden': 'true' }) : iconName ? icon(iconName) : null,
    label != null ? h('span', { class: 'c-btn-label' }, label) : null,
    iconAfter ? icon(iconAfter) : null,
  ];
  if (href) {
    return h('a', { class: cls, href, title, 'aria-disabled': disabled ? 'true' : null, ...attrs }, ...kids);
  }
  return h('button', {
    class: cls, type, title, disabled: disabled || null, 'aria-busy': busy ? 'true' : null, onclick: onClick, ...attrs,
  }, ...kids);
}

/** iconButton({ icon, label, variant, size, onClick, pressed, badge }) - square button; `label` becomes its accessible name and tooltip. */
export function iconButton({ icon: iconName, label, variant = 'quiet', size = 'md', onClick, pressed, badge, disabled = false, attrs = {} } = {}) {
  const cls = ['c-btn', `c-btn-${variant}`, 'c-btn-icon', size !== 'md' && `c-btn-${size}`].filter(Boolean).join(' ');
  return h('button', {
    class: cls, type: 'button', 'aria-label': label, title: label, onclick: onClick, disabled: disabled || null,
    'aria-pressed': pressed == null ? null : String(!!pressed), ...attrs,
  }, icon(iconName), badge ? h('span', { class: 'c-btn-badge', 'aria-hidden': 'true' }, badge) : null);
}

/** Toggle a button's busy state in place (spinner + aria-busy, keeps its width). */
export function setBusy(btn, busy) {
  btn.classList.toggle('is-busy', !!busy);
  btn.toggleAttribute('aria-busy', !!busy);
  btn.disabled = !!busy;
  const first = btn.firstElementChild;
  if (busy && !btn.querySelector('.c-spinner')) btn.prepend(h('span', { class: 'c-spinner', 'aria-hidden': 'true' }));
  if (!busy) btn.querySelector('.c-spinner')?.remove();
  if (first?.classList?.contains('icon')) first.style.display = busy ? 'none' : '';
}

/**
 * field({ label, type, name, value, placeholder, options, rows, help, error, required, hideLabel, onInput, onChange, attrs })
 * type: text | email | search | number | password | date | select | textarea.
 * options (select): [{ value, label }] or strings. Returns div.c-field; the control is `node.control`.
 */
export function field({
  label, type = 'text', name, id = nextId('f'), value, placeholder, options = [], rows = 4, help, error,
  required = false, hideLabel = false, disabled = false, onInput, onChange, prefix, attrs = {},
} = {}) {
  const helpId = help ? `${id}-help` : null;
  const errId = `${id}-err`;
  const describedBy = [helpId, error ? errId : null].filter(Boolean).join(' ') || null;
  const common = {
    id, name, required: required || null, disabled: disabled || null, 'aria-describedby': describedBy,
    'aria-invalid': error ? 'true' : null, oninput: onInput, onchange: onChange, ...attrs,
  };
  let control;
  if (type === 'select') {
    control = h('select', { class: 'c-input c-select', ...common },
      options.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        return h('option', { value: opt.value, selected: String(opt.value) === String(value) ? true : null }, opt.label);
      }));
  } else if (type === 'textarea') {
    control = h('textarea', { class: 'c-input c-textarea', rows, placeholder, ...common });
    if (value != null) control.value = value;
  } else {
    control = h('input', { class: 'c-input', type, placeholder, value: value ?? null, ...common });
  }
  const node = h('div', { class: `c-field${error ? ' has-error' : ''}` },
    h('label', { class: `c-field-label${hideLabel ? ' sr-only' : ''}`, for: id }, label, required ? h('span', { class: 'c-field-req', 'aria-hidden': 'true' }, ' *') : null),
    prefix ? h('div', { class: 'c-input-wrap has-prefix' }, h('span', { class: 'c-input-prefix', 'aria-hidden': 'true' }, typeof prefix === 'string' ? icon(prefix) : prefix), control) : control,
    help ? h('p', { class: 'c-field-help', id: helpId }, help) : null,
    h('p', { class: 'c-field-error', id: errId, role: 'alert', hidden: error ? null : true }, icon('circle-alert', 'icon-sm'), h('span', null, error || '')));
  node.control = control;
  return node;
}

/** Show or clear a field's error message (null clears). */
export function setFieldError(fieldNode, message) {
  const err = fieldNode.querySelector('.c-field-error');
  const ctl = fieldNode.control;
  const helpId = fieldNode.querySelector('.c-field-help')?.id;
  fieldNode.classList.toggle('has-error', !!message);
  err.hidden = !message;
  err.querySelector('span').textContent = message || '';
  ctl.setAttribute('aria-invalid', message ? 'true' : 'false');
  ctl.setAttribute('aria-describedby', [helpId, message ? err.id : null].filter(Boolean).join(' '));
}

/** checkbox({ label, checked, onChange, help }) - a labelled checkbox row. */
export function checkbox({ label, name, checked = false, onChange, help, id = nextId('cb') } = {}) {
  const input = h('input', { type: 'checkbox', class: 'c-check-input', id, name, checked: checked || null, onchange: onChange });
  const node = h('label', { class: 'c-check', for: id }, input, h('span', { class: 'c-check-box', 'aria-hidden': 'true' }, icon('check')),
    h('span', { class: 'c-check-text' }, h('span', null, label), help ? h('span', { class: 'c-field-help' }, help) : null));
  node.control = input;
  return node;
}
