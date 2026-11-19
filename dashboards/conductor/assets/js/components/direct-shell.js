// The Conductor: Direct page frame (vendor dashboard). Navy-led, outward-facing.
// It shows the Direct lockup, the vendor's company, the signed-in contact and Sign out. No staff navigation,
// no internal names, no ticket IDs. The Direct page (owner p3/direct-ui) fills `node.slot`.
import { h, icon } from '../lib.js';
import { lockup } from './marks.js';
import { avatar } from './badges.js';
import { menu } from './overlays.js';
import { ensureIcons } from './icons.js';

/**
 * directShell({ vendor, contact, onSignOut, nav, current, content })
 *   vendor:  { name, subsidiary? }      contact: { name, email }
 *   nav:     optional section links for the vendor's own pages: [{ id, label, href, count? }]
 *   current: the id of the current section
 *   content: nodes for the content slot (or fill node.slot later)
 * Returns the frame. node.slot is the <main> element; node.update({ vendor, contact, current }) refreshes the header.
 */
export function directShell({ vendor = {}, contact = {}, onSignOut, nav = [], current = null, content = null } = {}) {
  ensureIcons();
  const companyEl = h('span', { class: 'c-direct-company-name' });
  const contactSlot = h('div', { class: 'c-direct-contact' });
  const navEl = nav.length ? h('nav', { class: 'c-direct-nav', 'aria-label': 'Sections' }) : null;
  const slot = h('main', { class: 'c-direct-main', id: 'main', tabindex: '-1' }, content);

  const header = h('header', { class: 'c-direct-bar' },
    h('div', { class: 'c-direct-bar-inner' },
      lockup({ product: 'direct', tone: 'dark', orchestra: true }),
      h('div', { class: 'c-direct-company' }, icon('building'), h('span', { class: 'sr-only' }, 'Company: '), companyEl),
      h('div', { class: 'c-direct-spacer' }),
      contactSlot),
    navEl ? h('div', { class: 'c-direct-navbar' }, h('div', { class: 'c-direct-bar-inner' }, navEl)) : null);

  const root = h('div', { class: 'c-direct' },
    h('a', { class: 'skip', href: '#main', onclick: (e) => { e.preventDefault(); slot.focus(); } }, 'Skip to main content'),
    header, slot);

  const signOut = () => {
    if (onSignOut) return onSignOut();
    try { sessionStorage.removeItem('conductor.session'); } catch { /* storage blocked */ }
    location.assign('/');
    return null;
  };

  function update(next = {}) {
    if (next.vendor) Object.assign(vendor, next.vendor);
    if (next.contact) Object.assign(contact, next.contact);
    if (next.current !== undefined) current = next.current;
    companyEl.textContent = vendor.name || '';
    const who = contact.name || contact.email || '';
    contactSlot.replaceChildren(menu({
      label: `Signed in as ${who}`,
      align: 'end',
      trigger: h('button', { class: 'c-direct-user', type: 'button', 'aria-label': `Account: ${who}` },
        avatar({ name: who, size: 'sm', tone: 'direct' }),
        h('span', { class: 'c-direct-user-name' }, who),
        icon('chev-down', 'c-direct-caret')),
      items: [
        { node: h('div', { class: 'c-usercard' }, h('strong', null, contact.name || ''), h('span', null, contact.email || ''), vendor.name ? h('span', null, vendor.name) : null) },
        { separator: true },
        { label: 'Sign out', icon: 'log-out', onSelect: signOut },
      ],
    }));
    if (navEl) {
      navEl.replaceChildren(...nav.map((n) => h('a', { class: 'c-direct-navlink', href: n.href, 'aria-current': n.id === current ? 'page' : null },
        h('span', null, n.label), n.count ? h('span', { class: 'c-direct-navcount' }, n.count) : null)));
    }
  }
  update();
  root.slot = slot;
  root.update = update;
  return root;
}
