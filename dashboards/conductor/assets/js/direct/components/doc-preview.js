// docPreview({ invoice, documents, selected }) - the document an answer came from, shown as a sheet of paper.
// A segmented switch picks the invoice copy or the remittance advice; Download PDF saves the selected one.
// The HTML is fetched with this tab's headers and framed as a blob: URL (document routes allow same-origin framing).
// The frame is sandboxed without scripts; same origin is kept only so its height can follow the document.
// node.destroy() revokes the object URLs.
import { h } from '../../lib.js';
import { button, tabs, skeleton, notice } from '../../components/index.js';
import * as direct from '../../api-direct.js';
import { downloadPdf } from './page.js';

export function docPreview({ invoice, documents = [], selected } = {}) {
  let current = documents.some((d) => d.kind === selected) ? selected : documents[documents.length - 1]?.kind;
  const urls = new Map();
  let disposed = false;
  let seq = 0;

  const stage = h('div', { class: 'dx-doc-stage' });
  const titleEl = h('span', { class: 'dx-doc-name' });
  const dl = button({ label: 'Download PDF', icon: 'download', variant: 'secondary', onClick: () => downloadPdf(invoice, current, dl) });
  const switcher = documents.length > 1
    ? tabs({ label: 'Document', variant: 'segmented', size: 'sm', items: documents.map((d) => ({ id: d.kind, label: d.label })), selected: current, onSelect: (k) => show(k) })
    : null;

  const node = h('div', { class: 'dx-doc' },
    h('div', { class: 'dx-doc-bar' },
      switcher || titleEl,
      h('div', { class: 'dx-doc-actions' }, dl)),
    stage);

  function fit(frame) {
    try {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      frame.style.height = `${Math.max(320, doc.documentElement.scrollHeight)}px`;
    } catch { /* not readable: keep the default height */ }
  }

  async function show(kind) {
    current = kind;
    const d = documents.find((x) => x.kind === kind);
    titleEl.textContent = d?.label || '';
    dl.querySelector('.c-btn-label').textContent = 'Download PDF';
    dl.setAttribute('aria-label', `Download ${d?.label || 'document'} as PDF`);
    const mine = ++seq;
    stage.replaceChildren(h('div', { class: 'dx-doc-loading', role: 'status', 'aria-label': `Loading the ${d?.label?.toLowerCase() || 'document'}` },
      skeleton({ width: '40%', height: 18 }), skeleton({ width: '62%', height: 12 }), skeleton({ width: '100%', height: 1 }),
      skeleton({ width: '90%', height: 12 }), skeleton({ width: '76%', height: 12 }), skeleton({ width: '84%', height: 12 })));
    try {
      let url = urls.get(kind);
      if (!url) {
        url = await direct.documentUrl(invoice, kind, 'html');
        if (disposed) { URL.revokeObjectURL(url); return; }
        urls.set(kind, url);
      }
      if (mine !== seq) return;
      const frame = h('iframe', { class: 'dx-doc-frame', title: `${d?.label || 'Document'} for invoice ${invoice}`, src: url, sandbox: 'allow-same-origin' });
      frame.addEventListener('load', () => fit(frame));
      stage.replaceChildren(frame);
    } catch (e) {
      if (mine !== seq) return;
      stage.replaceChildren(notice({ tone: 'info', title: "This document isn't available right now.", text: 'Please try again in a moment.' }));
    }
  }

  const onResize = () => { const f = stage.querySelector('iframe'); if (f) fit(f); };
  window.addEventListener('resize', onResize);
  node.destroy = () => {
    disposed = true;
    window.removeEventListener('resize', onResize);
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls.clear();
  };
  if (current) show(current);
  return node;
}
