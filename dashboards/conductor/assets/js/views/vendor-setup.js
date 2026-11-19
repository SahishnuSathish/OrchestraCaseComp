// Vendor setup (#/vendor-setup[/:vendorId]): vendors whose W-9 is missing, expired or does not match our records, with
// the bills each one holds up. Request W-9 drafts an email that a person reviews, approves and sends. Review upload
// shows what was read from the vendor's PDF next to our record; Mark verified records who and when, and the next
// human step is to update the NetSuite vendor record (Conductor never writes to NetSuite). A TIN never shows more
// than its last 4 digits. Fraud-flagged uploads need the CFO and cannot be verified here.
import { h, icon, mount as fill } from '../lib.js';
import {
  button, setBusy, badge, fmtMoney, skeletonRows, skeletonText, empty, notice, tabs, toast,
} from '../components/index.js';
import {
  pageHead, fmtDay, fmtWhen, nameOf, plural, kv, errText, liveRegion, say, reviewBadge, dataAsOf,
} from '../components/leadership/util.js';
import * as w9 from '../api-w9.js';
import * as wf from '../api-workflow.js';
import { subscribe } from '../api-live.js';

const STATUS = {
  missing: { label: 'Missing', tone: 'waiting', icon: 'file' },
  expired: { label: 'Expired', tone: 'waiting', icon: 'clock' },
  name_mismatch: { label: 'Name mismatch', tone: 'risk', icon: 'alert' },
  tin_mismatch: { label: 'TIN mismatch', tone: 'risk', icon: 'alert' },
  on_file: { label: 'On file', tone: 'settled', icon: 'circle-check' },
};
const statusBadge = (s, label) => badge({ ...(STATUS[s] || { tone: 'neutral' }), label: label || STATUS[s]?.label || s });
const UPLOAD_STATE = {
  received: { label: 'Upload to review', tone: 'scheduled', icon: 'file' },
  needs_review: { label: 'Upload to review', tone: 'scheduled', icon: 'file' },
  verified: { label: 'Verified', tone: 'settled', icon: 'circle-check' },
};
const NEXT_STEP = 'Update NetSuite vendor record';

// Open bills split two ways: already scheduled for a payment run (the status names the date), and the rest, which the
// W-9 holds up. Each list is in number order (OF1381 before OF12162), scheduled ones by payment date first.
const SCHEDULED = /^Scheduled for payment on (.+)$/i;
const billNo = (b) => Number(String(b.tranId || '').replace(/\D+/g, '')) || 0;
const payDate = (b) => { const m = SCHEDULED.exec(b.status || ''); return m ? Date.parse(m[1]) || 0 : 0; };
function splitBills(bills = []) {
  const scheduled = bills.filter((b) => SCHEDULED.test(b.status || '')).sort((a, b) => payDate(a) - payDate(b) || billNo(a) - billNo(b));
  const held = bills.filter((b) => !SCHEDULED.test(b.status || '')).sort((a, b) => billNo(a) - billNo(b));
  return { held, scheduled };
}
const sum = (list) => list.reduce((n, b) => n + (Number(b.amount) || 0), 0);

