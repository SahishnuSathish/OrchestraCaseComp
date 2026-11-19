#!/usr/bin/env node
/*
 * Conductor browser smoke suite (Phase 3): the sign-in hub (/), the staff workspace (/app) and the vendor dashboard (/direct).
 *
 * Stories (the numbers match tests/ui/README.md):
 *   1  Hub: two ways in, staff account picker with titles, handshake, reload skips it, sign out
 *   2  Ulla's morning: "While you were away", a Draft ready ticket, evidence chips, Approve & send, write-back
 *   3  Sign-off: priority reply needs Request sign-off; Elena signs off in a second browser; Ulla sends
 *   4  Fraud: banner, no composer, no approve
 *   5  Approver: Ben lands on Waiting on you, disabled "Open in NetSuite", commits to a date
 *   6  Ahead: "Tell vendors before they ask.", impact numbers, estimate labels, self-serve lookups
 *   7  Vendor: SSO to /direct, status chips and no totals, a paid invoice's remittance, a question that reaches the inbox,
 *      the neutral failure, a vendor session kept out of /app
 *   8  W-9: upload as the vendor, the extraction with a mismatch as Ulla
 *   9  Live arrivals: Sync now, and arrivals on their own
 *   10 Advanced: import a tickets file, export, Ulla refused
 *   11 Every page at 375, 768, 1280 and 1440: no horizontal scroll, no console errors, no internal words; accessibility basics
 *
 * Run (from the repo root):   node tests/ui/smoke.mjs ["<regex>"]       (the regex keeps only tests whose name matches)
 * See tests/ui/README.md for prerequisites. Playwright missing => prints "skipped" and exits 0.
 *
 * Isolation: each run starts its own servers (ports 8808 and 8809) with CONDUCTOR_STATE_DIR in a fresh temp dir outside the
 * repository, so nothing is written to the tracked dashboards/conductor/state or out/. The default outbox mode writes the
 * .eml files into that temp dir; no mail is ever sent. A final test compares `git status` for those paths before and after.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  assert, chromium, setBrowser, REPO, DATA_DIR, W9_SAMPLES, DESKTOP, WIDTHS, vp, PORT_MAIN, PORT_LIVE,
  startApp, apiAs, rawApi, poll, sleep, test, tests, runOne, shortError, cleanup, shuttingDown,
  assertCleanPage, visibleText, a11yAudit, a11yProblems, waitForHash, pickThread, PEOPLE,
} from './harness.mjs';

const A = { main: null, live: null, question: null };
const gotoApp = async (page, hash = '') => { await page.goto(`${page.app.base}/app${hash}`, { waitUntil: 'domcontentloaded' }); await page.locator('main').first().waitFor({ state: 'attached' }); };
const gotoDirect = async (page, hash = '') => { await page.goto(`${page.app.base}/direct${hash}`, { waitUntil: 'domcontentloaded' }); await page.locator('main').first().waitFor({ state: 'attached' }); };
const readingPane = (page) => page.getByRole('region', { name: 'Reading pane' });
const details = (page) => page.getByRole('complementary', { name: 'Ticket details' });
const messageList = (page) => page.getByRole('listbox', { name: 'Messages' });
const openRow = (page, id) => messageList(page).getByRole('option').filter({ hasText: `#${id}` });
const reply = (page) => readingPane(page).getByRole('button', { name: 'Approve & send' });
const queueButton = (page, label) => page.getByRole('navigation', { name: 'Queues' }).getByRole('button', { name: new RegExp(`^${label}, \\d+ threads?`) });
const toast = (page, text) => page.locator('.c-toast', { hasText: text });
const QUEUE_ID = { 'Needs reply': 'needs_reply', 'Needs action': 'needs_action', Closed: 'closed' };
const QUEUE_OF = { draft_ready: 'Needs reply', action_needed: 'Needs action', no_reply: 'Closed' };

/** Wait for the inbox to have painted its rows (not the skeleton). */
async function inboxReady(page) { await messageList(page).getByRole('option').first().waitFor(); }

/** The evidence panel is a column from 1360 px up and the "Details" tab of the reading pane below that. */
async function openDetails(page) {
  const ev = details(page);
  if (!(await ev.isVisible())) await readingPane(page).getByRole('tab', { name: 'Details' }).click();
  await ev.waitFor();
  return ev;
}

async function hubVendorSignIn(page, { provider = 'Microsoft', email }) {
  await page.goto(`${page.app.base}/`);
  await page.getByRole('button', { name: `Continue with ${provider}` }).click();
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Next' }).click();
}

