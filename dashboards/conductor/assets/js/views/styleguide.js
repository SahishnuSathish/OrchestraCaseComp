// Style guide (#/styleguide, CFO only, not in the rail). The live catalogue of every token and component.
// Wave-2 workers build from what is shown here: import from ../components/index.js and use the c- classes.
import { h, icon, mount as fill } from '../lib.js';
import {
  lockup, mark, PRODUCTS, button, iconButton, setBusy, field, checkbox, badge, outcomeBadge, riskBadges, contactBadge, statusBadge,
  chip, sourceChip, dot, avatar, table, stat, timeline, skeletonRows, skeletonText, reading, empty, notice, pane, split, tabs,
  menu, modal, toast, progress, directShell,
} from '../components/index.js';
import { setTicketTabs, onTicketTabClose, notify } from '../shell.js';

const SECTIONS = [
  ['products', 'Products'], ['color', 'Color'], ['type', 'Type'], ['shape', 'Shape, depth, motion'], ['buttons', 'Buttons'],
  ['badges', 'Badges and chips'], ['avatars', 'Avatars'], ['fields', 'Fields'], ['tabs', 'Tabs'], ['overlays', 'Menus, modals, toasts'],
  ['table', 'Table'], ['stats', 'Stat tiles'], ['timeline', 'Timeline'], ['loading', 'Loading'], ['empty', 'Empty and notices'],
  ['panes', 'Panes and splits'], ['shell', 'Shell hooks'], ['direct', 'Direct frame'],
];

const PRIMITIVES = [
  ['Ink', '--p-ink'], ['Grey 800', '--p-grey-800'], ['Grey 600', '--p-grey-600'], ['Grey 500', '--p-grey-500'], ['Grey 450', '--p-grey-450'],
  ['Grey 300', '--p-grey-300'], ['Paper', '--p-paper'], ['White', '--p-white'],
  ['Orchestra green', '--p-green-900'], ['Green 600', '--p-green-600'], ['Mint', '--p-mint'],
  ['Navy', '--p-navy-900'], ['Sky', '--p-sky'], ['Slate', '--p-slate'], ['Peach', '--p-peach'], ['Crimson', '--p-crimson'],
];
const SEMANTIC = [
  ['Surfaces', [['canvas', '--color-canvas'], ['surface', '--color-surface'], ['surface-subtle', '--color-surface-subtle'], ['surface-selected', '--color-surface-selected'], ['border', '--color-border'], ['border-input', '--color-border-input']]],
  ['Text and action', [['text', '--color-text', '15.9:1'], ['text-secondary', '--color-text-secondary', '7.5:1'], ['text-muted', '--color-text-muted', '5.7:1'], ['link', '--color-link', '8.9:1'], ['action', '--color-action', '13.6:1'], ['focus', '--color-focus']]],
  ['Status (meaning only)', [['settled', '--color-settled'], ['scheduled', '--color-scheduled'], ['waiting', '--color-waiting'], ['risk', '--color-risk']]],
  ['Chrome', [['chrome (Conductor)', '--color-chrome'], ['chrome-highlight', '--color-chrome-highlight'], ['direct (Direct)', '--color-direct'], ['ahead (Ahead)', '--color-ahead']]],
];
const BILLS = [
  { bill: '50000', ref: 'INV-95020', vendor: 'Thistledown Staffing', date: 'Oct 1, 2026', due: 'Nov 15, 2026', amount: 4180.33, status: { code: 'paid', label: 'Paid Oct 15' } },
  { bill: '50001', ref: 'INV-18529', vendor: 'Fernhollow Photo', date: 'Oct 5, 2026', due: 'Nov 19, 2026', amount: 29262.63, status: { code: 'paid', label: 'Paid Nov 12' } },
  { bill: '50002', ref: 'A-77386', vendor: 'Marrowgate Consulting', date: 'Oct 2, 2026', due: 'Nov 1, 2026', amount: 857.24, status: { code: 'scheduled', label: 'Scheduled Nov 19' } },
  { bill: '50003', ref: '2026-1186', vendor: 'Priya Halvorsen', date: 'Oct 11, 2026', due: 'Oct 26, 2026', amount: 503.11, status: { code: 'pending_approval', label: 'Awaiting approval' } },
  { bill: '50004', ref: 'AT44305', vendor: 'Amberline Transcription', date: 'Oct 3, 2026', due: 'Oct 18, 2026', amount: 1216.94, status: { code: 'under_review', label: 'Under review' } },
];

