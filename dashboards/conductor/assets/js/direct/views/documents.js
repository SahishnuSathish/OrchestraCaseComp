// Documents & W-9: the vendor's W-9 status and upload, and the documents for their invoices.
// Upload: PDF only, 50 MB at most (checked before anything is sent), chunked with SHA-256 by api-w9.uploadFile,
// with a progress bar, cancel and plain error states. Bank details are never accepted here.
import { h, icon } from '../../lib.js';
import { button, badge, empty, notice, field, skeleton, skeletonRows, setBusy } from '../../components/index.js';
import * as direct from '../../api-direct.js';
import * as w9api from '../../api-w9.js';
import { fmtDay, fmtStamp, fmtSize, documentsFor } from '../format.js';
import { invoiceHref } from '../routes.js';
import { pageHead, section, downloadPdf } from '../components/page.js';
import { meter } from '../components/meter.js';

const MAX_BYTES = 50 * 1024 * 1024;
const PAGE = 15;

const W9 = {
  on_file: { tone: 'settled', icon: 'circle-check', text: 'We have a current W-9 on file for you. Send a new one only if your business details change.' },
  missing: { tone: 'waiting', icon: 'clock', text: "We don't have a W-9 on file for you. Please upload a signed W-9 as a PDF." },
  expired: { tone: 'waiting', icon: 'clock', text: 'The W-9 we have on file needs updating. Please upload a new signed W-9 as a PDF.' },
  under_review: { tone: 'info', icon: 'info', text: 'Thanks. Our team is reviewing your W-9. We will contact you if we need anything else.' },
};

function checkFile(file) {
  if (!file) return 'Please choose a PDF file.';
  const isPdf = /\.pdf$/i.test(file.name) && (!file.type || /^application\/(x-)?pdf$/i.test(file.type));
  if (!isPdf) return 'Please choose a PDF file. Other file types cannot be accepted.';
  if (file.size === 0) return 'That file is empty. Please choose another PDF.';
  if (file.size > MAX_BYTES) return `That file is ${fmtSize(file.size)}. The limit is 50 MB. Please choose a smaller PDF.`;
  return null;
}

