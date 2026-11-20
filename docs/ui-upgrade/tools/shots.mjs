#!/usr/bin/env node
/*
 * Screenshots of every Conductor page for the UI upgrade (not a test: it never fails on looks).
 *
 *   node docs/ui-upgrade/tools/shots.mjs <out-dir> [--widths 375,1440] [--only <regex>] [--port 8820] [--look a|b|c] [--full]
 *
 * Starts its own server (fresh temp state dir, outside the repo), signs people in over the API exactly as the smoke suite
 * does, and writes <out-dir>/<page>@<width>.jpg. Prints console errors per page and exits 1 if any page logged one.
 * Needs node_modules (playwright) resolvable from tests/ui: in a git worktree, symlink the main checkout's node_modules.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  chromium, setBrowser, startApp, apiAs, signInApi, vp, sleep, cleanup,
} from '../../../tests/ui/harness.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(`--${name}`);
const outDir = path.resolve(args[0] && !args[0].startsWith('--') ? args[0] : 'shots');
const widths = opt('widths', '375,1440').split(',').map(Number);
const only = opt('only') ? new RegExp(opt('only'), 'i') : null;
const port = Number(opt('port', 8820));
const look = opt('look');
const full = flag('full');
const lookQ = look ? `?look=${look}` : '';

fs.mkdirSync(outDir, { recursive: true });
const errorsByPage = {};

async function settle(page) {
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 8000 }).catch(() => {});
  await sleep(900); // entrances and fonts
}

async function shoot(page, name, width) {
  if (only && !only.test(name)) return;
  const file = path.join(outDir, `${name}@${width}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 78, fullPage: full });
  console.log(`  ${path.basename(file)}  ${Math.round(fs.statSync(file).size / 1024)} KB`);
}

async function contextFor(browser, width, session) {
  const ctx = await browser.newContext({ viewport: vp(width), deviceScaleFactor: 1 });
  if (session) {
    await ctx.addInitScript((s) => {
      try { if (!sessionStorage.getItem('__seeded')) { sessionStorage.setItem('conductor.session', s); sessionStorage.setItem('__seeded', '1'); } } catch { /* blocked */ }
    }, JSON.stringify(session));
  }
  return ctx;
}

function track(page, name) {
  page.on('console', (m) => { if (m.type() === 'error') (errorsByPage[name()] ||= []).push(m.text()); });
  page.on('pageerror', (e) => (errorsByPage[name()] ||= []).push(String(e.message)));
  return page;
}

async function main() {
  const app = await startApp({ port, label: 'shots' });
  const browser = await chromium.launch();
  setBrowser(browser);
  const ulla = await apiAs(app, 'ulla');
  const draft = (await ulla.get('/api/inbox/threads?queue=needs_reply')).json.rows.find((r) => r.outcome === 'draft_ready');
  const vapi = await apiAs(app, 'vendor');
  const inv = (await vapi.get('/api/direct/invoices')).json.rows.find((r) => r.status?.code === 'paid').invoice;

  for (const width of widths) {
    console.log(`@${width}`);
    let current = '';
    // ---- hub, signed out
    {
      const ctx = await contextFor(browser, width);
      const page = track(await ctx.newPage(), () => current);
      current = 'hub';
      await page.goto(`${app.base}/${lookQ}`);
      await page.getByRole('heading', { name: 'Orchestra staff' }).waitFor();
      await sleep(1200);
      await shoot(page, 'hub', width);
      current = 'hub-staff-picker';
      await page.getByRole('button', { name: 'Sign in with Microsoft' }).click();
      await page.getByRole('dialog').getByRole('button', { name: /Ulla Abernathy/ }).waitFor();
      await sleep(500);
      await shoot(page, 'hub-staff-picker', width);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' }).catch(() => {});
      current = 'hub-vendor';
      await page.getByRole('button', { name: 'Continue with Microsoft' }).click();
      await page.getByRole('dialog').getByLabel('Work email').waitFor();
      await sleep(500);
      await shoot(page, 'hub-vendor', width);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' }).catch(() => {});
      current = 'hub-code';
      await page.getByRole('region', { name: 'Sign in' }).getByRole('button', { name: 'Use a sign-in code instead' }).click();
      await sleep(500);
      await shoot(page, 'hub-code', width);
      // the handshake: sign in as Omar through the UI and catch it mid-way
      current = 'hub-handshake';
      await page.goto(`${app.base}/${lookQ}`);
      await page.getByRole('button', { name: 'Sign in with Microsoft' }).click();
      await page.getByRole('dialog').getByRole('button', { name: /Omar Calloway/ }).click();
      await sleep(700);
      await shoot(page, 'hub-handshake', width);
      await ctx.close();
    }
    // ---- staff pages
    const staff = [
      ['ulla', 'inbox', '#/inbox'],
      ['ulla', 'inbox-ticket', `#/inbox/${draft.ticket_id}`],
      ['ulla', 'ahead', '#/ahead'],
      ['ulla', 'vendor-setup', '#/vendor-setup'],
      ['ulla', 'settings', '#/settings'],
      ['ulla', 'styleguide', '#/styleguide'],
      ['ulla', 'not-found', '#/no-such-page'],
      ['elena', 'escalations', '#/escalations'],
      ['elena', 'team', '#/team'],
      ['elena', 'advanced', '#/settings/advanced'],
      ['ben', 'approver', '#/approver'],
    ];
    const ctxs = {};
    for (const [who, name, hash] of staff) {
      if (only && !only.test(name)) continue;
      if (!ctxs[who]) { ctxs[who] = await contextFor(browser, width, await signInApi(app, who)); }
      const page = track(await ctxs[who].newPage(), () => current);
      current = name;
      await page.goto(`${app.base}/app${hash}`, { waitUntil: 'domcontentloaded' });
      if (name === 'inbox') await page.getByRole('listbox', { name: 'Messages' }).getByRole('option').first().waitFor().catch(() => {});
      if (name === 'inbox-ticket') await page.getByRole('region', { name: 'What Conductor found' }).waitFor().catch(() => {});
      await settle(page);
      await shoot(page, name, width);
      await page.close();
    }
    for (const c of Object.values(ctxs)) await c.close();
    // ---- vendor dashboard
    {
      const ctx = await contextFor(browser, width, await signInApi(app, 'vendor'));
      for (const [name, hash] of [['direct-invoices', '#/invoices'], ['direct-invoice', `#/invoices/${encodeURIComponent(inv)}`], ['direct-messages', '#/messages'], ['direct-documents', '#/documents'], ['direct-updates', '#/updates']]) {
        if (only && !only.test(name)) continue;
        const page = track(await ctx.newPage(), () => current);
        current = name;
        await page.goto(`${app.base}/direct${hash}`, { waitUntil: 'domcontentloaded' });
        await settle(page);
        await shoot(page, name, width);
        await page.close();
      }
      await ctx.close();
    }
  }
  await cleanup();
  const bad = Object.entries(errorsByPage);
  for (const [p, errs] of bad) console.log(`CONSOLE ERRORS on ${p}:\n    ${[...new Set(errs)].slice(0, 4).join('\n    ')}`);
  return bad.length ? 1 : 0;
}

process.exitCode = await main().catch(async (e) => { console.log(`FATAL ${e?.stack || e}`); await cleanup(); return 2; });