const section = (id, title, intro, ...kids) => h('section', { class: 'sg-section', id: `sg-${id}`, 'aria-labelledby': `sg-${id}-h` },
  h('header', { class: 'sg-section-head' }, h('h2', { id: `sg-${id}-h` }, title), intro ? h('p', null, intro) : null), ...kids);
const specimen = (label, ...kids) => h('div', { class: 'sg-specimen' }, h('p', { class: 'sg-label' }, label), h('div', { class: 'sg-row' }, ...kids));
const code = (text) => h('code', { class: 'sg-code' }, text);

function swatch(name, varName, note) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return h('div', { class: 'sg-swatch' },
    h('span', { class: 'sg-chip', style: { background: `var(${varName})` } }),
    h('span', { class: 'sg-swatch-text' }, h('strong', null, name), h('span', { class: 'mono' }, varName), h('span', { class: 'mono' }, value + (note ? ` · ${note} on white` : ''))));
}

function productsSection() {
  return section('products', 'Products', 'One family, three products. Each lockup pairs the mark with the Orchestra name. Taglines are plain, never hype.',
    h('div', { class: 'sg-products' }, Object.entries(PRODUCTS).map(([id, p]) => h('div', { class: `sg-product sg-product-${id}` },
      h('div', { class: 'sg-product-dark' }, lockup({ product: id, tone: 'dark' })),
      h('div', { class: 'sg-product-light' }, lockup({ product: id, tone: 'light' }),
        h('p', { class: 'sg-tagline' }, p.tagline),
        h('div', { class: 'sg-row' }, mark({ product: id, size: 16 }), mark({ product: id, size: 24 }), mark({ product: id, size: 36 }), code(`lockup({ product: '${id}' })`)))))));
}

function colorSection() {
  return section('color', 'Color', 'Three layers: primitives (raw Orchestra values), semantic tokens (what a color is for), component tokens (one control). Components use semantic or component tokens only, never hex. Color means status only: green settled, navy scheduled, peach waiting, crimson risk.',
    h('h3', { class: 'sg-h3' }, 'Primitives'),
    h('div', { class: 'sg-swatches' }, PRIMITIVES.map(([n, v]) => swatch(n, v))),
    SEMANTIC.map(([group, list]) => [h('h3', { class: 'sg-h3' }, group), h('div', { class: 'sg-swatches' }, list.map(([n, v, c]) => swatch(n, v, c)))]),
    h('h3', { class: 'sg-h3' }, 'Status pairs (text on tint, all AA)'),
    h('div', { class: 'sg-row' }, badge({ label: 'Settled 12.8:1', tone: 'settled', icon: 'circle-check' }), badge({ label: 'Scheduled 7.7:1', tone: 'scheduled', icon: 'calendar' }),
      badge({ label: 'Waiting 7.6:1', tone: 'waiting', icon: 'clock' }), badge({ label: 'Risk 6.9:1', tone: 'risk', icon: 'alert' }), badge({ label: 'Neutral 7.5:1' })));
}

