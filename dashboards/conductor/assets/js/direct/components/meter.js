// meter({ label }) - a determinate progress bar for an upload. node.set(fraction 0..1), node.reset().
// It is a real progressbar (aria-valuenow); the view announces milestones through its own live region.
import { h } from '../../lib.js';

export function meter({ label = 'Upload progress' } = {}) {
  const fill = h('span', { class: 'dx-meter-fill' });
  const pct = h('span', { class: 'dx-meter-pct num', 'aria-hidden': 'true' }, '0%');
  const bar = h('div', { class: 'dx-meter-track', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fill);
  const node = h('div', { class: 'dx-meter' }, bar, pct);
  node.set = (f) => {
    const v = Math.max(0, Math.min(100, Math.round((f || 0) * 100)));
    fill.style.transform = `scaleX(${v / 100})`;
    bar.setAttribute('aria-valuenow', String(v));
    pct.textContent = `${v}%`;
  };
  node.reset = () => node.set(0);
  return node;
}
