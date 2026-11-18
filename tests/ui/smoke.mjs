#!/usr/bin/env node
/*
 * Conductor browser smoke / regression test.
 *
 * What it covers (the behaviours rebuilt in the Conductor overhaul):
 *   1  every route loads directly at 360/768/1280/1920 (heading, title, no overflow, no console errors) + error pages
 *   2  legacy hash redirects                      3  breadcrumbs and the narrow back link
 *   4  history is not polluted (J/K, filters, search, choosing a row)
 *   5  list state is remembered (filters, scroll) 6  deterministic back controls (from=review / from=tickets)
 *   7  navigation drawer and collapsible rail     8  "restarted" and "can't reach Conductor" banners
 *   9  New run (double start = one run, invalid path)  10 run overview links into filtered lists
 *   11 review workflow (tab in URL, approve/undo/send, edit problems, autosave failure, narrow layout)
 *   12 Settings + local model against a fake Ollama (status, models, streaming test console, stop, errors)
 *   13 the selected model reaches a run          14 accessibility basics
 *
 * Run (from the repo root):   node tests/ui/smoke.mjs
 *
 * Prerequisites
 *   - Node 22 (plain ESM, no package.json, no new dependencies).
 *   - Python 3 with the app's dependencies (fastapi, uvicorn, pydantic ...): `python3 webapp/server.py` must start.
 *   - The `playwright` package with a Chromium build already installed. If `playwright` cannot be loaded the test
 *     prints "skipped: Playwright is not installed" and exits 0. This script never runs `playwright install`.
 *
 * Isolation
 *   The test starts its own Conductor (random free port, CONDUCTOR_STATE_DIR in a fresh temp dir) and its own fake Ollama
 *   (tests/fake_ollama.py, no inference). Nothing is written inside the repository: the tracked webapp/state/ and out/
 *   are never touched (a final check compares `git status` for those paths before and after). Both child processes and
 *   the temp dir are removed in `finally`, also on SIGINT/SIGTERM.
 *
 * Test 13 and the model cache
 *   The pipeline caches model readings in out/.cache/model (tracked files) and there is no override for that
 *   directory (prototype/cache.py: DEFAULT_DIR is fixed, webapp/runner.py does not pass one). A cache entry is only
 *   written when the model returned a valid reading, so test 13 talks to a dedicated fake Ollama started with
 *   `--fail http500`: every /api/chat answers HTTP 500, no reading is ever produced and nothing is cached. The model
 *   selection is still observable (run.model, the overview header and the `model` of every /api/chat request).
 *
 * Optional: `node tests/ui/smoke.mjs "<regex>"` runs only the tests whose name matches (handy while debugging).
 *
 * Exit code: 0 when every test passed (or the suite was skipped), 1 otherwise.
 */
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOVA = path.resolve(HERE, '..', '..');           // repo root
const REPO = NOVA;
const DATA_DIR = path.join(NOVA, 'data');

// ------------------------------------------------------------------------------------------------ playwright
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.log('skipped: Playwright is not installed (npm install playwright && npx playwright install chromium)');
  process.exit(0);
}

const VP = {
  phone: { width: 360, height: 740 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
  wide: { width: 1920, height: 1080 },
};
const ALL_WIDTHS = Object.values(VP);
const TEST_TIMEOUT = 20000;

// ------------------------------------------------------------------------------------------------ processes
const children = new Set();
let stateDir = null;
let browser = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

async function waitHttp(url, child, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`process exited early (${child.exitCode}): ${child.tail()}`);
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${url}: ${child.tail()}`);
    await sleep(100);
  }
}

function startChild(label, args, env) {
  const child = spawn('python3', args, { cwd: NOVA, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const keep = (b) => { out = (out + b.toString()).slice(-3000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.tail = () => out.trim().split('\n').slice(-6).join(' | ');
  child.label = label;
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await Promise.race([done, sleep(3000)]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await Promise.race([done, sleep(1000)]); }
}

async function startFake({ fail, tokenDelay = 0.05 } = {}) {
  const port = await freePort();
  const args = ['tests/fake_ollama.py', '--port', String(port), '--models', 'qwen3.5:9b,llama3.2:3b', '--token-delay', String(tokenDelay)];
  if (fail) args.push('--fail', fail);
  const proc = startChild('fake-ollama', args, { ...process.env, PYTHONDONTWRITEBYTECODE: '1' });
  const url = `http://127.0.0.1:${port}`;
  await waitHttp(`${url}/api/version`, proc);
  const fake = {
    url, port, proc,
    stop: () => stopChild(proc),
    requests: async () => (await (await fetch(`${url}/__requests`)).json()).requests,
    chats: async () => (await fake.requests()).filter((r) => r.path === '/api/chat'),
    reset: async () => { await fetch(`${url}/__reset`, { method: 'POST' }); },
  };
  return fake;
}

const cleanEnv = () => {
  const env = { ...process.env, CONDUCTOR_STATE_DIR: stateDir, AP_DESK_STATE_DIR: stateDir, PYTHONDONTWRITEBYTECODE: '1' };
  delete env.OLLAMA_URL; delete env.OLLAMA_MODEL; delete env.ORCHESTRA_MAIL_MODE;
  return env;
};