export function mount(root, { route }) {
  let alive = true;
  let rows = null;
  let loadError = null;
  let filter = 'all';
  let selected = route.vendorId || null;
  let detail = null; // { id, vendor, requests, upload } | { id, loading } | { id, error }
  let seq = 0;
  const live = liveRegion();

  const listBody = h('div', { class: 'vs-list-body' });
  const filterSlot = h('div');
  const listPane = h('section', { class: 'c-pane vs-list', 'aria-labelledby': 'vs-list-h' },
    h('header', { class: 'c-pane-head' }, h('div', { class: 'c-pane-titles' }, h('h2', { class: 'c-pane-title', id: 'vs-list-h' }, 'Vendors'),
      h('p', { class: 'c-pane-sub' }, 'Most open bills first.')), filterSlot),
    listBody);
  const detailPane = h('section', { class: 'c-pane vs-detail', 'aria-label': 'Selected vendor', tabindex: '-1' });
  const grid = h('div', { class: 'vs-grid' }, listPane, detailPane);
  const asOf = h('p', { class: 'lv-meta' }, dataAsOf());
  fill(root, h('div', { class: 'page lv-page vs-page' },
    pageHead({
      title: 'Vendor setup',
      lede: 'Vendors whose W-9 is missing, expired or does not match our records, and the bills each one is holding up. Bank details are never accepted here.',
      meta: asOf,
    }),
    grid, live));

  // ------------------------------------------------------------------ list
  const hasUpload = (r) => !!r.upload_id;
  function renderList() {
    const counts = { all: rows?.length || 0, uploads: (rows || []).filter(hasUpload).length };
    fill(filterSlot, tabs({ label: 'Show', variant: 'segmented', size: 'sm', selected: filter,
      items: [{ id: 'all', label: 'All', count: rows ? counts.all : null }, { id: 'uploads', label: 'Uploads', count: rows ? counts.uploads : null }],
      onSelect: (id) => { filter = id; renderList(); } }));
    if (loadError) { fill(listBody, empty({ icon: 'circle-alert', compact: true, title: 'Vendors could not be loaded', text: loadError, actions: button({ label: 'Try again', icon: 'refresh', onClick: load }) })); return; }
    if (!rows) { fill(listBody, skeletonRows({ rows: 6, avatar: false, label: 'Loading vendors' })); return; }
    const list = rows.filter((r) => filter === 'all' || hasUpload(r));
    if (!list.length) {
      fill(listBody, empty({ icon: 'vendor-setup', compact: true, title: filter === 'uploads' ? 'No uploads to review' : 'Every W-9 is on file',
        text: filter === 'uploads' ? 'When a vendor adds a W-9 in Conductor: Direct, it appears here.' : 'Nothing is holding up a payment.' }));
      return;
    }
    fill(listBody, h('ul', { class: 'vs-rows' }, list.map((r) => {
      const active = r.vendor_id === selected;
      const { held } = splitBills(r.bills_held);
      return h('li', null, h('a', { class: `vs-row${active ? ' is-active' : ''}`, href: `#/vendor-setup/${r.vendor_id}`, 'aria-current': active ? 'true' : null },
        h('div', { class: 'vs-row-top' }, h('strong', { class: 'truncate' }, r.vendor), statusBadge(r.status, r.label)),
        h('div', { class: 'vs-row-sub' },
          h('span', null, `${plural((r.bills_held || []).length, 'open bill')}, ${held.length} held by the W-9`), h('span', { class: 'money' }, fmtMoney(sum(held))),
          hasUpload(r) ? badge({ ...UPLOAD_STATE.received }) : null)));
    })));
  }

  async function load() {
    loadError = null;
    try {
      const q = await w9.queue();
      if (!alive) return;
      rows = q.rows || [];
      asOf.textContent = dataAsOf();
    } catch (e) {
      if (!alive) return;
      loadError = errText(e);
    }
    renderList();
    if (!selected) renderDetail();
  }

  // ------------------------------------------------------------------ detail
  async function open(id, { quiet = false, uploadId } = {}) {
    const my = ++seq;
    if (!id) { detail = null; renderDetail(); return; }
    if (!quiet || detail?.id !== id) { detail = { id, loading: true }; renderDetail(); }
    try {
      const [v, ob] = await Promise.all([w9.vendor(id), wf.outbound('w9_request').catch(() => ({ rows: [] }))]);
      const pick = uploadId || (v.uploads || []).find((u) => u.state === 'received' || u.state === 'needs_review')?.upload_id || v.uploads?.[0]?.upload_id;
      const up = pick ? await w9.upload(pick).catch(() => null) : null;
      if (!alive || my !== seq) return;
      detail = { id, vendor: v, requests: (ob.rows || []).filter((o) => String(o.vendor_id) === String(id)), upload: up };
    } catch (e) {
      if (!alive || my !== seq) return;
      detail = { id, error: e.status === 404 ? 'We couldn’t find that vendor.' : errText(e) };
    }
    renderDetail();
  }

  const back = () => h('a', { class: 'vs-back', href: '#/vendor-setup' }, icon('chev-left'), 'Back to vendors');

  function renderDetail() {
    grid.toggleAttribute('data-open', !!selected);
    if (!selected) {
      fill(detailPane, h('div', { class: 'vs-body' }, empty({ icon: 'vendor-setup', title: 'Choose a vendor', text: 'See their W-9 on file, the bills it holds up, any upload to review, and request a new W-9.' })));
      return;
    }
    if (!detail || detail.loading) { fill(detailPane, h('div', { class: 'vs-body' }, skeletonText({ lines: 3, label: 'Opening vendor' }), skeletonText({ lines: 5 }))); return; }
    if (detail.error) { fill(detailPane, h('div', { class: 'vs-body' }, back(), empty({ icon: 'circle-alert', title: 'This vendor could not be opened', text: detail.error }))); return; }
    const v = detail.vendor;
    const of = v.on_file || {};
    fill(detailPane, h('div', { class: 'vs-body' },
      back(),
      h('header', { class: 'vs-dhead' },
        h('div', { class: 'vs-dtitles' }, h('h2', { class: 'vs-dtitle' }, v.vendor), h('p', { class: 'lv-muted' }, h('span', { class: 'mono' }, v.email), ` · vendor ${v.vendor_id}`)),
        statusBadge(v.status, v.label)),
      uploadCard(detail.upload, v),
      requestCard(v, detail.requests),
      h('section', { class: 'vs-section', 'aria-labelledby': 'vs-onfile-h' },
        h('h3', { class: 'vs-h3', id: 'vs-onfile-h' }, 'On our record'),
        kv([
          ['Legal name', of.legal_name || '—'], ['Entity type', of.entity_type || '—'], ['Address', of.address || '—'],
          ['TIN', h('span', { class: 'mono' }, of.tin_masked || '—')],
          ['W-9 on file', of.on_file_at ? fmtDay(of.on_file_at, { year: true }) : 'None'],
          of.verified_by ? ['Verified', `${nameOf(of.verified_by)}${of.verified_at ? `, ${fmtWhen(of.verified_at)}` : ''}`] : null,
        ], 'lv-kv-wide')),
      billsSection(v.bills_held || []),
      (v.uploads || []).length > 1 ? h('section', { class: 'vs-section' }, h('h3', { class: 'vs-h3' }, 'Earlier uploads'),
        h('ul', { class: 'vs-uploads' }, v.uploads.map((u) => h('li', null,
          h('button', { class: 'lv-linkbtn', type: 'button', onclick: () => open(v.vendor_id, { quiet: true, uploadId: u.upload_id }) }, u.filename),
          h('span', { class: 'lv-muted' }, ` · ${fmtWhen(u.uploaded_at)} · ${u.state === 'verified' ? 'verified' : 'to review'}`))))) : null));
  }

  function billsSection(bills) {
    const { held, scheduled } = splitBills(bills);
    const list = (id, title, sub, rows) => h('section', { class: 'vs-section', 'aria-labelledby': id },
      h('h3', { class: 'vs-h3', id }, title, h('span', { class: 'lv-count' }, rows.length), h('span', { class: 'money vs-total' }, fmtMoney(sum(rows)))),
      h('p', { class: 'lv-muted vs-sub' }, sub),
      h('ul', { class: 'vs-bills' }, rows.map((b) => h('li', { class: 'vs-bill' },
        h('span', { class: 'mono' }, b.tranId), h('span', { class: 'money' }, fmtMoney(b.amount)), h('span', { class: 'lv-muted vs-bill-st' }, b.status)))));
    if (!bills.length) {
      return h('section', { class: 'vs-section', 'aria-labelledby': 'vs-bills-h' }, h('h3', { class: 'vs-h3', id: 'vs-bills-h' }, 'Open bills'),
        h('p', { class: 'lv-muted' }, 'No open bills for this vendor.'));
    }
    return h('div', { class: 'vs-billgroups' },
      held.length ? list('vs-held-h', 'Held by the W-9', 'Open bills not yet in a payment run, in number order.', held) : null,
      scheduled.length ? list('vs-sched-h', 'Already scheduled', 'In a payment run already, by payment date.', scheduled) : null);
  }

  // ---- the extraction card
  function uploadCard(u, v) {
    if (!u) return null;
    const fraud = (u.flags || []).includes('fraud');
    const verified = u.state === 'verified';
    const mismatches = (u.fields || []).filter((f) => f.match === false).length;
    const verifyBtn = button({ label: 'Mark verified', variant: 'primary', icon: 'circle-check', disabled: fraud || verified });
    verifyBtn.addEventListener('click', async () => {
      setBusy(verifyBtn, true);
      try {
        await w9.verify(u.upload_id);
        toast({ message: 'W-9 verified. Next, update the NetSuite vendor record.', tone: 'settled' });
        say(live, 'W-9 marked verified.');
        await Promise.all([open(v.vendor_id, { quiet: true, uploadId: u.upload_id }), load()]);
      } catch (e) { setBusy(verifyBtn, false); toast({ message: errText(e), tone: 'risk' }); }
    });
    const markFor = (f) => (f.match === true ? badge({ label: 'Matches', tone: 'settled', icon: 'check' })
      : f.match === false ? badge({ label: 'Differs', tone: 'risk', icon: 'alert' }) : badge({ label: 'Not on record', tone: 'neutral' }));
    return h('section', { class: 'c-pane vs-card', 'aria-labelledby': 'vs-up-h' },
      h('header', { class: 'c-pane-head' }, h('div', { class: 'c-pane-titles' },
        h('h3', { class: 'c-pane-title', id: 'vs-up-h' }, verified ? 'Verified W-9' : 'Review upload'),
        h('p', { class: 'c-pane-sub' }, h('span', null, u.filename), ` · ${Math.max(1, Math.round((u.size || 0) / 1024))} KB · uploaded ${fmtWhen(u.uploaded_at)}`))),
      h('div', { class: 'c-pane-body' },
        fraud ? notice({ tone: 'risk', title: 'Needs CFO review', text: 'This upload carries bank details or other fraud signs. It goes to the fraud review path and can’t be verified here.' }) : null,
        !fraud && !verified && mismatches ? notice({ tone: 'waiting', title: `${plural(mismatches, 'field')} ${mismatches === 1 ? 'differs' : 'differ'} from our record`, text: 'Check with the vendor before you verify, or verify if the record is the one that is out of date.' }) : null,
        h('table', { class: 'c-table c-table-dense vs-fields' },
          h('caption', { class: 'sr-only' }, 'Fields read from the W-9 compared with our record'),
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Field'), h('th', { scope: 'col' }, 'On the W-9'), h('th', { scope: 'col' }, 'On our record'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Match')))),
          h('tbody', null, (u.fields || []).map((f) => h('tr', { class: f.match === false ? 'vs-diff' : null },
            h('th', { scope: 'row' }, f.name),
            h('td', { class: f.name === 'TIN' ? 'mono' : null }, f.value_masked || '—'),
            h('td', { class: f.name === 'TIN' ? 'mono' : null }, f.record || '—'),
            h('td', { class: 'is-end' }, markFor(f)))))),
        h('p', { class: 'vs-hash' }, 'SHA-256 ', h('span', { class: 'mono' }, (u.sha256 || '').slice(0, 16)), ' · the file is stored on this computer, never in email.'),
        verified ? notice({ tone: 'settled', title: `Verified by ${nameOf(u.verified_by)}`, text: u.verified_at ? fmtWhen(u.verified_at) : '' }) : null,
        verified ? h('div', { class: 'vs-next' }, h('span', { class: 'vs-next-label' }, 'Next step for a person'),
          h('strong', null, u.next_step || NEXT_STEP), h('span', { class: 'lv-muted' }, 'Conductor does not change NetSuite.')) : null),
      verified ? null : h('footer', { class: 'c-pane-foot vs-actions' },
        h('span', { class: 'lv-muted vs-foot-note' }, fraud ? 'Only the CFO can clear this.' : 'Records who verified it and when. Then update the NetSuite vendor record.'),
        verifyBtn));
  }

  // ---- Request W-9: draft -> approve -> send
  function requestCard(v, requests) {
    const latest = requests[0];
    const drafting = button({ label: 'Request W-9', icon: 'mail', variant: latest ? 'secondary' : 'primary', disabled: v.status === 'on_file' || (latest && latest.state !== 'sent') });
    drafting.addEventListener('click', async () => {
      setBusy(drafting, true);
      try {
        await w9.requestW9(v.vendor_id);
        toast({ message: 'W-9 request drafted. Review it, then approve and send.', tone: 'settled' });
        await open(v.vendor_id, { quiet: true });
      } catch (e) { setBusy(drafting, false); toast({ message: errText(e), tone: 'risk' }); }
    });
    const head = h('header', { class: 'c-pane-head' }, h('div', { class: 'c-pane-titles' },
      h('h3', { class: 'c-pane-title' }, 'W-9 request'),
      h('p', { class: 'c-pane-sub' }, v.requested_at ? `Last requested ${fmtWhen(v.requested_at)}` : 'An email with a secure upload link to Conductor: Direct.')),
    v.status === 'on_file' ? null : drafting);
    if (!latest) {
      return h('section', { class: 'c-pane vs-card' }, head, h('div', { class: 'c-pane-body' },
        h('p', { class: 'lv-muted' }, v.status === 'on_file' ? 'A W-9 is on file. No request is needed.' : 'No request drafted yet. The text comes from our records and asks for no bank details.')));
    }
    const actions = [];
    if (latest.state === 'pending') {
      const approve = button({ label: 'Approve', icon: 'check', disabled: (latest.problems || []).length > 0 });
      approve.addEventListener('click', async () => {
        setBusy(approve, true);
        try { await wf.setOutboundState(latest.id, 'approved'); toast({ message: 'Approved. Send it when you are ready.', tone: 'settled' }); await open(v.vendor_id, { quiet: true }); } catch (e) { setBusy(approve, false); toast({ message: errText(e), tone: 'risk' }); }
      });
      actions.push(approve);
    } else if (latest.state === 'approved') {
      const undo = button({ label: 'Undo', variant: 'quiet' });
      undo.addEventListener('click', async () => {
        setBusy(undo, true);
        try { await wf.setOutboundState(latest.id, 'pending'); await open(v.vendor_id, { quiet: true }); } catch (e) { setBusy(undo, false); toast({ message: errText(e), tone: 'risk' }); }
      });
      const send = button({ label: 'Send', variant: 'primary', icon: 'send' });
      send.addEventListener('click', async () => {
        setBusy(send, true);
        try { await wf.sendOutbound(latest.id); toast({ message: `Sent to ${latest.to}.`, tone: 'settled' }); say(live, 'W-9 request sent.'); await open(v.vendor_id, { quiet: true }); } catch (e) { setBusy(send, false); toast({ message: errText(e), tone: 'risk' }); }
      });
      actions.push(undo, send);
    }
    return h('section', { class: 'c-pane vs-card', 'aria-label': 'W-9 request' }, head,
      h('div', { class: 'c-pane-body vs-req' },
        (latest.problems || []).length ? notice({ tone: 'risk', title: 'This can’t be approved', text: latest.problems.join('; ') }) : null,
        v.status === 'on_file' && latest.state !== 'sent' ? notice({ tone: 'info', text: 'A W-9 is now on file, so this request no longer needs to go out.' }) : null,
        kv([['To', h('span', { class: 'mono' }, latest.to)], ['Subject', latest.subject],
          ['Drafted', `${nameOf(latest.created_by)}, ${fmtWhen(latest.created_at)}`],
          latest.sent_at ? ['Sent', fmtWhen(latest.sent_at)] : null], 'lv-kv-wide'),
        h('div', { class: 'lv-letter' }, latest.body)),
      h('footer', { class: 'c-pane-foot vs-actions' }, reviewBadge(latest.state), h('span', { class: 'lv-spacer' }), actions));
  }

  // ------------------------------------------------------------------ live
  const off = subscribe((ev) => {
    if (!alive) return;
    if (ev.type === 'w9.received') {
      load();
      if (selected && String(ev.vendor_id) === String(selected)) open(selected, { quiet: true });
      say(live, ev.summary || 'A W-9 arrived.');
    }
    if (ev.type === 'outbound.sent' || ev.type === 'outbound.created') { if (selected) open(selected, { quiet: true }); }
  });

  renderList();
  renderDetail();
  load();
  if (selected) open(selected);

  return {
    update({ route: next }) {
      const id = next.vendorId || null;
      if (id === selected) return;
      selected = id;
      renderList();
      open(id);
      if (id) detailPane.focus({ preventScroll: true });
    },
    destroy() { alive = false; off?.(); },
  };
}
