// Layout: panes, resizable splits and tabs.
import { h, icon, ls } from '../lib.js';
import { nextId } from './controls.js';

/**
 * pane({ title, subtitle, actions, body, footer, flush, scroll, label, as, id, headingLevel })
 * A square surface with a hairline header. scroll: true makes the body the scroll container (for split panes).
 */
export function pane({ title, subtitle, actions, body, footer, flush = false, scroll = false, label, as = 'section', id, headingLevel = 2, class: cls } = {}) {
  const headId = title ? nextId('pane') : null;
  return h(as, { class: ['c-pane', scroll && 'is-scroll', cls].filter(Boolean).join(' '), id, 'aria-labelledby': headId, 'aria-label': !title ? label : null },
    title || actions ? h('header', { class: 'c-pane-head' },
      h('div', { class: 'c-pane-titles' },
        title ? h(`h${headingLevel}`, { class: 'c-pane-title', id: headId }, title) : null,
        subtitle ? h('p', { class: 'c-pane-sub' }, subtitle) : null),
      actions ? h('div', { class: 'c-pane-actions' }, actions) : null) : null,
    h('div', { class: `c-pane-body${flush ? ' is-flush' : ''}` }, body),
    footer ? h('footer', { class: 'c-pane-foot' }, footer) : null);
}

/**
 * split({ panes, storageKey, label }) - side-by-side panes with draggable, keyboard-operable handles.
 * panes: [{ content, size, min, max, label }]. `size` (px) applies to every pane but the last, which takes the rest.
 * Below 768px the panes stack and the handles hide. Sizes persist in localStorage under `storageKey`.
 */
export function split({ panes, storageKey = null, label = 'Resizable panes' } = {}) {
  const saved = storageKey ? safeParse(ls(storageKey)) : null;
  const sizes = panes.map((p, i) => (i < panes.length - 1 ? clamp(saved?.[i] ?? p.size ?? 320, p.min ?? 200, p.max ?? 900) : null));
  const root = h('div', { class: 'c-split', role: 'group', 'aria-label': label });
  const cells = panes.map((p) => h('div', { class: 'c-split-pane' }, p.content));
  const handles = [];

  function apply() {
    root.style.gridTemplateColumns = cells.map((_, i) => (i < cells.length - 1 ? `${sizes[i]}px auto` : 'minmax(0, 1fr)')).join(' ');
    handles.forEach((hd, i) => {
      hd.setAttribute('aria-valuenow', String(Math.round(sizes[i])));
    });
  }
  function save() { if (storageKey) ls(storageKey, JSON.stringify(sizes)); }

  cells.forEach((cell, i) => {
    root.append(cell);
    if (i === cells.length - 1) return;
    const p = panes[i];
    const min = p.min ?? 200;
    const max = p.max ?? 900;
    const handle = h('div', {
      class: 'c-split-handle', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical',
      'aria-label': `Resize ${p.label || `pane ${i + 1}`}`, 'aria-valuemin': String(min), 'aria-valuemax': String(max),
    }, h('span', { class: 'c-split-grip', 'aria-hidden': 'true' }));
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 64 : 16;
      if (e.key === 'ArrowLeft') sizes[i] = clamp(sizes[i] - step, min, max);
      else if (e.key === 'ArrowRight') sizes[i] = clamp(sizes[i] + step, min, max);
      else if (e.key === 'Home') sizes[i] = min;
      else if (e.key === 'End') sizes[i] = max;
      else return;
      e.preventDefault();
      apply(); save();
    });
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const start = sizes[i];
      root.classList.add('is-resizing');
      const move = (ev) => { sizes[i] = clamp(start + ev.clientX - startX, min, max); apply(); };
      const up = () => {
        root.classList.remove('is-resizing');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        save();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('dblclick', () => { sizes[i] = clamp(p.size ?? 320, min, max); apply(); save(); });
    handles.push(handle);
    root.append(handle);
  });
  apply();
  root.panes = cells;
  return root;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || lo));
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

/**
 * tabs({ label, items, selected, onSelect, variant, panels })
 * items: [{ id, label, count, icon, href }]. variant: line (default, for sections) | segmented (for small filters).
 * Arrow keys move between tabs (automatic activation). With href items it renders links (aria-current) instead.
 * `node.select(id)` changes the selection from code.
 */
export function tabs({ label, items = [], selected, onSelect, variant = 'line', size = 'md' } = {}) {
  const linkMode = items.some((it) => it.href);
  const root = h('div', { class: `c-tabs c-tabs-${variant}${size === 'sm' ? ' c-tabs-sm' : ''}`, role: linkMode ? null : 'tablist', 'aria-label': label });
  const btns = items.map((it) => {
    const active = it.id === selected;
    const kids = [it.icon ? icon(it.icon) : null, h('span', { class: 'c-tab-label' }, it.label),
      it.count != null ? h('span', { class: 'c-tab-count' }, it.count) : null];
    if (linkMode) return h('a', { class: 'c-tab', href: it.href, 'aria-current': active ? 'page' : null }, ...kids);
    return h('button', {
      class: 'c-tab', type: 'button', role: 'tab', id: it.tabId || null, 'aria-selected': String(active), tabindex: active ? '0' : '-1',
      'aria-controls': it.panelId || null, onclick: () => choose(it.id, true),
    }, ...kids);
  });
  function choose(id, notify) {
    items.forEach((it, i) => {
      const on = it.id === id;
      if (linkMode) btns[i].toggleAttribute('aria-current', on);
      else { btns[i].setAttribute('aria-selected', String(on)); btns[i].tabIndex = on ? 0 : -1; }
    });
    if (notify) onSelect?.(id);
  }
  if (!linkMode) {
    root.addEventListener('keydown', (e) => {
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % btns.length;
      else if (e.key === 'ArrowLeft') j = (i - 1 + btns.length) % btns.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = btns.length - 1;
      if (j == null) return;
      e.preventDefault();
      btns[j].focus();
      choose(items[j].id, true);
    });
  }
  root.append(...btns);
  root.select = (id) => choose(id, false);
  return root;
}
