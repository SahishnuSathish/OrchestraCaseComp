// Evidence panel, like Zendesk's context panel: the requester and vendor card, the bill, payment and run behind each
// invoice (every fact with a source chip), linked tickets, the brief, and the rule trail in plain words.
// Payment accounts arrive masked from the server and are masked again here, so no more than 4 digits ever show.
import { h, icon } from '../../lib.js';
import { badge, sourceChip, avatar, statusBadge } from '../badges.js';
import { fmtMoney, notice } from '../data.js';
import { maskSensitive } from './format.js';
import { senderBadge } from './reading.js';

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

function requesterCard(ev, t) {
  const r = ev.requester || {};
  const v = ev.vendor;
  const w9 = v?.w9_status ? W9[v.w9_status] : null;
  return section('Requester', h('div', { class: 'ws-ev-card' },
    h('div', { class: 'ws-ev-person' }, avatar({ name: r.name || r.email || '?' }),
      h('div', { class: 'ws-ev-person-text' }, h('strong', null, r.name || 'Unknown sender'), h('span', { class: 'ws-ev-email' }, r.email || ''),
        h('span', { class: 'ws-ev-kind' }, KIND[r.kind] || 'Sender'))),
    h('div', { class: 'ws-ev-badges' }, senderBadge({ ...t, sender_verified: !!r.authorized })),
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
  intake: 'Email received', sender: 'Who sent it', extract_regex: 'What they asked', extract_model: 'Read by the local model',
  prechecks: 'Safety checks', plan: 'What to look up', lookups: 'Records found', linked: 'Related tickets', rules: 'Decision',
  draft: 'Reply written', draft_check: 'Reply checked', compose: 'Reply written',
};
const DRAFT_STAGES = new Set(['draft', 'draft_check', 'compose']);
const INTENTS = {
  status_request: 'a payment status question', not_received: 'a payment that did not arrive', bank_change: 'a change of bank details',
  legal_or_collections_threat: 'a legal or collections threat', hr_or_payroll: 'pay or HR', receivable_from_client: 'money paid to Orchestra',
  machine_notice: 'an automated notice', no_request: 'no request', expedite_request: 'early payment', late_fee: 'a late fee', other: 'another question',
};
// What each rule decided, without repeating the reason (the insight strip already says why).
const RULES = {
  fraud: 'Held as possible fraud. A person decides; no reply is written.',
  holding_reply: 'A holding reply, sent only after the CFO signs off.',
  unauthorized_sender: 'An internal note, because the sender is not on file.',
  late_fee: 'An internal note for the late fee.',
  expedite_request: 'An internal note for the early payment request.',
  returned_payment: 'An internal note for the returned payment.',
  injection_suspected: 'Held for a person, because the email has unusual content.',
  not_on_file: 'A reply asking for a copy of the invoice.',
};
const plural = (n, one, many = `${one}s`) => `${n} ${Number(n) === 1 ? one : many}`;
const sentence = (s) => { const x = String(s || '').trim(); return x ? x[0].toUpperCase() + x.slice(1) + (/[.!?]$/.test(x) ? '' : '.') : ''; };

export function plainStage(s) {
  const t = String(s.summary || '');
  let m;
  switch (s.name) {
    case 'intake': {
      const n = /(\d+) attachment/.exec(t);
      const from = t.split(';')[0].trim();
      return `From ${from}${n ? `, ${n[1] === '0' ? 'no attachments' : plural(n[1], 'attachment')}` : ''}.`;
    }
    case 'sender':
      if (/authorized=True/.test(t)) return /employee/.test(t) ? 'An active Orchestra employee.' : 'A contact listed on the vendor record.';
      return 'Not on any vendor record, so nothing private is shared.';
    case 'extract_regex':
      if ((m = /intent=(\w+)/.exec(t))) {
        const refs = (/refs=\[(.*?)\]/.exec(t)?.[1] || '').replace(/'/g, '').trim();
        return `Read as ${INTENTS[m[1]] || m[1].replace(/_/g, ' ')}${refs ? `, about ${refs}` : ''}.`;
      }
      return sentence(t);
    case 'extract_model': return sentence(t);
    case 'prechecks': return /fraud=yes/.test(t) ? 'Signs of fraud found, so a person handles it.' : 'No signs of fraud.';
    case 'plan':
      if ((m = /(\d+) invoice reference/.exec(t))) return `${plural(m[1], 'invoice reference')} to look up: bills, payments and payment runs.`;
      return /no invoice/i.test(t) ? 'No invoice number to look up.' : sentence(t);
    case 'lookups': {
      const n = /(\d+) item/.exec(t);
      const found = (t.match(/'found'/g) || []).length;
      return n ? `${found} of ${plural(n[1], 'invoice')} found in NetSuite.` : sentence(t);
    }
    case 'linked': {
      if (/linked=\[\]/.test(t) && /copied=\[\]/.test(t)) return 'No related tickets. No executives copied.';
      const linked = (/linked=\[(.*?)\]/.exec(t)?.[1] || '').replace(/'/g, '').trim();
      const execs = (/copied=\[(.*?)\]/.exec(t)?.[1] || '').replace(/'/g, '').trim();
      return [linked ? `Related: ${linked}.` : 'No related tickets.', execs ? `Executives copied: ${execs}.` : null].filter(Boolean).join(' ');
    }
    case 'rules': {
      const rule = /rule '([\w-]+)'/.exec(t)?.[1];
      if (rule && RULES[rule]) return RULES[rule];
      if (/^draft_reply/.test(t)) return 'A reply drafted from the records.';
      if (/^internal_action_note/.test(t)) return 'An internal note for a person to act on.';
      if (/^no_draft/.test(t)) return 'No reply needed.';
      return rule ? `The ${rule.replace(/_/g, ' ')} rule applies.` : sentence(t);
    }
    case 'draft': case 'compose': return /chars/.test(t) ? 'Written from the records only.' : sentence(t);
    case 'draft_check': return t === 'passed' ? 'No amounts, dates or promises beyond the records.' : sentence(t);
    default: return sentence(t);
  }
}

/** The steps worth showing: no reply steps when there is no reply, and no step that did not run. */
function trailSteps(t) {
  const hasDraft = (t.review?.draft?.output_type || t.result?.output_type) === 'draft_reply';
  return (t.evidence?.rule_trail || []).filter((s) => {
    if (DRAFT_STAGES.has(s.name) && !hasDraft) return false;
    if (s.name === 'extract_model' && /skipped|not used|no-model/i.test(String(s.summary || ''))) return false;
    return true;
  });
}

/** wsEvidence(thread) - the whole Details tab. */
export function wsEvidence(t) {
  const ev = t.evidence || {};
  const keep = t.invoice_refs || [];
  const items = ev.items || [];
  const brief = ev.brief?.bullets || [];
  const steps = trailSteps(t);
  return h('div', { class: 'ws-ev' },
    requesterCard(ev, t),
    section(items.length === 1 ? 'Invoice' : 'Invoices', items.length
      ? h('div', { class: 'ws-ev-items' }, items.map((it) => itemCard(it, keep)))
      : h('p', { class: 'ws-ev-note' }, 'No invoice number in this email.'), { id: 'ws-ev-inv' }),
    (ev.linked || []).length ? section('Linked tickets', h('ul', { class: 'ws-ev-linked' }, ev.linked.map((l) => h('li', null,
      sourceChip({ label: `Zendesk #${l.id}` }), h('span', { class: 'ws-ev-linked-sub' }, l.subject || ''), l.status ? badge({ label: l.status, tone: 'neutral' }) : null))), { id: 'ws-ev-linked' }) : null,
    brief.length ? section('Brief', h('dl', { class: 'ws-brief' }, brief.map((b) => [h('dt', null, b.label), h('dd', null, maskSensitive(b.text, keep))])),
      { id: 'ws-ev-brief', actions: h('span', { class: 'ws-ev-hint' }, ev.brief?.source === 'model' ? 'Written by the local model' : 'Written from the records') }) : null,
    steps.length ? h('section', { class: 'ws-ev-section' },
      h('details', { class: 'ws-steps' },
        h('summary', { class: 'ws-steps-summary' }, icon('chevron-right', 'ws-steps-chev'), h('span', { class: 'ws-ev-title' }, 'How Conductor got here'),
          h('span', { class: 'ws-ev-hint' }, plural(steps.length, 'step'))),
        h('ol', { class: 'ws-trail' }, steps.map((s) => h('li', null,
          h('span', { class: 'ws-trail-name' }, STAGE[s.name] || sentence(s.name.replace(/_/g, ' ')).replace(/\.$/, '')),
          h('span', { class: 'ws-trail-text' }, maskSensitive(plainStage(s), keep))))))) : null);
}
