// Reading pane parts, styled like an Outlook message: the subject bar, the insight strip pinned above the message,
// workflow notices, the thread history with full headers, attachment chips and the "Sent by" receipt.
// Every body is masked before it is shown (account, routing and tax numbers: last 4 digits only).
import { h, icon } from '../../lib.js';
import { badge, outcomeBadge, riskBadges, contactBadge, chip, avatar } from '../badges.js';
import { notice } from '../data.js';
import { maskSensitive, fullTime, clockTime, personName, reasonLabel, firstName, isPriority, hasRisk, plainWhy } from './format.js';

const ZENDESK = { open: 'Open', new: 'New', pending: 'Pending', solved: 'Solved', closed: 'Closed', hold: 'On hold' };

/** wsSubjectBar(thread, { actions }) - subject, ticket id, source, assignee and the thread's badges. */
export function wsSubjectBar(t, { lead, actions } = {}) {
  const source = t.source === 'Conductor: Direct' ? 'Conductor: Direct' : 'Outlook';
  return h('header', { class: 'ws-subject' },
    lead || null,
    h('div', { class: 'ws-subject-main' },
      h('h2', { class: 'ws-subject-title', id: 'ws-reading-title' }, t.subject || 'No subject'),
      h('div', { class: 'ws-subject-meta' },
        h('span', { class: 'ws-zd', title: 'Zendesk ticket' }, icon('tickets'), h('span', { class: 'mono' }, `Zendesk #${t.ticket_id}`),
          h('span', { class: 'ws-zd-status' }, ZENDESK[t.zendesk_status] || t.zendesk_status || 'Open')),
        h('span', { class: `ws-source${source === 'Outlook' ? '' : ' is-direct'}` }, icon(source === 'Outlook' ? 'mail' : 'building'), source),
        t.assignee ? h('span', { class: 'ws-assignee' }, icon('user'), `Assigned to ${personName(t.assignee)}`) : h('span', { class: 'ws-assignee' }, icon('user'), 'Unassigned'))),
    actions ? h('div', { class: 'ws-subject-actions' }, actions) : null);
}

/**
 * senderBadge(t) - the sender check. A green "Verified contact" only when nothing else on the ticket is a risk: with a
 * fraud, legal or copied-executive flag the sender is just "Listed contact", in grey, so the chips never disagree.
 */
export function senderBadge(t) {
  if (!t.sender_verified) return contactBadge(false);
  if (hasRisk(t)) return badge({ label: 'Listed contact', tone: 'neutral', icon: 'user', title: 'The sender is listed on the vendor record. That alone does not make this request safe.' });
  return contactBadge(true);
}

/** The outcome chip. A priority reply needs the CFO's sign-off before it is a ready draft. */
export function outcomeChip(t) {
  if (t.outcome === 'draft_ready' && isPriority(t)) {
    return (t.workflow?.state || t.workflow_state) === 'signed_off'
      ? badge({ label: 'Signed off', tone: 'scheduled', icon: 'circle-check' })
      : badge({ label: 'Needs sign-off', tone: 'waiting', icon: 'escalations', title: 'The CFO signs off this reply before it goes out' });
  }
  return outcomeBadge(t.outcome);
}

/** The badge row under the subject: outcome, risks and the sender check. */
export function wsBadgeRow(t) {
  return h('div', { class: 'ws-badgerow' }, outcomeChip(t), ...riskBadges(t.flags || []), senderBadge(t),
    t.group_size > 1 ? chip({ label: `${t.group_size} threads in this group`, icon: 'link' }) : null);
}

/**
 * wsInsight(thread) - the strip pinned above the message: what they want, the invoice matched, what the records say
 * and why. Words come from records and rules (inbox._insight), never from the email.
 */
