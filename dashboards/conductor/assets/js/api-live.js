// The live event stream (docs/phase3/CONTRACTS.md section 3). One EventSource is shared by every subscriber.
// It gets a single-use ticket, opens the stream, and after a drop reconnects with a fresh ticket.
// handler(event) receives the parsed data object ({id, at, type, summary, ...}). No DOM.
import * as http from './http.js';

// EventSource cannot listen to "every" named event, so the types from the contract are listed here.
export const EVENT_TYPES = [
  'ticket.arrived', 'ticket.outcome', 'queue.counts', 'ticket.assigned', 'ticket.escalated', 'signoff.requested',
  'ticket.returned', 'ticket.signed_off', 'ticket.decided', 'ticket.sent', 'ticket.scheduled', 'outbound.created',
  'outbound.sent', 'ahead.sent', 'approver.committed', 'w9.received', 'direct.question', 'direct.message',
  'direct.update', 'sync.status',
];

const handlers = new Set();
let source = null;
let retry = null;
let delay = 1000;
let generation = 0;

function dispatch(ev) {
  let data;
  try { data = JSON.parse(ev.data); } catch { return; }
  for (const fn of [...handlers]) {
    try { fn(data); } catch (e) { console.error('live handler failed', e); }
  }
}

function close() {
  generation += 1;
  clearTimeout(retry);
  retry = null;
  if (source) { source.close(); source = null; }
}

function later() {
  if (!handlers.size || retry) return;
  retry = setTimeout(() => { retry = null; connect(); }, delay);
  delay = Math.min(delay * 2, 15000);
}

async function connect() {
  if (source || !handlers.size || typeof EventSource === 'undefined') return;
  const mine = ++generation;
  let ticket;
  try {
    ticket = await http.liveTicket();
  } catch (e) {
    if (e && e.status === 401) return;   // signed out: http.js has already sent the browser to the hub
    if (mine === generation) later();
    return;
  }
  if (mine !== generation || !handlers.size) return;
  const es = new EventSource(`/api/live?ticket=${encodeURIComponent(ticket)}`);
  source = es;
  es.onopen = () => { delay = 1000; };
  for (const type of EVENT_TYPES) es.addEventListener(type, dispatch);
  es.onmessage = dispatch;
  es.onerror = () => {
    // The ticket is spent, so a plain EventSource retry would fail. Start over with a new one.
    if (source === es) { es.close(); source = null; later(); }
  };
}

// subscribe(handler) -> unsubscribe
export function subscribe(handler) {
  handlers.add(handler);
  if (handlers.size === 1) connect();
  return () => {
    handlers.delete(handler);
    if (!handlers.size) close();
  };
}