function typeSection() {
  const row = (label, el) => h('div', { class: 'sg-type-row' }, h('span', { class: 'sg-label' }, label), el);
  return section('type', 'Type', 'Bricolage Grotesque for display and headings, Geist for interface text, Geist Mono for IDs, references and amounts in tables. Money always uses tabular figures.',
    row('Display 40 · Bricolage 600', h('p', { class: 'sg-t-display' }, 'Payment questions, answered')),
    row('Page title 34 · .h1', h('p', { class: 'h1' }, 'Escalations')),
    row('Section 20 · .h2', h('p', { class: 'h2' }, 'Waiting on approver')),
    row('Subsection 16 · .h3', h('p', { class: 'h3' }, 'Evidence')),
    row('Body 14 · Geist', h('p', null, 'The vendor asked when invoice INV-21529 will be paid. NetSuite shows it was paid on Nov 6.')),
    row('Small 13 · secondary', h('p', { class: 'muted', style: { fontSize: 'var(--fs-sm)' } }, 'Sent by Ulla Abernathy · Zendesk updated · 10:42')),
    row('Mono 13 · IDs', h('p', { class: 'mono' }, 'RUN-2026-11-19 · bill 50000 · #41249')),
    row('Money · .money', h('p', null, h('span', { class: 'money' }, '$29,262.63'), '  ', h('span', { class: 'money' }, '$857.24'))));
}

function shapeSection() {
  return section('shape', 'Shape, depth, motion', 'Surfaces are square (radius 0). Inputs, buttons and badges round to 2px at most. Hairline 1px borders separate; a shadow marks a floating layer only. Motion is 120 to 200 ms, ease-out, no bounce, and movement stops under reduced motion.',
    h('div', { class: 'sg-row sg-shapes' },
      h('div', { class: 'sg-shape' }, h('span', { class: 'sg-box' }), h('span', null, 'Surface · radius 0 · hairline')),
      h('div', { class: 'sg-shape' }, h('span', { class: 'sg-box sg-box-control' }), h('span', null, 'Control · radius 2px')),
      h('div', { class: 'sg-shape' }, h('span', { class: 'sg-box sg-box-float' }), h('span', null, 'Floating · --shadow-float'))),
    h('div', { class: 'sg-row' }, code('--dur-fast 120ms'), code('--dur-base 160ms'), code('--dur-slow 200ms'), code('--ease-out'), code('prefers-reduced-motion honored')));
}

function buttonsSection() {
  const busyBtn = button({ label: 'Approve & send', variant: 'primary', icon: 'send' });
  busyBtn.addEventListener('click', () => { setBusy(busyBtn, true); setTimeout(() => setBusy(busyBtn, false), 1400); });
  return section('buttons', 'Buttons', 'One primary (green) action per area. Secondary for the rest, quiet for low-emphasis and toolbars, danger only for destructive acts.',
    specimen('Variants · button({ label, variant })',
      button({ label: 'Approve & send', variant: 'primary', icon: 'send' }), button({ label: 'Schedule', variant: 'secondary', icon: 'clock' }),
      button({ label: 'More', variant: 'quiet', icon: 'more' }), button({ label: 'Remove attachment', variant: 'danger', icon: 'trash' })),
    specimen('Sizes · size: sm | md | lg',
      button({ label: 'Small', size: 'sm' }), button({ label: 'Medium' }), button({ label: 'Large', size: 'lg', variant: 'primary' })),
    specimen('States', busyBtn, button({ label: 'Busy', variant: 'secondary', busy: true }), button({ label: 'Disabled', variant: 'primary', disabled: true }),
      button({ label: 'Link styled as a button', href: '#/styleguide', iconAfter: 'arrow-right' })),
    specimen('Icon buttons · iconButton({ icon, label })',
      iconButton({ icon: 'refresh', label: 'Refresh' }), iconButton({ icon: 'more', label: 'More actions', variant: 'secondary' }),
      iconButton({ icon: 'bell', label: 'Notifications', badge: 3 }), iconButton({ icon: 'x', label: 'Close', size: 'sm' })));
}

