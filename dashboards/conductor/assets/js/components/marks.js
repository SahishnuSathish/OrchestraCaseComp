// Product marks, lockups and taglines for the Conductor family. Our own drawings; no third-party logos.
//   Conductor           staff workspace   baton on a mint square (green chrome)
//   Conductor: Direct   vendor dashboard  baton on a sky square (navy chrome)
//   Conductor: Ahead    proactive notices the upbeat: a rising stroke on a mint square
import { h } from '../lib.js';

export const PRODUCTS = {
  conductor: { name: 'Conductor', tagline: 'The accounts payable inbox, read and drafted from our records.' },
  direct: { name: 'Conductor: Direct', tagline: 'Invoice status for vendors, straight from our records.' },
  ahead: { name: 'Conductor: Ahead', tagline: 'Tell vendors before they ask.' },
};
export const TAGLINES = Object.fromEntries(Object.entries(PRODUCTS).map(([k, v]) => [k, v.tagline]));

const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}

/** The product mark (a 32-unit square). product: conductor | direct | ahead. Decorative unless `label` is given. */
export function mark({ product = 'conductor', size = 28, label = null } = {}) {
  const el = svg('svg', {
    class: `c-mark c-mark-${product}`, viewBox: '0 0 32 32', width: size, height: size, focusable: 'false',
    ...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' }),
  });
  el.append(svg('rect', { class: 'c-mark-bg', width: 32, height: 32 }));
  if (product === 'ahead') {
    // the upbeat: a stroke rising from the downbeat, ending forward
    el.append(
      svg('path', { class: 'c-mark-stroke', d: 'M7.5 24.5c7.6 0 12.8-5.2 15.4-14', fill: 'none', 'stroke-width': '2.4', 'stroke-linecap': 'square' }),
      svg('path', { class: 'c-mark-stroke', d: 'M17.6 11.6 23.2 9.1 25.6 14.7', fill: 'none', 'stroke-width': '2.4', 'stroke-linecap': 'square', 'stroke-linejoin': 'miter' }),
      svg('rect', { class: 'c-mark-ink', x: 5.6, y: 22.6, width: 3.8, height: 3.8 }),
    );
  } else {
    // the baton: tip top-right, handle bottom-left, and the faint arc of the beat it draws
    el.append(
      svg('path', { class: 'c-mark-arc', d: 'M25.2 15.2A9.4 9.4 0 0 1 16.4 25', fill: 'none', 'stroke-width': '1.6', 'stroke-linecap': 'square' }),
      svg('polygon', { class: 'c-mark-ink', points: '9.6,20.8 11.9,23.1 24.9,8.6 23.9,7.6' }),
      svg('rect', { class: 'c-mark-ink', x: 6.6, y: 21.4, width: 5.2, height: 5.2, transform: 'rotate(45 9.2 24)' }),
    );
  }
  return el;
}

/**
 * The lockup: [mark] Orchestra | Conductor (or Conductor: Direct / Conductor: Ahead).
 * tone: 'dark' on green or navy chrome, 'light' on paper. orchestra: false drops the parent name.
 */
export function lockup({ product = 'conductor', tone = 'light', orchestra = true, size = 'md', href = null } = {}) {
  const name = PRODUCTS[product]?.name || PRODUCTS.conductor.name;
  const label = orchestra ? `Orchestra ${name}` : name;
  const kids = [
    mark({ product, size: size === 'lg' ? 36 : size === 'sm' ? 22 : 28 }),
    h('span', { class: 'c-lockup-words', 'aria-hidden': 'true' },
      orchestra ? h('span', { class: 'c-lockup-parent' }, 'Orchestra') : null,
      orchestra ? h('span', { class: 'c-lockup-rule' }) : null,
      h('span', { class: 'c-lockup-product' }, name)),
    h('span', { class: 'sr-only' }, label),
  ];
  const cls = `c-lockup c-lockup-${tone} c-lockup-${size} c-lockup-for-${product}`;
  return href ? h('a', { class: cls, href }, ...kids) : h('span', { class: cls }, ...kids);
}
