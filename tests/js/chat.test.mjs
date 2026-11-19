import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// chat.js pulls in api.js, which reads the page's token meta tag at load time.
globalThis.document = { querySelector: () => null };
let C;
before(async () => { C = await import('../../dashboards/conductor/assets/js/chat.js'); });

describe('chat helpers', () => {
  it('keys a panel by run and ticket', () => {
    assert.equal(C.chatKey({ runId: 'ab12', ticketId: 41 }), 'ab12:41');
    assert.notEqual(C.chatKey({ runId: 'ab12', ticketId: 41 }), C.chatKey({ runId: 'ab12', ticketId: 42 }));
  });

  it('turns saved rows into messages and skips bad rows', () => {
    const m = C.toMessages([{ id: 1, role: 'user', content: 'Q' }, { id: 2, role: 'assistant', content: 'A' },
      { role: 'system', content: 'x' }, null, { role: 'user' }]);
    assert.deepEqual(m, [{ id: 1, role: 'user', text: 'Q' }, { id: 2, role: 'assistant', text: 'A' }]);
    assert.deepEqual(C.toMessages(undefined), []);
  });

  it('cleans and gates the question', () => {
    assert.equal(C.cleanQuestion('  hi  '), 'hi');
    assert.equal(C.cleanQuestion('x'.repeat(3000)).length, 2000);
    assert.equal(C.canSend('   ', false), false);
    assert.equal(C.canSend('hi', true), false);
    assert.equal(C.canSend('hi', false), true);
  });

  it('appends tokens as received', () => {
    let s = '';
    for (const d of [{ text: 'Hel' }, { text: 'lo' }, {}, null]) s = C.appendToken(s, d);
    assert.equal(s, 'Hello');
  });

  it('adds a hint for a missing model or an unreachable server', () => {
    assert.match(C.errorText('model_missing', 'qwen is not installed').hint, /Settings/);
    assert.match(C.errorText('unreachable', 'x').hint, /Settings/);
    assert.equal(C.errorText('http', 'boom').hint, null);
    assert.ok(C.errorText('http').message);
  });

  it('evicts idle panels but never a busy one', () => {
    const map = new Map([['a', { busy: true }], ['b', { busy: false }], ['c', { busy: false }]]);
    C.evictIdle(map, 1, (v) => v.busy);
    assert.deepEqual([...map.keys()], ['a']);
  });
});
