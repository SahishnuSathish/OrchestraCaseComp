// Pure helpers for the workspace (inbox) views: masking, app-clock times, the reply hash and what a thread allows.
// No DOM here, so the module imports in Node.

// ---------------------------------------------------------------------------- masking
// Bank account numbers, routing numbers and TINs show the last 4 digits at most, everywhere (spec section 4).
// Incoming email can carry them in plain text, so every body, snippet and note is masked before it is shown.
const SENSITIVE_LINE = /\b(routing|aba|account|acct|a\/c|iban|swift|bic|sort code|tin|ein|ssn|tax ?id|taxpayer|bank)\b/i;

/** maskSensitive(text, keep) - replace long digit runs with "••••1234". Invoice numbers in `keep` are never masked. */
export function maskSensitive(text, keep = []) {
  const safe = new Set((keep || []).map(String));
  return String(text ?? '').split('\n').map((line) => {
    const sensitive = SENSITIVE_LINE.test(line);
    return line.replace(/(?<![\w-])\d[\d ]{4,}\d(?![\w-])/g, (m) => {
      const digits = m.replace(/\D/g, '');
      if (safe.has(m) || safe.has(digits)) return m;
      if (digits.length >= 9 || (sensitive && digits.length >= 6)) return `••••${digits.slice(-4)}`;
      return m;
    });
  }).join('\n');
}

// ---------------------------------------------------------------------------- the app clock
// Conductor runs on one clock: the snapshot date, Friday Nov 13, 2026, with the real time of day (CONTRACTS section 4).
// The server's own timestamps (live events, the schedule's `now`) move the offset when they arrive.
const APP_DATE = { y: 2026, m: 10, d: 13 };
let skewMs = null;

