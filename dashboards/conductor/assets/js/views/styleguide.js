// Phase 3 seam stub. Owner: p3/design-shell. Contract: docs/phase3/CONTRACTS.md section 12.
import { h, mount as fill } from '../lib.js';

export function mount(root) {
  fill(root, h('div', { class: 'page' }, h('p', {}, 'Loading')));
  return {};
}