let cleanupPromise = null;
let shuttingDown = false;
// Idempotent: the signal handler and the normal exit path share one run.
function cleanup() {
  cleanupPromise ||= (async () => {
    try { await Promise.race([browser?.close(), sleep(5000)]); } catch { /* ignore */ }
    await Promise.all([...children].map(stopChild));
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${sig}: cleaning up`);
    cleanup().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
  });
}
// Last resort, synchronous: whatever path ends the process, no child and no temp dir is left behind.
process.on('exit', () => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  if (stateDir) { try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

// ------------------------------------------------------------------------------------------------ app + api helpers
const A = { port: 0, token: '', runId: '', rows: [], fake: null, modelDeadPort: 0 };
const BASE = () => `http://127.0.0.1:${A.port}/`;

async function api(pathname, method = 'GET', body) {
  const res = await fetch(`http://127.0.0.1:${A.port}${pathname}`, {
    method,
    headers: { 'x-ap-token': A.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) { const e = new Error(`${method} ${pathname} -> ${res.status} ${text.slice(0, 200)}`); e.status = res.status; throw e; }
  return json;
}
async function apiStatus(pathname, method = 'GET', body) {
  try { await api(pathname, method, body); return 200; } catch (e) { if (e.status) return e.status; throw e; }
}

async function poll(fn, { timeout = 10000, interval = 60, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error(`timed out waiting for ${message}${last instanceof Error ? ` (${last.message})` : ''}`);
    await sleep(interval);
  }
}

async function waitRunDone(runId, timeout = 60000) {
  return poll(async () => {
    const r = await api(`/api/runs/${runId}`);
    if (['failed', 'cancelled', 'interrupted'].includes(r.status)) throw new Error(`run ${runId} ended as ${r.status}: ${r.error}`);
    return r.status === 'done' ? r : null;
  }, { timeout, message: `run ${runId} to finish` });
}

async function createRun({ limit, useModel = false } = {}) {
  const body = { path: DATA_DIR, use_model: useModel };
  if (limit) body.limit = limit;
  const { run_id } = await api('/api/runs', 'POST', body);
  await waitRunDone(run_id);
  return run_id;
}

// Finish, then delete (a run in progress cannot be deleted: 409).
async function removeRun(runId) {
  await waitRunDone(runId).catch(() => {});
  await api(`/api/runs/${runId}`, 'DELETE');
}

const ticketRows = async (runId) => (await api(`/api/runs/${runId}/tickets`)).rows;
const isDraft = (r) => r.output_type === 'draft_reply';
const isClean = (r) => isDraft(r) && r.review_state === 'pending' && !(r.flags || []).length && !r.priority && !r.act_by;
const firstDraftTicketId = (rows = A.rows) => rows.find(isDraft).ticket_id;

async function resetModelSettings() {
  await api('/api/settings/model', 'PUT', { url: null, model: null, timeout_s: null });
}
const configureModel = (body) => api('/api/settings/model', 'PUT', body);

// ------------------------------------------------------------------------------------------------ page helpers
const hashOf = (page) => page.evaluate(() => location.hash);
const historyLength = (page) => page.evaluate(() => history.length);
const queryOf = async (page) => new URLSearchParams(((await hashOf(page)).split('?')[1]) || '');

async function waitForHash(page, expected, timeout = 8000) {
  const isRe = expected instanceof RegExp;
  try {
    await page.waitForFunction(([exp, re, flags]) => (re ? new RegExp(exp, flags).test(location.hash) : location.hash === exp),
      [isRe ? expected.source : expected, isRe, isRe ? expected.flags : ''], { timeout });
  } catch {
    throw new Error(`expected URL hash ${expected}, but it is ${await hashOf(page)}`);
  }
}
const waitForRoute = waitForHash;

// Always a full page load (leaves the SPA first so same-document hash navigation cannot hide a failure).
async function gotoRoute(page, hash) {
  if (page.url().startsWith(BASE())) await page.goto('about:blank');
  await page.goto(`${BASE()}${hash}`);
  await page.locator('#main').waitFor({ state: 'attached' });
}

async function assertNoOverflow(page, label = '') {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(m.sw <= m.cw, `horizontal overflow${label ? ` (${label})` : ''}: scrollWidth ${m.sw} > clientWidth ${m.cw}`);
}

async function waitTitle(page) {
  await page.waitForFunction(() => document.title.endsWith('Conductor') && document.title.includes(' · '));
}

const sidebar = (page) => page.locator('nav[aria-label="Primary"]');
const crumbsNav = (page) => page.getByRole('navigation', { name: 'Breadcrumb' });
const rowIds = (page) => page.evaluate(() => [...document.querySelectorAll('.tbl tbody tr[data-id]')].map((tr) => Number(tr.dataset.id)));
const toastWith = (page, text) => page.locator('.toast', { hasText: text });
async function waitDisabled(locator, disabled = true, message = 'button state') {
  await poll(async () => (await locator.isDisabled()) === disabled, { timeout: 6000, message });
}

// The route table shared by tests 1 and 14: hash, what proves the page rendered (a selector inside <main>).
function routeTable() {
  const run = A.runId;
  const draft = firstDraftTicketId();
  return [
    { name: 'runs', hash: '#/runs', wait: '.run-name' },
    { name: 'new run', hash: '#/runs/new', wait: '#reader-regex' },
    { name: 'overview', hash: `#/runs/${run}`, wait: '.stat-grid' },
    { name: 'tickets', hash: `#/runs/${run}/tickets`, wait: '.tbl tbody tr[data-id]' },
    { name: 'ticket detail', hash: `#/runs/${run}/tickets/41259`, wait: '.detail-head h2' },
    { name: 'review', hash: `#/runs/${run}/review`, wait: 'a.q-item' },
    { name: 'review draft', hash: `#/runs/${run}/review/${draft}`, wait: '.center-head h2' },
    { name: 'prevent', hash: `#/runs/${run}/prevent`, wait: '.prevent-ready' },
    { name: 'settings', hash: '#/settings', wait: '.st-status' },
  ];
}

// ------------------------------------------------------------------------------------------------ test harness
const tests = [];
function test(name, fn, opts = {}) { tests.push({ name, fn, opts }); }

async function runOne(t) {
  const started = Date.now();
  const ctxs = [];
  const errors = [];
  const allowed = [];
  const track = (page) => {
    page.setDefaultTimeout(8000);
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console error: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`uncaught page error: ${e.message}`));
    return page;
  };
  const env = {
    track,
    async newPage(viewport = VP.desktop, ctxOpts = {}) {
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, ...ctxOpts });
      ctxs.push(ctx);
      return track(await ctx.newPage());
    },
    // A second page in the same browser context (shares localStorage).
    async siblingPage(page) { return track(await page.context().newPage()); },
    allowErrors(...patterns) { allowed.push(...patterns); },
  };
  let timer;
  try {
    await Promise.race([
      t.fn(env),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${(t.opts.timeout || TEST_TIMEOUT) / 1000}s`)), t.opts.timeout || TEST_TIMEOUT); }),
    ]);
    const bad = errors.filter((e) => !allowed.some((p) => (p instanceof RegExp ? p.test(e) : e.includes(p))));
    if (bad.length) throw new Error(`browser reported errors:\n        ${[...new Set(bad)].slice(0, 4).join('\n        ')}`);
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e };
  } finally {
    clearTimeout(timer);
    for (const c of ctxs) { try { await c.close(); } catch { /* ignore */ } }
  }
}

function shortError(e) {
  const msg = String(e?.message || e).split('\n').filter((l) => !/^\s*(at |- waiting|=+ logs)/.test(l)).slice(0, 5).join('\n        ');
  return msg;
}

// ================================================================================================ TESTS
// ---------------------------------------------------------------------------------------------- 1. routes load directly
for (const vp of ALL_WIDTHS) {
  test(`1 routes load directly @${vp.width}`, async (t) => {
    const page = await t.newPage(vp);
    for (const r of routeTable()) {
      await gotoRoute(page, r.hash);
      for (const pass of ['load', 'reload']) {
        if (pass === 'reload') { await page.reload(); await page.locator('#main').waitFor({ state: 'attached' }); }
        await page.locator(`#main ${r.wait}`).first().waitFor({ state: 'attached' });
        const h1 = page.locator('main h1');
        assert.equal(await h1.count(), 1, `${r.name} (${pass}): expected exactly one <h1> in <main>`);
        assert.ok((await h1.innerText()).trim().length > 0, `${r.name} (${pass}): <h1> is empty`);
        assert.ok(await h1.isVisible(), `${r.name} (${pass}): <h1> not visible`);
        await waitTitle(page);
        await assertNoOverflow(page, `${r.name} ${pass}`);
      }
    }
  });
}

