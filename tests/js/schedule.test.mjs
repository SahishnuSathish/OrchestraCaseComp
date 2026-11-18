import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'America/New_York';
const { localInputToUtc, utcToLocalInput, toLocalInput, windowError, checkInput, MIN_AHEAD_MS, MAX_AHEAD_MS, mailHint } =
  await import('../../webapp/static/js/schedule.js');

describe('local time <-> UTC', () => {
  it('converts a local summer time to UTC', () => {
    assert.equal(localInputToUtc('2026-07-01T09:00'), '2026-07-01T13:00:00Z');
  });

  it('converts a local winter time to UTC', () => {
    assert.equal(localInputToUtc('2026-12-01T09:00'), '2026-12-01T14:00:00Z');
  });

  it('round-trips', () => {
    for (const v of ['2026-03-08T12:30', '2026-11-01T00:05', '2027-01-31T23:59']) {
      assert.equal(utcToLocalInput(localInputToUtc(v)), v);
    }
  });

  it('shows UTC in local time', () => {
    assert.equal(utcToLocalInput('2026-07-01T13:00:00Z'), '2026-07-01T09:00');
  });

  it('rejects things that are not a time', () => {
    assert.equal(localInputToUtc(''), null);
    assert.equal(localInputToUtc('soon'), null);
    assert.equal(localInputToUtc('2026-13-45T99:99'), null);
    assert.equal(utcToLocalInput('nope'), '');
  });

  it('formats a Date for the input', () => {
    assert.equal(toLocalInput(new Date(2026, 0, 5, 7, 3)), '2026-01-05T07:03');
  });
});

describe('send window: 1 minute to 30 days ahead', () => {
  const now = Date.UTC(2026, 5, 1, 12, 0, 0);

  it('refuses a time under a minute away', () => {
    assert.match(windowError(new Date(now + MIN_AHEAD_MS - 1), now), /at least 1 minute/);
    assert.match(windowError(new Date(now - 1000), now), /at least 1 minute/);
  });

  it('accepts the near edge', () => {
    assert.equal(windowError(new Date(now + MIN_AHEAD_MS), now), null);
  });

  it('accepts the far edge and refuses beyond it', () => {
    assert.equal(windowError(new Date(now + MAX_AHEAD_MS), now), null);
    assert.match(windowError(new Date(now + MAX_AHEAD_MS + 1), now), /30 days/);
  });

  it('refuses a missing date', () => {
    assert.match(windowError(new Date('x'), now), /date and time/);
    assert.match(windowError(null, now), /date and time/);
  });

  it('checks a picker value and returns UTC', () => {
    const ok = checkInput('2026-06-02T09:00', now);
    assert.equal(ok.error, null);
    assert.equal(ok.utc, '2026-06-02T13:00:00Z');
    assert.match(checkInput('2026-06-01T08:00', now).error, /at least 1 minute/);
    assert.match(checkInput('2026-08-01T08:00', now).error, /30 days/);
    assert.match(checkInput('', now).error, /date and time/);
  });
});

describe('mail hint', () => {
  it('says what happens at send time in each mode', () => {
    assert.match(mailHint('simulated'), /outbox/);
    assert.match(mailHint('smtp'), /mail server/);
    assert.match(mailHint('smtp'), /running/);
  });
});