function badgesSection() {
  return section('badges', 'Badges and chips', 'Badges state a fact and are not clickable. Chips are references or filters. Every badge has words, and an icon when the state matters.',
    specimen('Outcome · outcomeBadge(outcome)', outcomeBadge('draft_ready'), outcomeBadge('action_needed'), outcomeBadge('no_reply')),
    specimen('Risk · riskBadges(flags)', ...riskBadges(['fraud', 'legal', 'exec_cc', 'bank_change'])),
    specimen('Sender · contactBadge(verified)', contactBadge(true), contactBadge(false)),
    specimen('Payment status · statusBadge({ code, label })',
      statusBadge({ code: 'received', label: 'Received' }), statusBadge({ code: 'pending_approval', label: 'Awaiting internal approval' }),
      statusBadge({ code: 'approved', label: 'Approved' }), statusBadge({ code: 'scheduled', label: 'Scheduled for Nov 19' }),
      statusBadge({ code: 'payment_sent', label: 'Payment sent Nov 12' }), statusBadge({ code: 'paid', label: 'Paid Nov 6' }), statusBadge({ code: 'under_review', label: 'Under review' })),
    specimen('Solid (rare: one per screen)', badge({ label: 'Needs CFO sign-off', tone: 'risk', icon: 'shield-alert', solid: true }), badge({ label: 'Sent', tone: 'settled', icon: 'check', solid: true })),
    specimen('Source · sourceChip({ label })', sourceChip({ label: 'NetSuite · bill 50000' }), sourceChip({ label: 'Payment run RUN-2026-11-19' }), sourceChip({ label: 'Zendesk #41249', href: '#/styleguide' })),
    specimen('Chips · chip({ label, onClick | onRemove })',
      chip({ label: 'Zendesk #41249', icon: 'tickets' }), chip({ label: 'Needs reply', count: 12, pressed: true, onClick: (e) => e.currentTarget.setAttribute('aria-pressed', String(e.currentTarget.getAttribute('aria-pressed') !== 'true')) }),
      chip({ label: 'Waiting on vendor', count: 3, pressed: false, onClick: (e) => e.currentTarget.setAttribute('aria-pressed', String(e.currentTarget.getAttribute('aria-pressed') !== 'true')) }),
      chip({ label: 'billing@quillfernstudio.example', icon: 'mail' }), chip({ label: 'Remittance advice.pdf', icon: 'clip', onRemove: (e) => e.currentTarget.closest('.c-chip').remove() })),
    specimen('Dots · dot({ tone, label })', dot({ tone: 'settled', label: 'Connected', live: true }), dot({ tone: 'scheduled', label: 'Syncing' }), dot({ tone: 'waiting', label: 'Waiting' }), dot({ tone: 'risk', label: 'Not connected' })));
}

function avatarsSection() {
  return section('avatars', 'Avatars', 'Square initials. Decorative beside a name; pass `label` when the avatar stands alone.',
    specimen('avatar({ name, size, tone })',
      avatar({ name: 'Elena Lockhart', size: 'sm' }), avatar({ name: 'Ulla Abernathy' }), avatar({ name: 'Omar Calloway', size: 'lg' }),
      avatar({ name: 'Ben Merriweather', tone: 'chrome', label: 'Ben Merriweather' }), avatar({ name: 'Quillfern Studio', tone: 'direct' })));
}

function fieldsSection() {
  return section('fields', 'Fields', 'Every control has a visible label. Errors say what to do, sit under the field and are announced.',
    h('div', { class: 'sg-grid-2' },
      field({ label: 'Vendor email', type: 'email', placeholder: 'name@company.com', help: 'The address on the vendor record.' }),
      field({ label: 'Search', type: 'search', placeholder: 'Invoice, vendor or ticket', prefix: 'search' }),
      field({ label: 'Reason', type: 'select', value: 'legal', options: [{ value: 'legal', label: 'Legal threat' }, { value: 'exec', label: 'Executive copied' }, { value: 'fraud', label: 'Possible fraud' }] }),
      field({ label: 'Invoice number', value: 'INV-2152', error: 'No bill matches INV-2152. Check the number on the invoice.', attrs: { class: 'c-input mono' } }),
      field({ label: 'Guidance for Ulla', type: 'textarea', rows: 3, placeholder: 'What should change before this goes out?', required: true }),
      h('div', { class: 'sg-stack' },
        checkbox({ label: 'Email me when a vendor replies', checked: true }),
        checkbox({ label: 'Include the remittance advice', help: 'Rendered from the payment record.' }),
        field({ label: 'Disabled', value: 'Read-only from NetSuite', disabled: true }))));
}

