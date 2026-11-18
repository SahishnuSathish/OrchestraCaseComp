// API calls for the ticket chat. The server builds all context from its own records; the browser sends only the question.
import { api, request } from './api.js';

const base = (runId, ticketId) => `/api/runs/${encodeURIComponent(runId)}/tickets/${encodeURIComponent(ticketId)}/chat`;

export const chatApi = {
  history: (runId, ticketId, opts) => request('GET', base(runId, ticketId), undefined, opts),
  clear: (runId, ticketId) => request('DELETE', base(runId, ticketId)),
  // Streams start, token*, then done or error. Abort the signal to stop the model.
  send: (runId, ticketId, message, { signal, onEvent } = {}) => api.stream(base(runId, ticketId), { message }, { signal, onEvent }),
};