test('1 unknown routes show a way out', async (t) => {
  t.allowErrors(/404/);
  const run = A.runId;
  const page = await t.newPage(VP.tablet);

  await gotoRoute(page, '#/nope');
  await page.getByRole('heading', { name: 'Page not found' }).waitFor();
  await page.locator('#main').getByRole('link', { name: /Go to runs/ }).click();
  await waitForHash(page, '#/runs');

  await gotoRoute(page, '#/runs/deadbeef');
  await page.getByRole('heading', { name: 'This run no longer exists' }).waitFor();
  await page.locator('#main').getByRole('link', { name: 'Go to runs' }).click();
  await waitForHash(page, '#/runs');

  for (const vp of [VP.tablet, VP.phone]) {
    await page.setViewportSize(vp);
    await gotoRoute(page, `#/runs/${run}/tickets/999999`);
    await page.getByRole('heading', { name: /Could not load ticket #999999/ }).waitFor();
    await assertNoOverflow(page, `unknown ticket @${vp.width}`);
    await page.locator('#main .empty').getByRole('link', { name: 'All tickets' }).click(); // the error state's own way back
    await waitForHash(page, `#/runs/${run}/tickets`);
    await page.locator('.tbl tbody tr[data-id]').first().waitFor();
  }

  await page.setViewportSize(VP.tablet);
  await gotoRoute(page, `#/runs/${run}/review/999999`);
  await page.getByRole('heading', { name: /Ticket #999999 is not in this run/ }).waitFor();
  await page.locator('#main').getByRole('link', { name: 'Back to queue' }).click();
  await waitForHash(page, `#/runs/${run}/review`);
});

// ---------------------------------------------------------------------------------------------- 2. legacy redirects
test('2 legacy redirects (replace, not push) when a run was opened', async (t) => {
  const run = A.runId;
  const page = await t.newPage(VP.tablet); // narrow: Review does not auto-select a ticket, so the URL stays as redirected
  await page.context().addInitScript((id) => { try { localStorage.setItem('ap.run', id); } catch { /* ignore */ } }, run);

  const cases = [
    ['#/tickets/41259', `#/runs/${run}/tickets/41259`],
    ['#/review', `#/runs/${run}/review`],
    ['#/run', '#/runs'],
    ['', '#/runs'],
  ];
  for (const [from, to] of cases) {
    await page.goto('about:blank');
    if (from === '') {
      await page.goto(BASE()); // an empty hash can only be tested on a fresh load of the bare URL
      await waitForHash(page, to);
      await page.goBack();
      assert.equal(page.url(), 'about:blank', 'the redirect from the empty hash replaced its history entry');
      continue;
    }
    await page.goto(`${BASE()}#/settings`); // a known page to come back to
    await page.locator('.st-status').waitFor();
    const len = await historyLength(page);
    await page.evaluate((h) => { location.hash = h; }, from);
    await waitForHash(page, to);
    assert.equal(await historyLength(page), len + 1, `redirect from "${from}" must replace its history entry`);
    await page.locator('#main h1, #main .tbl, #main .q-item').first().waitFor({ state: 'attached' });
  }
  // replace semantics: Back from a redirected hash goes to the page before it
  await page.goto('about:blank');
  await page.goto(`${BASE()}#/settings`);
  await page.locator('.st-status').waitFor();
  await page.evaluate(() => { location.hash = '#/tickets/41259'; });
  await waitForHash(page, `#/runs/${run}/tickets/41259`);
  await page.goBack();
  await waitForHash(page, '#/settings');
});

test('2 legacy list hash without a remembered run goes to Runs', async (t) => {
  const page = await t.newPage(VP.tablet);
  await gotoRoute(page, '#/tickets');
  await waitForHash(page, '#/runs');
  await page.getByRole('heading', { name: 'Runs', level: 1 }).waitFor();
  await gotoRoute(page, '#/review/41259');
  await waitForHash(page, '#/runs');
});

// ---------------------------------------------------------------------------------------------- 3. breadcrumbs
test('3 breadcrumbs on a ticket detail @1280', async (t) => {
  const run = A.runId;
  const page = await t.newPage(VP.desktop);
  await gotoRoute(page, `#/runs/${run}/tickets/41259`);
  await page.locator('.detail-head h2').waitFor();
  const nav = crumbsNav(page);
  assert.deepEqual((await nav.locator('li').allInnerTexts()).map((s) => s.trim()), ['Runs', 'data', 'Tickets', '#41259']);
  assert.equal(await nav.locator('[aria-current="page"]').count(), 1, 'only one breadcrumb is the current page');
  assert.equal((await nav.locator('li').last().locator('[aria-current="page"]').count()), 1, 'the last crumb is the current page');
  const links = await nav.locator('li a').evaluateAll((as) => as.map((a) => [a.textContent.trim(), a.getAttribute('href')]));
  assert.deepEqual(links, [['Runs', '#/runs'], ['data', `#/runs/${run}`], ['Tickets', `#/runs/${run}/tickets`]]);

  await nav.getByRole('link', { name: 'Tickets' }).click();
  await waitForHash(page, `#/runs/${run}/tickets`);
  await page.locator('.tbl tbody tr[data-id]').first().waitFor();
  await crumbsNav(page).getByRole('link', { name: 'data' }).click();
  await waitForHash(page, `#/runs/${run}`);
  await page.locator('.stat-grid').waitFor();
  await crumbsNav(page).getByRole('link', { name: 'Runs' }).click();
  await waitForHash(page, '#/runs');
  await page.getByRole('heading', { name: 'Runs', level: 1 }).waitFor();
});

test('3 narrow screens show a back link to the parent instead of the breadcrumb @360', async (t) => {
  const run = A.runId;
  const page = await t.newPage(VP.phone);
  await gotoRoute(page, `#/runs/${run}/tickets/41259`);
  await page.locator('.detail-head h2').waitFor();
  const back = page.locator('a.crumb-back');
  await back.waitFor({ state: 'visible' });
  const parentHref = await crumbsNav(page).locator('li a').last().getAttribute('href'); // the parent crumb, hidden at this width
  assert.ok(parentHref && parentHref.startsWith(`#/runs/${run}/tickets`), `unexpected parent crumb ${parentHref}`);
  assert.equal(await back.getAttribute('href'), parentHref, 'the back link points at the parent crumb');
  const shown = (await crumbsNav(page).innerText()).trim();
  assert.equal(shown, '#41259', `only the current page title is shown, got "${shown}"`);
  await back.click();
  await waitForHash(page, new RegExp(`^#/runs/${run}/tickets(\\?|$)`));
});

// ---------------------------------------------------------------------------------------------- 4. history is not polluted
test('4 stepping with J does not add history entries and Back skips the tickets it stepped over', async (t) => {
  const run = A.runId;
  const order = A.rows.map((r) => r.ticket_id); // list order = seq order
  const page = await t.newPage(VP.desktop);
  await gotoRoute(page, '#/runs');
  await page.locator('.run-name').first().waitFor();
  await page.evaluate((h) => { location.hash = h; }, `#/runs/${run}/tickets/${order[0]}`);
  await page.locator('.detail-head h2').waitFor();
  await page.evaluate(() => document.activeElement?.blur?.());
  const len = await historyLength(page);
  for (let i = 1; i <= 5; i++) {
    await page.keyboard.press('j');
    await waitForHash(page, `#/runs/${run}/tickets/${order[i]}`);
    assert.equal(await historyLength(page), len, `history.length changed after J #${i}`);
  }
  await page.goBack();
  await waitForHash(page, '#/runs'); // the page visited before the tickets page, not a previous ticket
  await page.getByRole('heading', { name: 'Runs', level: 1 }).waitFor();
});

test('4 filters and search replace the URL, keep focus and add no history', async (t) => {
  const run = A.runId;
  const page = await t.newPage(VP.desktop);
  await gotoRoute(page, `#/runs/${run}/tickets`);
  await page.locator('.tbl tbody tr[data-id]').first().waitFor();
  const len = await historyLength(page);

  await page.locator('.tk-chips').getByRole('button', { name: /^Reply/ }).click();
  await waitForHash(page, /[?&]output=draft_reply/);
  assert.equal(await historyLength(page), len, 'a filter chip must not add a history entry');
  assert.equal((await rowIds(page)).length, A.rows.filter(isDraft).length);

  const search = page.getByRole('searchbox', { name: 'Search tickets' });
  await search.click();
  await search.pressSequentially('dove', { delay: 90 });
  await waitForHash(page, /[?&]q=dove/);
  assert.equal((await queryOf(page)).get('output'), 'draft_reply', 'the filter stays in the URL while searching');
  assert.equal(await historyLength(page), len, 'typing in search must not add a history entry');
  const st = await page.evaluate(() => { const s = document.querySelector('input[type=search]'); return { focused: document.activeElement === s, caret: s.selectionStart, value: s.value }; });
  assert.ok(st.focused, 'search lost focus while typing');
  assert.equal(st.caret, st.value.length, 'search caret moved while typing');
  assert.equal(st.value, 'dove');
  // caret in the middle survives the URL round trip too
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('x');
  await waitForHash(page, /[?&]q=doxve/);
  const mid = await page.evaluate(() => { const s = document.querySelector('input[type=search]'); return { focused: document.activeElement === s, caret: s.selectionStart }; });
  assert.ok(mid.focused && mid.caret === 3, `caret should stay after the typed character, got ${JSON.stringify(mid)}`);
  assert.equal(await historyLength(page), len);
});

test('4 choosing a row pushes exactly one history entry and Back returns to the list', async (t) => {
  const run = A.runId;
  const page = await t.newPage(VP.desktop);
  await gotoRoute(page, `#/runs/${run}/tickets`);
  await page.locator('.tbl tbody tr[data-id]').first().waitFor();
  const len = await historyLength(page);
  await page.locator('tbody tr[data-id="41259"] a').click();
  await waitForHash(page, `#/runs/${run}/tickets/41259`);
  await page.locator('.detail-head h2').waitFor();
  assert.equal(await historyLength(page), len + 1);
  await page.goBack();
  await waitForHash(page, `#/runs/${run}/tickets`);
  await page.locator('.tbl tbody tr[data-id]').first().waitFor();
});

// ---------------------------------------------------------------------------------------------- 5. list state memory
for (const vp of [VP.phone, VP.tablet]) {
  test(`5 ticket list filters and window scroll survive opening a ticket and Back @${vp.width}`, async (t) => {
    const run = A.runId;
    const list = `#/runs/${run}/tickets?output=draft_reply`;
    const page = await t.newPage(vp);
    await gotoRoute(page, list);
    await page.locator('.tbl tbody tr[data-id]').first().waitFor();
    const ids = await rowIds(page);
    assert.equal(ids.length, A.rows.filter(isDraft).length);
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); // scroll is saved on a frame
    const y = await page.evaluate(() => window.scrollY);
    assert.ok(y > 300, `the list did not scroll (scrollY ${y})`);
    const id = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.tbl tbody tr[data-id]')].find((tr) => tr.getBoundingClientRect().top > 120);
      return Number(row.dataset.id);
    });
    await page.locator(`tbody tr[data-id="${id}"] a`).click();
    await waitForHash(page, `#/runs/${run}/tickets/${id}?output=draft_reply`);
    await page.locator('.detail-head h2').waitFor();
    await page.goBack();
    await waitForHash(page, list);
    await page.locator('.tbl tbody tr[data-id]').first().waitFor();
    assert.deepEqual(await rowIds(page), ids, 'same filtered rows after Back');
    await poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - y) <= 5, { message: `scroll restored to ${y}` });

    // Same again, but leaving through an in-app control instead of browser Back (the browser's own scroll restoration
    // does not apply to a new history entry, so this exercises the app's list memory).
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const y2 = await page.evaluate(() => window.scrollY);
    assert.ok(y2 > y + 100, `the list did not scroll further (${y} -> ${y2})`);
    const id2 = await page.evaluate(() => [...document.querySelectorAll('.tbl tbody tr[data-id]')].find((tr) => tr.getBoundingClientRect().top > 120).dataset.id);
    await page.locator(`tbody tr[data-id="${id2}"] a`).click();
    await page.locator('.detail-head h2').waitFor();
    if (vp.width > 640) {
      await page.getByRole('link', { name: 'All tickets', exact: true }).click(); // the in-pane control keeps the filters
    } else {
      await page.locator('#menu-btn').click(); // on a phone the sidebar's Tickets link carries the remembered filters
      await sidebar(page).getByRole('link', { name: 'Tickets', exact: true }).click();
    }
    await waitForHash(page, list);
    await page.locator('.tbl tbody tr[data-id]').first().waitFor();
    assert.deepEqual(await rowIds(page), ids, 'same filtered rows after returning through the app');
    await poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - y2) <= 5, { message: `scroll restored to ${y2} after an in-app return` });
  });
}

