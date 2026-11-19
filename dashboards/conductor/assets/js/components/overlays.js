// Floating layers: menus, modals, toasts and the top progress bar. These are the only surfaces with a shadow.
import { h, icon } from '../lib.js';
import { nextId } from './controls.js';

// ---------------------------------------------------------------------------- menu
let openState = null; // { pop, anchor, close }

/**
 * openMenu({ anchor, items, align, label, onClose }) - show a menu under `anchor` (fixed, flips to fit the viewport).
 * item: { label, icon, onSelect, href, danger, disabled, hint, checked } | { separator: true } | { heading: 'Text' } | { node }
 */
export function openMenu({ anchor, items, align = 'start', label, onClose, width } = {}) {
  closeMenu();
  const pop = h('div', { class: 'c-menu', role: 'menu', 'aria-label': label || null, tabindex: '-1' });
  if (width) pop.style.width = `${width}px`;
  const focusables = [];
  for (const it of items) {
    if (!it) continue;
    if (it.separator) { pop.append(h('div', { class: 'c-menu-sep', role: 'separator' })); continue; }
    if (it.heading) { pop.append(h('div', { class: 'c-menu-heading', role: 'presentation' }, it.heading)); continue; }
    if (it.node) { pop.append(h('div', { class: 'c-menu-node', role: 'presentation' }, it.node)); continue; }
    const kids = [it.icon ? icon(it.icon) : h('span', { class: 'c-menu-icon-gap' }), h('span', { class: 'c-menu-label' }, it.label),
      it.hint ? h('span', { class: 'c-menu-hint' }, it.hint) : null, it.checked ? icon('check', 'c-menu-check') : null];
    const role = it.checked != null ? 'menuitemcheckbox' : 'menuitem';
    const cls = `c-menu-item${it.danger ? ' is-danger' : ''}`;
    const el = it.href
      ? h('a', { class: cls, role, href: it.href, tabindex: '-1', 'aria-checked': it.checked != null ? String(!!it.checked) : null, onclick: () => closeMenu() }, ...kids)
      : h('button', {
        class: cls, role, type: 'button', tabindex: '-1', disabled: it.disabled || null, 'aria-checked': it.checked != null ? String(!!it.checked) : null,
        onclick: () => { closeMenu({ refocus: true }); it.onSelect?.(); },
      }, ...kids);
    if (!it.disabled) focusables.push(el);
    pop.append(el);
  }
  document.body.append(pop);
  place(pop, anchor, align);

  const onKey = (e) => {
    const i = focusables.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu({ refocus: true }); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); focusables[(i + 1) % focusables.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusables[(i - 1 + focusables.length) % focusables.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); focusables[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); focusables[focusables.length - 1]?.focus(); }
    else if (e.key === 'Tab') closeMenu();
  };
  const onDown = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  const onWin = () => closeMenu();
  pop.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('resize', onWin);
  window.addEventListener('scroll', onWin, true);
  anchor.setAttribute('aria-expanded', 'true');

  const close = ({ refocus = false } = {}) => {
    pop.remove();
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('resize', onWin);
    window.removeEventListener('scroll', onWin, true);
    anchor.setAttribute('aria-expanded', 'false');
    if (refocus) anchor.focus({ preventScroll: true });
    onClose?.();
  };
  openState = { pop, anchor, close };
  (focusables[0] || pop).focus({ preventScroll: true });
  return pop;
}

/** Close whichever menu is open. */
export function closeMenu(opts) {
  const s = openState;
  openState = null;
  s?.close(opts);
}

