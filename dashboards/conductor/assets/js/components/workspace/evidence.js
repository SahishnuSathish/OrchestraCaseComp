// Evidence panel, like Zendesk's context panel: the requester and vendor card, the bill, payment and run behind each
// invoice (every fact with a source chip), linked tickets, the brief, and the rule trail in plain words.
// Payment accounts arrive masked from the server and are masked again here, so no more than 4 digits ever show.
import { h, icon } from '../../lib.js';
import { badge, contactBadge, sourceChip, avatar, statusBadge } from '../badges.js';
import { fmtMoney, notice } from '../data.js';
import { maskSensitive } from './format.js';

const W9 = {
  on_file: { label: 'W-9 on file', tone: 'settled', icon: 'circle-check' },
  missing: { label: 'W-9 missing', tone: 'waiting', icon: 'circle-alert' },
  expired: { label: 'W-9 expired', tone: 'waiting', icon: 'clock' },
  name_mismatch: { label: 'W-9 name mismatch', tone: 'risk', icon: 'alert' },
  tin_mismatch: { label: 'W-9 TIN mismatch', tone: 'risk', icon: 'alert' },
};
const OUTCOME = {
  paid: { code: 'paid', label: 'Paid' }, released: { code: 'payment_sent', label: 'Payment released' },
  scheduled: { code: 'scheduled', label: 'On a payment run' }, approved_no_run: { code: 'approved', label: 'Approved, no run yet' },
  pending: { code: 'pending_approval', label: 'Waiting on approval' }, returned: { code: 'under_review', label: 'Payment returned' },
  conflict: { code: 'under_review', label: 'Records disagree' },
};
const KIND = { vendor_contact: 'Vendor contact', employee: 'Orchestra employee', unknown: 'Unknown sender', internal: 'Orchestra employee' };

