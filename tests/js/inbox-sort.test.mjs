import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SORTS, DEFAULT_SORT, DESTINATIONS, normalizeSort, sortRows, groupKey } from '../../dashboards/conductor/assets/js/components/workspace/sort.js';

const row = (ticket_id, o = {}) => ({
  ticket_id, received_at: '2026-11-13T10:00:00Z', amount: null, due_date: null, urgency: 4, destination: 'vendor', destination_name: null, ...o,
});
const ids = (rows) => rows.map((r) => r.ticket_id);

describe('sortRows', () => {
  it('newest pins arrivals then orders by time', () => {
    const rows = [row(1, { received_at: '2026-11-13T08:00:00Z' }), row(2, { received_at: '2026-11-13T12:00:00Z' }),
      row(3, { received_at: '2026-11-13T06:00:00Z' }), row(4, { received_at: '2026-11-13T07:00:00Z' })];
    assert.deepEqual(ids(sortRows(rows, 'newest', { arrived: [3, 4] })), [4, 3, 2, 1]);
    assert.deepEqual(ids(sortRows(rows, 'newest')), [2, 1, 4, 3]);
  });

  it('oldest puts an unparseable received_at last', () => {
    const rows = [row(1, { received_at: 'nope' }), row(2, { received_at: '2026-11-13T12:00:00Z' }), row(3, { received_at: '2026-11-13T06:00:00Z' }),
      row(4, { received_at: null })];
    assert.deepEqual(ids(sortRows(rows, 'oldest')), [3, 2, 4, 1]);
  });

  it('amount puts null last in both directions', () => {
    const rows = [row(1, { amount: null }), row(2, { amount: 50 }), row(3, { amount: 900 }), row(4, { amount: 50, received_at: '2026-11-13T11:00:00Z' })];
    assert.deepEqual(ids(sortRows(rows, 'amount_desc')), [3, 4, 2, 1]);
    assert.deepEqual(ids(sortRows(rows, 'amount_asc')), [4, 2, 3, 1]);
  });

  it('urgency orders tiers then newest first', () => {
    const rows = [row(1, { urgency: 4 }), row(2, { urgency: 1, received_at: '2026-11-13T05:00:00Z' }), row(3, { urgency: 1, received_at: '2026-11-13T09:00:00Z' }),
      row(4, { urgency: 5 }), row(5, { urgency: 2 })];
    assert.deepEqual(ids(sortRows(rows, 'urgency')), [3, 2, 5, 1, 4]);
  });

  it('due puts null last and overdue first', () => {
    const rows = [row(1, { due_date: null }), row(2, { due_date: '2026-11-20' }), row(3, { due_date: '2026-11-01' }), row(4, { due_date: '2026-11-15' })];
    assert.deepEqual(ids(sortRows(rows, 'due')), [3, 4, 2, 1]);
  });

  it('waiting puts unanswered oldest first, then closed', () => {
    const rows = [row(1, { received_at: '2026-11-13T09:00:00Z' }), row(2, { received_at: '2026-11-13T05:00:00Z' }),
      row(3, { destination: 'closed', received_at: '2026-11-13T04:00:00Z' }), row(4, { destination: 'closed', received_at: '2026-11-13T11:00:00Z' })];
    assert.deepEqual(ids(sortRows(rows, 'waiting')), [2, 1, 4, 3]);
  });

  it('waiting puts an unparseable date last among the unanswered and treats forwarded as answered', () => {
    const rows = [row(1, { received_at: 'bad' }), row(2, { received_at: '2026-11-13T05:00:00Z' }), row(3, { received_at: null }),
      row(4, { destination: 'forwarded', received_at: '2026-11-13T01:00:00Z' }), row(5, { received_at: '2026-11-13T09:00:00Z' })];
    assert.deepEqual(ids(sortRows(rows, 'waiting')), [2, 5, 3, 1, 4]);
  });

  it('goes_to follows the destination order and groups approvers by name', () => {
    const rows = [row(1, { destination: 'closed' }), row(2, { destination: 'vendor' }), row(3, { destination: 'approver', destination_name: 'zed@x.example' }),
      row(4, { destination: 'cfo' }), row(5, { destination: 'approver', destination_name: 'amy@x.example' }), row(6, { destination: 'desk' })];
    assert.deepEqual(ids(sortRows(rows, 'goes_to')), [4, 5, 3, 2, 6, 1]);
  });

  it('does not mutate its input', () => {
    const rows = [row(1, { amount: 1 }), row(2, { amount: 2 })];
    const copy = [...rows];
    sortRows(rows, 'amount_desc');
    assert.deepEqual(rows, copy);
  });
});

describe('normalizeSort and groupKey', () => {
  it('normalizeSort falls back on garbage, null and undefined', () => {
    assert.equal(normalizeSort('amount_desc'), 'amount_desc');
    for (const bad of ['garbage', null, undefined, '', 42, '__proto__']) assert.equal(normalizeSort(bad), DEFAULT_SORT);
  });

  it('lists the eight sorts in order, and the seven destinations', () => {
    assert.deepEqual(SORTS.map((s) => s.id), ['newest', 'oldest', 'amount_desc', 'amount_asc', 'urgency', 'due', 'waiting', 'goes_to']);
    assert.deepEqual(DESTINATIONS.map((d) => d.id), ['cfo', 'approver', 'vendor', 'payment_run', 'forwarded', 'desk', 'closed']);
  });

  it('groupKey is null except for goes_to', () => {
    assert.equal(groupKey(row(1), 'newest'), null);
    assert.deepEqual(groupKey(row(1, { destination: 'cfo' }), 'goes_to'), { id: 'cfo', label: 'CFO sign-off' });
    assert.deepEqual(groupKey(row(1, { destination: 'approver', destination_name: 'amy@x.example' }), 'goes_to'), { id: 'approver:amy@x.example', label: 'Approver: amy@x.example' });
  });
});
