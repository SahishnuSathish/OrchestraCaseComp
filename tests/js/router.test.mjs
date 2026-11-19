import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse, href, crumbs } from '../../dashboards/conductor/assets/js/router.js';

const RUN = 'ab12cd34';
const LAST = { lastRunId: RUN };

describe('parse recognises every route', () => {
  it('runs home', () => {
    const r = parse('#/runs');
    assert.equal(r.name, 'runs');
    assert.equal(r.runId, undefined);
    assert.equal(r.ticketId, undefined);
  });

  it('new run', () => {
    const r = parse('#/runs/new');
    assert.equal(r.name, 'run-new');
  });

  it('run overview', () => {
    const r = parse(`#/runs/${RUN}`);
    assert.equal(r.name, 'overview');
    assert.equal(r.runId, RUN);
  });

  it('tickets list', () => {
    const r = parse(`#/runs/${RUN}/tickets`);
    assert.equal(r.name, 'tickets');
    assert.equal(r.runId, RUN);
    assert.equal(r.ticketId, undefined);
  });

  it('ticket detail', () => {
    const r = parse(`#/runs/${RUN}/tickets/41259`);
    assert.equal(r.name, 'tickets');
    assert.equal(r.runId, RUN);
    assert.equal(r.ticketId, 41259);
  });

  it('review queue', () => {
    const r = parse(`#/runs/${RUN}/review`);
    assert.equal(r.name, 'review');
    assert.equal(r.runId, RUN);
    assert.equal(r.ticketId, undefined);
  });

  it('review draft', () => {
    const r = parse(`#/runs/${RUN}/review/41500`);
    assert.equal(r.name, 'review');
    assert.equal(r.runId, RUN);
    assert.equal(r.ticketId, 41500);
  });

  it('settings', () => {
    const r = parse('#/settings');
    assert.equal(r.name, 'settings');
    assert.equal(r.runId, undefined);
    assert.equal(r.ticketId, undefined);
  });
});

describe('parse reads the query string', () => {
  it('tickets query values are decoded', () => {
    const r = parse(`#/runs/${RUN}/tickets?output=draft_reply&q=acme%20print&flagged=1`);
    assert.equal(r.name, 'tickets');
    assert.equal(r.query.output, 'draft_reply');
    assert.equal(r.query.q, 'acme print');
    assert.equal(r.query.flagged, '1');
  });

  it('review draft query values', () => {
    const r = parse(`#/runs/${RUN}/review/41500?tab=approved&from=tickets`);
    assert.equal(r.name, 'review');
    assert.equal(r.ticketId, 41500);
    assert.equal(r.query.tab, 'approved');
    assert.equal(r.query.from, 'tickets');
  });
});

describe('parse treats unknown or malformed routes as not-found', () => {
  const cases = [
    '#/nope',
    `#/runs/${RUN}/unknown`,
    `#/runs/${RUN}/tickets/abc`,
    `#/runs/${RUN}/tickets/0`,
    `#/runs/${RUN}/tickets/-5`,
    '#/runs/NOT-A-RUN-ID/tickets',
  ];
  for (const hash of cases) {
    it(hash, () => {
      assert.equal(parse(hash, LAST).name, 'not-found');
    });
  }
});

describe('new is a reserved run id', () => {
  it('#/runs/new is run-new, not a run', () => {
    const r = parse('#/runs/new');
    assert.equal(r.name, 'run-new');
    assert.equal(r.runId, undefined);
    assert.notEqual(r.name, 'overview');
  });
});

describe('legacy redirects', () => {
  it('empty hash redirects to runs', () => {
    assert.equal(parse('', { lastRunId: null }).redirect, '#/runs');
  });

  it('#/run redirects to runs', () => {
    assert.equal(parse('#/run', { lastRunId: null }).redirect, '#/runs');
  });

  it('#/tickets redirects to last run tickets', () => {
    assert.equal(parse('#/tickets', LAST).redirect, `#/runs/${RUN}/tickets`);
  });

  it('#/tickets/41259 redirects to last run ticket detail', () => {
    assert.equal(parse('#/tickets/41259', LAST).redirect, `#/runs/${RUN}/tickets/41259`);
  });

  it('#/review redirects to last run review', () => {
    assert.equal(parse('#/review', LAST).redirect, `#/runs/${RUN}/review`);
  });

  it('#/review/41500 redirects to last run review draft', () => {
    assert.equal(parse('#/review/41500', LAST).redirect, `#/runs/${RUN}/review/41500`);
  });

  it('#/tickets with no last run redirects to runs', () => {
    assert.equal(parse('#/tickets', { lastRunId: null }).redirect, '#/runs');
  });

  it('#/review with no last run redirects to runs', () => {
    assert.equal(parse('#/review', { lastRunId: null }).redirect, '#/runs');
  });
});