test('5 filters and list scroll survive leaving through the sidebar; reload and a second page reproduce the list @1280', async (t) => {
  const run = A.runId;
  const list = `#/runs/${run}/tickets?output=draft_reply&sort=subject`;
  const page = await t.newPage(VP.desktop);
  await gotoRoute(page, list);
  await page.locator('.tbl tbody tr[data-id]').first().waitFor();
  const ids = await rowIds(page);
  assert.equal(ids.length, A.rows.filter(isDraft).length);
  await page.evaluate(() => { document.querySelector('.table-wrap').scrollTop = 700; });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const top = await page.evaluate(() => document.querySelector('.table-wrap').scrollTop);
  assert.ok(top > 300, `the list container did not scroll (${top})`);

  await sidebar(page).getByRole('link', { name: /^Review/ }).click();
  await waitForHash(page, new RegExp(`^#/runs/${run}/review`));
  await page.locator('a.q-item').first().waitFor();
  await sidebar(page).getByRole('link', { name: 'Tickets', exact: true }).click();
  await waitForHash(page, list);
  await page.locator('.tbl tbody tr[data-id]').first().waitFor();
  assert.deepEqual(await rowIds(page), ids, 'same rows (same filter and sort) after returning via the sidebar');
  await poll(async () => Math.abs((await page.evaluate(() => document.querySelector('.table-wrap').scrollTop)) - top) <= 5, { message: `list scroll restored to ${top}` });

  await page.reload();
  await page.locator('.tbl tbody tr[data-id]').first().waitFor();
  assert.equal(await hashOf(page), list, 'reload keeps the URL');
  assert.deepEqual(await rowIds(page), ids, 'reload keeps the filtered rows');

  const second = await t.siblingPage(page);
  await second.goto(`${BASE()}${list}`);
  await second.locator('.tbl tbody tr[data-id]').first().waitFor();
  assert.deepEqual(await rowIds(second), ids, 'the same URL in a second page shows the same rows');

  // combined filters come straight from the URL (the flagged tickets of the practice data are internal notes)
  await second.goto(`${BASE()}#/runs/${run}/tickets?output=internal_action_note&flagged=1`);
  await second.locator('.tbl tbody tr[data-id]').first().waitFor();
  const expected = A.rows.filter((r) => r.output_type === 'internal_action_note' && (r.flags || []).length).map((r) => r.ticket_id).sort();
  assert.ok(expected.length > 0);
  assert.deepEqual((await rowIds(second)).sort(), expected);
  await second.goto(`${BASE()}#/runs/${run}/tickets?output=draft_reply&flagged=1`);
  await second.getByRole('heading', { name: 'No tickets match' }).waitFor();
});

test('5 Review remembers its tab when you leave and come back through the sidebar', async (t) => {
  const run = A.runId;
  const page = await t.newPage(VP.desktop);
  await gotoRoute(page, `#/runs/${run}/review?tab=notes`);
  await page.locator('a.q-item').first().waitFor();
  await waitForHash(page, new RegExp(`^#/runs/${run}/review/\\d+\\?tab=notes`));
  await sidebar(page).getByRole('link', { name: 'Overview' }).click();
  await waitForHash(page, `#/runs/${run}`);
  await sidebar(page).getByRole('link', { name: /^Review/ }).click();
  await waitForHash(page, new RegExp(`^#/runs/${run}/review/\\d+\\?tab=notes`));
  assert.equal(await page.getByRole('tab', { name: /^Notes/ }).getAttribute('aria-selected'), 'true');
});

// ---------------------------------------------------------------------------------------------- 6. deterministic back controls
for (const vp of [VP.tablet, VP.phone]) {
  test(`6 ticket opened with from=review offers "Back to review" without any history @${vp.width}`, async (t) => {
    const run = A.runId;
    const page = await t.newPage(vp);
    await gotoRoute(page, `#/runs/${run}/tickets/41259?from=review`);
    await page.locator('.detail-head h2').waitFor();
    assert.ok((await historyLength(page)) <= 2, 'precondition: no real history behind this page');
    const back = page.getByRole('link', { name: 'Back to review', exact: true });
    await back.waitFor({ state: 'visible' });
    assert.equal(await back.getAttribute('href'), `#/runs/${run}/review/41259`);
    await back.click();
    await waitForHash(page, `#/runs/${run}/review/41259`);
    await page.locator('.center-head h2').waitFor();
  });
}

for (const vp of [VP.phone, VP.tablet, VP.desktop]) {
  test(`6 draft opened with from=tickets offers "Back to ticket" without any history @${vp.width}`, async (t) => {
    const run = A.runId;
    const id = firstDraftTicketId();
    const page = await t.newPage(vp);
    await gotoRoute(page, `#/runs/${run}/review/${id}?from=tickets`);
    await page.locator('.center-head h2').waitFor();
    const back = page.getByRole('link', { name: 'Back to ticket', exact: true });
    await back.waitFor({ state: 'visible' });
    assert.equal(await back.getAttribute('href'), `#/runs/${run}/tickets/${id}`);
    await back.click();
    await waitForHash(page, `#/runs/${run}/tickets/${id}`);
    await page.locator('.detail-head h2').waitFor();
  });
}

test('6 "All tickets" returns to the list with the same query even on a direct visit @768', async (t) => {
  const run = A.runId;
  const page = await t.newPage(VP.tablet);
  await gotoRoute(page, `#/runs/${run}/tickets/41259?output=draft_reply`);
  await page.locator('.detail-head h2').waitFor();
  const all = page.getByRole('link', { name: 'All tickets', exact: true });
  await all.waitFor({ state: 'visible' });
  assert.equal(await all.getAttribute('href'), `#/runs/${run}/tickets?output=draft_reply`);
  await all.click();
  await waitForHash(page, `#/runs/${run}/tickets?output=draft_reply`);
  await page.locator('.tbl tbody tr[data-id]').first().waitFor();
  assert.equal((await rowIds(page)).length, A.rows.filter(isDraft).length);
});

// On a phone the in-pane "All tickets" / "Queue" controls are hidden and the topbar chevron is the way back: it must
// not forget the filters or the tab the person came from (SPEC section 1: back controls return to "the list with the
// current filters" / "the review list (same tab)").
test('6 on a phone the back chevron of a filtered ticket returns to the same filtered list @360', async (t) => {
  const run = A.runId;
  const page = await t.newPage(VP.phone);
  await gotoRoute(page, `#/runs/${run}/tickets/41259?output=draft_reply`);
  await page.locator('.detail-head h2').waitFor();
  await page.locator('a.crumb-back').click();
  await waitForHash(page, `#/runs/${run}/tickets?output=draft_reply`);
});

test('6 on a phone the back chevron of a note opened from the Notes tab returns to the Notes tab @360', async (t) => {
  const run = A.runId;
  const note = A.rows.find((r) => r.output_type === 'internal_action_note').ticket_id;
  const page = await t.newPage(VP.phone);
  await gotoRoute(page, `#/runs/${run}/review/${note}?tab=notes`);
  await page.locator('.center-head h2').waitFor();
  await page.locator('a.crumb-back').click();
  await waitForHash(page, `#/runs/${run}/review?tab=notes`);
  assert.equal(await page.getByRole('tab', { name: /^Notes/ }).getAttribute('aria-selected'), 'true');
});

// ---------------------------------------------------------------------------------------------- 7. drawer
for (const vp of [VP.phone, VP.tablet]) {
  test(`7 navigation drawer: focus, inert, scroll lock, focus trap, Escape, scrim, link @${vp.width}`, async (t) => {
    const run = A.runId;
    const page = await t.newPage(vp);
    await gotoRoute(page, `#/runs/${run}/tickets`);
    await page.locator('.tbl tbody tr[data-id]').first().waitFor();
    const menu = page.locator('#menu-btn');
    const inside = () => page.evaluate(() => document.getElementById('sidebar').contains(document.activeElement));
    const open = async () => { await menu.click(); await poll(async () => (await menu.getAttribute('aria-expanded')) === 'true', { message: 'drawer opens' }); };
    assert.equal(await menu.getAttribute('aria-expanded'), 'false');

    await page.evaluate(() => window.scrollTo(0, 400));
    const y0 = await page.evaluate(() => window.scrollY);
    await open();
    assert.ok(await inside(), 'focus moves into the drawer');
    assert.ok(await page.evaluate(() => document.getElementById('main-col').inert), 'the main column is inert while open');
    assert.ok(await page.evaluate(() => document.querySelector('main').closest('[inert]') !== null));
    const lock = await page.evaluate(() => [document.documentElement, document.body].map((e) => getComputedStyle(e).overflow));
    assert.ok(lock.includes('hidden'), `page scroll is locked while the drawer is open (overflow ${lock})`);
    await page.mouse.move(vp.width - 20, 400);
    await page.mouse.wheel(0, 600);
    await sleep(150); // negative check: nothing to wait for, only to give a wrong scroll time to happen
    assert.equal(await page.evaluate(() => window.scrollY), y0, 'the page behind the drawer must not scroll');

    for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); assert.ok(await inside(), `Tab #${i + 1} left the drawer`); }
    for (let i = 0; i < 14; i++) { await page.keyboard.press('Shift+Tab'); assert.ok(await inside(), `Shift+Tab #${i + 1} left the drawer`); }

    await page.keyboard.press('Escape');
    await poll(async () => (await menu.getAttribute('aria-expanded')) === 'false', { message: 'Escape closes the drawer' });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'menu-btn', 'focus returns to the menu button');
    assert.equal(await page.evaluate(() => document.getElementById('main-col').inert), false);

    await open();
    await sidebar(page).getByRole('link', { name: 'Runs', exact: true }).click();
    await waitForHash(page, '#/runs');
    await poll(async () => (await menu.getAttribute('aria-expanded')) === 'false', { message: 'a navigation link closes the drawer' });
    assert.equal(await page.evaluate(() => document.getElementById('main-col').inert), false);

    await open();
    await page.locator('#scrim').click({ position: { x: vp.width - 20, y: 400 } });
    await poll(async () => (await menu.getAttribute('aria-expanded')) === 'false', { message: 'the scrim closes the drawer' });
  });
}

