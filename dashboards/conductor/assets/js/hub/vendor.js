// Vendor sign-in. Email first, as the real providers do: nothing about vendors or contacts is shown before an
// address is typed, and every failure reads the same. The only convenience is the last account used in this browser.
// Fallback: email + invoice number -> a 6-digit code delivered to a simulated "Your inbox" panel.
import { h, icon, mount } from '../lib.js';
import { modal } from '../components/overlays.js';
import { avatar } from '../components/badges.js';
import { button, field, setFieldError, setBusy } from '../components/controls.js';
import { notice } from '../components/data.js';
import { lockup } from '../components/marks.js';
import { ssoVendor, requestCode, verifyCode, homeFor, forgetLocal } from './session-port.js';

const LAST_KEY = 'conductor.hub.lastVendorEmail';
const NEUTRAL = "We couldn't sign you in with that account.";
const PROVIDERS = {
  microsoft: { name: 'Microsoft', icon: 'building', account: 'work or school account' },
  google: { name: 'Google', icon: 'at-sign', account: 'Google account' },
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function lastEmail() { try { return localStorage.getItem(LAST_KEY) || ''; } catch { return ''; } }
function rememberEmail(e) { try { localStorage.setItem(LAST_KEY, e); } catch { /* storage blocked */ } }
function forgetEmail() { try { localStorage.removeItem(LAST_KEY); } catch { /* storage blocked */ } }

/** openVendorSignIn({ provider, onUseCode }) - the provider-style window: email -> checking -> your account. */
export function openVendorSignIn({ provider = 'microsoft', onUseCode } = {}) {
  const p = PROVIDERS[provider] || PROVIDERS.microsoft;
  const body = h('div', { class: 'hub-provider-step' });
  let signedIn = false;
  const dlg = modal({
    label: `Sign in with ${p.name}`,
    size: 'sm',
    class: 'hub-provider',
    onClose: () => { if (signedIn !== 'done') { if (signedIn) forgetLocal(); } },
    body: h('div', { class: 'hub-provider-frame' },
      h('div', { class: 'hub-provider-top' },
        h('span', { class: 'hub-provider-org' }, icon(p.icon), `${p.name} account`),
        h('button', { class: 'c-btn c-btn-quiet c-btn-icon c-btn-sm', type: 'button', 'aria-label': 'Close', title: 'Close', onclick: () => dlg.close() }, icon('x'))),
      body),
  });

  function stepEmail(prefill = '', error = null) {
    const last = lastEmail();
    const f = field({ label: 'Work email', type: 'email', name: 'email', value: prefill, placeholder: 'name@company.com', required: true, attrs: { autocomplete: 'email', inputmode: 'email', spellcheck: 'false' } });
    const next = button({ label: 'Next', variant: 'primary', type: 'submit' });
    const form = h('form', { class: 'hub-provider-form', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const email = f.control.value.trim();
      if (!EMAIL.test(email)) { setFieldError(f, 'Enter your work email, like name@company.com.'); f.control.focus(); return; }
      stepChecking(email);
    } },
    h('h2', { class: 'hub-provider-title' }, 'Sign in'),
    h('p', { class: 'hub-provider-sub' }, 'to continue to Conductor: Direct'),
    error ? notice({ tone: 'risk', title: NEUTRAL, text: 'Check the address, try another account, or use a sign-in code.', role: 'alert' }) : null,
    last && !error ? h('div', { class: 'hub-last' },
      h('p', { class: 'hub-last-label' }, 'Last used on this browser'),
      h('div', { class: 'hub-last-row' },
        h('button', { class: 'hub-last-account', type: 'button', onclick: () => stepChecking(last) }, avatar({ name: last.split('@')[0], size: 'sm' }), h('span', { class: 'hub-email' }, last)),
        h('button', { class: 'c-btn c-btn-quiet c-btn-icon c-btn-sm', type: 'button', 'aria-label': `Forget ${last} on this browser`, title: 'Forget on this browser', onclick: (e) => { forgetEmail(); e.currentTarget.closest('.hub-last').remove(); f.control.focus(); } }, icon('x')))) : null,
    f,
    h('p', { class: 'hub-provider-note' }, `Use the ${p.account} you use with Orchestra.`),
    h('div', { class: 'hub-provider-actions' },
      h('button', { class: 'hub-link', type: 'button', onclick: () => { dlg.close(); onUseCode?.(); } }, 'Use a sign-in code instead'),
      next));
    mount(body, form);
    f.control.addEventListener('input', () => setFieldError(f, null));
    f.control.focus();
  }

  async function stepChecking(email) {
    mount(body, h('div', { class: 'hub-provider-wait', role: 'status' },
      h('h2', { class: 'hub-provider-title' }, 'Signing you in'),
      h('p', { class: 'hub-provider-sub hub-email' }, email),
      h('div', { class: 'hub-provider-spin' }, h('span', { class: 'c-spinner', 'aria-hidden': 'true' }), h('span', null, 'Checking your account'))));
    let answer = null;
    try {
      [answer] = await Promise.all([ssoVendor(provider, email), wait(700)]);
    } catch {
      await wait(0);
      stepEmail(email, true);
      return;
    }
    signedIn = true;
    stepAccount(answer);
  }

  function stepAccount(a) {
    const go = () => {
      signedIn = 'done';
      rememberEmail(a.email);
      location.assign(a.home || homeFor('vendor'));
    };
    mount(body, h('div', { class: 'hub-provider-form' },
      h('h2', { class: 'hub-provider-title' }, 'Pick an account'),
      h('p', { class: 'hub-provider-sub' }, 'to continue to Conductor: Direct'),
      h('button', { class: 'hub-account', type: 'button', onclick: go, 'aria-label': `Continue as ${a.name}, ${a.vendor?.name || ''}, ${a.email}` },
        avatar({ name: a.name, size: 'lg', tone: 'direct' }),
        h('span', { class: 'hub-account-text' },
          h('span', { class: 'hub-account-name' }, a.name),
          h('span', { class: 'hub-account-role' }, a.vendor?.name || ''),
          h('span', { class: 'hub-account-email' }, a.email)),
        icon('chev-right', 'hub-account-go')),
      h('div', { class: 'hub-provider-actions' },
        h('button', { class: 'hub-link', type: 'button', onclick: () => { forgetLocal(); signedIn = false; stepEmail(''); } }, 'Use another account'))));
    body.querySelector('.hub-account').focus();
  }

  stepEmail('');
  return dlg;
}