const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(`${String(s).slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const kv = (rows) => h('dl', { class: 'ws-kv' }, rows.filter((r) => r && r[1] != null && r[1] !== '').map(([k, v, cls]) => [h('dt', null, k), h('dd', { class: cls || null }, v)]));
const section = (title, body, { id, actions } = {}) => h('section', { class: 'ws-ev-section', 'aria-labelledby': id },
  h('header', { class: 'ws-ev-head' }, h('h3', { class: 'ws-ev-title', id }, title), actions || null), body);

function requesterCard(ev) {
  const r = ev.requester || {};
  const v = ev.vendor;
  const w9 = v?.w9_status ? W9[v.w9_status] : null;
  return section('Requester', h('div', { class: 'ws-ev-card' },
    h('div', { class: 'ws-ev-person' }, avatar({ name: r.name || r.email || '?' }),
      h('div', { class: 'ws-ev-person-text' }, h('strong', null, r.name || 'Unknown sender'), h('span', { class: 'ws-ev-email' }, r.email || ''),
        h('span', { class: 'ws-ev-kind' }, KIND[r.kind] || 'Sender'))),
    h('div', { class: 'ws-ev-badges' }, contactBadge(!!r.authorized)),
    v ? h('div', { class: 'ws-ev-vendor' },
      h('div', { class: 'ws-ev-vendor-name' }, icon('building'), h('strong', null, v.name), w9 ? badge(w9) : null),
      kv([['Subsidiary', v.subsidiary], ['Terms', v.terms], ['Vendor ID', v.id, 'mono']]),
      h('div', { class: 'ws-ev-sub' }, 'Authorized contacts'),
      h('ul', { class: 'ws-ev-contacts' }, (v.contacts || []).map((c) => h('li', { class: c.is_requester ? 'is-requester' : null },
        icon(c.is_requester ? 'user-check' : 'user'), h('span', { class: 'ws-ev-email' }, c.email), c.is_requester ? h('span', { class: 'ws-ev-tag' }, 'Sender') : null))),
      h('div', { class: 'ws-ev-sources' }, sourceChip({ label: `NetSuite · vendor ${v.id}` })))
      : notice({ tone: 'neutral', text: 'No vendor record matches this sender.' })), { id: 'ws-ev-req' });
}

function itemCard(it, keep) {
  const b = it.bill;
  if (!b) {
    return h('article', { class: 'ws-ev-item' },
      h('header', { class: 'ws-ev-item-head' }, h('span', { class: 'mono' }, it.ref), badge({ label: it.status === 'not_found' ? 'Not found in NetSuite' : (it.status || '').replace(/_/g, ' '), tone: 'waiting', icon: 'circle-alert' })),
      h('p', { class: 'ws-ev-note' }, 'No bill with this number is on record for this vendor.'));
  }
  const o = OUTCOME[it.outcome];
  const p = it.payment;
  const r = it.run;
  return h('article', { class: 'ws-ev-item' },
    h('header', { class: 'ws-ev-item-head' },
      h('span', { class: 'ws-ev-inv' }, 'Invoice ', h('span', { class: 'mono' }, b.tranId)),
      o ? statusBadge(o) : null),
    h('div', { class: 'ws-ev-amount money' }, fmtMoney(b.userTotal, b.currency || 'USD')),
    kv([['Bill date', fmtDate(b.tranDate)], ['Due', fmtDate(b.dueDate)], ['Status', b.status], ['Approval', b.approvalStatus],
      b.nextApprover ? ['Next approver', b.nextApprover] : null, b.poNumber ? ['PO', b.poNumber, 'mono'] : null, b.memo ? ['Memo', b.memo] : null]),
    p ? h('div', { class: 'ws-ev-block' }, h('div', { class: 'ws-ev-sub' }, icon('send'), 'Payment'),
      kv([['Payment', p.tranId, 'mono'], ['Method', p.paymentMethod], ['Amount', fmtMoney(p.total, b.currency || 'USD'), 'money'],
        ['Released', fmtDate(p.released_date)], ['Settled', fmtDate(p.settled_date)], ['Status', p.release_status],
        p.referenceNumber ? ['Reference', p.referenceNumber, 'mono'] : null,
        p.account ? ['Account', maskSensitive(String(p.account), keep).replace(/\d(?=\d{4})/g, '•'), 'mono'] : null])) : null,
    r ? h('div', { class: 'ws-ev-block' }, h('div', { class: 'ws-ev-sub' }, icon('calendar'), 'Payment run'),
      kv([['Run', r.run_id, 'mono'], ['Run date', fmtDate(r.run_date)], ['Status', r.run_status]])) : null,
    (it.sources || []).length ? h('div', { class: 'ws-ev-sources' }, it.sources.map((s) => sourceChip({ label: s.label, title: `Source: ${s.label} (${s.ref})` }))) : null);
}

// The pipeline's stage summaries, said in plain words. Unknown stages keep their own summary.
const STAGE = {
  intake: 'Email received', sender: 'Who sent it', extract_regex: 'What they asked', extract_model: 'Local model reading',
  prechecks: 'Safety checks', plan: 'What to look up', lookups: 'Records found', linked: 'Related tickets', rules: 'Rule applied',
  draft: 'Draft written', draft_check: 'Draft checked', compose: 'Draft written',
};
const INTENTS = {
  status_request: 'a payment status question', not_received: 'a payment that did not arrive', bank_change: 'a change of bank details',
  legal_or_collections_threat: 'a legal or collections threat', hr_or_payroll: 'pay or HR', receivable_from_client: 'money paid to Orchestra',
  machine_notice: 'an automated notice', no_request: 'no request', expedite_request: 'early payment', late_fee: 'a late fee', other: 'another question',
};
export function plainStage(s) {
  const t = String(s.summary || '');
  let m;
  switch (s.name) {
    case 'intake': { const n = /(\d+) attachment/.exec(t); return `From ${t.split(';')[0]}${n ? `, ${n[1] === '0' ? 'no attachments' : `${n[1]} attachment${n[1] === '1' ? '' : 's'}`}` : ''}.`; }
    case 'sender':
      if (/authorized=True/.test(t)) return /employee/.test(t) ? 'An active Orchestra employee.' : 'A contact listed on the vendor record.';
      return 'Not on any vendor record, so nothing private is shared.';
    case 'extract_regex':
      if ((m = /intent=(\w+)/.exec(t))) {
        const refs = (/refs=\[(.*?)\]/.exec(t)?.[1] || '').replace(/'/g, '').trim();
        return `Read as ${INTENTS[m[1]] || m[1].replace(/_/g, ' ')}${refs ? `, about ${refs}` : ''}.`;
      }
      return t;
    case 'extract_model': return /skipped/.test(t) ? 'Not used. The records answer this one.' : t;
    case 'prechecks': return /fraud=yes/.test(t) ? 'Fraud signals found. Held for a person.' : 'No fraud signals.';
    case 'lookups': { const n = /(\d+) item/.exec(t); const found = (t.match(/'found'/g) || []).length; return n ? `${found} of ${n[1]} invoice${n[1] === '1' ? '' : 's'} found in NetSuite.` : t; }
    case 'linked': return /linked=\[\]/.test(t) && /copied=\[\]/.test(t) ? 'No related tickets, no executives copied.' : t.replace('linked=', 'Related: ').replace('executives copied=', 'executives copied: ');
    case 'rules': if ((m = /rule '([\w-]+)': (.*)$/.exec(t))) return `${m[2].replace(/^./, (c) => c.toUpperCase())}${/[.]$/.test(m[2]) ? '' : '.'}`; return t;
    case 'draft': return /chars/.test(t) ? 'Written from the records only.' : t;
    case 'draft_check': return t === 'passed' ? 'Passed: no new amounts, dates or promises beyond the records.' : t;
    default: return t;
  }
}

/** wsEvidence(thread) - the whole Details tab. */
export function wsEvidence(t) {
  const ev = t.evidence || {};
  const keep = t.invoice_refs || [];
  const items = ev.items || [];
  const brief = ev.brief?.bullets || [];
  return h('div', { class: 'ws-ev' },
    requesterCard(ev),
    section(items.length === 1 ? 'Invoice' : 'Invoices', items.length
      ? h('div', { class: 'ws-ev-items' }, items.map((it) => itemCard(it, keep)))
      : h('p', { class: 'ws-ev-note' }, 'No invoice number in this email.'), { id: 'ws-ev-inv' }),
    (ev.linked || []).length ? section('Linked tickets', h('ul', { class: 'ws-ev-linked' }, ev.linked.map((l) => h('li', null,
      sourceChip({ label: `Zendesk #${l.id}` }), h('span', { class: 'ws-ev-linked-sub' }, l.subject || ''), l.status ? badge({ label: l.status, tone: 'neutral' }) : null))), { id: 'ws-ev-linked' }) : null,
    brief.length ? section('Brief', h('dl', { class: 'ws-brief' }, brief.map((b) => [h('dt', null, b.label), h('dd', null, maskSensitive(b.text, keep))])),
      { id: 'ws-ev-brief', actions: h('span', { class: 'ws-ev-hint' }, ev.brief?.source === 'model' ? 'Written by the local model' : 'Written from the records') }) : null,
    (ev.rule_trail || []).length ? section('Why this outcome', h('ol', { class: 'ws-trail' }, ev.rule_trail.map((s) => h('li', null,
      h('span', { class: 'ws-trail-name' }, STAGE[s.name] || s.name.replace(/_/g, ' ')), h('span', { class: 'ws-trail-text' }, maskSensitive(plainStage(s), keep))))), { id: 'ws-ev-why' }) : null);
}
