// Settings (placeholder): shows the local model status. The full settings page replaces this file.
import { h, icon, mount as fill } from '../lib.js';
import { S, on, refreshModel } from '../state.js';
import { pageHeader, panel } from '../ui.js';

const WORDS = {
  ready: 'Ready', unreachable: 'Not reachable', model_missing: 'Model not installed', no_models: 'No models installed', not_local: 'Not a local server',
};

export function mount(root) {
  const status = h('p', { role: 'status' });
  const checkBtn = h('button', { class: 'btn', type: 'button', onclick: async () => { checkBtn.disabled = true; await refreshModel(true); checkBtn.disabled = false; } }, icon('refresh'), 'Check again');
  fill(root, h('div', { class: 'page' },
    pageHeader({ title: 'Settings' }),
    h('div', { class: 'page-grid' }, panel({ title: 'Local model', icon: 'cpu', body: h('div', { class: 'stack' }, status, h('div', null, checkBtn)) }))));

  function render() {
    const m = S.model;
    if (!m) { status.textContent = 'Checking the local model…'; return; }
    const state = m.state || (m.usable ? 'ready' : 'unreachable');
    status.textContent = `${WORDS[state] || state}${m.model ? ` · ${m.model}` : ''}${m.error ? `. ${m.error}` : ''}`;
  }
  render();
  const off = on((kind) => { if (kind === 'model') render(); });
  return { update() {}, destroy: off };
}
