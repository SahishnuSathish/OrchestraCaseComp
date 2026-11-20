// Product marks, lockups and taglines for the Conductor family. Our own drawings; no third-party logos.
// One construction for the whole family (see docs/ui-upgrade/BRAND.md): a rounded field, three printed staff lines
// and one line that swells out of the lowest one and rises across the staff (a crescendo, the conductor's sweep).
//   Conductor           staff workspace   mint field on green chrome (green field on paper)
//   Conductor: Direct   vendor dashboard  sky field on navy chrome (navy field on paper)
//   Conductor: Ahead    proactive notices mint field; the staff lines fall back and the sweep runs ahead of the score
// Drawn on a 32-unit grid: the staff lines sit on even units, so at 16 px they land on whole pixels.
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

// The geometry, shared with the favicons in /static/brand/ and the specimen in docs/ui-upgrade/brand/.
const STAFF_Y = [8, 14, 20];                       // three staff lines, 2 units thick, 4 units apart
const STAFF_W = { conductor: [22, 22, 22], direct: [22, 22, 22], ahead: [16, 13, 8] };
const SWEEP = 'M5 26C15 26 22.5 20.5 27.4 8.4L23.2 6.6C19 17.5 12.5 23.6 5 24.4Z';

/** The product mark (a 32-unit square). product: conductor | direct | ahead. Decorative unless `label` is given. */
export function mark({ product = 'conductor', size = 28, label = null } = {}) {
  const el = svg('svg', {
    class: `c-mark c-mark-${product}`, viewBox: '0 0 32 32', width: size, height: size, focusable: 'false',
    ...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' }),
  });
  const widths = STAFF_W[product] || STAFF_W.conductor;
  el.append(
    svg('rect', { class: 'c-mark-bg', width: 32, height: 32, rx: 7 }),
    svg('g', { class: 'c-mark-staff' }, ...STAFF_Y.map((y, i) => svg('rect', { x: 5, y, width: widths[i], height: 2 }))),
    svg('path', { class: 'c-mark-sweep', d: SWEEP }),
  );
  if (product === 'ahead') {
    // a mint field on a pale page needs an edge; drawn inside the field so the outline never grows the mark
    el.append(svg('rect', { class: 'c-mark-edge', x: 0.5, y: 0.5, width: 31, height: 31, rx: 6.5, fill: 'none' }));
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
    mark({ product, size: size === 'lg' ? 36 : size === 'sm' ? 20 : 28 }),
    h('span', { class: 'c-lockup-words', 'aria-hidden': 'true' },
      orchestra ? h('span', { class: 'c-lockup-parent' }, 'Orchestra') : null,
      orchestra ? h('span', { class: 'c-lockup-rule' }) : null,
      h('span', { class: 'c-lockup-product' }, name)),
    h('span', { class: 'sr-only' }, label),
  ];
  const cls = `c-lockup c-lockup-${tone} c-lockup-${size} c-lockup-for-${product}`;
  return href ? h('a', { class: cls, href }, ...kids) : h('span', { class: cls }, ...kids);
}