// ---------------------------------------------------------------------------- sign-in code fallback
/** codePanel({ onBack }) - email + invoice number -> code -> Direct. Rendered in the hub's right column. */
export function codePanel({ onBack } = {}) {
  const email = field({ label: 'Work email', type: 'email', name: 'email', value: lastEmail(), required: true, attrs: { autocomplete: 'email', inputmode: 'email', spellcheck: 'false' } });
  const invoice = field({ label: 'Invoice number', name: 'invoice', required: true, help: 'The number on any invoice you sent to Orchestra.', attrs: { autocomplete: 'off', spellcheck: 'false', class: 'c-input mono' } });
  const send = button({ label: 'Send code', variant: 'primary', type: 'submit', block: true });
  const stage = h('div', { class: 'hub-code-stage' });
  let sentTo = null;

  const form = h('form', { class: 'hub-code-form', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    const em = email.control.value.trim();
    const inv = invoice.control.value.trim();
    let bad = false;
    if (!EMAIL.test(em)) { setFieldError(email, 'Enter your work email, like name@company.com.'); bad = true; }
    if (!inv) { setFieldError(invoice, 'Enter an invoice number.'); bad = true; }
    if (bad) { (EMAIL.test(em) ? invoice : email).control.focus(); return; }
    setBusy(send, true);
    try {
      const r = await requestCode(em, inv);
      sentTo = { email: em, invoice: inv };
      showVerify(r.message);
      if (r.inbox) showInbox(r.inbox);
    } catch (err) {
      mount(stage, notice({ tone: 'risk', title: "Couldn't send a code", text: err.status === 429 ? 'Too many tries. Wait a few minutes, then try again.' : (err.message || 'Try again in a moment.'), role: 'alert' }));
    } finally {
      setBusy(send, false);
    }
  } }, email, invoice, send);
  [email, invoice].forEach((f) => f.control.addEventListener('input', () => setFieldError(f, null)));

  function showVerify(message) {
    const code = field({ label: 'Sign-in code', name: 'code', required: true, help: 'Six digits, from the email we sent.', attrs: { autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: '6', pattern: '[0-9]{6}', class: 'c-input mono hub-code-input' } });
    const verify = button({ label: 'Sign in', variant: 'primary', type: 'submit', block: true });
    form.hidden = true;
    mount(stage,
      notice({ tone: 'info', title: 'Check your email', text: message || 'If that email and invoice match our records, a code is on its way.' }),
      h('form', { class: 'hub-code-form', novalidate: true, onsubmit: async (e) => {
        e.preventDefault();
        const v = code.control.value.replace(/\s/g, '');
        if (!/^\d{6}$/.test(v)) { setFieldError(code, 'Enter the 6-digit code.'); code.control.focus(); return; }
        setBusy(verify, true);
        try {
          const a = await verifyCode(sentTo.email, sentTo.invoice, v);
          rememberEmail(a.email);
          closeInbox();
          location.assign(a.home || homeFor('vendor'));
        } catch (err) {
          setBusy(verify, false);
          setFieldError(code, err.status === 401 ? 'That code is not valid or has expired.' : (err.message || 'Try again in a moment.'));
          code.control.select();
        }
      } }, h('p', { class: 'hub-code-to' }, 'Code sent for ', h('span', { class: 'hub-email' }, sentTo.email)), code, verify,
      h('button', { class: 'hub-link', type: 'button', onclick: () => { closeInbox(); form.hidden = false; mount(stage); email.control.focus(); } }, 'Use a different email or invoice')));
    code.control.addEventListener('input', () => setFieldError(code, null));
    code.control.focus();
  }

  return h('div', { class: 'hub-card hub-card-code' },
    h('button', { class: 'hub-back', type: 'button', onclick: () => { closeInbox(); onBack?.(); } }, icon('arrow-left'), 'Back'),
    h('h2', { class: 'hub-card-title' }, 'Sign in with a code'),
    h('p', { class: 'hub-card-lede' }, 'For vendors and partners. We email a 6-digit code to the address on your account.'),
    form, stage);
}

