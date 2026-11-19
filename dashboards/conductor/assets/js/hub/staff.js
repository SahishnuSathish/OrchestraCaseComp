// Staff sign-in: a Microsoft-style account picker (our own generic design and icons), then the handshake screen.
// Titles and departments are shown prominently because first names repeat (Elena Lockhart is the CFO,
// Elena Fairbanks is an approver).
import { h, icon, mount, $ } from '../lib.js';
import { modal } from '../components/overlays.js';
import { avatar } from '../components/badges.js';
import { lockup } from '../components/marks.js';
import { skeletonRows, notice } from '../components/data.js';
import { button } from '../components/controls.js';
import { directory, ssoStaff, homeFor } from './session-port.js';

const GROUPS = [
  { id: 'ap', label: 'Accounts payable', roles: ['cfo', 'ap_specialist'] },
  { id: 'approvers', label: 'Budget approvers', roles: ['approver'] },
];
const ORDER = { cfo: 0, ap_specialist: 1, approver: 2 };

export function openStaffPicker() {
  const list = h('div', { class: 'hub-picker-list' }, skeletonRows({ rows: 5, lines: 3, label: 'Loading accounts' }));
  const filter = h('input', {
    class: 'c-input', type: 'search', placeholder: 'Filter by name, title or department', 'aria-label': 'Filter accounts', autocomplete: 'off', spellcheck: 'false',
  });
  const count = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  let accounts = [];

  const dlg = modal({
    label: 'Pick an account',
    size: 'md',
    class: 'hub-provider',
    body: h('div', { class: 'hub-provider-frame' },
      h('div', { class: 'hub-provider-top' },
        h('span', { class: 'hub-provider-org' }, icon('building'), 'Orchestra work account'),
        h('button', { class: 'c-btn c-btn-quiet c-btn-icon c-btn-sm', type: 'button', 'aria-label': 'Close', title: 'Close', onclick: () => dlg.close() }, icon('x'))),
      h('h2', { class: 'hub-provider-title' }, 'Pick an account'),
      h('p', { class: 'hub-provider-sub' }, 'to continue to Orchestra Conductor'),
      h('div', { class: 'hub-picker-filter' }, h('span', { class: 'c-input-wrap has-prefix' }, h('span', { class: 'c-input-prefix', 'aria-hidden': 'true' }, icon('search')), filter)),
      count,
      list,
      h('p', { class: 'hub-provider-foot' }, icon('lock'), 'Accounts are managed by Orchestra IT. Only people with a Conductor role are listed.')),
  });

  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const hits = accounts.filter((a) => !q || `${a.name} ${a.title} ${a.department} ${a.email}`.toLowerCase().includes(q));
    count.textContent = `${hits.length} ${hits.length === 1 ? 'account' : 'accounts'}`;
    if (!hits.length) {
      mount(list, h('p', { class: 'hub-picker-none' }, 'No account matches that. Check the spelling, or clear the filter.'));
      return;
    }
    mount(list, GROUPS.map((g) => {
      const rows = hits.filter((a) => g.roles.includes(a.role)).sort((a, b) => (ORDER[a.role] - ORDER[b.role]) || a.name.localeCompare(b.name));
      if (!rows.length) return null;
      return h('section', { class: 'hub-picker-group', 'aria-label': g.label },
        h('h3', { class: 'hub-picker-group-title' }, g.label),
        h('ul', null, rows.map((a) => h('li', null, h('button', {
          class: 'hub-account', type: 'button', 'aria-label': `${a.name}, ${a.title}, ${a.department}, ${a.email}`,
          onclick: () => { dlg.close(); handshake(a); },
        },
        avatar({ name: a.name, size: 'lg' }),
        h('span', { class: 'hub-account-text' },
          h('span', { class: 'hub-account-name' }, a.name),
          h('span', { class: 'hub-account-role' }, `${a.title} · ${a.department}`),
          h('span', { class: 'hub-account-email' }, a.email)),
        icon('chev-right', 'hub-account-go'))))));
    }));
  };
  filter.addEventListener('input', draw);

  const load = async () => {
    mount(list, skeletonRows({ rows: 5, lines: 3, label: 'Loading accounts' }));
    try {
      const r = await directory();
      accounts = (r.accounts || []).filter((a) => ORDER[a.role] != null);
      draw();
      filter.focus();
    } catch {
      mount(list, notice({ tone: 'risk', title: "Couldn't load the accounts", text: 'Check that Conductor is running, then try again.', actions: button({ label: 'Try again', size: 'sm', onClick: load }) }));
    }
  };
  load();
}

