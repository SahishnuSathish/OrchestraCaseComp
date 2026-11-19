// Shared by views/tickets.js and views/review.js: finish the redirect of an old run link once the inbox run is known.
import { h, mount as fill } from '../../lib.js';
import { inboxRunId } from '../../api-inbox.js';
import { navigate, runLinkTarget, rememberInboxRunId, homeHash } from '../../router.js';
import { reading, empty } from '../data.js';
import { button } from '../controls.js';

export function redirectRunLink(root, route) {
  let live = true;
  fill(root, h('div', { class: 'page' }, reading({ text: 'Opening the inbox…' })));
  inboxRunId().then((id) => {
    if (!live) return;
    rememberInboxRunId(id);
    navigate(runLinkTarget(route, id), { replace: true });
  }, (e) => {
    if (!live) return;
    fill(root, h('div', { class: 'page' }, empty({ icon: 'circle-alert', title: 'This link could not be opened', text: e.message || 'The inbox did not answer.',
      actions: button({ label: 'Go to your home page', variant: 'primary', href: homeHash() }) })));
  });
  return { destroy() { live = false; } };
}