// The simulated mailbox: a small notification-style panel under the card, so the flow is self-contained on this computer.
let inboxEl = null;
function closeInbox() { inboxEl?.remove(); inboxEl = null; }
function showInbox(msg) {
  closeInbox();
  const now = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  inboxEl = h('aside', { class: 'hub-inbox', 'aria-label': 'Your inbox', role: 'region' },
    h('header', { class: 'hub-inbox-head' }, icon('mail'), h('span', null, 'Your inbox'), h('span', { class: 'hub-inbox-time' }, now),
      h('button', { class: 'hub-inbox-close', type: 'button', 'aria-label': 'Close inbox', onclick: closeInbox }, icon('x'))),
    h('div', { class: 'hub-inbox-msg', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'hub-inbox-from' }, lockup({ product: 'direct', tone: 'light', orchestra: false, size: 'sm' })),
      h('p', { class: 'hub-inbox-meta' }, h('strong', null, 'Orchestra Accounts Payable'), h('span', { class: 'hub-email' }, 'ap@orchestra-mock.example')),
      h('p', { class: 'hub-inbox-subject' }, msg.subject || 'Your Orchestra sign-in code'),
      h('p', { class: 'hub-inbox-to' }, 'To ', h('span', { class: 'hub-email' }, msg.to)),
      h('p', { class: 'hub-inbox-body' }, 'Your sign-in code is'),
      h('p', { class: 'hub-inbox-code', 'aria-label': `Code ${String(msg.code).split('').join(' ')}` }, msg.code),
      h('p', { class: 'hub-inbox-body' }, 'It expires in 10 minutes. If you did not ask for it, you can ignore this email.')));
  (document.querySelector('.hub-signin-inner') || document.body).append(inboxEl);
  // Bring the whole message into view (it lands under the card, below the fold on a phone and on short desktop screens).
  const el = inboxEl;
  const still = document.hidden || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  // If a smooth scroll did not run (some browsers skip it in a background window), settle it directly.
  setTimeout(() => { if (el.isConnected && el.getBoundingClientRect().bottom > window.innerHeight) el.scrollIntoView({ block: 'nearest' }); }, 700);
}
