// Data calls for the inbox, attachments, documents, Connections and Advanced. Plain async functions, no DOM.
// Owner: p3/inbox-sync. Contract: docs/phase3/CONTRACTS.md sections 5 and 8.
// A thread id is the Zendesk ticket id. The existing review, draft, send, brief, chat and schedule routes use the
// run id from `summary().run_id` (or `thread(id).run_id`), under /api/runs/{run_id}/...
import { getJSON, postJSON, del, blob } from './http.js';

const enc = encodeURIComponent;

function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

// "While you were away" card: {run_id, read, drafts_ready, action_needed, no_reply, held_back, prevented_this_week, connected_at}
export const summary = () => getJSON('/api/inbox/summary');

// {queues: [{id, label, count}]}
export const queues = () => getJSON('/api/inbox/queues');

// {rows: [ThreadRow]}. All filters optional: queue (a queue id), q (search text), assignee (an email, or 'unassigned').
export const threads = ({ queue, q, assignee } = {}, opts) => getJSON(`/api/inbox/threads${query({ queue, q, assignee })}`, opts);

// One Thread: headers, messages, insight, result, decision, review, workflow, evidence, attachments, schedule, run_id.
export const thread = (ticketId, opts) => getJSON(`/api/inbox/threads/${enc(ticketId)}`, opts);

// The run id every /api/runs/{run_id}/... route needs for the inbox.
export const inboxRunId = async () => (await summary()).run_id;

// Bring the next held-back email in now. {arrived: [ticket_id]} (empty when none are left).
export const syncNow = () => postJSON('/api/inbox/sync');

// Attach an invoice copy or remittance advice (kind 'invoice' | 'remittance') for a bill on this ticket. {attachments: [Attachment]}
export const addAttachment = (ticketId, kind, billId) => postJSON(`/api/inbox/threads/${enc(ticketId)}/attachments`, { kind, bill_id: String(billId) });
export const removeAttachment = (ticketId, attachmentId) => del(`/api/inbox/threads/${enc(ticketId)}/attachments/${enc(attachmentId)}`);

// {connections: [{id, name, status, last_sync, scopes, detail}], log: [{at, text}]}
export const connections = () => getJSON('/api/connections');

// Documents. The browser fetches with its headers and gets a blob: URL for an iframe or a download link.
// Revoke it with URL.revokeObjectURL when done. kind: 'invoice' | 'remittance'; fmt: 'html' | 'pdf'.
export const documentPath = (kind, billId, fmt) => `/api/documents/${enc(kind)}/${enc(billId)}.${enc(fmt)}`;
export const documentBlobUrl = (kind, billId, fmt = 'pdf') => blob(documentPath(kind, billId, fmt));

// Advanced (CFO only).
export const adminReset = () => postJSON('/api/admin/reset');                  // {run_id, old_run_id, read, held_back}
export const adminImport = (path) => postJSON('/api/admin/import', { path });  // {run_id}: a normal batch run; follow it at /api/runs/{run_id}
export const adminExportBlobUrl = (runId, scope = 'signed_off') => blob(`/api/admin/export${query({ run_id: runId, scope })}`);