function tabsSection() {
  return section('tabs', 'Tabs', 'Line tabs switch sections of one page; segmented tabs filter a list. Arrow keys move between tabs.',
    specimen('tabs({ items, selected, variant: "line" })', tabs({ label: 'Reading pane', selected: 'message', items: [
      { id: 'message', label: 'Message' }, { id: 'evidence', label: 'Evidence', count: 4 }, { id: 'ask', label: 'Ask about this ticket' }, { id: 'trail', label: 'Why this outcome' }] })),
    specimen('variant: "segmented"', tabs({ label: 'Show', variant: 'segmented', selected: 'all', items: [{ id: 'all', label: 'All' }, { id: 'mine', label: 'Assigned to me', count: 7 }, { id: 'unassigned', label: 'Unassigned', count: 2 }] })));
}

function overlaysSection() {
  const openModal = () => modal({
    title: 'Escalate to Elena Lockhart', description: 'The CFO decides priority tickets. Say why in one or two sentences.',
    body: () => h('div', { class: 'sg-stack' },
      field({ label: 'Reason', type: 'select', options: ['Legal threat', 'Executive copied', 'Possible fraud', 'Other'] }),
      field({ label: 'Note', type: 'textarea', rows: 3 })),
    actions: (dlg) => [button({ label: 'Cancel', onClick: () => dlg.close() }), button({ label: 'Escalate', variant: 'primary', icon: 'escalations', onClick: () => { dlg.close(); toast({ message: 'Escalated #41249 to Elena Lockhart.', tone: 'settled' }); } })],
  });
  return section('overlays', 'Menus, modals, toasts', 'The only layers with a shadow. Menus open under their trigger and close on Escape; modals trap focus and return it; toasts are announced politely and pause on hover.',
    h('div', { class: 'sg-row' },
      menu({ label: 'More', icon: 'more', items: [
        { label: 'Assign to Omar Calloway', icon: 'user', onSelect: () => toast({ message: 'Assigned to Omar Calloway.' }) },
        { label: 'Chase approver', icon: 'bell', hint: 'Ben Merriweather' },
        { label: 'Forward to HR', icon: 'send' },
        { separator: true },
        { label: 'Mark no reply needed', icon: 'circle-dash' },
        { label: 'Delete draft', icon: 'trash', danger: true },
      ] }),
      button({ label: 'Open a modal', onClick: openModal }),
      button({ label: 'Show a toast', onClick: () => toast({ message: 'Sent to billing@quillfernstudio.example. Zendesk #41249 marked solved.', tone: 'settled', actionLabel: 'Undo' }) }),
      button({ label: 'Show a risk toast', onClick: () => toast({ title: 'Escalation', message: 'Omar escalated #41262: bank details change request.', tone: 'risk', actionLabel: 'Open' }) }),
      button({ label: 'Run the progress bar', onClick: () => { progress.start(); setTimeout(() => progress.done(), 1400); } })),
    h('div', { class: 'sg-row' }, code("menu({ label, items })"), code("modal({ title, body, actions })"), code("toast({ message, tone })"), code('progress.start() / progress.done()')));
}

