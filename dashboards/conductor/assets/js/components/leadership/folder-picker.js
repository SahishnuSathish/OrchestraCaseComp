// The built-in folder list (a modal), used when the operating system's own folder window is not available.
// Moved here from the old New run page so Settings, Advanced can use it. Lists folders on this computer only.
import { h, icon, mount as fill, cleanPath } from '../../lib.js';
import { api } from '../../api.js';
import { button, modal, badge, chip } from '../index.js';

/** openFolderPicker(startPath, onPick(path), { title }) */
export function openFolderPicker(startPath, onPick, { title = 'Choose a folder' } = {}) {
  let listing = null;
  let useBtn = null;
  const pathInput = h('input', { class: 'c-input mono', type: 'text', 'aria-label': 'Folder path', spellcheck: 'false' });
  const shortcuts = h('div', { class: 'lv-fp-shortcuts' });
  const list = h('ul', { class: 'lv-fp-list', 'aria-label': 'Subfolders' });
  const note = h('div', { class: 'lv-fp-note', 'aria-live': 'polite' });
  const upBtn = h('button', { class: 'c-btn c-btn-secondary c-btn-icon', type: 'button', 'aria-label': 'Up one folder', title: 'Up one folder', onclick: () => listing && browse(listing.parent) }, icon('arrow-up'));

  async function browse(p) {
    try {
      listing = await api.fsList(p || '');
      pathInput.value = listing.path;
      upBtn.disabled = !listing.path;
      fill(shortcuts, (listing.shortcuts || []).map((s) => chip({ label: s.name, onClick: () => browse(s.path) })));
      fill(list, listing.entries.length
        ? listing.entries.map((e) => h('li', null, h('button', { class: 'lv-fp-item', type: 'button', onclick: () => browse(e.path) },
          icon(e.has_tickets ? 'folder-check' : listing.path ? 'folder' : 'drive'), h('span', { class: 'truncate', title: e.name }, e.name),
          e.has_tickets ? badge({ label: 'Tickets file', tone: 'info' }) : null, icon('chev-right', 'icon-sm'))))
        : h('li', { class: 'lv-fp-empty' }, 'No folders here.'));
      fill(note, listing.is_dataset ? badge({ label: 'This folder holds a tickets file', tone: 'settled', icon: 'check' }) : null);
      if (useBtn) useBtn.disabled = !listing.path;
    } catch (e) {
      fill(note, badge({ label: e.message || 'That folder can’t be opened', tone: 'risk', icon: 'circle-alert' }));
    }
  }
  list.addEventListener('keydown', (e) => {
    const items = [...list.querySelectorAll('.lv-fp-item')];
    const i = items.indexOf(document.activeElement);
    const to = { ArrowDown: items[i + 1] || items[0], ArrowUp: items[i - 1] || items[items.length - 1], Home: items[0], End: items[items.length - 1] }[e.key];
    if (to && i >= 0) { e.preventDefault(); to.focus(); }
  });
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); browse(cleanPath(pathInput.value)); } });

  const dlg = modal({
    title, size: 'md',
    body: h('div', { class: 'lv-fp' }, h('div', { class: 'lv-fp-path' }, upBtn, pathInput), shortcuts, list, note),
    actions: (d) => {
      useBtn = button({ label: 'Use this folder', variant: 'primary', disabled: true, onClick: () => { onPick(listing.path); d.close(); } });
      return [button({ label: 'Cancel', variant: 'quiet', onClick: () => d.close() }), useBtn];
    },
  });
  browse(startPath);
  return dlg;
}