function place(pop, anchor, align) {
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let left = align === 'end' ? r.right - pw : r.left;
  left = Math.max(8, Math.min(left, vw - pw - 8));
  let top = r.bottom + 4;
  let origin = 'top';
  if (top + ph > vh - 8 && r.top - ph - 4 > 8) { top = r.top - ph - 4; origin = 'bottom'; }
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(8, top)}px`;
  pop.style.maxHeight = `${vh - 16}px`;
  pop.style.transformOrigin = `${align === 'end' ? 'right' : 'left'} ${origin}`;
}

/**
 * menu({ label, icon, items, align, variant, size, iconOnly, trigger }) - a button that opens a menu.
 * Returns the trigger button. `items` may be a function, called each time the menu opens.
 */
export function menu({ label, icon: iconName = null, items, align = 'start', variant = 'secondary', size = 'md', iconOnly = false, caret = !iconOnly, trigger } = {}) {
  const btn = trigger || h('button', {
    class: ['c-btn', `c-btn-${variant}`, iconOnly && 'c-btn-icon', size !== 'md' && `c-btn-${size}`].filter(Boolean).join(' '),
    type: 'button', 'aria-label': iconOnly ? label : null, title: iconOnly ? label : null,
  }, iconName ? icon(iconName) : null, iconOnly ? null : h('span', { class: 'c-btn-label' }, label), caret ? icon('chev-down', 'c-btn-caret') : null);
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', () => {
    if (openState?.anchor === btn) { closeMenu(); return; }
    openMenu({ anchor: btn, items: typeof items === 'function' ? items() : items, align, label });
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && openState?.anchor !== btn) { e.preventDefault(); btn.click(); }
  });
  return btn;
}

// ---------------------------------------------------------------------------- modal
/**
 * modal({ title, description, body, actions, size, onClose, dismissible, label })
 * Opens a native <dialog> (focus is trapped, Escape closes, focus returns to the opener) and returns it.
 * body and actions may be nodes or functions (dlg) => nodes. Call dlg.close() to close it. size: sm | md | lg.
 */
export function modal({ title, description, body, actions, size = 'md', onClose, dismissible = true, label, class: cls } = {}) {
  const titleId = nextId('dlg');
  const descId = description ? nextId('dlgd') : null;
  const opener = document.activeElement;
  const dlg = h('dialog', {
    class: ['c-modal', `c-modal-${size}`, cls].filter(Boolean).join(' '),
    'aria-labelledby': title ? titleId : null, 'aria-label': title ? null : label, 'aria-describedby': descId,
  });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onClose?.();
    setTimeout(() => dlg.remove(), 220);
    if (opener && document.contains(opener)) opener.focus?.({ preventScroll: true });
  };
  const nativeClose = dlg.close.bind(dlg);
  dlg.close = (v) => { if (dlg.open) nativeClose(v); finish(); };
  dlg.addEventListener('close', finish);
  dlg.addEventListener('cancel', (e) => { if (!dismissible) e.preventDefault(); });
  if (dismissible) dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop

  const resolve = (x) => (typeof x === 'function' ? x(dlg) : x);
  const head = title ? h('header', { class: 'c-modal-head' },
    h('div', { class: 'c-modal-titles' }, h('h2', { class: 'c-modal-title', id: titleId }, title),
      description ? h('p', { class: 'c-modal-desc', id: descId }, description) : null),
    dismissible ? h('button', { class: 'c-btn c-btn-quiet c-btn-icon c-btn-sm', type: 'button', 'aria-label': 'Close', title: 'Close', onclick: () => dlg.close() }, icon('x')) : null) : null;
  const acts = resolve(actions);
  dlg.append(h('div', { class: 'c-modal-frame' }, head, h('div', { class: 'c-modal-body' }, resolve(body)),
    acts ? h('footer', { class: 'c-modal-foot' }, acts) : null));
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// ---------------------------------------------------------------------------- toast
function region() {
  let r = document.getElementById('c-toasts');
  if (!r) {
    r = h('div', { id: 'c-toasts', class: 'c-toasts', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false', 'aria-relevant': 'additions' });
    document.body.append(r);
  }
  return r;
}

/**
 * toast({ message, title, tone, actionLabel, onAction, duration }) - a short notice in the live region (announced politely).
 * tone: neutral | settled | risk. Pauses while hovered or focused, and while the tab is hidden. Returns close().
 */
export function toast({ message, title, tone = 'neutral', actionLabel, onAction, duration = 5000 } = {}) {
  const root = region();
  while (root.children.length >= 3) root.firstElementChild.remove();
  const ic = { settled: 'circle-check', risk: 'alert', neutral: 'info', info: 'bell' }[tone] || 'info';
  let timer = 0;
  let left = duration;
  let started = 0;
  const el = h('div', { class: `c-toast c-toast-${tone}` },
    icon(ic, 'c-toast-icon'),
    h('div', { class: 'c-toast-body' }, title ? h('strong', null, title) : null, h('span', null, message)),
    actionLabel ? h('button', { class: 'c-toast-action', type: 'button', onclick: () => { onAction?.(); close(); } }, actionLabel) : null,
    h('button', { class: 'c-toast-close', type: 'button', 'aria-label': 'Dismiss', onclick: () => close() }, icon('x')));
  const run = () => { if (!duration || document.hidden) return; started = Date.now(); timer = setTimeout(close, left); };
  const pause = () => { if (!timer) return; clearTimeout(timer); timer = 0; left -= Date.now() - started; };
  const onVis = () => (document.hidden ? pause() : run());
  function close() {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVis);
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 160);
  }
  el.addEventListener('pointerenter', pause);
  el.addEventListener('pointerleave', () => { if (!el.contains(document.activeElement)) run(); });
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) run(); });
  document.addEventListener('visibilitychange', onVis);
  root.append(el);
  run();
  return close;
}

// ---------------------------------------------------------------------------- top progress bar
let bar = null;
let depth = 0;
let showTimer = 0;
let trickle = 0;
let value = 0;

function ensureBar() {
  if (bar) return bar;
  bar = h('div', { class: 'c-progress', role: 'progressbar', 'aria-label': 'Loading page', 'aria-hidden': 'true' }, h('span', { class: 'c-progress-fill' }));
  document.body.append(bar);
  return bar;
}
function setValue(v) {
  value = v;
  ensureBar().firstElementChild.style.transform = `scaleX(${v})`;
}

/** progress.start() / progress.done() - the slim bar at the very top for navigation and long loads. Calls nest. Appears only after 120 ms, so quick loads never flash. */
export const progress = {
  start() {
    depth += 1;
    if (depth > 1) return;
    ensureBar();
    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      bar.classList.add('is-active');
      bar.removeAttribute('aria-hidden');
      setValue(0.15);
      clearInterval(trickle);
      trickle = setInterval(() => setValue(Math.min(0.9, value + (0.9 - value) * 0.12)), 200);
    }, 120);
  },
  done() {
    depth = Math.max(0, depth - 1);
    if (depth) return;
    clearTimeout(showTimer);
    clearInterval(trickle);
    if (!bar || !bar.classList.contains('is-active')) return;
    setValue(1);
    setTimeout(() => { bar.classList.remove('is-active'); bar.setAttribute('aria-hidden', 'true'); setTimeout(() => setValue(0), 200); }, 180);
  },
  /** Wrap a promise: progress.track(fetchSomething()) */
  async track(promise) {
    progress.start();
    try { return await promise; } finally { progress.done(); }
  },
};