// ------------------------------------------------------------------------------------------- W-9 block
function w9Block() {
  const statusSlot = h('div', { class: 'dx-w9-status', role: 'status', 'aria-busy': 'true', 'aria-label': 'Loading your W-9 status' },
    skeleton({ width: 110, height: 22 }), skeleton({ width: '80%', height: 12 }));
  const live = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const uploader = h('div', { class: 'dx-upload' });
  const node = h('div', { class: 'dx-w9' }, statusSlot, uploader, live);
  let controller = null;
  let lastAnnounced = -1;

  async function loadStatus() {
    try {
      const w = await w9api.status();
      const meta = W9[w.status] || W9.missing;
      statusSlot.removeAttribute('aria-busy');
      statusSlot.removeAttribute('aria-label');
      statusSlot.removeAttribute('role');
      statusSlot.replaceChildren(
        h('div', { class: 'dx-w9-line' }, h('span', { class: 'dx-w9-label' }, 'W-9 status'), badge({ label: w.label, tone: meta.tone, icon: meta.icon })),
        h('p', { class: 'dx-w9-text' }, meta.text),
        w.last_upload ? h('p', { class: 'dx-muted dx-w9-last' }, icon('file-check', 'icon-sm'),
          h('span', null, `Last upload: ${w.last_upload.filename}, ${fmtStamp(w.last_upload.at)}`)) : '');
      return w;
    } catch {
      statusSlot.removeAttribute('aria-busy');
      statusSlot.replaceChildren(notice({ tone: 'info', title: "We couldn't load your W-9 status.", text: 'You can still upload a W-9 below.' }));
      return null;
    }
  }

  function pick(prefill) {
    const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', class: 'dx-file-input', id: 'dx-w9-file', 'aria-describedby': 'dx-w9-hint' });
    const zone = h('label', { class: 'dx-drop', for: 'dx-w9-file' },
      h('span', { class: 'dx-drop-icon', 'aria-hidden': 'true' }, icon('upload')),
      h('span', { class: 'dx-drop-main' }, h('span', { class: 'dx-drop-action' }, 'Choose a PDF'), h('span', { class: 'dx-drop-or' }, ' or drag it here')),
      h('span', { class: 'dx-drop-hint', id: 'dx-w9-hint' }, 'A signed W-9 form. PDF only, up to 50 MB.'));
    const error = h('div', { class: 'dx-upload-error', role: 'alert' });
    const choose = (file) => {
      const msg = checkFile(file);
      if (msg) { error.replaceChildren(notice({ tone: 'risk', title: msg })); return; }
      ready(file);
    };
    input.addEventListener('change', () => choose(input.files?.[0]));
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('is-over'); choose(e.dataTransfer?.files?.[0]); });
    uploader.replaceChildren(input, zone, error);
    if (prefill) error.replaceChildren(prefill);
  }

  function fileRow(file) {
    return h('div', { class: 'dx-file' }, icon('file', 'dx-file-icon'),
      h('div', { class: 'dx-file-meta' }, h('span', { class: 'dx-file-name' }, file.name), h('span', { class: 'dx-muted num' }, `PDF, ${fmtSize(file.size)}`)));
  }

  function ready(file) {
    const send = button({ label: 'Upload W-9', variant: 'primary', icon: 'upload', onClick: () => start(file) });
    const other = button({ label: 'Choose another file', variant: 'quiet', onClick: () => { pick(); uploader.querySelector('.dx-drop')?.focus(); } });
    uploader.replaceChildren(fileRow(file), h('div', { class: 'dx-upload-actions' }, send, other));
    send.focus();
  }

  async function start(file) {
    // a .pdf without a reported type is still a PDF to the server's check; the server reads the bytes too
    const f = file.type ? file : new File([file], file.name, { type: 'application/pdf' });
    controller = new AbortController();
    const bar = meter({ label: `Uploading ${file.name}` });
    const cancel = button({ label: 'Cancel upload', variant: 'secondary', icon: 'x', onClick: () => controller?.abort() });
    uploader.replaceChildren(fileRow(file), bar, h('div', { class: 'dx-upload-actions' }, cancel));
    cancel.focus();
    lastAnnounced = -1;
    live.textContent = `Uploading ${file.name}.`;
    try {
      const r = await w9api.uploadFile(f, {
        signal: controller.signal,
        onProgress: (x) => {
          bar.set(x);
          const step = Math.floor(x * 4) * 25;   // announce at 25, 50, 75 and 100 percent
          if (step > lastAnnounced && step > 0 && step < 100) { lastAnnounced = step; live.textContent = `${step} percent uploaded.`; }
        },
      });
      bar.set(1);
      setBusy(cancel, true);
      controller = null;
      const msg = r?.message || 'Thanks. Our team will review it.';
      live.textContent = `Upload complete. ${msg}`;
      await loadStatus();
      uploader.replaceChildren(
        h('div', { class: 'dx-upload-done', tabindex: '-1' }, icon('circle-check', 'dx-upload-done-icon'),
          h('div', null, h('p', { class: 'dx-upload-done-title' }, 'W-9 received'), h('p', { class: 'dx-muted' }, msg),
            button({ label: 'Upload a different file', variant: 'quiet', size: 'sm', onClick: () => pick() }))));
      uploader.firstElementChild.focus({ preventScroll: true });
    } catch (e) {
      controller = null;
      if (e?.name === 'AbortError') {
        live.textContent = 'Upload cancelled.';
        pick(notice({ tone: 'info', title: 'Upload cancelled.', text: 'Nothing was submitted. You can choose the file again.' }));
        return;
      }
      const text = typeof e?.detail === 'string' ? e.detail : "The upload didn't finish. Please check your connection and try again.";
      live.textContent = text;
      pick(notice({ tone: 'risk', title: text }));
    }
  }

  loadStatus();
  pick();
  node.destroy = () => controller?.abort();
  return node;
}

