// How the inbox list is ordered. Pure functions over the rows of GET /api/inbox/threads: no DOM, no network, so they can
// be tested on their own. The server supplies amount, due_date, urgency and destination (dashboards/conductor/sortfacts.py).

export const SORTS = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'amount_desc', label: 'Amount: high to low' },
  { id: 'amount_asc', label: 'Amount: low to high' },
  { id: 'urgency', label: 'Urgency' },
  { id: 'due', label: 'Due date: soonest first' },
  { id: 'waiting', label: 'Waiting longest' },
  { id: 'goes_to', label: 'Goes to' },
];
export const DEFAULT_SORT = 'newest';

// Where the work goes next, in the order the "Goes to" sort lists them.
export const DESTINATIONS = [
  { id: 'cfo', label: 'CFO sign-off' },
  { id: 'approver', label: 'Approver' },
  { id: 'vendor', label: 'Reply to vendor' },
  { id: 'payment_run', label: 'Payment run' },
  { id: 'forwarded', label: 'Forwarded' },
  { id: 'desk', label: 'Your desk' },
  { id: 'closed', label: 'Closed' },
];

/** A known sort id, or the default for anything else (a stale URL, a stale stored value, garbage). */
export function normalizeSort(id) {
  return SORTS.some((s) => s.id === id) ? id : DEFAULT_SORT;
}

const when = (r) => { const t = Date.parse(r.received_at || ''); return Number.isNaN(t) ? null : t; };
const newestFirst = (a, b) => (when(b) ?? -Infinity) - (when(a) ?? -Infinity) || b.ticket_id - a.ticket_id;
// Oldest first; a missing or unparseable time goes last.
const oldestFirst = (a, b) => {
  const x = when(a);
  const y = when(b);
  if (x === null || y === null) return x === y ? newestFirst(a, b) : (x === null ? 1 : -1);
  return x - y || a.ticket_id - b.ticket_id;
};
// Threads with nothing left waiting on a reply: closed, or forwarded to HR or AR.
const ANSWERED = new Set(['closed', 'forwarded']);
// Rows with no value for a key go last, whichever way the rest is ordered.
const byValue = (key, dir) => (a, b) => {
  const x = a[key] ?? null;
  const y = b[key] ?? null;
  if (x === null || y === null) return x === y ? newestFirst(a, b) : (x === null ? 1 : -1);
  return x === y ? newestFirst(a, b) : (x < y ? -dir : dir);
};
const destIndex = (r) => { const i = DESTINATIONS.findIndex((d) => d.id === r.destination); return i < 0 ? DESTINATIONS.length : i; };

/** A new array of `rows` in the order `sortId` asks for. `arrived` (ticket ids that came in this session) stay on top under Newest first only. */
export function sortRows(rows, sortId, { arrived = [] } = {}) {
  const out = [...rows];
  switch (normalizeSort(sortId)) {
    case 'oldest': return out.sort(oldestFirst);
    case 'amount_desc': return out.sort(byValue('amount', -1));
    case 'amount_asc': return out.sort(byValue('amount', 1));
    case 'urgency': return out.sort((a, b) => (a.urgency ?? 4) - (b.urgency ?? 4) || newestFirst(a, b));
    case 'due': return out.sort(byValue('due_date', 1));
    case 'waiting':
      return out.sort((a, b) => {
        const doneA = ANSWERED.has(a.destination);
        const doneB = ANSWERED.has(b.destination);
        if (doneA !== doneB) return doneA ? 1 : -1;
        return doneA ? newestFirst(a, b) : oldestFirst(a, b);
      });
    case 'goes_to':
      return out.sort((a, b) => destIndex(a) - destIndex(b)
        || String(a.destination_name || '').localeCompare(String(b.destination_name || ''))
        || (a.urgency ?? 4) - (b.urgency ?? 4) || newestFirst(a, b));
    default: {
      const pinned = new Set(arrived);
      return out.sort((a, b) => (pinned.has(b.ticket_id) - pinned.has(a.ticket_id)) || newestFirst(a, b));
    }
  }
}

/** The heading a row sits under, or null when the sort has no headings (only "Goes to" does). Approvers get one heading each. */
export function groupKey(row, sortId) {
  if (normalizeSort(sortId) !== 'goes_to') return null;
  const d = DESTINATIONS.find((x) => x.id === row.destination) || DESTINATIONS.at(-1);
  if (row.destination === 'approver' && row.destination_name) return { id: `approver:${row.destination_name}`, label: `Approver: ${row.destination_name}` };
  return { id: d.id, label: d.label };
}