test('7 at 1280 there is no menu button and the collapse toggle persists across reload', async (t) => {
  const page = await t.newPage(VP.desktop);
  await gotoRoute(page, '#/runs');
  await page.locator('.run-name').first().waitFor();
  assert.equal(await page.locator('#menu-btn').isVisible(), false, 'no menu button on wide screens');
  const toggle = page.locator('#rail-toggle');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.rail), 'open');
  await toggle.click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.rail), 'collapsed');
  assert.equal(await page.evaluate(() => localStorage.getItem('ap.rail')), 'collapsed');
  await page.reload();
  await page.locator('.run-name').first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.rail), 'collapsed', 'collapsed state survives a reload');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.click();
  await page.reload();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.rail), 'open', 'expanded choice survives a reload too');
});

// ---------------------------------------------------------------------------------------------- 8. banners
test('8 a 401 shows the "restarted" banner with a Reload button', async (t) => {
  t.allowErrors(/401/);
  const page = await t.newPage(VP.desktop);
  await gotoRoute(page, '#/settings');
  await page.locator('.st-status').waitFor();
  await page.getByText('Connected').or(page.getByText('Not connected')).first().waitFor();
  await page.route('**/api/**', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ detail: 'missing or bad token' }) }));
  await page.getByRole('button', { name: /Check again/ }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Conductor was restarted' });
  await alert.waitFor();
  await alert.getByRole('button', { name: 'Reload' }).waitFor();
});

test("8 an unreachable server shows \"Can't reach Conductor\" and Retry now clears it", async (t) => {
  t.allowErrors(/ERR_FAILED|net::|Failed to load resource/);
  const page = await t.newPage(VP.desktop);
  await gotoRoute(page, '#/settings');
  await page.locator('.st-status').waitFor();
  await page.route('**/api/**', (route) => route.abort());
  await page.getByRole('button', { name: /Check again/ }).click();
  const alert = page.getByRole('alert').filter({ hasText: "Can't reach Conductor" });
  await alert.waitFor();
  const retry = alert.getByRole('button', { name: 'Retry now' });
  await retry.waitFor();
  await page.unroute('**/api/**');
  await retry.click();
  await alert.waitFor({ state: 'detached' });
});

// ---------------------------------------------------------------------------------------------- 9. new run
test('9 double-clicking Start creates exactly one run and opens its overview', async (t) => {
  const page = await t.newPage(VP.desktop);
  const before = (await api('/api/runs')).runs.length;
  await gotoRoute(page, '#/runs/new');
  const path_ = page.getByLabel('Folder', { exact: true });
  await path_.fill(DATA_DIR);
  await page.locator('.nr-ready').waitFor();
  await page.locator('summary', { hasText: 'Advanced: ticket limit' }).click();
  await page.getByLabel('Ticket limit').fill('5');
  const start = page.getByRole('button', { name: /^Start run on 5 tickets/ });
  await waitDisabled(start, false, 'Start enabled for a valid folder');
  await start.dblclick();
  await waitForHash(page, new RegExp('^#/runs/[0-9a-f]{8}$'));
  const id = (await hashOf(page)).split('/')[2];
  assert.notEqual(id, A.runId);
  await page.locator('.stat-grid').waitFor();
  await waitRunDone(id);
  const after = (await api('/api/runs')).runs;
  assert.equal(after.length, before + 1, 'exactly one new run after a double click');
  await removeRun(id);
  assert.equal((await api('/api/runs')).runs.length, before);
});

test('9 an invalid folder disables Start and says why', async (t) => {
  const page = await t.newPage(VP.desktop);
  await gotoRoute(page, '#/runs/new');
  const field = page.getByLabel('Folder', { exact: true });
  await field.fill('/definitely/not/a/dataset');
  await poll(async () => (await field.getAttribute('aria-invalid')) === 'true', { message: 'folder marked invalid' });
  const start = page.getByRole('button', { name: /^Start run/ });
  await waitDisabled(start, true, 'Start disabled');
  const reason = page.locator('.nr-reason');
  await reason.waitFor({ state: 'visible' });
  assert.ok((await reason.innerText()).trim().length > 5, 'a visible reason is shown next to the disabled Start button');
  assert.ok(await page.getByRole('alert').filter({ hasText: /not a folder|cannot be used/i }).first().isVisible());
});

test('9 a run in progress cannot be deleted (409), a finished one can', async () => {
  const { run_id } = await api('/api/runs', 'POST', { path: DATA_DIR, use_model: false }); // 100 tickets keep it busy for ~2s
  assert.equal(await apiStatus(`/api/runs/${run_id}`, 'DELETE'), 409, 'deleting an active run must be refused');
  await waitRunDone(run_id);
  assert.equal(await apiStatus(`/api/runs/${run_id}`, 'DELETE'), 200);
  assert.equal(await apiStatus(`/api/runs/${run_id}`), 404);
});

// ---------------------------------------------------------------------------------------------- 10. overview links
test('10 overview tiles and review rows link to the matching lists', async (t) => {
  const run = A.runId;
  const flagged = A.rows.filter((r) => (r.flags || []).length).length;
  const page = await t.newPage(VP.desktop);
  await gotoRoute(page, `#/runs/${run}`);
  const tiles = page.locator('.stat-grid');
  await tiles.waitFor();

  const flaggedTile = tiles.getByRole('link', { name: /Flagged/ });
  assert.equal(await flaggedTile.getAttribute('href'), `#/runs/${run}/tickets?flagged=1`);
  await flaggedTile.click();
  await waitForHash(page, `#/runs/${run}/tickets?flagged=1`);
  await page.locator('.tbl tbody tr[data-id]').first().waitFor();
  const ids = await rowIds(page);
  assert.equal(ids.length, flagged);
  assert.equal(ids.length, 3, 'the practice data has 3 flagged tickets');
  assert.ok(ids.every((id) => (A.rows.find((r) => r.ticket_id === id).flags || []).length > 0), 'only flagged rows are listed');

  await page.goBack();
  await waitForHash(page, `#/runs/${run}`);
  const drafts = tiles.getByRole('link', { name: /Draft replies/ });
  assert.equal(await drafts.getAttribute('href'), `#/runs/${run}/tickets?output=draft_reply`);
  await drafts.click();
  await waitForHash(page, `#/runs/${run}/tickets?output=draft_reply`);
  await page.locator('.tbl tbody tr[data-id]').first().waitFor();
  assert.equal((await rowIds(page)).length, A.rows.filter(isDraft).length);

  await page.goBack();
  await waitForHash(page, `#/runs/${run}`);
  const approved = page.getByRole('region', { name: 'Review progress' }).getByRole('link', { name: /^Approved/ });
  assert.equal(await approved.getAttribute('href'), `#/runs/${run}/review?tab=approved`);
  await approved.click();
  await waitForHash(page, `#/runs/${run}/review?tab=approved`);
  assert.equal(await page.getByRole('tab', { name: /^Approved/ }).getAttribute('aria-selected'), 'true');
});

// ---------------------------------------------------------------------------------------------- 11. review workflow
async function selectQueueItem(page, id) {
  await page.locator(`a.q-item[data-id="${id}"]`).click();
  await page.locator('.center-head h2').waitFor();
  await page.waitForFunction((tid) => document.querySelector('.center-head .meta .mono')?.textContent === `#${tid}`, id);
}
const actionBar = (page) => page.locator('.action-bar');
const approveButton = (page) => actionBar(page).getByRole('button', { name: /^Approve/ });
const replyBox = (page) => page.getByRole('textbox', { name: 'Reply body (editable)' });