function tableSection() {
  let selected = '50001';
  const wrap = h('div');
  const draw = () => fill(wrap, table({
    caption: 'Bills', selectedKey: selected, rowKey: (r) => r.bill, onRowClick: (r) => { selected = r.bill; draw(); }, rowLabel: (r) => `${r.ref}, ${r.vendor}`,
    columns: [
      { key: 'ref', label: 'Invoice', kind: 'mono' },
      { key: 'vendor', label: 'Vendor' },
      { key: 'date', label: 'Date' },
      { key: 'due', label: 'Due' },
      { key: 'amount', label: 'Amount', kind: 'money' },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
      { key: 'bill', label: 'Source', render: (r) => sourceChip({ label: `NetSuite · bill ${r.bill}` }) },
    ],
    rows: BILLS,
  }));
  draw();
  return section('table', 'Table', 'Generous rows, hairline separators, sticky header, right-aligned money in Geist Mono with tabular figures. The open row gets the mint highlight and a green edge.',
    h('div', { class: 'sg-frame' }, wrap), h('div', { class: 'sg-row' }, code('table({ columns, rows, rowKey, selectedKey, onRowClick })'), code("column.kind: 'money' | 'mono' | 'num'")));
}

function statsSection() {
  return section('stats', 'Stat tiles', 'A headline number with its label, one line of context, and its source (for example "Practice data, snapshot Nov 13"). The values below are samples. Tone is for status only.',
    h('div', { class: 'c-stat-grid' },
      stat({ label: 'Drafts ready', value: '58', context: 'of 100 emails read', source: 'Sample value' }),
      stat({ label: 'First reply, median', value: '4', unit: 'min', context: 'Case baseline: more than 1.5 days', source: 'Sample value' }),
      stat({ label: 'Waiting on approvers', value: '9', context: 'Ben Merriweather holds 3', tone: 'waiting', source: 'Sample value' }),
      stat({ label: 'Escalated to you', value: '4', context: '2 need sign-off today', tone: 'risk', icon: 'shield-alert', href: '#/escalations', source: 'Sample value' })),
    h('div', { class: 'sg-row' }, code('stat({ label, value, unit, context, source, tone, href })'), code('.c-stat-grid')));
}

function timelineSection() {
  return section('timeline', 'Timeline', 'Status history and ticket trails. Done steps are ticked in green; the current step is ringed; upcoming steps are dashed.',
    h('div', { class: 'sg-grid-2' },
      timeline({ label: 'Invoice status', items: [
        { title: 'Received', at: 'Oct 5' }, { title: 'Approved', at: 'Oct 9' }, { title: 'Scheduled for payment', at: 'Nov 12', detail: 'Payment run RUN-2026-11-12' },
        { title: 'Paid', state: 'current', at: 'Nov 12' }, { title: 'Remittance advice sent', state: 'upcoming' }] }),
      timeline({ label: 'Ticket trail', items: [
        { title: 'Arrived from Outlook', at: '9:14', actor: 'billing@dovetaillaneprinting.example' }, { title: 'Draft ready', at: '9:14', actor: 'Conductor' },
        { title: 'Escalated: legal threat', at: '9:40', actor: 'Ulla Abernathy', state: 'risk' }, { title: 'CFO sign-off', state: 'current', actor: 'Elena Lockhart' }] })));
}

function loadingSection() {
  return section('loading', 'Loading', 'Conventions for every view: skeleton rows the height of the real rows (no shimmer, no layout jump); the slim top bar for navigation and long loads (progress.track(promise)); "Conductor is reading…" inline while a draft or brief is built; the button that started an action shows its own spinner.',
    h('div', { class: 'sg-grid-2' },
      h('div', { class: 'sg-frame' }, skeletonRows({ rows: 3 })),
      h('div', { class: 'sg-stack' }, h('div', { class: 'sg-frame sg-pad' }, skeletonText({ lines: 4 })), reading(), reading({ text: 'Conductor is writing the brief…' }))),
    h('div', { class: 'sg-row' }, code('skeletonRows({ rows })'), code('skeletonText({ lines })'), code('reading({ text })'), code('setBusy(button, true)')));
}