export function wsInsight(t) {
  const i = t.insight || {};
  const ev = t.evidence || {};
  const verified = ev.requester?.authorized ?? t.sender_verified;
  const cell = (label, value, cls) => h('div', { class: `ws-insight-cell${cls ? ` ${cls}` : ''}` },
    h('dt', null, label), h('dd', null, value || h('span', { class: 'ws-muted' }, 'Nothing on record')));
  const statusLines = (i.status_line || '').split(';').map((s) => s.trim()).filter(Boolean);
  const who = ev.vendor ? `for ${ev.vendor.name}` : '';
  let sender;
  if (!verified) sender = h('span', { class: 'ws-insight-warn' }, icon('user-x'), 'Not an authorized contact on any vendor record');
  else if (hasRisk(t)) sender = h('span', { class: 'ws-insight-plain' }, icon('user'), ev.vendor ? `Listed contact ${who}` : 'Listed contact');
  else sender = h('span', { class: 'ws-insight-ok' }, icon('shield-check'), ev.vendor ? `Authorized contact ${who}` : (ev.requester?.kind === 'employee' ? 'Active Orchestra employee' : 'Verified contact'));
  const why = i.why ? plainWhy(maskSensitive(i.why, t.invoice_refs || [])) : '';
  return h('section', { class: 'ws-insight', 'aria-label': 'What Conductor found' },
    h('dl', { class: 'ws-insight-grid' },
      cell('They want', i.wants ? sentence(`${firstName(t.from_name) || 'The sender'} ${i.wants}`) : null, 'is-wide'),
      cell(invoiceCount(i.invoice) > 1 ? 'Invoices' : 'Invoice', i.invoice ? invoiceList(i.invoice) : null),
      cell('Records say', statusLines.length ? h('ul', { class: 'ws-insight-list' }, statusLines.map((s) => h('li', null, s))) : null),
      cell('Sender', sender),
      why ? cell('Why', why, 'is-wide') : null));
}
// "2026-67322 (matched in NetSuite), 61787 (not found)" -> one line per invoice: the number, then how it matched.
const HOW = { 'matched in netsuite': 'Matched in NetSuite', 'not found': 'Not found', 'ambiguous': 'More than one match' };
const invoicePairs = (text) => [...String(text || '').matchAll(/([^,(]+?)\s*\(([^)]+)\)/g)].map((m) => [m[1].trim(), m[2].trim()]);
const invoiceCount = (text) => invoicePairs(text).length;
function invoiceList(text) {
  const items = invoicePairs(text);
  if (!items.length) return h('span', { class: 'mono' }, text);
  return h('ul', { class: 'ws-insight-refs' }, items.map(([ref, how]) => {
    const words = HOW[how.toLowerCase()] || how.charAt(0).toUpperCase() + how.slice(1);
    return h('li', { class: /not found/i.test(how) ? 'is-missing' : null }, h('span', { class: 'mono' }, ref), ' ', h('span', { class: 'ws-muted' }, words));
  }));
}
const sentence = (s) => { const x = String(s || '').trim(); return x ? x[0].toUpperCase() + x.slice(1) + (/[.!?]$/.test(x) ? '' : '.') : ''; };

/** The fraud banner: nothing on this ticket can be approved or sent from Conductor. */
export function wsFraudBanner(t) {
  return h('div', { class: 'ws-fraud', role: 'alert' },
    icon('shield-alert'),
    h('div', { class: 'ws-fraud-body' },
      h('strong', null, 'Possible fraud. Nothing on this ticket can be approved or sent.'),
      h('span', null, (t.flags || []).includes('fraud') && /bank/i.test(t.insight?.wants || t.decision?.why || '')
        ? 'This email asks to change bank details. Never act on details from the email. Verify by calling the vendor on the number already in NetSuite.'
        : 'Verify the request with the vendor through the contact details already in NetSuite. The CFO decides what happens next.')));
}

/** Workflow notices: escalated, waiting on sign-off, returned with guidance, signed off, chased. */
export function wsWorkflowNotices(t, wf, { role } = {}) {
  const out = [];
  const st = t.workflow?.state || 'open';
  const hist = wf?.history || [];
  const last = (action) => [...hist].reverse().find((a) => a.action === action);
  if (st === 'returned') {
    const r = last('return');
    out.push(notice({ tone: 'waiting', title: role === 'cfo' ? `You returned this to ${personName(t.assignee) || 'the specialist'}` : `${personName(r?.actor) || 'The CFO'} returned this to you`, text: r?.detail?.guidance ? `Guidance: ${r.detail.guidance}` : 'Read the guidance, then reply or escalate again.' }));
  }
  if (st === 'escalated') {
    const r = last('escalate');
    out.push(notice({ tone: 'waiting', title: role === 'cfo' ? `${personName(r?.actor) || 'A specialist'} escalated this to you` : 'Escalated to Elena Lockhart',
      text: [r?.detail?.reason ? reasonLabel(r.detail.reason) : null, r?.detail?.note || null, r?.at ? fullTime(r.at) : null].filter(Boolean).join(' · ') || null }));
  }
  if (st === 'signoff_requested') {
    const r = last('request-signoff');
    out.push(notice({ tone: 'waiting', title: role === 'cfo' ? `${personName(r?.actor) || 'A specialist'} asked for your sign-off` : 'Waiting for Elena Lockhart to sign off',
      text: [r?.detail?.note || null, r?.at ? `Requested ${fullTime(r.at)}` : null].filter(Boolean).join(' · ') || 'The reply goes out only after the CFO signs off on this exact text.' }));
  }
  if (st === 'signed_off' && wf?.signoff) {
    out.push(notice({ tone: 'settled', title: `Signed off by ${personName(wf.signoff.by)}`, text: `${fullTime(wf.signoff.at)}. Any edit to the reply cancels the sign-off.` }));
  }
  for (const c of wf?.chases || []) out.push(notice({ tone: c.responded ? 'settled' : 'info', title: c.label, text: c.state === 'sent' ? `Sent ${fullTime(c.at)}` : 'The nudge is waiting for review in Ahead, under Approver digests.' }));
  if (['decided', 'closed'].includes(st)) {
    const r = last('decide') || last('forward') || last('no-reply');
    if (r) {
      const what = r.action === 'forward' ? `Forwarded to ${r.detail?.to?.name || 'another team'}` : r.action === 'no-reply' ? 'Marked as no reply needed'
        : r.detail?.decision === 'acknowledged' ? 'Acknowledged' : 'Closed';
      out.push(notice({ tone: 'settled', title: `${what} by ${personName(r.actor)}`, text: [r.detail?.action_taken, r.detail?.note, fullTime(r.at)].filter(Boolean).join(' · ') }));
    }
  }
  return out.length ? h('div', { class: 'ws-notices' }, out) : null;
}

