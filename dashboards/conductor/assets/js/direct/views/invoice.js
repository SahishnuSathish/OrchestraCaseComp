// Invoice detail: the answer (status and the records-only message), the public steps, and the document it came from.
// No approver, no approval date, no reason for a review: the server sends only the public steps.
import { h, icon } from '../../lib.js';
import { button, empty, timeline, skeleton, skeletonText } from '../../components/index.js';
import * as direct from '../../api-direct.js';
import { fmtDay, money, STATUS_TONE } from '../format.js';
import { pageHead, section } from '../components/page.js';
import { docPreview } from '../components/doc-preview.js';
import { questionForm } from '../components/question-form.js';

function steps(items = []) {
  let currentSet = false;
  return items.map((s) => {
    let state = 'done';
    if (!s.done) { state = currentSet ? 'upcoming' : 'current'; currentSet = true; }
    return { title: s.label, at: s.date ? fmtDay(s.date) : null, state };
  });
}

function fact(label, value, cls = '') {
  return h('div', { class: `dx-fact ${cls}`.trim() }, h('dt', null, label), h('dd', null, value));
}

export function mount(root, { route, ctx }) {
  const ref = route.ref;
  const back = { href: ctx.listHash || '#/invoices', label: 'All invoices' };
  let preview = null;
  let form = null;
  let alive = true;

  const title = h('span', null, 'Invoice ', h('span', { class: 'dx-title-ref' }, ref));
  const head = pageHead({ title, back });

  // placeholder with the same shape as the answer, so the page does not jump
  root.replaceChildren(h('div', { class: 'dx-page dx-detail' }, head,
    h('div', { class: 'dx-answer is-skeleton', role: 'status', 'aria-busy': 'true', 'aria-label': 'Loading the invoice' },
      skeleton({ width: '55%', height: 26 }), skeletonText({ lines: 2 }),
      h('div', { class: 'dx-facts' }, Array.from({ length: 4 }, () => h('div', { class: 'dx-fact' }, skeleton({ width: 70, height: 10 }), skeleton({ width: 96, height: 16 })))))));

  // Swap the page body. Moving the heading node drops focus, so keep it on the h1 if it was there.
  // Call headingFocused() before building the new tree: h() moves the heading node out of the page while building.
  const headingFocused = () => !!(document.activeElement?.matches?.('h1') && root.contains(document.activeElement));
  function swap(node, hadFocus) {
    root.replaceChildren(node);
    if (hadFocus) node.querySelector('h1')?.focus({ preventScroll: true });
  }

  function notFound() {
    document.title = 'Invoice not found | Conductor: Direct';
    const had = headingFocused();
    swap(h('div', { class: 'dx-page dx-detail' },
      pageHead({ title: 'Invoice not found', back }),
      h('div', { class: 'dx-panel' }, empty({
        icon: 'search',
        title: "We couldn't find that invoice.",
        text: 'Check the invoice number on your copy. If you sent it recently, it may not be in our records yet.',
        actions: button({ label: 'All invoices', variant: 'secondary', href: back.href }),
      }))), had);
  }

  function failed() {
    const had = headingFocused();
    swap(h('div', { class: 'dx-page dx-detail' }, head,
      h('div', { class: 'dx-panel' }, empty({
        icon: 'circle-alert', title: "We couldn't load this invoice.", text: 'Please try again in a moment.',
        actions: button({ label: 'Try again', icon: 'refresh', onClick: () => load() }),
      }))), had);
  }

  function render(inv) {
    const had = headingFocused();
    document.title = `Invoice ${inv.invoice} | Conductor: Direct`;
    const tone = STATUS_TONE[inv.status?.code] || 'neutral';
    const docs = inv.documents || [];

    const answer = h('section', { class: 'dx-answer', 'data-tone': tone, 'aria-labelledby': 'dx-answer-status' },
      h('p',{ class: 'dx-answer-status', id: 'dx-answer-status' }, inv.status?.label || ''),
      h('p', { class: 'dx-answer-msg' }, inv.message),
      h('dl', { class: 'dx-facts' },
        fact('Invoice date', h('span', { class: 'num' }, fmtDay(inv.date))),
        fact('Due date', h('span', { class: 'num' }, inv.due ? fmtDay(inv.due) : 'Not set')),
        fact('Invoice amount', h('span', { class: 'money' }, money(inv.amount, inv.currency))),
        fact('Open balance', inv.balance == null ? 'Our team will confirm' : h('span', { class: 'money' }, money(inv.balance, inv.currency)), 'is-balance')));

    preview = docs.length ? docPreview({ invoice: inv.invoice, documents: docs, selected: docs.some((d) => d.kind === 'remittance') ? 'remittance' : 'invoice' }) : null;
    const docSection = section({
      id: 'dx-docs', title: 'Documents',
      sub: docs.some((d) => d.kind === 'remittance') ? 'The remittance advice for this payment, and a copy of your invoice as we have it on file.' : 'A copy of your invoice as we have it on file.',
      body: preview || h('p', { class: 'dx-muted' }, 'No documents are available for this invoice yet.'),
      class: 'dx-docs',
    });

    const progress = section({
      id: 'dx-steps', title: 'Progress',
      body: timeline({ items: steps(inv.timeline), label: `Progress of invoice ${inv.invoice}` }),
      class: 'dx-steps',
    });

    form = questionForm({ invoice: inv.invoice });
    const ask = section({
      id: 'dx-ask', title: 'Ask about this invoice',
      sub: 'A person on our team reads every question and checks every answer before it is sent.',
      body: form, class: 'dx-ask',
    });

    swap(h('div', { class: 'dx-page dx-detail' },
      head,
      answer,
      h('div', { class: 'dx-detail-grid' },
        h('div', { class: 'dx-detail-main' }, docSection),
        h('aside', { class: 'dx-detail-side', 'aria-label': 'Progress and questions' }, progress, ask)),
      h('p', { class: 'dx-source' }, icon('database', 'icon-sm'), h('span', null, `Source: ${inv.source || 'Orchestra accounts payable records'}`))), had);
  }

  async function load() {
    try {
      const inv = await direct.invoice(ref);
      if (!alive) return;
      render(inv);
    } catch (e) {
      if (!alive) return;
      if (e?.status === 404) notFound(); else failed();
    }
  }
  load();

  return {
    heading: () => root.querySelector('h1'),
    destroy() { alive = false; preview?.destroy?.(); form?.destroy?.(); },
  };
}