test('11 review workflow: tab in the URL, approve, undo, send (simulated outbox) @1280', async (t) => {
  const run = await createRun();
  try {
    const rows = await ticketRows(run);
    const first = rows.find(isClean).ticket_id;
    const page = await t.newPage(VP.desktop);
    await gotoRoute(page, `#/runs/${run}/review`);
    await page.locator('a.q-item').first().waitFor();
    await waitForHash(page, new RegExp(`^#/runs/${run}/review/\\d+$`)); // the first ticket is selected automatically

    await page.getByRole('tab', { name: /^Approved/ }).click();
    await waitForHash(page, new RegExp(`[?&]tab=approved`));
    await page.reload();
    await page.getByRole('tab', { name: /^Approved/ }).waitFor();
    assert.equal(await page.getByRole('tab', { name: /^Approved/ }).getAttribute('aria-selected'), 'true', 'the selected tab survives a reload');
    assert.match(await hashOf(page), /tab=approved/);
    await page.getByRole('tab', { name: /^To review/ }).click();
    await waitForHash(page, new RegExp(`^#/runs/${run}/review/\\d+$`));

    await selectQueueItem(page, first);
    await page.keyboard.press('a'); // focus is on the page, not in a field
    await toastWith(page, `Approved #${first}`).getByRole('button', { name: 'Undo' }).waitFor();
    await page.locator(`a.q-item[data-id="${first}"]`).waitFor({ state: 'detached' }); // left "To review"
    await toastWith(page, `Approved #${first}`).getByRole('button', { name: 'Undo' }).click();
    await page.locator(`a.q-item[data-id="${first}"]`).waitFor();
    assert.equal((await api(`/api/runs/${run}/tickets/${first}`)).review.state, 'pending', 'undo restores the pending state');

    const outboxDir = path.join(stateDir, 'outbox');
    const emlBefore = fs.existsSync(outboxDir) ? fs.readdirSync(outboxDir).filter((f) => f.endsWith('.eml')).length : 0;
    await selectQueueItem(page, first);
    await approveButton(page).click();
    const send = actionBar(page).getByRole('button', { name: /Send reply/ });
    await send.waitFor();
    await send.click();
    const dlg = page.locator('dialog[open]');
    await dlg.getByRole('heading', { name: 'Send this reply?' }).waitFor();
    assert.match(await dlg.innerText(), /Simulated send/);
    await dlg.getByRole('button', { name: /Send \(simulated\)/ }).click();
    await actionBar(page).locator('.status', { hasText: /Sent/ }).waitFor();
    const detail = await api(`/api/runs/${run}/tickets/${first}`);
    assert.equal(detail.review.state, 'sent');
    const emls = fs.readdirSync(outboxDir).filter((f) => f.endsWith('.eml'));
    assert.equal(emls.length - emlBefore, 1, 'exactly one .eml was written');
    assert.ok(emls.some((f) => f.startsWith(`ticket-${first}-`)), `an outbox file for ticket ${first} exists (${emls})`);
  } finally { await removeRun(run).catch(() => {}); }
});

test('11 an edit that adds a link blocks Approve; autosave failure blocks it until Retry works @1280', async (t) => {
  t.allowErrors(/ERR_FAILED|net::|Failed to load resource/);
  const run = await createRun();
  try {
    const rows = await ticketRows(run);
    const id = rows.filter(isClean).map((r) => r.ticket_id)[2];
    const page = await t.newPage(VP.desktop);
    await gotoRoute(page, `#/runs/${run}/review`);
    await page.locator('a.q-item').first().waitFor();
    await selectQueueItem(page, id);
    const box = replyBox(page);
    await box.waitFor();
    const original = await box.inputValue();

    await box.fill(`${original}\nhttp://x.example`);
    await page.getByText(/adds: .*link/).waitFor();
    await waitDisabled(approveButton(page), true, 'Approve disabled while the edit adds a link');
    await box.fill(original);
    await page.getByText(/adds: .*link/).waitFor({ state: 'hidden' });
    await waitDisabled(approveButton(page), false, 'Approve enabled again');

    await page.route('**/review/*/draft', (route) => route.abort());
    await box.fill(`${original}\nsmall edit`);
    const flag = page.locator('.save-flag');
    await flag.getByText('Could not save').waitFor();
    await flag.getByRole('button', { name: 'Retry' }).waitFor();
    await waitDisabled(approveButton(page), true, 'Approve disabled while the edit is unsaved');
    await page.unroute('**/review/*/draft');
    await flag.getByRole('button', { name: 'Retry' }).click();
    await flag.getByText('Could not save').waitFor({ state: 'detached' });
    await waitDisabled(approveButton(page), false, 'Approve enabled after a successful Retry');
  } finally { await removeRun(run).catch(() => {}); }
});

test('11 on a phone the queue and the draft are separate pages with the action bar in view @360', async (t) => {
  const run = await createRun();
  try {
    const rows = await ticketRows(run);
    const id = rows.filter(isClean).map((r) => r.ticket_id)[3];
    const page = await t.newPage(VP.phone);
    await gotoRoute(page, `#/runs/${run}/review`);
    const queue = page.locator('section[aria-label="Review queue"]');
    const draft = page.locator('section[aria-label="Draft reply"]');
    await page.locator('a.q-item').first().waitFor();
    assert.ok(await queue.isVisible() && !(await draft.isVisible()), 'the queue page shows no draft');
    await page.locator(`a.q-item[data-id="${id}"]`).click();
    await waitForHash(page, new RegExp(`^#/runs/${run}/review/${id}`));
    await page.locator('.center-head h2').waitFor();
    assert.ok(await draft.isVisible() && !(await queue.isVisible()), 'the draft page hides the queue');
    const bar = await actionBar(page).boundingBox();
    const vh = VP.phone.height;
    assert.ok(bar && bar.y >= 0 && bar.y + bar.height <= vh + 1, `the action bar is not inside the viewport: ${JSON.stringify(bar)}`);
    await assertNoOverflow(page, 'review draft');
    await page.locator('a.crumb-back').click();
    await waitForHash(page, `#/runs/${run}/review`);
    await page.locator('a.q-item').first().waitFor();
    assert.ok(await queue.isVisible(), 'the topbar back link returns to the queue');
  } finally { await removeRun(run).catch(() => {}); }
});

// ---------------------------------------------------------------------------------------------- 12. settings + local model
const settingsPage = async (t, vp = VP.desktop) => {
  const page = await t.newPage(vp);
  await gotoRoute(page, '#/settings');
  await page.locator('.st-status').waitFor();
  return page;
};
const urlForm = (page) => page.locator('form', { has: page.getByLabel('Server address') });
const runTestButton = (page) => page.getByRole('button', { name: /Run test/ });
const modelOutput = (page) => page.locator('.st-out');
const runStatusLine = (page) => page.locator('.st-runstatus');

test('12 with nothing listening the page, sidebar and test console say the model is offline', async (t) => {
  if (await portInUse(11434)) { return; } // the default address answers on this machine: the premise does not hold
  const page = await settingsPage(t);
  await page.locator('.st-status', { hasText: 'Not connected' }).waitFor();
  await page.locator('a.side-model', { hasText: 'Local model offline' }).waitFor();
  await page.locator('.status-chip', { hasText: 'Local model offline' }).waitFor();
  await runTestButton(page).click();
  const err = page.locator('.st-errbox').getByRole('alert');
  await err.waitFor();
  await err.getByRole('button', { name: 'Try again' }).waitFor();
  await poll(async () => /Failed/.test(await runStatusLine(page).innerText()), { message: 'status line says Failed' });
  assert.equal(await page.locator('.st-result').innerText(), '', 'a failed test must not show a result');
  assert.doesNotMatch(await runStatusLine(page).innerText(), /Finished|success/i);
});

test('12 saving the fake server address connects, lists both models and updates the chips without a reload', async (t) => {
  try {
    const page = await settingsPage(t);
    await page.evaluate(() => { window.__noReload = true; });
    await page.getByLabel('Server address').fill(A.fake.url);
    await urlForm(page).getByRole('button', { name: 'Save' }).click();
    await page.locator('.st-status', { hasText: 'Connected' }).waitFor();
    await page.getByRole('radio', { name: /qwen3\.5:9b/ }).waitFor();
    await page.getByRole('radio', { name: /llama3\.2:3b/ }).waitFor();
    await page.locator('a.side-model', { hasText: 'Local model ready' }).waitFor();
    await page.locator('.status-chip', { hasText: 'qwen3.5:9b' }).waitFor();
    assert.ok(await page.evaluate(() => window.__noReload === true), 'the page must not have reloaded');

    await page.locator('label.st-model', { hasText: 'llama3.2:3b' }).click();
    await poll(async () => (await api('/api/settings')).model.model === 'llama3.2:3b', { message: 'selected model saved' });
    const s = (await api('/api/settings')).model;
    assert.equal(s.source.model, 'saved');
    assert.equal(s.url, A.fake.url);
    await page.locator('.status-chip', { hasText: 'llama3.2:3b' }).waitFor();
  } finally { await resetModelSettings(); }
});

