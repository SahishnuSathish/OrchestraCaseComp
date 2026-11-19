// The sign-in hub (/). Split screen: Orchestra's promise on the left, the two ways in on the right.
// Staff: "Sign in with Microsoft" -> account picker -> handshake -> home.
// Vendors: "Continue with Microsoft / Google" -> email-first step -> their one account -> Direct.
//          "Use a sign-in code instead" -> email + invoice -> code in "Your inbox" -> Direct.
// Every call goes through ./session-port.js. Nothing here lists vendors or contacts.
import { h, icon, mount, $ } from '../lib.js';
import { lockup, mark, PRODUCTS } from '../components/marks.js';
import { button } from '../components/controls.js';
import { ensureIcons } from '../components/icons.js';
import { current, homeFor } from './session-port.js';
import { openStaffPicker } from './staff.js';
import { openVendorSignIn, codePanel } from './vendor.js';

const root = $('#hub-root');

const PROOF = [
  '100 practice emails read and matched to their bill, payment and run',
  '4.3 record lookups per email, done before anyone opens it',
  'Nothing goes out until a person approves it',
];

let cardSlot = null;

function brandColumn() {
  return [
    h('header', { class: 'hub-brand' },
      lockup({ product: 'conductor', tone: 'dark', size: 'lg' }),
      h('h1', { class: 'hub-value' }, 'Accounts payable email, read and matched to the records before anyone opens it.')),
    h('section', { class: 'hub-proof', 'aria-label': 'What Conductor does' },
      h('ul', { class: 'hub-proof-list' }, PROOF.map((p) => h('li', null, p))),
      h('p', { class: 'hub-proof-source' }, 'Practice data, snapshot Nov 13, 2026')),
    h('footer', { class: 'hub-family', 'aria-label': 'Conductor products' },
      h('ul', null, Object.entries(PRODUCTS).map(([id, p]) => h('li', { class: 'hub-family-item' },
        mark({ product: id, size: 20 }),
        h('span', { class: 'hub-family-text' }, h('strong', null, p.name), h('span', null, p.tagline)))))),
  ];
}

function chooseCard() {
  const staffBtn = button({ label: 'Sign in with Microsoft', variant: 'primary', size: 'lg', icon: 'building', block: true, attrs: { 'aria-describedby': 'hub-staff-desc' } });
  staffBtn.addEventListener('click', () => openStaffPicker({ opener: staffBtn }));
  const msBtn = button({ label: 'Continue with Microsoft', variant: 'secondary', size: 'lg', icon: 'building', block: true });
  const gBtn = button({ label: 'Continue with Google', variant: 'secondary', size: 'lg', icon: 'at-sign', block: true });
  msBtn.addEventListener('click', () => openVendorSignIn({ provider: 'microsoft', onUseCode: showCode }));
  gBtn.addEventListener('click', () => openVendorSignIn({ provider: 'google', onUseCode: showCode }));
  return h('div', { class: 'hub-card', id: 'hub-card' },
    h('h2', { class: 'hub-card-title' }, 'Sign in'),
    h('p', { class: 'hub-card-lede' }, 'Choose how you work with Orchestra.'),
    h('section', { class: 'hub-choice', 'aria-labelledby': 'hub-staff-h' },
      h('div', { class: 'hub-choice-head' },
        h('h3', { id: 'hub-staff-h' }, 'Orchestra staff'),
        h('p', { id: 'hub-staff-desc' }, 'Accounts payable, finance and budget approvers. Use your Orchestra work account.')),
      staffBtn),
    h('section', { class: 'hub-choice', 'aria-labelledby': 'hub-vendor-h' },
      h('div', { class: 'hub-choice-head' },
        h('h3', { id: 'hub-vendor-h' }, 'Vendors & partners'),
        h('p', null, 'See the status of the invoices you sent us, with the documents behind each answer.')),
      h('div', { class: 'hub-choice-actions' }, msBtn, gBtn),
      h('button', { class: 'hub-link', type: 'button', onclick: showCode }, icon('key'), 'Use a sign-in code instead')),
    h('p', { class: 'hub-help' }, 'Need access? Write to Orchestra accounts payable at ', h('span', { class: 'hub-email' }, 'ap@orchestra-mock.example'), '.'));
}

function showChoose({ focus = false } = {}) {
  mount(cardSlot, chooseCard());
  if (focus) cardSlot.querySelector('button')?.focus();
}

function showCode() {
  mount(cardSlot, codePanel({ onBack: () => showChoose({ focus: true }) }));
  cardSlot.querySelector('input')?.focus();
}

function render() {
  cardSlot = h('div', { class: 'hub-signin-inner' });
  mount(root, h('div', { class: 'hub' },
    ...brandColumn(),
    h('section', { class: 'hub-signin', 'aria-label': 'Sign in' }, cardSlot)));
  showChoose();
  root.removeAttribute('aria-busy');
}

async function boot() {
  ensureIcons();
  // Already signed in in this tab (a reload, or a bookmark): go straight home, skipping the handshake.
  let s = null;
  try { s = await current(); } catch { s = null; }
  if (s && s.role) { location.replace(s.home || homeFor(s.role)); return; }
  render();
}

boot();