// ---------------------------------------------------------------------------- handshake
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The short "connecting" screen after a staff account is picked. About 1.5 s; Skip goes straight on. */
export async function handshake(account) {
  const root = $('#hub-root');
  const lastLine = account.role === 'approver' ? 'Preparing your approvals…' : 'Preparing your inbox…';
  const steps = [
    `Signing in as ${account.name}…`,
    'Connecting Zendesk (orchestra-mock.zendesk.com)',
    'Connecting Outlook (ap@orchestra-mock.example)',
    'Connecting NetSuite (read-only)',
    lastLine,
  ];
  // Each step shows a quiet dot while it waits, a spinner while it runs, then a check. No empty boxes.
  const items = steps.map((text) => h('li', { class: 'hub-step is-waiting' },
    h('span', { class: 'hub-step-node', 'aria-hidden': 'true' }, h('span', { class: 'hub-step-dot' })), h('span', { class: 'hub-step-text' }, text), h('span', { class: 'sr-only hub-step-state' }, 'Waiting')));
  let skipped = false;
  let answer = null;
  const skip = h('button', { class: 'c-btn c-btn-quiet c-btn-sm hub-skip', type: 'button', onclick: () => { skipped = true; go(); } }, 'Skip', icon('chev-right'));
  const status = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const panel = h('div', { class: 'hub-handshake' },
    h('div', { class: 'hub-handshake-card' },
      h('div', { class: 'hub-handshake-top' }, lockup({ product: 'conductor', tone: 'light' }), skip),
      h('div', { class: 'hub-handshake-who' },
        avatar({ name: account.name, size: 'lg' }),
        h('div', null, h('strong', null, account.name), h('span', null, `${account.title} · ${account.department}`))),
      h('ol', { class: 'hub-steps' }, items),
      status));
  mount(root, panel);
  skip.focus();

  const mark = (i, state) => {
    const li = items[i];
    li.className = `hub-step is-${state}`;
    li.querySelector('.hub-step-node').replaceChildren(state === 'done' ? icon('circle-check') : state === 'active' ? h('span', { class: 'c-spinner' }) : h('span', { class: 'hub-step-dot' }));
    li.querySelector('.hub-step-state').textContent = state === 'done' ? 'Done' : state === 'active' ? 'In progress' : 'Waiting';
    if (state === 'active') status.textContent = steps[i];
  };

  let gone = false;
  async function go() {
    if (gone) return;
    try { answer = answer || await signIn; } catch { return; }
    gone = true;
    location.assign(answer.home || homeFor(answer.role));
  }

  const signIn = ssoStaff(account.email);
  signIn.catch(() => {});
  try {
    mark(0, 'active');
    [answer] = await Promise.all([signIn, wait(320)]);
    if (skipped) return;
    mark(0, 'done');
    const beats = [300, 280, 220, 320];
    for (let i = 1; i < steps.length; i += 1) {
      mark(i, 'active');
      await wait(beats[i - 1]);
      if (skipped) return;
      mark(i, 'done');
    }
    await wait(120);
    go();
  } catch (err) {
    items.forEach((li, i) => { if (!li.classList.contains('is-done')) mark(i, 'waiting'); });
    skip.remove();
    panel.querySelector('.hub-handshake-card').append(
      notice({ tone: 'risk', title: "We couldn't sign you in with that account.", text: err?.message && err.status !== 401 ? err.message : 'Pick another account, or ask Orchestra IT to check your access.', role: 'alert' }),
      h('div', { class: 'hub-handshake-actions' }, button({ label: 'Back to sign in', variant: 'primary', icon: 'arrow-left', onClick: () => location.assign('/') })));
  }
}