test('12 the test console streams output, shows a result and uses the selected model', async (t) => {
  try {
    await configureModel({ url: A.fake.url, model: 'llama3.2:3b' });
    const page = await settingsPage(t);
    await page.locator('.st-status', { hasText: 'Connected' }).waitFor();
    await A.fake.reset();
    await runTestButton(page).click();
    await page.getByRole('button', { name: 'Stop' }).waitFor();
    await poll(async () => (await modelOutput(page).innerText()).length > 0, { message: 'first streamed text' });
    const n1 = (await modelOutput(page).innerText()).length;
    await sleep(300); // the one explicit sample interval: the output must keep growing while the model "writes"
    const n2 = (await modelOutput(page).innerText()).length;
    assert.ok(n2 > n1, `output did not grow between two reads 300ms apart (${n1} -> ${n2})`);
    await page.locator('.st-result').getByRole('heading', { name: 'Result' }).waitFor();
    await poll(async () => /Finished/.test(await runStatusLine(page).innerText()), { message: 'status line says Finished' });
    const chats = await A.fake.chats();
    assert.ok(chats.length >= 1, 'the fake received an /api/chat request');
    assert.ok(chats.every((c) => c.model === 'llama3.2:3b' && c.stream === true), `chat requests: ${JSON.stringify(chats)}`);
  } finally { await resetModelSettings(); }
});

test('12 "Try <other model>" tests that model without changing the selection', async (t) => {
  try {
    await configureModel({ url: A.fake.url, model: 'llama3.2:3b' });
    const page = await settingsPage(t);
    await page.locator('.st-status', { hasText: 'Connected' }).waitFor();
    await page.getByRole('combobox', { name: 'Model' }).selectOption({ label: 'Try qwen3.5:9b' });
    await A.fake.reset();
    await runTestButton(page).click();
    await poll(async () => /Finished/.test(await runStatusLine(page).innerText()), { timeout: 12000, message: 'test finished' });
    const chats = await A.fake.chats();
    assert.ok(chats.length >= 1 && chats.every((c) => c.model === 'qwen3.5:9b'), `chat requests: ${JSON.stringify(chats)}`);
    assert.equal((await api('/api/settings')).model.model, 'llama3.2:3b', 'the selected model is unchanged');
  } finally { await resetModelSettings(); }
});

test('12 Stop ends the test, shows "Stopped" and the upstream request is aborted', async (t) => {
  try {
    await configureModel({ url: A.fake.url, model: 'qwen3.5:9b' });
    const page = await settingsPage(t);
    await page.locator('.st-status', { hasText: 'Connected' }).waitFor();
    await A.fake.reset();
    await runTestButton(page).click();
    await poll(async () => (await modelOutput(page).innerText()).length > 0, { message: 'streaming started' });
    await page.getByRole('button', { name: 'Stop' }).click();
    await runTestButton(page).waitFor({ state: 'visible' });
    await page.getByText('Stopped.', { exact: true }).waitFor();
    assert.match(await runStatusLine(page).innerText(), /Stopped/);
    await poll(async () => (await A.fake.chats()).some((c) => c.aborted === true), { timeout: 5000, message: 'the fake sees the aborted request' });
  } finally { await resetModelSettings(); }
});

test('12 a non-local server address is refused inline and nothing is saved', async (t) => {
  t.allowErrors(/status of 400/); // the browser logs the rejected PUT
  try {
    await configureModel({ url: A.fake.url, model: 'qwen3.5:9b' });
    const page = await settingsPage(t);
    await page.locator('.st-status', { hasText: 'Connected' }).waitFor();
    const before = JSON.stringify(await api('/api/settings'));
    const field = page.getByLabel('Server address');
    await field.fill('http://example.com:11434');
    await urlForm(page).getByRole('button', { name: 'Save' }).click();
    await poll(async () => (await field.getAttribute('aria-invalid')) === 'true', { message: 'address marked invalid' });
    await urlForm(page).getByRole('alert').filter({ hasText: /on this computer/i }).waitFor();
    assert.equal(JSON.stringify(await api('/api/settings')), before, 'GET /api/settings must be unchanged');
    assert.equal(await field.inputValue(), 'http://example.com:11434', 'the typed value is kept');
  } finally { await resetModelSettings(); }
});

test('12 when the model server goes away Run test shows an error with "Try again" and keeps the text', async (t) => {
  const fake = await startFake();
  try {
    await configureModel({ url: fake.url, model: 'qwen3.5:9b' });
    const page = await settingsPage(t);
    await page.locator('.st-status', { hasText: 'Connected' }).waitFor();
    const area = page.getByLabel('Sample ticket text');
    await area.fill('Subject: Where is my payment\n\nPlease check INV-1 for me.');
    const typed = await area.inputValue();
    await fake.stop();
    await runTestButton(page).click();
    const err = page.locator('.st-errbox').getByRole('alert');
    await err.waitFor();
    await err.getByRole('button', { name: 'Try again' }).waitFor();
    assert.equal(await area.inputValue(), typed, 'the textarea text is unchanged by the error');
    await poll(async () => /Failed/.test(await runStatusLine(page).innerText()), { message: 'status line says Failed' });
  } finally { await fake.stop(); await resetModelSettings(); }
});

// ---------------------------------------------------------------------------------------------- 13. model selection reaches a run
test('13 the model chosen in Settings is the one a started run records and uses', async (t) => {
  const fake = await startFake({ fail: 'http500' }); // HTTP 500 on /api/chat: no reading is ever cached in out/.cache (see header)
  let runId = null;
  try {
    await configureModel({ url: fake.url, model: 'llama3.2:3b' });
    const page = await t.newPage(VP.desktop);
    await gotoRoute(page, '#/runs/new');
    const modelRadio = page.locator('#reader-model');
    await poll(async () => await modelRadio.isEnabled(), { message: 'the model reader option becomes available' });
    await page.getByLabel('Folder', { exact: true }).fill(DATA_DIR);
    await page.locator('.nr-ready').waitFor();
    await page.locator('label[for="reader-model"]').click();
    assert.ok(await modelRadio.isChecked(), 'Regex + local model is selected');
    await page.locator('summary', { hasText: 'Advanced: ticket limit' }).click();
    await page.getByLabel('Ticket limit').fill('3');
    await page.getByRole('button', { name: /^Start run on 3 tickets/ }).click();
    await waitForHash(page, new RegExp('^#/runs/[0-9a-f]{8}$'));
    runId = (await hashOf(page)).split('/')[2];
    await page.locator('.stat-grid').waitFor();
    await page.locator('.page-meta', { hasText: 'Regex + llama3.2:3b' }).waitFor();
    const run = await waitRunDone(runId);
    assert.equal(run.model, 'llama3.2:3b');
    assert.equal(run.use_model, true);
    await poll(async () => (await api('/api/model/status')).briefs_pending === 0, { timeout: 20000, message: 'background briefs finished' });
    const chats = await fake.chats();
    assert.ok(chats.every((c) => c.model === 'llama3.2:3b'), `every chat request used the selected model, got ${JSON.stringify(chats.map((c) => c.model))}`);
  } finally {
    await resetModelSettings();
    if (runId) await removeRun(runId).catch(() => {});
    await fake.stop();
  }
}, { timeout: 40000 });

// ---------------------------------------------------------------------------------------------- 14. accessibility basics
async function a11yAudit(page) {
  return page.evaluate(() => {
    const path = (el) => {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && n !== document.documentElement && parts.length < 4; n = n.parentElement) {
        parts.unshift(`${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ''}${n.classList.length ? `.${[...n.classList].slice(0, 2).join('.')}` : ''}`);
      }
      return parts.join(' > ');
    };
    const rendered = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]');
    const nameOf = (el) => {
      const label = el.getAttribute('aria-label');
      if (label && label.trim()) return label.trim();
      const by = el.getAttribute('aria-labelledby');
      if (by) { const t = by.split(/\s+/).map((i) => document.getElementById(i)?.textContent || '').join(' ').trim(); if (t) return t; }
      if (el.labels && el.labels.length) { const t = [...el.labels].map((l) => l.textContent).join(' ').trim(); if (t) return t; }
      if (el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA') { const t = (el.textContent || '').trim(); if (t) return t; }
      if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type) && el.value) return el.value;
      const title = el.getAttribute('title');
      return title && title.trim() ? title.trim() : '';
    };
    const out = { unnamed: [], svgs: [], mains: document.querySelectorAll('main').length, h1s: document.querySelectorAll('h1').length, tabindex: [] };
    for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea')) {
      if (rendered(el) && !nameOf(el)) out.unnamed.push(path(el));
    }
    for (const svg of document.querySelectorAll('svg')) {
      if (svg.getAttribute('aria-hidden') === 'true' || svg.closest('[aria-hidden="true"]')) continue;
      if (svg.getAttribute('role') === 'img' && (svg.getAttribute('aria-label') || svg.querySelector('title'))) continue;
      out.svgs.push(path(svg));
    }
    for (const el of document.querySelectorAll('[tabindex]')) if (Number(el.getAttribute('tabindex')) > 0) out.tabindex.push(path(el));
    return out;
  });
}

