/*
 * Shared harness for the Conductor browser smoke suite (tests/ui/smoke.mjs).
 *
 * - loads Playwright (prints "skipped" and exits 0 when it is not installed)
 * - starts Conductor servers on fixed ports with a fresh temp state dir each (outside the repo)
 * - signs people in over the API and hands tests a page that is already signed in as that person
 * - the test() registry, the per-test runner (console errors fail a test) and the PASS/FAIL output
 * - layout, accessibility and "no internal words" checks shared by the stories
 */
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export { assert };

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const DATA_DIR = path.join(REPO, 'data');
export const W9_SAMPLES = path.join(REPO, 'dashboards', 'conductor', 'seed', 'w9', 'samples');

// ------------------------------------------------------------------------------------------------ playwright
export let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.log('skipped: Playwright is not installed (npm install playwright && npx playwright install chromium)');
  process.exit(0);
}

export const WIDTHS = [375, 768, 1280, 1440];
export const vp = (width) => ({ width, height: width <= 480 ? 800 : width < 1000 ? 1024 : 900 });
export const DESKTOP = vp(1280);
export const TEST_TIMEOUT = 40000;

export const PORT_MAIN = Number(process.env.UI_PORT_MAIN) || 8808;   // the main server: every story but the background-arrival one
export const PORT_LIVE = Number(process.env.UI_PORT_LIVE) || 8809;   // a second server whose background arrivals run quickly

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ people (CONTRACTS section 1)
export const PEOPLE = {
  ulla: { kind: 'staff', email: 'ulla.abernathy@orchestra-mock.example', name: 'Ulla Abernathy' },
  omar: { kind: 'staff', email: 'omar.calloway@orchestra-mock.example', name: 'Omar Calloway' },
  elena: { kind: 'staff', email: 'elena.lockhart@orchestra-mock.example', name: 'Elena Lockhart' },
  ben: { kind: 'staff', email: 'ben.merriweather@orchestra-mock.example', name: 'Ben Merriweather' },
  vendor: { kind: 'vendor', provider: 'microsoft', email: 'billing@dovetaillaneprinti.example', name: 'Zane Vandermeer', company: 'Dovetail Lane Printing' },
};

// ------------------------------------------------------------------------------------------------ processes
const children = new Set();
const stateDirs = [];
export let browser = null;
export const setBrowser = (b) => { browser = b; };

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
export function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

export async function waitHttp(url, child, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`process exited early (${child.exitCode}): ${child.tail()}`);
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${url}: ${child.tail()}`);
    await sleep(150);
  }
}

// The python that runs the server: CONDUCTOR_PYTHON, then python3, then python (on Windows "python3" is often only a Store stub).
let pythonCmd = null;
export function python() {
  if (pythonCmd) return pythonCmd;
  const candidates = [process.env.CONDUCTOR_PYTHON, 'python3', 'python', 'py'].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'import fastapi, uvicorn'], { encoding: 'utf8' });
    if (r.status === 0) { pythonCmd = c; return c; }
  }
  throw new Error(`no python with fastapi and uvicorn found (tried ${candidates.join(', ')}). Set CONDUCTOR_PYTHON.`);
}

function startChild(label, args, env) {
  const child = spawn(python(), args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

let cleanupPromise = null;
export let shuttingDown = false;
export function cleanup() {
  cleanupPromise ||= (async () => {
    try { await Promise.race([browser?.close(), sleep(5000)]); } catch { /* ignore */ }
    await Promise.all([...children].map(stopChild));
    for (const d of stateDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
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
process.on('exit', () => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of stateDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

/**
 * startApp({ port, cadence }) -> an app handle { port, token, base, state, proc }.
 * A fresh state dir under the OS temp folder, never inside the repository. `cadence` ([lo, hi] seconds) is written into
 * the new state DB before the server starts: the default 30 to 90 s keeps held-back tickets arriving on their own, which
 * would make "Sync now" unpredictable, so the main server waits an hour between arrivals.
 */
export async function startApp({ port, cadence = [3600, 3600], label = 'app' } = {}) {
  if (await portInUse(port)) throw new Error(`port ${port} is already in use`);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), `conductor-ui-${label}-`));
  stateDirs.push(state);
  const seed = spawnSync(python(), ['-c', [
    'import sqlite3, sys, json',
    'con = sqlite3.connect(sys.argv[1] + "/app.db")',
    'con.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)")',
    'con.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", ("inbox.cadence", json.dumps(json.loads(sys.argv[2]))))',
    'con.commit(); con.close()',
  ].join('\n'), state, JSON.stringify(cadence)], { encoding: 'utf8' });
  assert.equal(seed.status, 0, `could not seed the state DB: ${seed.stderr}`);
  const env = { ...process.env, CONDUCTOR_STATE_DIR: state, AP_DESK_STATE_DIR: state, PYTHONDONTWRITEBYTECODE: '1' };
  delete env.OLLAMA_URL; delete env.OLLAMA_MODEL; delete env.ORCHESTRA_MAIL_MODE;   // the default outbox mode: .eml files in the state dir
  const proc = startChild(label, ['dashboards/conductor/server.py', '--port', String(port)], env);
  const base = `http://127.0.0.1:${port}`;
  await waitHttp(`${base}/`, proc);
  const token = /name="ap-token" content="([^"]+)"/.exec(await (await fetch(`${base}/app`)).text())?.[1];
  assert.ok(token, 'could not read the ap-token from /app');
  const app = { port, base, token, state, proc, label };
  return app;
}

