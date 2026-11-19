// Leadership charts. One form: ranked horizontal bars on a shared baseline (a meter list), per the dataviz method:
// thin bars (12px, never over 24), a 4px rounded data end and a square baseline, the value at the tip in text ink,
// a hover and focus tooltip on each bar, and a table view twin. Bars are one neutral hue (slate); a status tone is
// used only where the bar means a state (for example, past the case baseline), and then it also carries words.
import { h, icon } from '../../lib.js';
import { nextId } from '../controls.js';

let tip = null;
function tooltip() {
  if (!tip) {
    tip = h('div', { class: 'lv-tip', role: 'tooltip', id: 'lv-tip', hidden: true });
    document.body.append(tip);
  }
  return tip;
}
function showTip(anchor, value, label, note) {
  const t = tooltip();
  t.replaceChildren(h('strong', null, value), h('span', null, label), note ? h('span', { class: 'lv-tip-note' }, note) : null);
  t.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = t.offsetWidth;
  const vw = document.documentElement.clientWidth;
  t.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - w / 2, vw - w - 8))}px`;
  t.style.top = `${Math.max(8, r.top - t.offsetHeight - 8)}px`;
}
function hideTip() { if (tip) tip.hidden = true; }

/**
 * barList({ rows, label, valueLabel, format, max, empty, tableLabel })
 * rows: [{ key, label, sub, value, tone, toneLabel, note, href }]. tone: undefined (slate) | waiting | risk | settled.
 * Returns a figure with the bars and a "Show table" toggle that swaps to an equivalent table.
 */
export function barList({ rows = [], label, valueLabel = 'Count', format = (v) => Number(v || 0).toLocaleString('en-US'), max, empty, tableLabel } = {}) {
  const top = Math.max(1, max ?? Math.max(0, ...rows.map((r) => Number(r.value) || 0)));
  const figId = nextId('fig');
  if (!rows.length) return empty || h('p', { class: 'lv-muted' }, 'Nothing to show yet.');

  const bars = h('ol', { class: 'lv-bars', 'aria-label': label },
    rows.map((r) => {
      const v = Number(r.value) || 0;
      const pct = v <= 0 ? 0 : Math.max(1.5, (v / top) * 100);
      const valueText = format(v, r);
      const aria = `${r.label}${r.sub ? `, ${r.sub}` : ''}: ${valueText}${r.toneLabel ? `, ${r.toneLabel}` : ''}`;
      const name = r.href
        ? h('a', { class: 'lv-bar-name', href: r.href }, r.label)
        : h('span', { class: 'lv-bar-name' }, r.label);
      const track = h('span', {
        class: 'lv-bar-track', tabindex: '0', role: 'img', 'aria-label': aria,
        onpointerenter: (e) => showTip(e.currentTarget, valueText, r.label, r.note || r.toneLabel),
        onpointerleave: hideTip,
        onfocus: (e) => showTip(e.currentTarget, valueText, r.label, r.note || r.toneLabel),
        onblur: hideTip,
      }, h('span', { class: `lv-bar${r.tone ? ` lv-bar-${r.tone}` : ''}`, style: { width: `${pct}%` } }));
      return h('li', { class: 'lv-bar-row' },
        h('span', { class: 'lv-bar-label' }, name, r.sub ? h('span', { class: 'lv-bar-sub' }, r.sub) : null),
        track,
        h('span', { class: 'lv-bar-value' }, valueText,
          r.toneLabel ? h('span', { class: `lv-bar-flag lv-flag-${r.tone || 'neutral'}` }, r.tone === 'risk' || r.tone === 'waiting' ? icon('clock', 'icon-sm') : null, r.toneLabel) : null));
    }));

  const tbl = h('table', { class: 'c-table c-table-dense lv-bars-table', hidden: true },
    h('caption', { class: 'sr-only' }, tableLabel || label),
    h('thead', null, h('tr', null, h('th', { scope: 'col', class: 'is-start' }, 'Item'), h('th', { scope: 'col', class: 'is-end' }, valueLabel))),
    h('tbody', null, rows.map((r) => h('tr', null,
      h('td', { class: 'is-start' }, r.label, r.sub ? h('span', { class: 'lv-muted' }, ` · ${r.sub}`) : null, r.toneLabel ? h('span', { class: 'lv-muted' }, ` · ${r.toneLabel}`) : null),
      h('td', { class: 'is-end num' }, format(Number(r.value) || 0, r))))));

  const toggle = h('button', { class: 'lv-linkbtn', type: 'button', 'aria-controls': figId, 'aria-pressed': 'false' }, 'Show table');
  toggle.addEventListener('click', () => {
    const asTable = tbl.hidden;
    tbl.hidden = !asTable;
    bars.hidden = asTable;
    toggle.setAttribute('aria-pressed', String(asTable));
    toggle.textContent = asTable ? 'Show bars' : 'Show table';
  });
  return h('figure', { class: 'lv-figure', id: figId }, bars, tbl, h('figcaption', { class: 'lv-figure-foot' }, toggle));
}

/**
 * compare({ items, unit, label }) - two or three values on one scale (for example "now" against a baseline).
 * items: [{ label, value, display, tone, note }]. Same bar marks as barList, no table toggle (the values are printed).
 */
export function compare({ items = [], label, max } = {}) {
  const top = Math.max(0.0001, max ?? Math.max(...items.map((i) => Number(i.value) || 0)));
  return h('div', { class: 'lv-compare', role: 'group', 'aria-label': label },
    items.map((it) => {
      const v = Number(it.value);
      const known = it.value != null && !Number.isNaN(v);
      return h('div', { class: 'lv-compare-row' },
        h('span', { class: 'lv-compare-label' }, it.label),
        h('span', { class: 'lv-bar-track', role: 'img', 'aria-label': `${it.label}: ${it.display}` },
          known ? h('span', { class: `lv-bar${it.tone ? ` lv-bar-${it.tone}` : ''}`, style: { width: `${Math.max(1.5, (v / top) * 100)}%` } }) : null),
        h('span', { class: 'lv-bar-value' }, it.display));
    }));
}