function emptySection() {
  return section('empty', 'Empty states and notices', 'An empty state says what is true and what to do next. A notice is an inline strip for a message on a page.',
    h('div', { class: 'sg-grid-2' },
      h('div', { class: 'sg-frame' }, empty({ icon: 'inbox', title: 'Nothing needs a reply', text: 'New emails appear here as they arrive. Conductor reads each one first.', actions: button({ label: 'Sync now', icon: 'refresh' }) })),
      h('div', { class: 'sg-stack' },
        notice({ tone: 'info', title: 'While you were away', text: 'Conductor read N emails: X drafts ready, Y need action, Z need no reply. (Sample text.)' }),
        notice({ tone: 'settled', title: 'Sent', text: 'Zendesk #41249 marked solved and filed in Sent items.' }),
        notice({ tone: 'waiting', title: 'Waiting on Ben Merriweather', text: 'Bill INV-18529 is pending approval. Chased Nov 13, no response yet.', actions: button({ label: 'Chase again', size: 'sm' }) }),
        notice({ tone: 'risk', title: 'Bank details change requested', text: 'This goes to the CFO. Do not reply with payment details.' }))));
}

function panesSection() {
  const list = pane({ title: 'Needs reply', subtitle: '12 threads', scroll: true, flush: true, body: skeletonRows({ rows: 4 }) });
  const read = pane({ title: 'Checking in on INV-21529', subtitle: 'billing@dovetaillaneprinting.example', scroll: true, body: h('p', null, 'The reading pane. Drag the handle or focus it and use the arrow keys to resize.') });
  const ev = pane({ title: 'Evidence', scroll: true, body: h('div', { class: 'sg-stack' }, sourceChip({ label: 'NetSuite · bill 50000' }), sourceChip({ label: 'Payment run RUN-2026-10-15' })) });
  return section('panes', 'Panes and splits', 'Panes are square surfaces with a hairline header. split() puts panes side by side with keyboard-operable handles, remembers sizes, and stacks under 768px.',
    h('div', { class: 'sg-split' }, split({ label: 'Inbox panes', storageKey: 'sg.split', panes: [
      { content: list, size: 260, min: 200, max: 420, label: 'message list' },
      { content: read, size: 380, min: 260, max: 640, label: 'reading pane' },
      { content: ev }] })),
    h('div', { class: 'sg-row' }, code('pane({ title, actions, body, footer, scroll })'), code('split({ panes: [{ content, size, min, max }], storageKey })')));
}

function shellSection() {
  let on = false;
  const off = onTicketTabClose(() => { on = false; setTicketTabs([]); });
  const toggleTabs = () => {
    on = !on;
    setTicketTabs(on ? [
      { id: 41249, label: 'Checking in on INV-21529', sub: '#41249', href: '#/styleguide', active: true },
      { id: 41262, label: 'Bank details update', sub: '#41262', href: '#/styleguide', unread: true },
      { id: 41270, label: 'Remittance for A-77386', sub: '#41270', href: '#/styleguide' },
    ] : []);
  };
  const node = section('shell', 'Shell hooks', 'Views talk to the shell through shell.js. Import what you need; unsubscribe in destroy().',
    h('div', { class: 'sg-row' },
      button({ label: 'Toggle sample ticket tabs', icon: 'tickets', onClick: toggleTabs }),
      button({ label: 'Send a sample notification', icon: 'bell', onClick: () => notify({ id: `sg-${Date.now()}`, type: 'ticket.returned', at: new Date().toISOString(), summary: 'Elena returned #41262 to you with guidance', ticket_id: 41262, to: [] }) })),
    h('dl', { class: 'sg-api' },
      h('dt', null, code('onSearch(fn) -> unsubscribe')), h('dd', null, 'Take over the global search while mounted. Without a handler, search opens #/inbox?q=.'),
      h('dt', null, code('setTicketTabs([{ id, label, sub, href, active, unread }])')), h('dd', null, 'The strip of open tickets under the top bar. An empty list hides it.'),
      h('dt', null, code('onTicketTabClose(fn) -> unsubscribe')), h('dd', null, 'Called with the tab id when a tab is closed.'),
      h('dt', null, code('setConnections({ zendesk: { status } })')), h('dd', null, "status: 'connected' | 'syncing' | 'error'. The shell also reads api-inbox.js connections() when it exists."),
      h('dt', null, code('notify(event)')), h('dd', null, 'Adds a live event to the tray. Events from api-live.js subscribe() arrive automatically; ones addressed to the viewer also toast.'),
      h('dt', null, code('getSession()')), h('dd', null, 'The signed-in session: { role, name, email, title }. Views also receive it as mount(root, { route, session }).'),
      h('dt', null, code('--topbar-h, --banner-h')), h('dd', null, 'Height of everything sticky above <main>, and of the global banner. Full-height layouts use calc(100dvh - var(--topbar-h) - var(--banner-h)).')));
  node.cleanup = () => { off(); setTicketTabs([]); };
  return node;
}