// ------------------------------------------------------------------------------------------------ API helpers (setup and cross-checks only; stories drive the UI)
export async function rawApi(app, pathname, { method = 'GET', body, session } = {}) {
  const res = await fetch(`${app.base}${pathname}`, {
    method,
    headers: {
      'x-ap-token': app.token,
      ...(session ? { 'x-conductor-session': session } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, ok: res.ok, json, text };
}

export async function signInApi(app, who) {
  const p = PEOPLE[who];
  const body = p.kind === 'vendor' ? { kind: 'vendor', provider: p.provider, email: p.email } : { kind: 'staff', email: p.email };
  const r = await rawApi(app, '/api/session/sso', { method: 'POST', body });
  assert.equal(r.status, 200, `API sign-in as ${who} answered ${r.status}: ${r.text.slice(0, 120)}`);
  return r.json;
}

/** An API client signed in as `who` (a new session each call). api.get/post/put return { status, json }. */
export async function apiAs(app, who) {
  const answer = await signInApi(app, who);
  const call = (method) => (pathname, body) => rawApi(app, pathname, { method, body, session: answer.session });
  return { answer, get: call('GET'), post: call('POST'), put: call('PUT'), del: call('DELETE') };
}

export async function poll(fn, { timeout = 10000, interval = 100, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error(`timed out waiting for ${message}${last instanceof Error ? ` (${last.message})` : ''}`);
    await sleep(interval);
  }
}

// ------------------------------------------------------------------------------------------------ page helpers
export async function assertNoOverflow(page, label = '') {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  if (m.sw > m.cw) {
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && e.getClientRects().length)
      .slice(0, 4).map((e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').slice(0, 2).join('.') : '') + ' right=' + Math.round(e.getBoundingClientRect().right)));
    assert.fail(`horizontal overflow${label ? ` (${label})` : ''}: scrollWidth ${m.sw} > clientWidth ${m.cw}; wide: ${wide.join(' | ')}`);
  }
}

/** Wait until a hash route matches (string or RegExp). */
export async function waitForHash(page, expected, timeout = 8000) {
  const isRe = expected instanceof RegExp;
  try {
    await page.waitForFunction(([exp, re, flags]) => (re ? new RegExp(exp, flags).test(location.hash) : location.hash === exp),
      [isRe ? expected.source : expected, isRe, isRe ? expected.flags : ''], { timeout });
  } catch {
    throw new Error(`expected URL hash ${expected}, but it is ${await page.evaluate(() => location.hash)}`);
  }
}

// Words that must not appear in any visible text. Email addresses and domains (orchestra-mock.example, mailbox-mock.example)
// are removed first, and so is the dataset's own subsidiary name "Mock Agency East/West/Studio" (vendors.csv, shown only
// to staff in the evidence panel: record data, not product copy).
export const BAD_WORDS = /\b(demo|prototype|mock|test)\b/i;
export function internalWords(text) {
  const cleaned = String(text)
    .replace(/\S*@\S*/g, ' ')
    .replace(/\b[\w.-]*\.(example|test|invalid|localhost)\b/gi, ' ')
    .replace(/\borchestra-mock\b/gi, ' ')
    .replace(/\bMock Agency (East|West|Studio)\b/g, ' ');
  const hits = [];
  for (const line of cleaned.split('\n')) { const m = BAD_WORDS.exec(line); if (m) hits.push(line.trim().slice(0, 100)); }
  return hits;
}

export async function visibleText(page) {
  return page.evaluate(() => document.body.innerText);
}

/** The page-level checks every page gets at every width: no horizontal scroll and no internal words. */
export async function assertCleanPage(page, label) {
  await assertNoOverflow(page, label);
  const hits = internalWords(await visibleText(page));
  assert.deepEqual(hits, [], `${label}: visible text with an internal word: ${JSON.stringify(hits.slice(0, 3))}`);
}

export async function a11yAudit(page) {
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
    const out = { unnamed: [], svgs: [], mains: document.querySelectorAll('main').length, h1s: document.querySelectorAll('h1').length, tabindex: [], title: document.title };
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

/** Problems from a11yAudit as readable lines (empty when the page is fine). */
export function a11yProblems(a) {
  const out = [];
  if (a.unnamed.length) out.push(`controls without an accessible name: ${[...new Set(a.unnamed)].slice(0, 5).join(' | ')}`);
  if (a.svgs.length) out.push(`icon svg without aria-hidden: ${[...new Set(a.svgs)].slice(0, 5).join(' | ')}`);
  if (a.mains !== 1) out.push(`${a.mains} <main> elements`);
  if (a.h1s !== 1) out.push(`${a.h1s} <h1> elements`);
  if (a.tabindex.length) out.push(`tabindex > 0 on ${a.tabindex.join(' | ')}`);
  if (!a.title || !a.title.trim()) out.push('empty document title');
  return out;
}

// axe-core (wcag2a + wcag2aa). Returns null when axe-core is not installed, so the caller can skip with a note.
const AXE_PATH = path.join(REPO, 'node_modules', 'axe-core', 'axe.min.js');
export const axeAvailable = () => fs.existsSync(AXE_PATH);
export async function axeRun(page) {
  // a dialog or page that is still fading in would be measured against blended colours: let every animation finish first
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null)))).catch(() => {});
  await sleep(150);
  if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 4).map((n) => `${n.target.join(' ')} :: ${(n.failureSummary || '').split(String.fromCharCode(10)).slice(1, 3).join(' ').trim().slice(0, 220)}`) }));
  });
}