// ------------------------------------------------------------------------------------------- documents list
function docList() {
  let rows = [];
  let shown = PAGE;
  let q = '';
  const search = field({
    label: 'Find an invoice', type: 'search', placeholder: 'INV-3181', prefix: 'search',
    attrs: { autocomplete: 'off', spellcheck: 'false', inputmode: 'search' },
    onInput: (e) => { q = e.target.value.trim().toLowerCase(); shown = PAGE; render(); },
  });
  search.classList.add('dx-doc-search');
  const slot = h('div', { class: 'dx-doclist-slot' }, skeletonRows({ rows: 4, avatar: false, lines: 1, label: 'Loading your documents' }));
  const more = h('div', { class: 'dx-more' });
  const node = h('div', { class: 'dx-doclist' }, search, slot, more);

  function dlButton(r, d) {
    const b = button({
      label: d.kind === 'remittance' ? 'Remittance' : 'Invoice copy', icon: 'download', size: 'sm', variant: 'secondary',
      attrs: { 'aria-label': `Download ${d.label.toLowerCase()} for ${r.invoice} as PDF` },
      onClick: () => downloadPdf(r.invoice, d.kind, b),
    });
    return b;
  }

  function render() {
    const list = q ? rows.filter((r) => r.invoice.toLowerCase().includes(q)) : rows;
    if (!rows.length) {
      slot.replaceChildren(empty({ compact: true, icon: 'file', title: 'No documents yet.', text: 'Documents appear here once we have an invoice from you.' }));
      more.replaceChildren();
      return;
    }
    if (!list.length) {
      slot.replaceChildren(empty({ compact: true, icon: 'search', title: 'No invoices match.', text: 'Check the invoice number, or try the last few digits.' }));
      more.replaceChildren();
      return;
    }
    slot.replaceChildren(h('ul', { class: 'dx-doclist-rows', 'aria-label': 'Invoice documents' }, list.slice(0, shown).map((r) => h('li', { class: 'dx-docrow' },
      h('div', { class: 'dx-docrow-ref' },
        h('a', { class: 'dx-ref', href: invoiceHref(r.invoice) }, r.invoice),
        h('span', { class: 'dx-muted num' }, fmtDay(r.date))),
      h('div', { class: 'dx-docrow-actions' }, documentsFor(r.status?.code).map((d) => dlButton(r, d)))))));
    more.replaceChildren(shown < list.length ? button({
      label: 'Show more', variant: 'secondary', icon: 'chev-down',
      onClick: () => { const first = shown; shown += PAGE; render(); slot.querySelectorAll('.dx-docrow .dx-ref')[first]?.focus(); },
    }) : '');
  }

  direct.invoices({}).then((r) => { rows = r.rows || []; render(); }).catch(() => {
    slot.replaceChildren(empty({ compact: true, icon: 'circle-alert', title: "We couldn't load your documents.", text: 'Please try again in a moment.' }));
  });
  return node;
}

// ------------------------------------------------------------------------------------------- view
export function mount(root) {
  const head = pageHead({ title: 'Documents & W-9', sub: 'Send us your W-9 and download copies of your invoices and remittance advice.' });
  const w9 = w9Block();
  const bank = h('div', { class: 'dx-bank' }, icon('phone', 'dx-bank-icon'),
    h('p', null, h('strong', null, 'Never send bank details here. '), 'Bank changes are handled by phone with our team.'));

  root.replaceChildren(h('div', { class: 'dx-page dx-documents' },
    head,
    h('div', { class: 'dx-docs-grid' },
      section({ id: 'dx-w9', title: 'W-9 form', sub: 'Your tax form, as a signed PDF. Our team checks every upload.', body: h('div', { class: 'dx-w9-body' }, w9, bank), class: 'dx-w9-section' }),
      section({ id: 'dx-invoice-docs', title: 'Invoice documents', sub: 'A copy of each invoice, and the remittance advice once a payment has been sent.', body: docList(), class: 'dx-doclist-section' }))));

  return { heading: head.heading, destroy() { w9.destroy(); } };
}
