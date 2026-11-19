// Formatting for Conductor: Direct. Pure functions, no DOM.
import { fmtMoney } from '../components/index.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-11-06" -> "Nov 6, 2026". A plain date is read as a calendar day, never shifted by the time zone.
export function fmtDay(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return String(iso);
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

// An ISO timestamp with an offset -> "Nov 13, 2026, 2:05 PM".
export function fmtStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fmtDay(iso);
  const day = fmtDay(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}

export function money(amount, currency = 'USD') {
  return amount == null ? '' : fmtMoney(amount, currency || 'USD');
}

export function fmtSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// The public status codes (CONTRACTS section 9) with the wording the filter uses.
export const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'received', label: 'Received' },
  { value: 'pending_approval', label: 'Awaiting internal approval' },
  { value: 'approved', label: 'Approved' },
  { value: 'scheduled', label: 'Scheduled for payment' },
  { value: 'payment_sent', label: 'Payment sent' },
  { value: 'paid', label: 'Paid' },
  { value: 'under_review', label: 'Under review' },
];
// The status tone (color carries status meaning only), matching components/badges.js statusBadge.
export const STATUS_TONE = {
  received: 'neutral', pending_approval: 'waiting', approved: 'scheduled', scheduled: 'scheduled',
  payment_sent: 'settled', paid: 'settled', under_review: 'waiting',
};

export const statusFilterLabel = (code) => STATUS_FILTERS.find((s) => s.value === code)?.label || '';

// Documents an invoice has, from its public status: a copy always; a remittance advice once the payment has gone out.
// The detail answer (documents: [...]) is the authority; this is for lists, where it matches direct._documents.
export function documentsFor(code) {
  const docs = [{ kind: 'invoice', label: 'Invoice copy' }];
  if (code === 'paid' || code === 'payment_sent') docs.push({ kind: 'remittance', label: 'Remittance advice' });
  return docs;
}

export function pdfName(invoice, kind) {
  const safe = String(invoice || 'invoice').replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe}-${kind === 'remittance' ? 'remittance-advice' : 'invoice-copy'}.pdf`;
}