// ================================================================================================ 1. hub
test('1 hub: two ways in, staff picker with titles, handshake, reload skips it, sign out @1280', async (t) => {
  const page = await t.newPage(DESKTOP);
  page.app = A.main;
  await page.goto(`${A.main.base}/`);
  await page.getByRole('heading', { name: 'Orchestra staff' }).waitFor();
  await page.getByRole('heading', { name: 'Vendors & partners' }).waitFor();
  await page.getByRole('button', { name: 'Continue with Microsoft' }).waitFor();
  await page.getByRole('button', { name: 'Continue with Google' }).waitFor();
  const before = await visibleText(page);
  assert.ok(!/Dovetail|Quillfern|Bramblewick/.test(before), 'the hub must not show any vendor before sign-in');

  await page.getByRole('button', { name: 'Sign in with Microsoft' }).click();
  const dlg = page.getByRole('dialog');
  // titles are shown because first names repeat: two Elenas, different jobs
  await dlg.getByRole('button', { name: /Ulla Abernathy, Accounts Payable Specialist/ }).waitFor();
  await dlg.getByRole('button', { name: /Elena Lockhart, Chief Financial Officer/ }).waitFor();
  await dlg.getByRole('button', { name: /Elena Fairbanks, Research Director/ }).waitFor();
  await dlg.getByRole('button', { name: /Ben Merriweather/ }).waitFor();
  assert.equal(await dlg.getByRole('button', { name: /Farid Abernathy|Quinn Ellsworth/ }).count(), 0, 'people without a Conductor role must not be listed');
  assert.ok(/Accounts Payable Specialist/.test(await dlg.innerText()), 'the picker shows titles on screen');

  await dlg.getByRole('button', { name: /Ulla Abernathy/ }).click();
  await page.getByText('Signing in as Ulla Abernathy…').first().waitFor();          // the handshake
  await page.getByText(/Connecting Zendesk/).waitFor();
  await page.waitForURL(/\/app#\/inbox/, { timeout: 15000 });
  await inboxReady(page);

  // a reload stays signed in; coming back to / goes straight home without the handshake
  await page.reload();
  await inboxReady(page);
  await page.goto(`${A.main.base}/`);
  await page.waitForURL(/\/app#\/inbox/, { timeout: 8000 });
  assert.equal(await page.getByText(/Signing in as/).count(), 0, 'the handshake must be skipped when already signed in');

  // sign out returns to the hub and ends the session
  await page.getByRole('button', { name: /Ulla Abernathy/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL(`${A.main.base}/`, { timeout: 8000 });
  await page.getByRole('heading', { name: 'Orchestra staff' }).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('conductor.session')), null, 'the tab session is cleared');
  await page.goto(`${A.main.base}/app#/inbox`);
  await page.waitForURL(`${A.main.base}/`, { timeout: 8000 });
}, { timeout: 60000 });

// ================================================================================================ 2. Ulla's morning
test("2 Ulla's morning: away card, Draft ready ticket, insight and evidence, Approve & send with write-back @1280", async (t) => {
  const row = await pickThread(A.main, 'ulla', {
    queue: 'needs_reply', label: 'routine Draft ready thread',
    test: (r) => r.outcome === 'draft_ready' && !(r.flags || []).length && r.workflow_state === 'open' && r.sender_verified && (r.invoice_refs || []).length,
  });
  const summary = (await (await apiAs(A.main, 'ulla')).get('/api/inbox/summary')).json;
  const page = await t.pageAs('ulla');
  await gotoApp(page, '#/inbox');
  await inboxReady(page);

  const away = page.getByRole('region', { name: 'While you were away' });
  await away.waitFor();
  const awayText = await away.innerText();
  assert.match(awayText, new RegExp(`Conductor read ${summary.read} emails`));
  for (const re of [/\d+\s+drafts? ready/, /\d+\s+need action/, /\d+\s+need no reply/]) assert.match(awayText, re);
  assert.ok(Number(/(\d+)\s+drafts? ready/.exec(awayText)[1]) > 0, 'the away card shows real numbers');

  await queueButton(page, 'Needs reply').waitFor();
  await openRow(page, row.ticket_id).first().click();
  await waitForHash(page, `#/inbox/${row.ticket_id}`);
  const read = readingPane(page);
  await read.getByRole('heading', { name: row.subject }).waitFor();
  assert.ok((await read.innerText()).includes(`<${row.from_email}>`), 'the reading pane shows the sender address (From)');
  await read.getByText('To', { exact: true }).first().waitFor();
  const insight = read.getByRole('region', { name: 'What Conductor found' });
  await insight.waitFor();
  const insightText = await insight.innerText();
  for (const label of ['They want', 'Invoice matched', 'Records say', 'Sender', 'Why']) assert.ok(insightText.includes(label), `the insight strip has "${label}"`);

  const ev = await openDetails(page);
  await ev.getByText(/NetSuite · bill \d+/).first().waitFor();
  assert.ok(/Payment run RUN-20\d\d-\d\d-\d\d|NetSuite · vendor \d+/.test(await ev.innerText()), 'the evidence panel carries source chips');
  const closeDetails = ev.getByRole('button', { name: 'Close details' });
  if (await closeDetails.isVisible()) await closeDetails.click();      // go back to the message to act on it

  await reply(page).click();
  await toast(page, /Sent to/).first().waitFor();
  await toast(page, /Zendesk updated · Outlook Sent items/).first().waitFor();       // the write-back toast
  await openRow(page, row.ticket_id).waitFor({ state: 'detached' });                    // it left Needs reply
  await read.getByText(/Sent by Ulla Abernathy/).waitFor();
  await queueButton(page, 'Sent').click();
  await openRow(page, row.ticket_id).first().waitFor();
});

// ================================================================================================ 3. sign-off
test('3 sign-off: Request sign-off, Elena signs off in a second browser, Ulla sends; scheduling is refused before @1280', async (t) => {
  t.allowErrors(/409/);   // the refused schedule below is a 409 the browser logs
  const row = await pickThread(A.main, 'ulla', {
    queue: 'needs_reply', label: 'priority holding reply',
    test: (r) => ((r.flags || []).includes('legal') || (r.flags || []).includes('exec_cc')) && r.workflow_state === 'open',
  });
  const ulla = await t.pageAs('ulla');
  await gotoApp(ulla, `#/inbox/${row.ticket_id}`);
  const read = readingPane(ulla);
  await read.getByRole('heading', { name: row.subject }).waitFor();
  const request = read.getByRole('button', { name: 'Request sign-off' });
  await request.waitFor();
  assert.equal(await read.getByRole('button', { name: 'Approve & send' }).count(), 0, 'a priority reply never offers Approve & send to a specialist');

  await request.click();
  await ulla.getByRole('dialog').getByRole('button', { name: 'Request sign-off' }).click();
  await toast(ulla, 'Sign-off requested').first().waitFor();
  try {
    await read.getByText(/Waiting for Elena Lockhart to sign off/).first().waitFor({ timeout: 4000 });
  } catch {                       // intermittent product bug (see the next test): the pane stays stale until a reload
    console.log(`        note: #${row.ticket_id} still showed Request sign-off after the request went through; reloading (known stale-pane bug)`);
    await ulla.reload();
    await read.getByText(/Waiting for Elena Lockhart to sign off/).first().waitFor();
  }

  // before the sign-off, scheduling that reply is refused with the server's reason
  const api = await apiAs(A.main, 'ulla');
  const runId = (await api.get('/api/inbox/summary')).json.run_id;
  const sendAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sched = await api.post(`/api/runs/${runId}/tickets/${row.ticket_id}/schedule`, { send_at: sendAt });
  assert.equal(sched.status, 409, `scheduling a priority reply before sign-off must be refused (got ${sched.status})`);
  assert.ok(String(sched.json?.detail || '').trim().length > 8, `the refusal carries the server's reason (${sched.text.slice(0, 80)})`);

  // Elena, in her own browser context
  const elena = await t.pageAs('elena');
  await gotoApp(elena, '#/escalations');
  const esc = elena.getByRole('link', { name: new RegExp(`#${row.ticket_id}\\b`) });
  await esc.waitFor();
  assert.ok(/Sign-off requested/.test(await esc.innerText()), 'Escalations lists the request');
  await esc.click();
  await elena.getByText('The exact text you sign off.').waitFor();
  await elena.getByRole('button', { name: 'Sign off', exact: true }).click();
  await toast(elena, /Signed off/).first().waitFor();

  // Ulla's open thread updates live; fall back to a reload, which the contract also allows
  try {
    await reply(ulla).waitFor({ timeout: 12000 });
  } catch {
    console.log(`        note: #${row.ticket_id} did not update live in Ulla's tab within 12s; reloading`);
    await ulla.reload();
    await reply(ulla).waitFor();
  }
  await read.getByText(/Signed off by Elena Lockhart/).waitFor();
  await reply(ulla).click();
  await toast(ulla, /Sent to/).first().waitFor();
  await read.getByText(/Sent by Ulla Abernathy/).waitFor();
}, { timeout: 70000 });

test('3 sign-off: the Schedule button on a priority reply is refused in the page, and Request sign-off still repaints the thread after it @1280', async (t) => {
  t.allowErrors(/409/);
  const row = await pickThread(A.main, 'ulla', {
    queue: 'needs_reply', label: 'second priority holding reply',
    test: (r) => ((r.flags || []).includes('legal') || (r.flags || []).includes('exec_cc')) && r.workflow_state === 'open',
  });
  const ulla = await t.pageAs('ulla');
  await gotoApp(ulla, `#/inbox/${row.ticket_id}`);
  const read = readingPane(ulla);
  await read.getByRole('button', { name: 'Request sign-off' }).waitFor();
  await read.getByRole('button', { name: 'Schedule' }).click();
  const refusal = read.getByRole('alert').filter({ hasText: /sign-off/i }).first();
  await refusal.waitFor();
  assert.match(await refusal.innerText(), /CFO's sign-off/, "the page shows the server's reason");
  await read.getByRole('button', { name: 'Request sign-off' }).click();
  await ulla.getByRole('dialog').getByRole('button', { name: 'Request sign-off' }).click();
  await toast(ulla, 'Sign-off requested').first().waitFor();
  // the thread should now say it is waiting for Elena (this is where the pane stays stale)
  await read.getByText(/Waiting for Elena Lockhart to sign off/).first().waitFor({ timeout: 5000 });
}, { known: 'After a refused Schedule on a priority reply, Request sign-off succeeds (toast, server state signoff_requested) but the reading pane does not repaint: it keeps showing Request sign-off and Schedule, and no "Waiting for Elena Lockhart to sign off" notice, until the page is reloaded (views/inbox.js).' });

// ================================================================================================ 4. fraud
test('4 fraud: banner, no composer, no approve @1280', async (t) => {
  t.allowErrors(/4\d\d/);   // the API cross-check below is a refused request
  const row = await pickThread(A.main, 'ulla', {
    queue: 'needs_action', label: 'fraud ticket', test: (r) => (r.flags || []).includes('fraud') && r.workflow_state === 'open',
  });
  const page = await t.pageAs('ulla');
  await gotoApp(page, `#/inbox/${row.ticket_id}`);
  const read = readingPane(page);
  const banner = read.getByRole('alert').filter({ hasText: /Possible fraud/ });
  await banner.waitFor();
  assert.match(await banner.innerText(), /Nothing on this ticket can be approved or sent/);
  assert.equal(await read.getByRole('region', { name: 'Reply' }).count(), 0, 'no reply composer on a fraud ticket');
  assert.equal(await read.getByRole('textbox').count(), 0, 'no text box to write a reply in');
  assert.equal(await read.getByRole('button', { name: /^(Approve|Send)/ }).count(), 0, 'no approve or send button');
  await read.getByRole('region', { name: 'Internal note' }).waitFor();
  // the server agrees: a specialist cannot approve it either
  const api = await apiAs(A.main, 'ulla');
  const runId = (await api.get('/api/inbox/summary')).json.run_id;
  const r = await api.put(`/api/runs/${runId}/review/${row.ticket_id}`, { state: 'approved' });
  assert.ok(r.status >= 400 && r.status < 500, `approving a fraud ticket must be refused (got ${r.status})`);
});

// ================================================================================================ 5. approver
test('5 approver: Ben lands on Waiting on you, NetSuite link disabled, commits to a date, cannot approve bills @1280', async (t) => {
  const page = await t.pageAs('ben');
  await page.goto(`${page.app.base}/`);                       // signed in: the hub sends him home
  await page.waitForURL(/\/app#\/approver/, { timeout: 8000 });
  await page.getByRole('heading', { name: 'Waiting on you', level: 1 }).waitFor();
  const links = page.getByRole('link', { name: /in NetSuite/ });
  await links.first().waitFor();
  assert.ok(await links.count() >= 1, 'bills offer Open in NetSuite');
  for (const aria of await links.evaluateAll((els) => els.map((e) => e.getAttribute('aria-disabled')))) assert.equal(aria, 'true', 'Open in NetSuite is disabled');
  assert.equal(await page.getByRole('button', { name: /\bapprove\b/i }).count(), 0, 'there is no approve-bill button');
  assert.equal(await page.getByRole('link', { name: 'Inbox', exact: true }).count(), 0, 'an approver has no inbox in the rail');

  await page.getByRole('button', { name: /^Commit to an approval date for/ }).first().click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Approval date').fill('2026-11-20');
  await dlg.getByRole('button', { name: 'Save date' }).click();
  await toast(page, /Committed to Nov 20/).first().waitFor();
  await page.getByText('Committed to Nov 20').first().waitFor();

  // the server keeps him out of the inbox and the vendor routes
  const api = await apiAs(A.main, 'ben');
  assert.equal((await api.get('/api/inbox/queues')).status, 403);
  assert.equal((await api.get('/api/direct/invoices')).status, 403);
  // the date is internal: the vendor's own data never carries it
  const v = await apiAs(A.main, 'vendor');
  assert.ok(!/approver|commit/i.test((await v.get('/api/direct/invoices')).text), 'vendor invoice data has no approver or commitment');
});

// ================================================================================================ 6. ahead
test('6 ahead: promise, impact numbers, estimate labels, self-serve lookups apart, one-invoice walkthrough @1280', async (t) => {
  const ulla = await t.pageAs('ulla');
  await gotoApp(ulla, '#/ahead');
  await ulla.getByRole('heading', { name: 'Tell vendors before they ask.', level: 1 }).waitFor();
  assert.ok(/Conductor: Ahead/.test(await ulla.getByRole('main').innerText()), 'the page is named Conductor: Ahead');
  await ulla.getByText(/tickets prevented/).first().waitFor();
  const text = await ulla.getByRole('main').innerText();
  assert.match(text, /\d+\s+tickets prevented/, 'impact shows how many tickets were prevented');
  assert.match(text, /Estimated hours saved\s+[\d.]+/, 'hours saved is labelled as an estimate');
  assert.ok(/an estimate/i.test(text.slice(text.indexOf('Estimated hours saved'))), 'the hours figure says it is an estimate');
  assert.match(text, /15 minutes/, 'the estimate states its 15 minutes per ticket basis');
  await ulla.getByRole('tab', { name: 'See it on one invoice' }).waitFor();
  await ulla.getByRole('tab', { name: 'Approver digests' }).waitFor();

  // Elena (CFO) sees self-serve lookups on a line of their own, not folded into tickets prevented
  const elena = await t.pageAs('elena');
  await gotoApp(elena, '#/ahead');
  await elena.getByText('Self-serve lookups').first().waitFor();
  const prevented = await elena.getByText(/tickets prevented/).first().locator('xpath=ancestor::*[contains(@class,"stat")][1]').innerText().catch(() => '');
  assert.ok(!/lookup/i.test(prevented), 'self-serve lookups are not part of the tickets-prevented figure');
  await elena.getByRole('tab', { name: 'See it on one invoice' }).click();
  await elena.getByRole('heading', { name: 'See it on one invoice' }).first().waitFor();
});

test('6 ahead: self-serve lookups are visible to an AP specialist too @1280', async (t) => {
  const ulla = await t.pageAs('ulla');
  await gotoApp(ulla, '#/ahead');
  await ulla.getByText(/tickets prevented/).first().waitFor();
  await ulla.getByText('Self-serve lookups').first().waitFor({ timeout: 4000 });
}, { known: 'Ahead hides the Self-serve lookups line from AP specialists: views/ahead.js fills it from GET /api/team/overview, which is CFO-only, although /api/inbox/summary already returns self_serve_lookups to staff.' });

// ================================================================================================ 7. vendor
test('7 vendor: Microsoft SSO by email lands on /direct, status chips, no totals @1280', async (t) => {
  const page = await t.newPage(DESKTOP);
  page.app = A.main;
  await page.goto(`${A.main.base}/`);
  await page.getByRole('button', { name: 'Continue with Microsoft' }).click();
  // email first: nothing about any vendor is shown before an address is typed
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Work email').waitFor();
  assert.ok(!/Dovetail|Quillfern|Bramblewick|Greywater/.test(await dlg.innerText()), 'no vendor is listed before an email is entered');
  await dlg.getByLabel('Work email').fill(PEOPLE.vendor.email);
  await dlg.getByRole('button', { name: 'Next' }).click();
  await dlg.getByRole('button', { name: /Continue as/ }).click();
  await page.waitForURL(/\/direct/, { timeout: 10000 });

  await page.getByRole('heading', { name: 'Invoices', level: 1 }).waitFor();
  const table = page.getByRole('table', { name: 'Your invoices' });
  const rows = table.locator('tbody tr');
  await rows.first().waitFor();
  const n = await rows.count();
  assert.ok(n >= 5, `the vendor's invoice list shows rows (${n})`);
  const chip = /^(Received|Awaiting internal approval|Approved, typically paid within 5 to 10 business days|Scheduled for payment on .+|Payment sent .+|Paid .+|Under review.*)$/;
  const figures = new Set();
  for (let i = 0; i < n; i += 1) {
    const cells = (await rows.nth(i).getByRole('cell').allInnerTexts()).map((c) => c.trim());
    assert.ok(cells.some((c) => chip.test(c)), `row ${i} has a plain-language status chip, cells: ${JSON.stringify(cells)}`);
    cells.filter((c) => /^\$[\d,]+\.\d\d$/.test(c)).forEach((c) => figures.add(c));
  }
  await page.getByText(/Source: Orchestra accounts payable records/).first().waitFor();

  // no totals, no counts across invoices, no sums
  const body = (await page.getByRole('main').innerText()).replace(/All statuses/g, '');
  assert.ok(!/\btotals?\b|subtotal|\boutstanding\b|\bin all\b|\ball invoices\b/i.test(body), 'no totals wording on the home page');
  assert.ok(!/\b\d[\d,]*\s+(open\s+|unpaid\s+|paid\s+)?invoices?\b/i.test(body), 'no "N invoices" counts on the home page');
  assert.ok(!/\b(showing|of)\s+\d+\b/i.test(body), 'no counts such as "Showing 25 of 40"');
  for (const m of body.match(/\$[\d,]+\.\d\d/g) || []) assert.ok(figures.has(m), `${m} on the home page is not one invoice's own amount (a sum?)`);

  // the search narrows the list without introducing any figure
  await page.getByLabel('Search by invoice number').fill('INV-16896');
  await page.getByRole('link', { name: 'INV-16896', exact: true }).first().waitFor();
  assert.ok(!/\b\d+\s+(results?|invoices?)\b/i.test(await page.getByRole('main').innerText()), 'filtering adds no result count');
});

test('7 vendor: a paid invoice shows its remittance and Download PDF; asking a question confirms @1280', async (t) => {
  const page = await t.pageAs('vendor');
  const api = await apiAs(A.main, 'vendor');
  const paid = (await api.get('/api/direct/invoices')).json.rows.find((r) => r.status?.code === 'paid');
  assert.ok(paid, 'the vendor has a paid invoice');
  await gotoDirect(page, `#/invoices/${encodeURIComponent(paid.invoice)}`);
  await page.getByRole('heading', { level: 1, name: new RegExp(paid.invoice) }).waitFor();
  await page.getByText(/^Paid /).first().waitFor();
  await page.getByText('Remittance advice').first().waitFor();
  const dl = page.getByRole('button', { name: /^Download .*PDF/ });
  await dl.waitFor();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), dl.click()]);
  const file = await download.path();
  assert.ok(String(download.suggestedFilename()).toLowerCase().endsWith('.pdf'), `downloaded file is a PDF (${download.suggestedFilename()})`);
  assert.equal(fs.readFileSync(file).subarray(0, 4).toString(), '%PDF', 'the download starts with %PDF');
  await page.getByRole('region', { name: 'Progress' }).waitFor();
  assert.ok(!/approver|committed|#\d{5}/i.test(await page.getByRole('main').innerText()), 'the vendor sees no internal names or ticket ids');

  // ask a question: a confirmation appears
  await page.getByLabel('Your question').fill(`Can you confirm the remittance reference for ${paid.invoice}?`);
  await page.getByRole('button', { name: 'Send question' }).click();
  await page.getByText('Thanks. Our team will reply here and by email.').first().waitFor();
  await page.getByText(/A person on our team will check the answer before it is sent/).first().waitFor();
  A.question = { invoice: paid.invoice };
});

test('7 vendor: the question reaches the staff inbox from "Conductor: Direct" (Sync or reload) @1280', async (t) => {
  assert.ok(A.question, 'the vendor question test must run first');
  const ulla = await t.pageAs('ulla');
  const api = await apiAs(A.main, 'ulla');
  const found = await poll(async () => {
    for (const queue of ['needs_reply', 'needs_action']) {
      const hit = (await api.get(`/api/inbox/threads?queue=${queue}`)).json.rows.find((x) => x.subject?.includes(A.question.invoice) && x.source === 'Conductor: Direct');
      if (hit) return { hit, queue };
    }
    return null;
  }, { timeout: 8000, message: 'the vendor question to appear in the inbox API' });
  await gotoApp(ulla, '#/inbox');
  await inboxReady(ulla);
  await ulla.reload();                                    // "Sync or reload": the list is reloaded from the server
  await inboxReady(ulla);
  if (found.queue !== 'needs_reply') await queueButton(ulla, 'Needs action').click();
  const row = openRow(ulla, found.hit.ticket_id).first();
  await row.waitFor();
  assert.ok((await row.innerText()).includes('Conductor: Direct'), 'the row names its source, Conductor: Direct');
  await row.click();
  await readingPane(ulla).getByText('Conductor: Direct').first().waitFor();
});

test('7 vendor: an unknown email gets the neutral message and nothing about who is on file @1280', async (t) => {
  t.allowErrors(/401/);
  const page = await t.newPage(DESKTOP);
  page.app = A.main;
  await hubVendorSignIn(page, { provider: 'Google', email: 'nobody@nowhere-vendor.example' });
  const dlg = page.getByRole('dialog');
  await dlg.getByText("We couldn't sign you in with that account.").waitFor();
  assert.ok(!/not on file|no account|unknown|not found|doesn.t exist/i.test(await dlg.innerText()), 'the failure does not say whether the address is on file');
  assert.equal(new URL(page.url()).pathname, '/', 'still on the hub');
  const r = await rawApi(A.main, '/api/session/sso', { method: 'POST', body: { kind: 'vendor', provider: 'google', email: 'nobody@nowhere-vendor.example' } });
  assert.equal(r.status, 401);
  assert.equal(r.json?.detail, "We couldn't sign you in with that account.");
});

test('7 vendor: a vendor session is sent away from the staff workspace @1280', async (t) => {
  const page = await t.pageAs('vendor');
  await page.goto(`${page.app.base}/app#/inbox`);
  await page.waitForURL(/\/direct/, { timeout: 10000 });
  await page.getByRole('heading', { name: 'Invoices', level: 1 }).waitFor();
  assert.equal(await messageList(page).count(), 0, 'no inbox is shown to a vendor');
  const api = await apiAs(A.main, 'vendor');
  for (const p of ['/api/inbox/queues', '/api/inbox/summary', '/api/runs', '/api/workflow/escalations', '/api/approver/queue', '/api/w9/queue']) {
    assert.equal((await api.get(p)).status, 403, `vendor on ${p}`);
  }
  const staff = await apiAs(A.main, 'ulla');                  // and the reverse: a staff session cannot read Direct
  assert.equal((await staff.get('/api/direct/invoices')).status, 403);
});

// ================================================================================================ 8. W-9
test('8 W-9: the vendor uploads a mismatching W-9 and sees Under review; Ulla sees the extraction with a mismatch @1280', async (t) => {
  const file = path.join(W9_SAMPLES, 'w9_dovetail_lane_printing_name_mismatch.pdf');
  assert.ok(fs.existsSync(file), `sample W-9 missing: ${file}`);
  const vendor = await t.pageAs('vendor');
  await gotoDirect(vendor, '#/documents');
  await vendor.getByRole('heading', { name: 'Documents & W-9', level: 1 }).waitFor();
  await vendor.locator('input[type=file]').setInputFiles(file);
  await vendor.getByText(path.basename(file)).first().waitFor();
  await vendor.getByRole('button', { name: 'Upload W-9' }).click();
  await vendor.getByText('Under review', { exact: true }).first().waitFor({ timeout: 15000 });
  await vendor.getByText(/Thanks\. Our team is reviewing your W-9/).first().waitFor();

  const ulla = await t.pageAs('ulla');
  await gotoApp(ulla, '#/vendor-setup');
  await ulla.getByRole('heading', { name: 'Vendor setup', level: 1 }).waitFor();
  const link = ulla.getByRole('link', { name: /Dovetail Lane Printing/ });
  await link.waitFor();
  assert.ok(/Upload to review/.test(await link.innerText()), 'the vendor shows an upload to review');
  await link.click();
  const card = ulla.getByRole('main');
  await card.getByText('Fields read from the W-9 compared with our record').waitFor();
  await card.getByText('Dovetail Print and Design Group LLC').first().waitFor();       // what the W-9 says
  await card.getByText('Differs', { exact: true }).first().waitFor();                  // the mismatch mark
  const text = await card.innerText();
  assert.ok(/XXX-XX-\d{4}/.test(text) && !/\b\d{3}-\d{2}-\d{4}\b/.test(text), 'a TIN shows only its last four digits');
  await card.getByRole('button', { name: 'Mark verified' }).waitFor();
  await card.getByRole('button', { name: 'Request W-9' }).waitFor();
}, { timeout: 60000 });

// ================================================================================================ 9. live arrivals
test('9 live arrivals: Sync now brings a new row in at the top @1280', async (t) => {
  const api = await apiAs(A.main, 'ulla');
  const before = (await api.get('/api/inbox/summary')).json;
  assert.ok(before.held_back > 0, `held-back tickets remain for Sync now (${before.held_back})`);
  const page = await t.pageAs('ulla');
  await gotoApp(page, '#/inbox');
  await inboxReady(page);
  const resp = page.waitForResponse((r) => r.url().includes('/api/inbox/sync') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Sync now' }).click();
  const arrived = (await (await resp).json()).arrived;
  assert.equal(arrived.length, 1, 'Sync now brings one ticket in');
  const id = arrived[0];
  // the row appears (first "Reading…", then its outcome), in whichever queue its outcome puts it
  await poll(async () => (await api.get('/api/inbox/summary')).json.held_back === before.held_back - 1, { message: 'held_back to drop by one' });
  const thread = (await api.get(`/api/inbox/threads/${id}`)).json;
  const queue = QUEUE_OF[thread.outcome] || 'Needs reply';
  await queueButton(page, queue).click();
  await openRow(page, id).first().waitFor();
  // the list is newest first by the real instant (received_at mixes "Z" dataset times and local-offset arrival times)
  const rows = (await api.get(`/api/inbox/threads?queue=${QUEUE_ID[queue]}`)).json.rows;
  const newest = rows.reduce((a, b) => (Date.parse(b.received_at) > Date.parse(a.received_at) ? b : a));
  const first = (await messageList(page).getByRole('option').first().innerText()).replace(/\s+/g, ' ');
  assert.ok(first.includes(`#${newest.ticket_id}`), `the newest thread #${newest.ticket_id} (${newest.received_at}) should be first in ${queue}; the top row is: ${first.slice(0, 90)}; the API's first row is #${rows[0].ticket_id} (${rows[0].received_at})`);
  if (newest.ticket_id === id) assert.equal(rows[0].ticket_id, id, `the new arrival #${id} is the newest thread, so it must be first`);
}, { known: 'Depends on the time of day: threads are sorted by comparing received_at as text, and an arrival is stamped with the app clock in a local offset (for example 10:54:50-06:00) while dataset rows end in Z (for example 11:05:00Z), so an arrival made before 11:05 local time lands below older tickets.' });

test('9 live arrivals: held-back tickets also arrive on their own, and the open inbox shows them @1280', async (t) => {
  A.live = await startApp({ port: PORT_LIVE, cadence: [2, 3], label: 'live' });
  const api = await apiAs(A.live, 'ulla');
  const start = (await api.get('/api/inbox/summary')).json;
  assert.ok(start.held_back >= 2, `held back at the start: ${start.held_back}`);
  const ids = async () => {
    const out = new Set();
    for (const q of ['needs_reply', 'needs_action', 'closed']) (await api.get(`/api/inbox/threads?queue=${q}`)).json.rows.forEach((r) => out.add(r.ticket_id));
    return out;
  };
  const known = await ids();
  const page = await t.pageAs('ulla', DESKTOP, A.live);
  await gotoApp(page, '#/inbox');
  await inboxReady(page);
  const arrivedId = await poll(async () => { for (const id of await ids()) if (!known.has(id)) return id; return null; }, { timeout: 25000, interval: 500, message: 'a held-back ticket to arrive by itself' });
  const thread = (await api.get(`/api/inbox/threads/${arrivedId}`)).json;
  await queueButton(page, QUEUE_OF[thread.outcome] || 'Needs reply').click();
  await openRow(page, arrivedId).first().waitFor({ timeout: 10000 });
}, { timeout: 90000 });

// ================================================================================================ 10. advanced (stretch path)
test('10 advanced: Elena imports a tickets file and exports; Ulla is refused @1280', async (t) => {
  t.allowErrors(/403/);
  const elena = await t.pageAs('elena');
  await gotoApp(elena, '#/settings/advanced');
  await elena.getByRole('heading', { name: /Import a (mailbox export|tickets file)/ }).waitFor();
  await elena.getByRole('heading', { name: /Batch runs and export|Export/ }).first().waitFor();
  await elena.getByRole('button', { name: /Import and process/ }).waitFor();

  // the stretch path through the page's own session: import data/tickets.json, wait for the run, export it
  const call = (method, pathname, body) => elena.evaluate(async ({ method, pathname, body }) => {
    const s = JSON.parse(sessionStorage.getItem('conductor.session') || 'null');
    const r = await fetch(pathname, { method, headers: { 'x-ap-token': document.querySelector('meta[name="ap-token"]').content, 'x-conductor-session': s.session, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, text: await r.text() };
  }, { method, pathname, body });
  const imp = await call('POST', '/api/admin/import', { path: path.join(DATA_DIR, 'tickets.json') });
  assert.equal(imp.status, 200, `import answered ${imp.status}: ${imp.text.slice(0, 160)}`);
  const runId = JSON.parse(imp.text).run_id;
  assert.ok(runId, 'import returns a run id');
  await poll(async () => {
    const run = JSON.parse((await call('GET', `/api/runs/${runId}`)).text);
    if (['failed', 'cancelled', 'interrupted'].includes(run.status)) throw new Error(`run ended as ${run.status}: ${run.error}`);
    return run.status === 'done';
  }, { timeout: 45000, interval: 400, message: 'the imported run to finish' });
  const exp = await call('GET', `/api/admin/export?run_id=${runId}&scope=all`);
  assert.equal(exp.status, 200);
  const out = JSON.parse(exp.text);
  assert.ok(out.team, 'the export has a team');
  assert.equal(out.results.length, 100, 'the export has 100 results');
  assert.ok(out.results.every((r) => r.output_type), 'every result has an output_type');
  await elena.reload();                                                  // the run shows in the Advanced page's table
  await elena.getByRole('heading', { name: /Import a (mailbox export|tickets file)/ }).waitFor();
  await elena.getByRole('button', { name: /^Export every result of/ }).first().waitFor();

  // Ulla is refused: in the page and on the API
  const ulla = await t.pageAs('ulla');
  await gotoApp(ulla, '#/settings/advanced');
  await ulla.getByText('Only the CFO can open Advanced.').waitFor();
  assert.equal(await ulla.getByRole('button', { name: /Import and process/ }).count(), 0, 'no import control for a specialist');
  const api = await apiAs(A.main, 'ulla');
  assert.equal((await api.post('/api/admin/import', { path: path.join(DATA_DIR, 'tickets.json') })).status, 403);
  assert.equal((await api.get('/api/admin/export')).status, 403);
}, { timeout: 100000 });

// ================================================================================================ 11. every page, four widths
const staffPages = (draftId) => [
  ['ulla', 'inbox', '#/inbox'],
  ['ulla', 'inbox ticket', `#/inbox/${draftId}`],
  ['ulla', 'ahead', '#/ahead'],
  ['ulla', 'vendor setup', '#/vendor-setup'],
  ['ulla', 'connections', '#/settings'],
  ['elena', 'escalations', '#/escalations'],
  ['elena', 'team', '#/team'],
  ['elena', 'advanced', '#/settings/advanced'],
  ['ben', 'approver', '#/approver'],
];
const directPages = (inv) => [
  ['invoices', '#/invoices'],
  ['invoice', `#/invoices/${encodeURIComponent(inv)}`],
  ['messages', '#/messages'],
  ['documents', '#/documents'],
  ['updates', '#/updates'],
];
async function settle(page) {
  await page.locator('h1').first().waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 8000 }).catch(() => {});
  await sleep(150);
}

for (const width of WIDTHS) {
  test(`11 every page: no horizontal scroll, no console errors, no internal words @${width}`, async (t) => {
    const view = vp(width);
    const api = await apiAs(A.main, 'ulla');
    const draft = (await api.get('/api/inbox/threads?queue=needs_reply')).json.rows.find((r) => r.outcome === 'draft_ready');
    const vapi = await apiAs(A.main, 'vendor');
    const inv = (await vapi.get('/api/direct/invoices')).json.rows.find((r) => r.status?.code === 'paid').invoice;

    // the hub, signed out
    const hub = await t.newPage(view);
    hub.app = A.main;
    await hub.goto(`${A.main.base}/`);
    await hub.getByRole('heading', { name: 'Orchestra staff' }).waitFor();
    await assertCleanPage(hub, `hub @${width}`);
    await hub.getByRole('button', { name: 'Sign in with Microsoft' }).click();
    await hub.getByRole('dialog').getByRole('button', { name: /Ulla Abernathy/ }).waitFor();
    await assertCleanPage(hub, `hub staff picker @${width}`);
    await hub.keyboard.press('Escape');
    await hub.getByRole('button', { name: 'Continue with Microsoft' }).click();
    await hub.getByRole('dialog').getByLabel('Work email').waitFor();
    await assertCleanPage(hub, `hub vendor sign-in @${width}`);

    // staff and approver pages, one browser context per person
    const pages = {};
    for (const [who, label, hash] of staffPages(draft.ticket_id)) {
      pages[who] ||= await t.pageAs(who, view);
      const page = pages[who];
      await gotoApp(page, hash);
      if (label === 'inbox') await inboxReady(page);
      else if (label === 'inbox ticket') await readingPane(page).getByRole('region', { name: 'What Conductor found' }).waitFor();
      else await settle(page);
      await assertCleanPage(page, `${label} @${width}`);
    }
    // the vendor dashboard
    const v = await t.pageAs('vendor', view);
    for (const [label, hash] of directPages(inv)) {
      await gotoDirect(v, hash);
      await settle(v);
      await assertCleanPage(v, `direct ${label} @${width}`);
    }
  }, { timeout: 120000 });
}

test('11 accessibility basics on the main pages @1280', async (t) => {
  const draft = (await (await apiAs(A.main, 'ulla')).get('/api/inbox/threads?queue=needs_reply')).json.rows.find((r) => r.outcome === 'draft_ready');
  const problems = new Map();
  const report = (route, text) => problems.set(text, [...(problems.get(text) || []), route]);
  const audit = async (page, route) => { for (const p of a11yProblems(await a11yAudit(page))) report(route, p); };

  const hub = await t.newPage(DESKTOP);
  await hub.goto(`${A.main.base}/`);
  await hub.getByRole('heading', { name: 'Orchestra staff' }).waitFor();
  await audit(hub, 'hub');
  await hub.getByRole('button', { name: 'Sign in with Microsoft' }).click();
  const dlg = hub.getByRole('dialog');
  await dlg.getByRole('button', { name: /Ulla Abernathy/ }).waitFor();
  await audit(hub, 'hub picker');
  assert.equal(await dlg.getByRole('searchbox', { name: 'Filter accounts' }).count() + await dlg.getByRole('textbox', { name: 'Filter accounts' }).count(), 1, 'the picker filter has a label');

  const ulla = await t.pageAs('ulla');
  for (const [route, hash] of [['inbox', '#/inbox'], ['ticket', `#/inbox/${draft.ticket_id}`], ['ahead', '#/ahead'], ['vendor setup', '#/vendor-setup'], ['settings', '#/settings']]) {
    await gotoApp(ulla, hash);
    if (route === 'inbox') await inboxReady(ulla);
    else if (route === 'ticket') await readingPane(ulla).getByRole('region', { name: 'What Conductor found' }).waitFor();
    else await settle(ulla);
    await audit(ulla, route);
    // the skip link is the first Tab stop and moves focus to <main>
    await ulla.evaluate(() => { const b = document.body; b.setAttribute('tabindex', '-1'); b.focus(); b.removeAttribute('tabindex'); window.scrollTo(0, 0); });
    await ulla.keyboard.press('Tab');
    const first = await ulla.evaluate(() => ({ cls: document.activeElement?.className || '', text: document.activeElement?.textContent?.trim() || '' }));
    if (!/skip/i.test(first.cls + first.text)) { report(route, `first Tab stop is "${first.text}", not the skip link`); continue; }
    await ulla.keyboard.press('Enter');
    if (!(await ulla.evaluate(() => document.activeElement === document.querySelector('main')))) report(route, 'Enter on the skip link did not focus <main>');
  }
  const elena = await t.pageAs('elena');
  for (const [route, hash] of [['escalations', '#/escalations'], ['team', '#/team'], ['advanced', '#/settings/advanced']]) { await gotoApp(elena, hash); await settle(elena); await audit(elena, route); }
  const ben = await t.pageAs('ben');
  await gotoApp(ben, '#/approver'); await settle(ben); await audit(ben, 'approver');
  const v = await t.pageAs('vendor');
  for (const [route, hash] of [['direct invoices', '#/invoices'], ['direct documents', '#/documents'], ['direct messages', '#/messages']]) { await gotoDirect(v, hash); await settle(v); await audit(v, route); }

  const lines = [...problems].map(([text, routes]) => `[${routes.join(', ')}] ${text}`);
  assert.ok(lines.length === 0, `accessibility problems:\n        ${lines.join('\n        ')}`);
}, { timeout: 120000 });

// ---------------------------------------------------------------------------------------------- repository hygiene (runs last)
const gitState = () => spawnSync('git', ['-C', REPO, 'status', '--short', '--untracked-files=all', '--', 'dashboards/conductor/state', 'out'], { encoding: 'utf8' }).stdout;
let gitBefore = '';
test('git status shows nothing new under dashboards/conductor/state or out', async () => {
  assert.equal(gitState(), gitBefore, 'files under dashboards/conductor/state or out/ changed while the test ran');
});

// ================================================================================================ main
async function main() {
  const started = Date.now();
  gitBefore = gitState();
  const results = [];
  try {
    A.main = await startApp({ port: PORT_MAIN, label: 'main' });
    try { setBrowser(await chromium.launch()); } catch (e) {
      console.log(`skipped: Chromium could not be launched (${String(e.message).split('\n')[0]})`);
      return 0;
    }
    const only = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
    for (const tst of tests.filter((x) => !only || only.test(x.name) || /^git status/.test(x.name))) {
      if (shuttingDown) break;
      const r = await runOne(tst, { app: A.main });
      const known = !r.ok && tst.opts.known;
      results.push({ name: tst.name, ...r, known });
      console.log(`${r.ok ? 'PASS' : known ? 'KNOWN' : 'FAIL'}  ${tst.name}  (${(r.ms / 1000).toFixed(1)}s)`);
      if (!r.ok) console.log(`        ${shortError(r.error)}`);
      if (r.ok && tst.opts.known) console.log(`        note: marked as a known product bug but it passed; remove the "known" option (${tst.opts.known.slice(0, 60)}...)`);
    }
  } catch (e) {
    console.log(`FATAL: ${e?.stack || e}`);
    results.push({ name: 'harness setup', ok: false });
  } finally {
    await cleanup();
  }
  const failed = results.filter((r) => !r.ok);
  const unexpected = failed.filter((r) => !r.known);
  console.log(`\n${results.length} tests, ${results.length - failed.length} passed, ${failed.length} failed in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  for (const f of failed) console.log(`  ${f.known ? 'KNOWN BUG' : 'FAILED'}: ${f.name}${f.known ? `\n      ${f.known}` : ''}`);
  if (failed.length && !unexpected.length) console.log('  (every failure above is a documented product bug)');
  return unexpected.length ? 1 : 0;
}

process.exitCode = await main();
