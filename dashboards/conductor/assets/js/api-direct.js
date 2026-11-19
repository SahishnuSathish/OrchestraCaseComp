// Conductor: Direct data access (docs/phase3/CONTRACTS.md section 9). Plain async functions, no DOM.
// Every call goes through http.js, which adds the token and this tab's vendor session.
import * as http from './http.js';

const enc = encodeURIComponent;

export const me = () => http.getJSON('/api/direct/me');

export function invoices({ q = '', status = '' } = {}) {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (status) p.set('status', status);
  const qs = p.toString();
  return http.getJSON('/api/direct/invoices' + (qs ? `?${qs}` : ''));
}

export const invoice = (ref) => http.getJSON(`/api/direct/invoices/${enc(ref)}`);

// Returns a blob: URL for the document (kind: invoice | remittance, fmt: html | pdf). Revoke it when done.
export const documentUrl = (ref, kind, fmt = 'pdf') =>
  http.blob(`/api/direct/invoices/${enc(ref)}/documents/${enc(kind)}.${enc(fmt)}`);

export const askQuestion = (invoiceRef, text) => http.postJSON('/api/direct/questions', { invoice: invoiceRef, text });

export const messages = () => http.getJSON('/api/direct/messages');
export const updates = () => http.getJSON('/api/direct/updates');

export const preferences = () => http.getJSON('/api/direct/preferences');
export const savePreferences = ({ email_updates, notice_types }) =>
  http.putJSON('/api/direct/preferences', { email_updates, notice_types });
