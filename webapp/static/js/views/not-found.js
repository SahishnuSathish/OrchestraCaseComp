// Fallback for any address the router does not know.
import { h, icon, mount as fill } from '../lib.js';
import { emptyState } from '../ui.js';
import { href } from '../router.js';

export function mount(root) {
  fill(root, h('div', { class: 'page' }, emptyState({
    iconName: 'circle-alert', title: 'Page not found', text: 'That address does not match anything in Conductor.',
    action: h('a', { class: 'btn btn-primary', href: href('runs') }, icon('layers'), 'Go to runs'),
  })));
  return {};
}