/** One message in the thread, with Outlook's header block. */
function messageCard(m, t, { first, last, keep }) {
  const isOurs = /orchestra/i.test(m.email || '') || /accounts payable/i.test(m.author || '');
  const to = first ? (t.headers?.to || '') : (isOurs ? t.from_email : t.headers?.to);
  const cc = first ? (t.headers?.cc || []) : [];
  const head = h('div', { class: 'ws-msg-head' },
    avatar({ name: m.author || '?', size: 'md', tone: isOurs ? 'chrome' : 'default' }),
    h('div', { class: 'ws-msg-who' },
      h('div', { class: 'ws-msg-from' }, h('strong', null, m.author || 'Unknown'), m.email ? h('span', { class: 'ws-msg-email' }, `<${m.email}>`) : null),
      h('dl', { class: 'ws-msg-hdrs' },
        to ? [h('dt', null, 'To'), h('dd', null, to)] : null,
        cc.length ? [h('dt', null, 'Cc'), h('dd', null, cc.join('; '))] : null),
      !m.public ? badge({ label: 'Internal note', tone: 'neutral', icon: 'lock' }) : null),
    h('time', { class: 'ws-msg-date', datetime: m.at || null }, fullTime(m.at)));
  const body = h('div', { class: 'ws-msg-body' }, maskSensitive(m.body || '', keep));
  const atts = (m.attachments || []).length ? h('div', { class: 'ws-msg-atts', 'aria-label': 'Attachments' },
    m.attachments.map((name) => chip({ label: name, icon: 'clip', title: `Attachment: ${name}` }))) : null;
  if (last) return h('article', { class: `ws-msg${isOurs ? ' is-ours' : ''}` }, head, body, atts);
  // Older messages fold, as in Outlook. A <details> keeps it keyboard reachable with no script.
  return h('details', { class: `ws-msg is-folded${isOurs ? ' is-ours' : ''}` },
    h('summary', { class: 'ws-msg-summary' }, avatar({ name: m.author || '?', size: 'sm', tone: isOurs ? 'chrome' : 'default' }),
      h('strong', null, m.author || 'Unknown'), h('span', { class: 'ws-msg-peek' }, maskSensitive((m.body || '').replace(/\s+/g, ' ').slice(0, 120), keep)),
      h('time', { class: 'ws-msg-date' }, fullTime(m.at))),
    head, body, atts);
}

/** wsThread(thread) - every message, oldest first; all but the last fold. */
export function wsThread(t) {
  const msgs = t.messages || [];
  const keep = t.invoice_refs || [];
  return h('div', { class: 'ws-thread', role: 'list' }, msgs.map((m, i) => h('div', { role: 'listitem' }, messageCard(m, t, { first: i === 0, last: i === msgs.length - 1, keep }))));
}

/** "Sent by Ulla Abernathy · Zendesk updated · 10:42" from the write-back record. */
export function wsReceipt(t) {
  const wb = t.write_back;
  const sentAt = wb?.sent_at || t.review?.review?.sent_at;
  if (!wb && t.review?.review?.state !== 'sent') return null;
  const parts = [
    `Sent by ${wb?.sent_by || 'Conductor'}`,
    wb?.zendesk_status ? `Zendesk updated (${ZENDESK[wb.zendesk_status] || wb.zendesk_status})` : 'Zendesk updated',
    wb?.sent_folder ? 'Outlook Sent items' : null,
    sentAt ? clockTime(typeof sentAt === 'number' ? new Date(sentAt * 1000).toISOString() : sentAt) : null,
  ].filter(Boolean);
  return h('div', { class: 'ws-receipt', role: 'status' }, icon('circle-check'), h('span', null, parts.join(' · ')),
    wb?.internal_note ? h('span', { class: 'ws-receipt-note' }, wb.internal_note) : null);
}