// ------------------------------------------------------------------------------------------------ test registry and runner
export const tests = [];
/** test(name, fn, { timeout, known }) - `known` is the text of a product bug this test is expected to hit (reported as KNOWN, not as a regression). */
export function test(name, fn, opts = {}) { tests.push({ name, fn, opts }); }

export async function runOne(t, ctxApps) {
  const started = Date.now();
  const ctxs = [];
  const errors = [];
  const allowed = [];
  const pagesSeen = [];
  const track = (page) => {
    pagesSeen.push(page);
    page.setDefaultTimeout(8000);
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console error: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`uncaught page error: ${e.message}`));
    return page;
  };
  const env = {
    ...ctxApps,
    track,
    /** A context with no session. */
    async newPage(viewport = DESKTOP, ctxOpts = {}) {
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true, ...ctxOpts });
      ctxs.push(ctx);
      return track(await ctx.newPage());
    },
    /** A page (in its own browser context, so its own tab session) already signed in as `who`. Returns the page; page.signin is the API answer. */
    async pageAs(who, viewport = DESKTOP, app = ctxApps.app, ctxOpts = {}) {
      const answer = await signInApi(app, who);
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true, ...ctxOpts });
      ctxs.push(ctx);
      await ctx.addInitScript((s) => {
        try { if (!sessionStorage.getItem('__seeded')) { sessionStorage.setItem('conductor.session', s); sessionStorage.setItem('__seeded', '1'); } } catch { /* storage blocked */ }
      }, JSON.stringify(answer));
      const page = track(await ctx.newPage());
      page.signin = answer;
      page.app = app;
      return page;
    },
    allowErrors(...patterns) { allowed.push(...patterns); },
  };
  const limit = t.opts.timeout || TEST_TIMEOUT;
  let timer;
  try {
    await Promise.race([
      t.fn(env),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${limit / 1000}s`)), limit); }),
    ]);
    const bad = errors.filter((e) => !allowed.some((p) => (p instanceof RegExp ? p.test(e) : e.includes(p))));
    if (bad.length) throw new Error(`browser reported errors:\n        ${[...new Set(bad)].slice(0, 4).join('\n        ')}`);
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    // a screenshot of every page the test opened, in the OS temp folder (never in the repo), for working out what went wrong
    if (process.env.UI_SHOTS) {
      const dir = path.join(os.tmpdir(), 'conductor-ui-failures');
      fs.mkdirSync(dir, { recursive: true });
      for (const [i, p] of pagesSeen.entries()) {
        try { await p.screenshot({ path: path.join(dir, `${t.name.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}-${i}.png`) }); } catch { /* page gone */ }
      }
    }
    return { ok: false, ms: Date.now() - started, error: e };
  } finally {
    clearTimeout(timer);
    for (const c of ctxs) { try { await c.close(); } catch { /* ignore */ } }
  }
}

export function shortError(e) {
  return String(e?.message || e).split('\n').filter((l) => !/^\s*(at |- waiting|=+ logs)/.test(l)).slice(0, 6).join('\n        ');
}

// ------------------------------------------------------------------------------------------------ choosing tickets
// The tests never hard-code which ticket is which: they ask the API for a thread that fits the story and remember it,
// so a story never reuses a ticket another story already changed.
const taken = new Set();
export async function pickThread(app, who, { queue, test: fits, label }) {
  const api = await apiAs(app, who);
  const r = await api.get(`/api/inbox/threads?queue=${queue}`);
  assert.equal(r.status, 200, `threads?queue=${queue} answered ${r.status}`);
  const row = (r.json.rows || []).find((x) => !taken.has(x.ticket_id) && fits(x));
  assert.ok(row, `no ${label || 'matching'} thread in the ${queue} queue`);
  taken.add(row.ticket_id);
  return row;
}
