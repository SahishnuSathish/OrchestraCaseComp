// Fallback for any address the router does not know.
import { h, mount as fill } from '../lib.js';
import { empty } from '../components/data.js';
import { button } from '../components/controls.js';
import { homeHash } from '../router.js';

export function mount(root) {
  fill(root, h('div', { class: 'page' }, empty({
    icon: 'circle-alert', title: 'Page not found', text: 'That address does not match anything in Conductor.',
    actions: button({ label: 'Go to your home page', variant: 'primary', icon: 'arrow-left', href: homeHash() }),
  })));
  return {};
}
