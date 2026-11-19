// Small building blocks shared by the Direct views. New components (listed in the report):
//   pageHead({ title, sub, actions, back })  the section heading; focus lands on the h1 after navigation
//   section({ title, sub, body, actions, id }) a titled block inside a page, lighter than a pane
//   liveStatus()                             a polite live region for confirmations (node.say(text))
//   downloadPdf(ref, kind, btn)              fetch a document as PDF and save it with <a download>
import { h, icon } from '../../lib.js';
import { setBusy, toast } from '../../components/index.js';
import * as direct from '../../api-direct.js';
import { pdfName } from '../format.js';

export function pageHead({ title, sub, actions, back, titleClass = '' } = {}) {
  const h1 = h('h1', { class: `dx-title ${titleClass}`.trim(), tabindex: '-1' }, title);
  const node = h('header', { class: 'dx-head' },
    back ? h('a', { class: 'dx-back', href: back.href }, icon('arrow-left'), h('span', null, back.label)) : null,
    h('div', { class: 'dx-head-row' },
      h('div', { class: 'dx-head-titles' }, h1, sub ? h('p', { class: 'dx-sub' }, sub) : null),
      actions ? h('div', { class: 'dx-head-actions' }, actions) : null));
  node.heading = h1;
  return node;
}

export function section({ title, sub, body, actions, id, as = 'section', class: cls = '' } = {}) {
  const headId = id ? `${id}-title` : null;
  return h(as, { class: `dx-section ${cls}`.trim(), id, 'aria-labelledby': headId },
    title ? h('div', { class: 'dx-section-head' },
      h('div', null, h('h2', { class: 'dx-section-title', id: headId }, title), sub ? h('p', { class: 'dx-section-sub' }, sub) : null),
      actions ? h('div', { class: 'dx-section-actions' }, actions) : null) : null,
    body);
}

export function liveStatus({ class: cls = '' } = {}) {
  const node = h('p', { class: `dx-live ${cls}`.trim(), role: 'status', 'aria-live': 'polite' });
  node.say = (text, tone = 'neutral') => {
    node.dataset.tone = tone;
    node.replaceChildren(text ? icon(tone === 'risk' ? 'circle-alert' : 'circle-check', 'icon-sm') : '', text ? h('span', null, text) : '');
  };
  return node;
}

export async function downloadPdf(ref, kind, btn) {
  if (btn) setBusy(btn, true);
  try {
    const url = await direct.documentUrl(ref, kind, 'pdf');
    const a = h('a', { href: url, download: pdfName(ref, kind), hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    toast({ tone: 'risk', message: e?.status === 404 ? "We couldn't find that document." : "The download didn't start. Please try again." });
  } finally {
    if (btn) setBusy(btn, false);
  }
}