for (const vp of [VP.desktop, VP.phone]) {
  test(`14 accessibility basics on every route @${vp.width}`, async (t) => {
    const page = await t.newPage(vp);
    const problems = new Map(); // problem text -> routes it shows up on (shell-level problems repeat on every route)
    const report = (route, text) => problems.set(text, [...(problems.get(text) || []), route]);
    for (const r of routeTable()) {
      await gotoRoute(page, r.hash);
      await page.locator(`#main ${r.wait}`).first().waitFor({ state: 'attached' });
      const a = await a11yAudit(page);
      if (a.unnamed.length) report(r.name, `controls without an accessible name: ${[...new Set(a.unnamed)].slice(0, 5).join(' | ')}`);
      if (a.svgs.length) report(r.name, `icon svg without aria-hidden: ${[...new Set(a.svgs)].slice(0, 5).join(' | ')}`);
      if (a.mains !== 1) report(r.name, `${a.mains} <main> elements`);
      if (a.h1s !== 1) report(r.name, `${a.h1s} <h1> elements`);
      if (a.tabindex.length) report(r.name, `tabindex > 0 on ${a.tabindex.join(' | ')}`);

      // Tab from the very start of the page reaches the skip link first; Enter on it focuses <main>.
      await page.evaluate(() => { const b = document.body; b.setAttribute('tabindex', '-1'); b.focus(); b.removeAttribute('tabindex'); window.scrollTo(0, 0); });
      await page.keyboard.press('Tab');
      const first = await page.evaluate(() => ({ cls: document.activeElement?.className || '', text: document.activeElement?.textContent?.trim() || '' }));
      if (!/\bskip\b/.test(first.cls)) { report(r.name, `first Tab stop is "${first.text}" (${first.cls}), not the skip link`); continue; }
      await page.keyboard.press('Enter');
      if (!(await page.evaluate(() => document.activeElement === document.querySelector('main')))) report(r.name, 'Enter on the skip link did not focus <main>');
    }
    const lines = [...problems].map(([text, routes]) => `[${routes.join(', ')}] ${text}`);
    assert.ok(lines.length === 0, `accessibility problems:\n        ${lines.join('\n        ')}`);
  });
}

test('15 prevent page builds, approves and sends a notice; skip and undo; no overflow @1280 @360', async (t) => {
  const run = await createRun();
  try {
    const page = await t.newPage(VP.desktop);
    await gotoRoute(page, `#/runs/${run}/prevent`);
    await page.getByRole('heading', { name: 'Nothing built yet' }).waitFor();
    await page.getByRole('button', { name: 'Build from records' }).last().click();
    await page.getByText('Self-servable').waitFor();
    assert.match(await page.title(), /^Prevent · .+ · Conductor$/);

    const first = page.locator('.prevent-item[data-kind="notice"]').first();
    const key = await first.getAttribute('data-key');
    const item = page.locator(`.prevent-item[data-kind="notice"][data-key="${key}"]`);
    await item.getByRole('button', { name: 'Approve' }).click();
    await item.getByRole('button', { name: 'Send' }).click();
    await page.locator(`.prevent-item[data-key="${key}"][data-state="sent"]`).waitFor();
    assert.equal(await item.getByRole('button').filter({ hasText: /^(Approve|Send|Skip)$/ }).count(), 0, 'a sent notice has no actions');

    const second = page.locator('.prevent-item[data-kind="notice"][data-state="pending"]').first();
    const key2 = await second.getAttribute('data-key');
    await second.getByRole('button', { name: 'Skip' }).click();
    const skipped = page.locator(`.prevent-item[data-key="${key2}"][data-state="skipped"]`);
    await skipped.waitFor();
    await skipped.getByRole('button', { name: 'Undo skip' }).click();
    await page.locator(`.prevent-item[data-key="${key2}"][data-state="pending"]`).waitFor();

    assert.ok(await page.locator('.prevent-item[data-kind="digest"]').count() > 0, 'digests are listed');
    const st = await api(`/api/runs/${run}/prevention`);
    assert.equal(st.states[`notice:${key}`].state, 'sent');
    await assertNoOverflow(page, 'prevent @1280');

    await page.reload();
    await page.locator(`.prevent-item[data-key="${key}"][data-state="sent"]`).waitFor(); // state survives a reload

    const phone = await t.newPage(VP.phone);
    await gotoRoute(phone, `#/runs/${run}/prevent`);
    await phone.getByText('Self-servable').waitFor();
    await assertNoOverflow(phone, 'prevent @360');
  } finally {
    await removeRun(run);
  }
});

test('14 reduced motion switches toasts and spinners off @1280', async (t) => {
  const page = await t.newPage(VP.desktop);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const animations = (selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => [el.className, getComputedStyle(el).animationDuration]), selector);
  const assertFast = (rows, what) => {
    assert.ok(rows.length > 0, `no ${what} element was present to measure`);
    for (const [cls, d] of rows) {
      const worst = Math.max(...d.split(',').map((x) => parseFloat(x) * (/ms\s*$/.test(x) ? 0.001 : 1)));
      assert.ok(worst <= 0.01, `.${cls} animation-duration is ${d} under prefers-reduced-motion`);
    }
  };
  await gotoRoute(page, `#/runs/${A.runId}/review`);
  await page.locator('a.q-item').first().waitFor();
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('z'); // "Nothing to undo" raises a toast without changing any data
  await page.locator('.toast').first().waitFor();
  assertFast(await animations('.toast'), 'toast');

  // a spinner: hold the status request open while "Check again" is pending on Settings
  await gotoRoute(page, '#/settings');
  await page.locator('.st-status').waitFor();
  await page.route('**/api/model/status*', async (route) => { await sleep(1500); await route.continue().catch(() => {}); });
  await page.getByRole('button', { name: /Check again/ }).click();
  await page.locator('.spinner, .spinner-sm').first().waitFor();
  assertFast(await animations('.spinner, .spinner-sm, .skeleton, .dot-live'), 'spinner');
  await page.unroute('**/api/model/status*');
});

// ---------------------------------------------------------------------------------------------- repository hygiene (runs last)
const gitState = () => spawnSync('git', ['-C', REPO, 'status', '--short', '--untracked-files=all', '--', 'webapp/state', 'out'],
  { encoding: 'utf8' }).stdout;
let gitBefore = '';
test('git status shows nothing new under webapp/state or out', async () => {
  assert.equal(gitState(), gitBefore, 'files under webapp/state or out/ changed while the test ran');
});

// ================================================================================================ main
async function main() {
  const started = Date.now();
  gitBefore = gitState();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apdesk-ui-'));
  const results = [];
  try {
    A.port = await freePort();
    const env = cleanEnv();
    if (await portInUse(11434)) { // keep "nothing listening at the default address" true
      A.modelDeadPort = await freePort();
      env.OLLAMA_URL = `http://127.0.0.1:${A.modelDeadPort}`;
      console.log('note: something listens on 127.0.0.1:11434; the app is pointed at a closed port instead');
    }
    const app = startChild('ap-desk', ['webapp/server.py', '--port', String(A.port)], env);
    await waitHttp(BASE(), app);
    A.token = /name="ap-token" content="([^"]+)"/.exec(await (await fetch(BASE())).text())?.[1];
    assert.ok(A.token, 'could not read the ap-token from /');
    A.fake = await startFake();

    A.runId = await createRun();
    A.rows = (await ticketRows(A.runId)).sort((a, b) => a.seq - b.seq);
    assert.equal(A.rows.length, 100, 'the practice data should give 100 tickets');
    const known = A.rows.find((r) => r.ticket_id === 41259);
    assert.ok(known && isDraft(known), 'ticket 41259 should be a drafted reply in the practice data');

    try { browser = await chromium.launch(); } catch (e) {
      console.log(`skipped: Chromium could not be launched (${String(e.message).split('\n')[0]})`);
      return 0;
    }
    const only = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
    for (const t of tests.filter((x) => !only || only.test(x.name))) {
      if (shuttingDown) break;
      const r = await runOne(t);
      results.push({ name: t.name, ...r });
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${t.name}  (${(r.ms / 1000).toFixed(1)}s)`);
      if (!r.ok) console.log(`        ${shortError(r.error)}`);
    }
  } catch (e) {
    console.log(`FATAL: ${e?.stack || e}`);
    results.push({ name: 'harness setup', ok: false });
  } finally {
    await cleanup();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} tests, ${results.length - failed.length} passed, ${failed.length} failed in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  for (const f of failed) console.log(`  FAILED: ${f.name}`);
  return failed.length ? 1 : 0;
}

process.exitCode = await main();
