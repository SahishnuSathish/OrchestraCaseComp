// API calls for scheduled send.
import { request } from './api.js';

const url = (runId, ticketId) => `/api/runs/${runId}/tickets/${ticketId}/schedule`;

export const getSchedule = (runId, ticketId) => request('GET', url(runId, ticketId));
export const setSchedule = (runId, ticketId, sendAtUtcIso) => request('POST', url(runId, ticketId), { send_at: sendAtUtcIso });
export const cancelSchedule = (runId, ticketId) => request('DELETE', url(runId, ticketId));

export { request };
