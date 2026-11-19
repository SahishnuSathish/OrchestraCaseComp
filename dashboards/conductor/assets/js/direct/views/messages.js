// Messages (tier 2). Interim view: the heading only, until the full view lands.
import { h } from '../../lib.js';
import { pageHead } from '../components/page.js';

export function mount(root) {
  const head = pageHead({ title: 'Messages' });
  root.replaceChildren(h('div', { class: 'dx-page' }, head));
  return { heading: head.heading };
}
