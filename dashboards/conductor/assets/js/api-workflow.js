// Workflow, outbound, approver, feedback and team data (CONTRACTS.md section 6; routes in docs/phase3/ROUTES.md).
// Data only, no DOM. Written by the orchestrator before wave 2 so workspace-ui and leadership-ui share one module.
import { getJSON, postJSON, putJSON } from './http.js';

const enc = encodeURIComponent;
const qs = (o) => {
  const p = Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? `?${p.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&')}` : '';
};

// ---- one ticket (ids are inbox ticket ids)
export const state = (ticketId) => getJSON(`/api/workflow/${enc(ticketId)}`);
export const escalate = (ticketId, reason, note = '') => postJSON(`/api/workflow/${enc(ticketId)}/escalate`, { reason, note });
export const requestSignoff = (ticketId, note = '') => postJSON(`/api/workflow/${enc(ticketId)}/request-signoff`, { note });
export const returnWithGuidance = (ticketId, guidance) => postJSON(`/api/workflow/${enc(ticketId)}/return`, { guidance }); // CFO
export const signoff = (ticketId, replyHash) => postJSON(`/api/workflow/${enc(ticketId)}/signoff`, { reply_hash: replyHash }); // CFO
export const decide = (ticketId, decision, actionTaken = '', note = '') =>                                                  // CFO
  postJSON(`/api/workflow/${enc(ticketId)}/decide`, { decision, action_taken: actionTaken, note });
export const assign = (ticketId, to) => postJSON(`/api/workflow/${enc(ticketId)}/assign`, { to });
export const chase = (ticketId) => postJSON(`/api/workflow/${enc(ticketId)}/chase`, {});
export const forward = (ticketId, to, note = '') => postJSON(`/api/workflow/${enc(ticketId)}/forward`, { to, note }); // to: 'hr' | 'ar'
export const noReply = (ticketId, note = '') => postJSON(`/api/workflow/${enc(ticketId)}/no-reply`, { note });

// ---- lists (CFO)
export const escalations = () => getJSON('/api/workflow/escalations');
export const audit = (limit = 100) => getJSON(`/api/workflow/audit${qs({ limit })}`);
export const expertise = () => getJSON('/api/workflow/expertise');
export const saveExpertise = (people) => putJSON('/api/workflow/expertise', { people });
export const teamOverview = () => getJSON('/api/team/overview');

// ---- outbound items (approver nudges, W-9 requests): reviewed, then sent
export const outbound = (kind) => getJSON(`/api/outbound${qs({ kind })}`);
export const setOutboundState = (id, state) => putJSON(`/api/outbound/${enc(id)}`, { state }); // 'approved' | 'pending'
export const sendOutbound = (id) => postJSON(`/api/outbound/${enc(id)}/send`);

// ---- approver ("Waiting on you")
export const approverQueue = (approver) => getJSON(`/api/approver/queue${qs({ approver })}`);
export const acknowledgeBill = (billId) => postJSON(`/api/approver/bills/${enc(billId)}/ack`);
export const commitBill = (billId, date) => postJSON(`/api/approver/bills/${enc(billId)}/commit`, { date });

// ---- feedback ("What was off?")
export const feedbackPrompt = (runId, ticketId) => getJSON(`/api/feedback/prompt${qs({ run_id: runId, ticket_id: ticketId })}`);
export const sendFeedback = (runId, ticketId, category, note = '') =>
  postJSON('/api/feedback', { run_id: runId, ticket_id: ticketId, category, note }); // tone | facts | missing_info | other
export const feedbackTrends = () => getJSON('/api/feedback/trends');