describe('href builds routes', () => {
  it('runs', () => assert.equal(href('runs'), '#/runs'));
  it('run-new', () => assert.equal(href('run-new'), '#/runs/new'));
  it('overview', () => assert.equal(href('overview', { runId: RUN }), `#/runs/${RUN}`));
  it('tickets list', () => assert.equal(href('tickets', { runId: RUN }), `#/runs/${RUN}/tickets`));
  it('ticket detail', () =>
    assert.equal(href('tickets', { runId: RUN, ticketId: 41259 }), `#/runs/${RUN}/tickets/41259`));
  it('review queue', () => assert.equal(href('review', { runId: RUN }), `#/runs/${RUN}/review`));
  it('review draft', () =>
    assert.equal(href('review', { runId: RUN, ticketId: 41500 }), `#/runs/${RUN}/review/41500`));
  it('settings', () => assert.equal(href('settings'), '#/settings'));

  it('drops default and empty query values', () => {
    assert.equal(
      href('tickets', {
        runId: RUN,
        query: { sort: 'seq', q: '', flagged: false, priority: 0, output: undefined, x: null },
      }),
      `#/runs/${RUN}/tickets`,
    );
  });

  it('drops the default tab on review', () => {
    assert.equal(href('review', { runId: RUN, query: { tab: 'todo' } }), `#/runs/${RUN}/review`);
  });

  it('keeps and encodes non-default values', () => {
    assert.equal(
      href('tickets', { runId: RUN, query: { output: 'draft_reply', q: 'acme print' } }),
      `#/runs/${RUN}/tickets?output=draft_reply&q=acme%20print`,
    );
  });
});

describe('href and parse round trip', () => {
  const routes = [
    { name: 'runs' },
    { name: 'run-new' },
    { name: 'overview', runId: RUN },
    { name: 'tickets', runId: RUN },
    { name: 'tickets', runId: RUN, ticketId: 41259 },
    { name: 'tickets', runId: RUN, query: { output: 'draft_reply', q: 'acme print', flagged: '1' } },
    { name: 'tickets', runId: RUN, ticketId: 41259, query: { from: 'review' } },
    { name: 'tickets', runId: RUN, query: { sort: 'subject', dir: 'desc', priority: '1', review: 'pending' } },
    { name: 'review', runId: RUN, query: { tab: 'approved' } },
    { name: 'review', runId: RUN, ticketId: 41500, query: { tab: 'approved', from: 'tickets' } },
    { name: 'settings' },
  ];

  for (const route of routes) {
    it(`${route.name} ${href(route.name, route)}`, () => {
      const parsed = parse(href(route.name, route));
      assert.equal(parsed.name, route.name);
      assert.equal(parsed.runId, route.runId);
      assert.equal(parsed.ticketId, route.ticketId);
      assert.deepEqual(parsed.query, route.query ?? {});
    });
  }
});

describe('crumbs', () => {
  const run = { id: RUN, label: 'practice data' };

  it('ticket detail trail has labels', () => {
    const trail = crumbs({ name: 'tickets', runId: RUN, ticketId: 41259, query: {} }, run);
    assert.deepEqual(
      trail.map((c) => c.label),
      ['Runs', 'practice data', 'Tickets', '#41259'],
    );
  });

  it('ticket detail links resolve to the expected routes', () => {
    const trail = crumbs({ name: 'tickets', runId: RUN, ticketId: 41259, query: {} }, run);
    const expected = ['runs', 'overview', 'tickets'];
    for (let i = 0; i < trail.length - 1; i++) {
      assert.ok(trail[i].href, `crumb ${i} has an href`);
      assert.equal(parse(trail[i].href).name, expected[i]);
    }
  });

  it('last crumb has no href', () => {
    const trail = crumbs({ name: 'tickets', runId: RUN, ticketId: 41259, query: {} }, run);
    assert.ok(trail.at(-1).href == null);
  });

  it('settings is a single Settings crumb', () => {
    const trail = crumbs({ name: 'settings', query: {} }, run);
    assert.equal(trail.length, 1);
    assert.equal(trail[0].label, 'Settings');
  });

  it('new run trail', () => {
    const trail = crumbs({ name: 'run-new', query: {} }, run);
    assert.deepEqual(
      trail.map((c) => c.label),
      ['Runs', 'New run'],
    );
  });
});

describe('crumbs keep the list state when going up from a ticket', () => {
  const run = { id: 'ab12cd34', label: 'practice data' };
  const parentHref = (route) => { const c = crumbs(route, run); return c[c.length - 2].href; };

  it('tickets: filters carry over, "from" does not', () => {
    const route = parse('#/runs/ab12cd34/tickets/41259?output=draft_reply&q=acme&from=review');
    assert.equal(parentHref(route), '#/runs/ab12cd34/tickets?output=draft_reply&q=acme');
  });

  it('review: the tab carries over', () => {
    const route = parse('#/runs/ab12cd34/review/41262?tab=notes&from=tickets');
    assert.equal(parentHref(route), '#/runs/ab12cd34/review?tab=notes');
  });

  it('no query means a plain list link', () => {
    assert.equal(parentHref(parse('#/runs/ab12cd34/tickets/41259')), '#/runs/ab12cd34/tickets');
  });
});

describe('prevent page route', () => {
  it('parses, links and has crumbs', () => {
    assert.deepEqual(parse(`#/runs/${RUN}/prevent`, { lastRunId: null }), { name: 'prevent', runId: RUN, query: {} });
    assert.equal(href('prevent', { runId: RUN }), `#/runs/${RUN}/prevent`);
    assert.deepEqual(crumbs({ name: 'prevent', runId: RUN }, { label: 'Nov 13' }).map((c) => c.label), ['Runs', 'Nov 13', 'Prevent']);
    assert.equal(crumbs({ name: 'prevent', runId: RUN }, { label: 'Nov 13' }).at(-1).href, null);
  });

  it('has no ticket level and rejects junk', () => {
    assert.equal(parse(`#/runs/${RUN}/prevent/41259`, { lastRunId: null }).name, 'not-found');
    assert.equal(parse(`#/runs/${RUN}/preventx`, { lastRunId: null }).name, 'not-found');
  });
});