function directSection() {
  const frame = directShell({
    vendor: { name: 'Quillfern Studio' }, contact: { name: 'Ulla', email: 'ulla@quillfernstudio.example' },
    nav: [{ id: 'invoices', label: 'Invoices', href: '#/styleguide' }, { id: 'messages', label: 'Messages', href: '#/styleguide', count: 1 }, { id: 'documents', label: 'Documents and W-9', href: '#/styleguide' }, { id: 'updates', label: 'Updates', href: '#/styleguide' }],
    current: 'invoices',
    onSignOut: () => toast({ message: 'In Direct this signs the vendor out and returns to the sign-in page.' }),
    content: h('div', { class: 'sg-stack' }, h('h1', { class: 'h1' }, 'Your invoices'), h('p', { class: 'muted' }, 'Source: Orchestra accounts payable records, updated Nov 13, 2026'),
      table({ caption: 'Invoices', columns: [{ key: 'ref', label: 'Invoice', kind: 'mono' }, { key: 'date', label: 'Date' }, { key: 'amount', label: 'Amount', kind: 'money' }, { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) }], rows: BILLS.slice(0, 3) })),
  });
  frame.querySelector('.skip')?.remove();
  frame.main.removeAttribute('id');
  return section('direct', 'Direct frame', 'directShell({ vendor, contact, nav, current, onSignOut }) is the Conductor: Direct page frame. Navy-led; no staff navigation, internal names or ticket IDs. Fill node.main.',
    h('div', { class: 'sg-direct' }, frame));
}

export function mount(root, { session } = {}) {
  if (session && session.role !== 'cfo') {
    fill(root, h('div', { class: 'page' }, empty({ icon: 'lock', title: 'This page is for the CFO', text: 'Ask Elena Lockhart if you need the style guide.' })));
    return {};
  }
  const shell = shellSection();
  fill(root, h('div', { class: 'sg' },
    h('header', { class: 'sg-head' },
      h('div', null, h('h1', { class: 'h1' }, 'Style guide'),
        h('p', { class: 'muted' }, 'Every token and component in the Conductor design system, with its variants. Build from these: ', code('import { … } from "../components/index.js"'), '.')),
      h('nav', { class: 'sg-toc', 'aria-label': 'Style guide sections' }, SECTIONS.map(([id, label]) => h('a', { href: `#/styleguide`, 'data-target': `sg-${id}`, onclick: (e) => { e.preventDefault(); document.getElementById(`sg-${id}`)?.scrollIntoView({ block: 'start' }); } }, label)))),
    productsSection(), colorSection(), typeSection(), shapeSection(), buttonsSection(), badgesSection(), avatarsSection(), fieldsSection(),
    tabsSection(), overlaysSection(), tableSection(), statsSection(), timelineSection(), loadingSection(), emptySection(), panesSection(), shell, directSection()));
  return { destroy() { shell.cleanup(); } };
}
void icon;