function defaultSkew() {
  const real = new Date();
  const app = new Date(APP_DATE.y, APP_DATE.m, APP_DATE.d, real.getHours(), real.getMinutes(), real.getSeconds(), real.getMilliseconds());
  return app.getTime() - real.getTime();
}
/** Tell the clock what time the server says it is (an ISO string from the app clock). */
export function syncAppClock(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isNaN(t)) skewMs = t - Date.now();
}
/** Now, on the app clock, in epoch ms. */
export function appNow() { return Date.now() + (skewMs ?? defaultSkew()); }

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** List time, Outlook style: "6:46 AM" today, "Nov 12" this year, "Nov 12, 2025" before. */
export function listTime(iso, now = appNow()) {
  const d = new Date(iso || '');
  if (Number.isNaN(d.getTime())) return '';
  const n = new Date(now);
  if (sameDay(d, n)) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const opts = d.getFullYear() === n.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' };
  return d.toLocaleDateString('en-US', opts);
}
/** Header date: "Fri, Nov 13, 2026, 6:46 AM". */
export function fullTime(iso) {
  const d = new Date(iso || '');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
/** Clock time only: "10:42". */
export function clockTime(iso) {
  const d = new Date(iso || '');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ---------------------------------------------------------------------------- the reply hash (decision 6)
// The CFO signs off the exact text on screen. The server compares SHA-256 over json.dumps([to, subject, body]) with
// Python's defaults (", " separators, ensure_ascii) - delivery.reply_hash. This builds the same bytes.
export function pyJsonString(s) {
  return JSON.stringify(String(s)).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
export function pyJsonList(items) {
  return `[${items.map((x) => (x == null ? 'null' : pyJsonString(x))).join(', ')}]`;
}
/** replyHash(to, subject, body) -> hex SHA-256, or null when the browser has no Web Crypto. */
export async function replyHash(to, subject, body) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(pyJsonList([to, subject, body])));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------- what a thread allows
// Mirrors workflow.can_approve / can_send so the buttons never promise what the server would refuse. The server still
// decides: every action shows its 409 or 422 reason if it says no.
export const isReply = (t) => t?.review?.draft?.output_type === 'draft_reply' || t?.result?.output_type === 'draft_reply';
export const isNote = (t) => (t?.review?.draft?.output_type || t?.result?.output_type) === 'internal_action_note';
export const isFraud = (t) => (t?.flags || []).includes('fraud') || (t?.result?.flags || []).includes('fraud') || t?.workflow?.category === 'fraud';
export const isBlocked = (t) => isFraud(t) || (t?.result?.flags || []).includes('injection');
/** A priority ticket: the CFO signs off the reply text. Rows carry no category, so a legal threat or a copied executive stands in. */
export const isPriority = (t) => t?.workflow?.category === 'priority' || t?.result?.priority === true
  || (!t?.workflow && !t?.result && (t?.flags || []).some((f) => f === 'legal' || f === 'exec_cc'));
/** Risk flags that make a sender's listing not worth a green "verified" mark. */
export const hasRisk = (t) => (t?.flags || []).some((f) => f === 'fraud' || f === 'legal' || f === 'exec_cc');

// ---------------------------------------------------------------------------- plain reasons
// The rules write their reasons for the record ("bank-detail change language: 'change of bank'"). Staff read these.
const WHY_RULES = [
  [/^(model read )?bank-detail change language/i, () => 'The email asks us to change bank details.'],
  [/^sender domain (\S+) imitates known domain (\S+)/i, (m) => `The sender's address (${m[1]}) imitates a known domain (${m[2]}).`],
  [/^link host (\S+) imitates known domain (\S+)/i, (m) => `A link in the email goes to ${m[1]}, which imitates ${m[2]}.`],
  [/^sign-in link in a payment email/i, () => 'The email asks someone to sign in through a link.'],
  [/^threat of collections, legal action or suspension/i, () => 'The email threatens collections, legal action or a suspension of service.'],
  [/^executive copied: (.+)$/i, (m) => `An executive is copied (${m[1]}).`],
  [/^sender raises a late fee/i, () => 'The sender asks about a late fee.'],
];
/** plainWhy(why) - a rule's reason in plain sentences. Repeated reasons are said once. */
export function plainWhy(why) {
  const parts = String(why || '').split(/;\s*(?=[a-z])/i).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const hit = WHY_RULES.find(([rx]) => rx.test(p));
    const s = hit ? hit[1](hit[0].exec(p)) : sentenceCase(p);
    if (!out.includes(s)) out.push(s);
  }
  // A list of quoted cues ("'change of bank'; 'changed banks'") belongs to the reason before it.
  return out.filter((s) => !/^'[^']*'\.?$/.test(s)).join(' ');
}
function sentenceCase(s) {
  const x = String(s || '').trim();
  return x ? x[0].toUpperCase() + x.slice(1) + (/[.!?]$/.test(x) ? '' : '.') : '';
}

/**
 * mode(thread, role) -> what the reading pane shows and which actions lead.
 * kind: reply | note | none. primary: send | request_signoff | waiting_signoff | signoff | sent | blocked | decide | escalate | handle | none.
 */
export function mode(t, role) {
  const cfo = role === 'cfo';
  const wf = t?.workflow || {};
  const st = wf.state || 'open';
  const cat = wf.category || null;
  const rv = t?.review?.review || {};
  const sent = rv.state === 'sent' || st === 'sent';
  const closed = st === 'closed' || st === 'decided' || rv.state === 'acknowledged' || rv.state === 'closed';
  if (isReply(t)) {
    const base = { kind: 'reply', sent, closed, priority: cat === 'priority', editable: false };
    if (sent) return { ...base, primary: 'sent' };
    if (isBlocked(t)) return { ...base, primary: 'blocked' };
    if (closed) return { ...base, primary: 'none' };
    const scheduled = t?.schedule?.schedule?.status === 'scheduled' || t?.schedule?.status === 'scheduled';
    if (cat === 'priority') {
      if (st === 'signed_off') return { ...base, primary: 'send', signedOff: true, scheduled };
      if (cfo) return { ...base, primary: 'signoff', editable: !scheduled, canReturn: ['escalated', 'signoff_requested'].includes(st) };
      if (st === 'signoff_requested' || st === 'escalated') return { ...base, primary: 'waiting_signoff' };
      return { ...base, primary: 'request_signoff', editable: !scheduled };
    }
    if (st === 'escalated' && !cfo) return { ...base, primary: 'send', editable: !scheduled && rv.state !== 'approved', escalated: true, scheduled };
    return { ...base, primary: 'send', editable: !scheduled && rv.state !== 'approved', scheduled };
  }
  if (isNote(t)) {
    const base = { kind: 'note', sent, closed, category: cat };
    if (closed) return { ...base, primary: 'none' };
    if (cfo) return { ...base, primary: 'decide' };
    if (cat) return { ...base, primary: st === 'escalated' ? 'waiting_decision' : 'escalate' };
    return { ...base, primary: 'handle' };
  }
  return { kind: 'none', sent, closed, primary: closed ? 'none' : 'close' };
}

export const ESCALATE_REASONS = [
  { value: 'legal', label: 'Legal or collections threat' },
  { value: 'exec', label: 'An executive is copied' },
  { value: 'fraud', label: 'Possible fraud' },
  { value: 'bank_change', label: 'Bank detail change' },
  { value: 'returned', label: 'Returned payment' },
  { value: 'early_payment', label: 'Early payment request' },
  { value: 'late_fee', label: 'Late fee or interest' },
  { value: 'conflict', label: 'Records disagree' },
  { value: 'other', label: 'Something else' },
];
/** The reason to preselect for a thread. */
export function suggestedReason(t) {
  const flags = t?.flags || [];
  const rule = t?.decision?.rule;
  if (flags.includes('fraud')) return 'fraud';
  if (flags.includes('legal')) return 'legal';
  if (flags.includes('exec_cc')) return 'exec';
  if (rule === 'returned_payment') return 'returned';
  if (rule === 'late_fee') return 'late_fee';
  if (rule === 'expedite_request') return 'early_payment';
  if (rule === 'conflict' || rule === 'record_conflict') return 'conflict';
  return 'other';
}
export const reasonLabel = (v) => ESCALATE_REASONS.find((r) => r.value === v)?.label || v || '';

// The two AP Specialists in the dataset. "Assign to the other specialist" uses the list from /api/workflow/expertise
// when it loads; these names are the fallback.
export const SPECIALISTS = [
  { email: 'ulla.abernathy@orchestra-mock.example', name: 'Ulla Abernathy' },
  { email: 'omar.calloway@orchestra-mock.example', name: 'Omar Calloway' },
];
const CFO = { email: 'elena.lockhart@orchestra-mock.example', name: 'Elena Lockhart' };
const PEOPLE = new Map([...SPECIALISTS, CFO].map((p) => [p.email, p.name]));
/** A person's name from an email we know, or a tidy version of the address. */
export function personName(email, extra) {
  if (!email) return '';
  const e = String(email).toLowerCase();
  if (extra?.has?.(e)) return extra.get(e);
  if (PEOPLE.has(e)) return PEOPLE.get(e);
  const local = e.split('@')[0];
  if (/^[a-z]+\.[a-z]+$/.test(local)) return local.split('.').map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
  return email;
}
export const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
