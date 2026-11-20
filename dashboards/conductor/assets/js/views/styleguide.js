// Style guide (#/styleguide, CFO only, not in the rail). The visual spec of the Conductor design system: the direction,
// every token layer (with contrast measured live from the stylesheet), type, space, shape, depth, motion, focus, the
// staff-rule signature, and every component with its variants. Workers build from what is shown here: import from
// ../components/index.js and use the c- classes and the tokens in /shared/css/tokens.css.
import { h, icon, mount as fill } from '../lib.js';
import {
  lockup, mark, PRODUCTS, button, iconButton, setBusy, field, checkbox, badge, outcomeBadge, riskBadges, contactBadge, statusBadge,
  chip, sourceChip, dot, avatar, table, stat, timeline, skeletonRows, skeletonText, reading, empty, notice, pane, split, tabs,
  menu, modal, toast, progress, directShell,
} from '../components/index.js';
import { setTicketTabs, onTicketTabClose, notify } from '../shell.js';

const SECTIONS = [
  ['direction', 'Direction'], ['products', 'Products'], ['color', 'Color'], ['type', 'Type'], ['space', 'Space'],
  ['shape', 'Radius'], ['depth', 'Elevation'], ['motion', 'Motion'], ['focus', 'Focus'], ['signature', 'Staff rule'],
  ['buttons', 'Buttons'], ['badges', 'Badges and chips'], ['avatars', 'Avatars'], ['fields', 'Fields'], ['tabs', 'Tabs'],
  ['overlays', 'Menus, modals, toasts'], ['cards', 'Cards'], ['table', 'Table'], ['stats', 'Stat tiles'], ['timeline', 'Timeline'],
  ['loading', 'Loading'], ['empty', 'Empty and notices'], ['panes', 'Panes and splits'], ['shell', 'Shell hooks'], ['direct', 'Direct frame'],
];

const RAMPS = [
  ['Paper', 'Warm green-grey neutrals: every surface, line and text role.', [
    ['0', '--p-paper-0'], ['50', '--p-paper-50'], ['100', '--p-paper-100'], ['200', '--p-paper-200'], ['300', '--p-paper-300'], ['400', '--p-paper-400'],
    ['500', '--p-paper-500'], ['600', '--p-paper-600'], ['700', '--p-paper-700'], ['800', '--p-paper-800'], ['900', '--p-paper-900']]],
  ['Green', 'Orchestra green #223307 is the anchor; the ink ramp gives the chrome depth.', [
    ['mint 50', '--p-mint-50'], ['mint', '--p-mint'], ['200', '--p-green-200'], ['250', '--p-green-250'], ['300', '--p-green-300'], ['500', '--p-green-500'],
    ['600', '--p-green-600'], ['700', '--p-green-700'], ['800', '--p-green-800'], ['900 anchor', '--p-green-900'], ['950', '--p-green-950'], ['990 hall', '--p-green-990']]],
  ['Navy', 'Direct chrome, links, focus, scheduled.', [
    ['50', '--p-navy-50'], ['75', '--p-navy-75'], ['100', '--p-navy-100'], ['200', '--p-navy-200'], ['sky 50', '--p-sky-50'], ['sky', '--p-sky'],
    ['800', '--p-navy-800'], ['900', '--p-navy-900'], ['950', '--p-navy-950'], ['slate', '--p-slate']]],
  ['Peach and crimson', 'Waiting and risk. Text uses the ink shades only.', [
    ['peach 50', '--p-peach-50'], ['peach 200', '--p-peach-200'], ['peach', '--p-peach'], ['peach ink', '--p-peach-ink'],
    ['crimson 50', '--p-crimson-50'], ['crimson 100', '--p-crimson-100'], ['crimson', '--p-crimson'], ['crimson 800', '--p-crimson-800']]],
];
const DECO = [
  ['Brass wash', '--deco-brass-wash'], ['Pale brass', '--deco-brass'], ['Brass line', '--deco-brass-line'], ['Brass ink', '--deco-brass-ink'],
  ['Hall ink', '--deco-hall'], ['Mint wash', '--deco-wash-mint'], ['Sky wash', '--deco-wash-sky'], ['Peach wash', '--deco-wash-peach'],
];
const TEXT_ROLES = [
  ['Text', '--color-text', 'Body, values, titles in panes'], ['Secondary', '--color-text-secondary', 'Supporting copy, labels'],
  ['Muted', '--color-text-muted', 'Meta, captions, counts'], ['Display ink', '--color-text-display', 'Page titles and big figures'],
  ['Link', '--color-link', 'Links and reference chips'], ['On action', '--color-on-action', 'Text on the green button', '--color-action'],
];
const SURFACES = [
  ['canvas', '--color-canvas'], ['surface', '--color-surface'], ['surface-subtle', '--color-surface-subtle'], ['surface-sunken', '--color-surface-sunken'],
  ['surface-selected', '--color-surface-selected'], ['surface-inverse', '--color-surface-inverse'], ['border', '--color-border'], ['border-strong', '--color-border-strong'],
  ['border-input', '--color-border-input'], ['action', '--color-action'], ['focus', '--color-focus'], ['chrome', '--color-chrome'],
];
const STATUS = [
  ['Settled', 'settled', 'circle-check', 'Paid, sent, verified'], ['Scheduled', 'scheduled', 'calendar', 'Approved, in a payment run'],
  ['Waiting', 'waiting', 'clock', 'Waiting on a person'], ['Risk', 'risk', 'alert', 'Legal, fraud, bank change'],
];
const TYPE_SCALE = [
  ['--fs-hero', 64, 'Hero figure · landing', 'editorial', 'Paid in full'],
  ['--fs-display-lg', 48, 'Editorial line', 'editorial', 'Composed, exact, quietly warm'],
  ['--fs-display', 40, 'Display number', 'display', '$29,262.63'],
  ['--fs-3xl', 34, 'Page title · .h1', 'display', 'Escalations'],
  ['--fs-2xl', 28, 'Stat figure', 'display', '58 drafts ready'],
  ['--fs-title', 24, 'Modal and card title', 'display', 'Escalate to Elena Lockhart'],
  ['--fs-xl', 20, 'Section · .h2', 'display', 'Waiting on approver'],
  ['--fs-lead', 18, 'Lead paragraph · .lead', 'sans', 'Every answer is drawn from the records.'],
  ['--fs-lg', 16, 'Subsection · .h3', 'sans-strong', 'Evidence'],
  ['--fs-body-lg', 15, 'Reading text', 'sans', 'The vendor asked when invoice INV-21529 will be paid.'],
  ['--fs-md', 14, 'Body and controls', 'sans', 'NetSuite shows it was paid on Nov 6 by check.'],
  ['--fs-sm', 13, 'Secondary', 'sans-muted', 'Sent by Ulla Abernathy · Zendesk updated · 10:42'],
  ['--fs-xs', 12, 'Badges, captions, table heads', 'sans-muted', 'Records as of Nov 13'],
  ['--fs-2xs', 11, 'Meta, keycaps', 'mono', 'RUN-2026-11-19 · bill 50000'],
];
const SPACE = [['--s-0', 2], ['--s-1', 4], ['--s-2', 8], ['--s-3', 12], ['--s-4', 16], ['--s-20', 20], ['--s-5', 24], ['--s-6', 32], ['--s-40', 40], ['--s-7', 48], ['--s-8', 64], ['--s-9', 80], ['--s-10', 96]];
const RADII = [
  ['--radius-surface', 'Tile · 0', 'Top bar, rail, inbox panes, the split'], ['--radius-xs', 'xs · 4', 'Checkboxes, menu items, keycaps'],
  ['--radius-badge', 'Badge · 6', 'Badges, chips, small buttons'], ['--radius-control', 'Control · 8', 'Buttons, inputs, segmented, menus, toasts'],
  ['--radius-card', 'Card · 12', 'Cards, panes and stat groups on the canvas'], ['--radius-panel', 'Panel · 14', 'Panels and landing surfaces'],
  ['--radius-modal', 'Modal · 16', 'Modals and sheets'],
];
const SHADOWS = [
  ['--shadow-1', '--shadow-card', 'Cards and panels resting on the canvas'], ['--shadow-2', '--shadow-raised', 'Hovered cards, the landing card'],
  ['--shadow-3', '--shadow-float', 'Menus, popovers, toasts, the tray'], ['--shadow-4', '--shadow-modal', 'Modals and sheets'],
];
const DURATIONS = [
  ['--dur-instant', 90, 'Hover color, toggles'], ['--dur-fast', 120, 'Press, small state changes'], ['--dur-base', 160, 'Menus, tabs, popovers'],
  ['--dur-slow', 240, 'Modals, toasts, drawers'], ['--dur-enter', 360, 'The one page entrance'], ['--dur-moment', 480, "A moment's arrival"],
];
const EASINGS = [
  ['--ease-out', [0.23, 1, 0.32, 1], 'Everything that answers a person'], ['--ease-emphasized', [0.16, 1, 0.3, 1], 'Entrances and moments'],
  ['--ease-in-out', [0.77, 0, 0.175, 1], 'Moving across the screen'],
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
const h3 = (text) => h('h3', { class: 'sg-h3' }, text);
const staff = (cls = '') => h('span', { class: `c-staff-rule ${cls}`.trim(), 'aria-hidden': 'true' });
const quiet = (b) => { b.classList.add('c-badge-quiet'); return b; };
const toggle = (e) => e.currentTarget.setAttribute('aria-pressed', String(e.currentTarget.getAttribute('aria-pressed') !== 'true'));

// ---- live measurement: read a token through a probe so the spec always shows what the stylesheet says ----------------
let probe = null;
function rgbOf(varName) {
  if (!probe) { probe = h('span', { 'aria-hidden': 'true', style: { position: 'absolute', width: '0', height: '0', overflow: 'hidden' } }); document.body.append(probe); }
  probe.style.color = `var(${varName})`;
  const m = getComputedStyle(probe).color.match(/[\d.]+/g) || [0, 0, 0];
  return m.slice(0, 3).map(Number);
}
const hexOf = (varName) => `#${rgbOf(varName).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const lum = (rgb) => { const c = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
function contrast(fg, bg) { const a = lum(rgbOf(fg)), b = lum(rgbOf(bg)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }
const ratio = (fg, bg) => `${contrast(fg, bg).toFixed(2)}:1`;

// ---- sections ----------------------------------------------------------------------------------------------------
function hero() {
  return h('header', { class: 'sg-hero' },
    h('div', { class: 'sg-hero-text' },
      h('p', { class: 'sg-eyebrow' }, staff('is-short has-barline'), h('span', null, 'Conductor design system')),
      h('h1', { class: 'h1' }, 'Style guide'),
      h('p', { class: 'editorial sg-hero-line' }, 'Composed, exact, quietly warm.'),
      h('p', { class: 'lead' }, 'The visual spec for every Conductor screen: a conductor\'s score on a ledger desk. Paper, forest-green ink, printed staff lines. Quiet chrome, and richness kept for a few moments.'),
      h('p', { class: 'sg-hero-meta' }, 'Tokens ', code('/shared/css/tokens.css'), ' · components ', code('import { … } from "../components/index.js"'))),
    h('nav', { class: 'sg-toc', 'aria-label': 'Style guide sections' }, SECTIONS.map(([id, label]) => h('a', {
      href: '#/styleguide', 'data-target': `sg-${id}`,
      onclick: (e) => { e.preventDefault(); document.getElementById(`sg-${id}`)?.scrollIntoView({ block: 'start' }); },
    }, label))));
}

function directionSection() {
  const line = (k, v) => h('div', { class: 'sg-dir' }, h('dt', null, k), h('dd', null, v));
  return section('direction', 'Direction', 'Five lines every screen is checked against. If the product name were swapped for another, the hub art, the staff rule and the insight strip would no longer fit.',
    h('dl', { class: 'sg-dirs' },
      line('Product', 'An accounts-payable inbox that reads every vendor email, matches it to the NetSuite records and drafts the answer, so the AP team approves instead of researching; plus Direct, where vendors see where their invoices stand.'),
      line('Character', 'Composed, exact, quietly warm. A finance leader should feel it has already been checked.'),
      line('World', 'A conductor\'s score on a ledger desk: warm off-white paper, printed staff lines, deep forest-green ink, a pale brass highlight, the hush of a hall before the downbeat.'),
      line('Moments', 'The sign-in hub art, "What Conductor found" on the review screen, the Ahead hero figure, the sent confirmation. Everything else stays quiet.'),
      line('Signature', 'The staff rule: five fine lines that mark the start of a moment, and only a moment.')),
    h('div', { class: 'sg-rules' },
      h('div', { class: 'sg-rule' }, h('strong', null, 'Quiet chrome, one bright element'), h('span', null, 'Working surfaces keep their density and calm. Richness goes only into the moments.')),
      h('div', { class: 'sg-rule' }, h('strong', null, 'Color means something'), h('span', null, 'Status color always comes with an icon and words. Decorative color lives in art only.')),
      h('div', { class: 'sg-rule' }, h('strong', null, 'Tiles square, floats soft'), h('span', null, 'What tiles the screen stays square; what floats on the canvas rounds and lifts.')),
      h('div', { class: 'sg-rule' }, h('strong', null, 'Motion answers a person'), h('span', null, 'One ease-out, 120 to 240 ms, one entrance per page, a static state under reduced motion.'))));
}

function productsSection() {
  return section('products', 'Products', 'One family, three products. Each lockup pairs the mark with the Orchestra name. Taglines are plain, never hype.',
    h('div', { class: 'sg-products' }, Object.entries(PRODUCTS).map(([id, p]) => h('div', { class: `sg-product sg-product-${id}` },
      h('div', { class: 'sg-product-dark on-dark' }, lockup({ product: id, tone: 'dark' })),
      h('div', { class: 'sg-product-light' }, lockup({ product: id, tone: 'light' }),
        h('p', { class: 'sg-tagline' }, p.tagline),
        h('div', { class: 'sg-row' }, mark({ product: id, size: 16 }), mark({ product: id, size: 24 }), mark({ product: id, size: 36 }), code(`lockup({ product: '${id}' })`)))))));
}

function rampTile(name, varName) {
  const L = lum(rgbOf(varName)), ink = lum(rgbOf('--color-text'));
  const dark = 1.05 / (L + 0.05) > (L + 0.05) / (ink + 0.05);  // pick whichever label color reads better
  return h('div', { class: `sg-ramp-tile${dark ? ' is-dark' : ''}`, style: { background: `var(${varName})` } },
    h('span', { class: 'sg-ramp-name' }, name), h('span', { class: 'sg-ramp-hex' }, hexOf(varName)));
}

function colorSection() {
  return section('color', 'Color', 'Three layers: primitives hold the hex, semantic tokens say what a color is for, component tokens set one control. Components use semantic or component tokens only. Ratios below are measured live against the surface they sit on.',
    h3('Primitive ramps'),
    h('div', { class: 'sg-ramps' }, RAMPS.map(([name, note, list]) => h('div', { class: 'sg-ramp' },
      h('div', { class: 'sg-ramp-head' }, h('strong', null, name), h('span', null, note)),
      h('div', { class: 'sg-ramp-row' }, list.map(([n, v]) => rampTile(n, v)))))),
    h3('Text roles, measured'),
    h('div', { class: 'sg-text-roles' }, TEXT_ROLES.map(([name, v, use, bg]) => h('div', { class: `sg-text-role${bg ? ' is-on-action' : ''}`, style: bg ? { background: `var(${bg})`, color: `var(${v})` } : null },
      h('span', { class: 'sg-aa', style: { color: `var(${v})` } }, 'Aa'),
      h('span', { class: 'sg-text-role-body' }, h('strong', null, name), h('span', { class: 'mono' }, v),
        h('span', { class: 'sg-measure' }, bg ? `${ratio(v, bg)} on action` : `${ratio(v, '--color-surface')} surface · ${ratio(v, '--color-canvas')} canvas`),
        h('span', { class: 'sg-use' }, use))))),
    h3('Semantic surfaces and lines'),
    h('div', { class: 'sg-swatches' }, SURFACES.map(([n, v]) => h('div', { class: 'sg-swatch' },
      h('span', { class: 'sg-chip', style: { background: `var(${v})` } }),
      h('span', { class: 'sg-swatch-text' }, h('strong', null, n), h('span', { class: 'mono' }, `${v} · ${hexOf(v)}`))))),
    h3('Status: meaning only, always icon and words'),
    h('div', { class: 'sg-status' }, STATUS.map(([name, tone, ic, use]) => h('div', { class: 'sg-status-item' },
      h('div', { class: 'sg-row' }, badge({ label: name, tone, icon: ic }), quiet(badge({ label: name, tone, icon: ic })), dot({ tone, label: name })),
      h('span', { class: 'sg-measure' }, `${ratio(`--color-${tone}-text`, `--color-${tone}-bg`)} text on tint`),
      h('span', { class: 'sg-use' }, use)))),
    h3('Decorative: art and moments only'),
    h('div', { class: 'sg-deco' },
      h('div', { class: 'sg-ramp-row' }, DECO.map(([n, v]) => rampTile(n, v))),
      h('div', { class: 'sg-dodont' },
        h('div', { class: 'sg-do' }, h('strong', null, icon('check'), 'Use for'), h('span', null, 'The hub art, the insight strip header, the Ahead hero, the sent receipt; lines and washes in art; display text 18px and up.')),
        h('div', { class: 'sg-dont' }, h('strong', null, icon('x'), 'Never for'), h('span', null, 'Badges, chips, dots, banners, buttons, or any element type that carries status. Brass never sits next to a waiting chip.')))));
}

function typeSection() {
  const sample = (kind, size, text) => {
    const cls = { editorial: 'sg-ts-editorial', display: 'sg-ts-display', sans: 'sg-ts-sans', 'sans-strong': 'sg-ts-sans is-strong', 'sans-muted': 'sg-ts-sans is-muted', mono: 'sg-ts-mono' }[kind];
    return h('span', { class: cls, style: { fontSize: `${size}px` } }, text);
  };
  return section('type', 'Type', 'Geist for the interface, Geist Mono for IDs and figures, Bricolage Grotesque for headings, Instrument Serif for one editorial moment per screen at most. Weights 400, 500 and 600. Sentence case everywhere; tracking tightens only on display sizes.',
    h('div', { class: 'sg-families' },
      h('div', { class: 'sg-family' }, h('span', { class: 'sg-family-glyph', style: { fontFamily: 'var(--font-sans)' } }, 'Ag'), h('strong', null, 'Geist'), h('span', null, 'Interface: labels, body, controls'), code('--font-sans')),
      h('div', { class: 'sg-family' }, h('span', { class: 'sg-family-glyph', style: { fontFamily: 'var(--font-display)', fontWeight: '600' } }, 'Ag'), h('strong', null, 'Bricolage Grotesque'), h('span', null, 'Headings and big figures, in display ink'), code('--font-display')),
      h('div', { class: 'sg-family' }, h('span', { class: 'sg-family-glyph', style: { fontFamily: 'var(--font-mono)' } }, '09'), h('strong', null, 'Geist Mono'), h('span', null, 'IDs, references, amounts; tabular'), code('--font-mono')),
      h('div', { class: 'sg-family is-editorial' }, h('span', { class: 'sg-family-glyph', style: { fontFamily: 'var(--font-editorial)' } }, 'Ag'), h('strong', null, 'Instrument Serif'), h('span', null, 'One editorial line per screen'), code('.editorial'))),
    h('div', { class: 'sg-scale' }, TYPE_SCALE.map(([tok, size, role, kind, text]) => h('div', { class: 'sg-scale-row' },
      h('span', { class: 'sg-scale-meta' }, h('strong', null, `${size}`), h('span', null, role), h('span', { class: 'mono' }, tok)),
      h('span', { class: 'sg-scale-sample' }, sample(kind, size, text))))),
    h3('The editorial moment'),
    h('div', { class: 'sg-editorial-demo' },
      staff('is-short has-barline'),
      h('p', { class: 'editorial' }, 'Questions answered before they are asked.'),
      h('p', { class: 'muted' }, 'Sample line. Instrument Serif at 48 (40 on phones), display ink, regular weight, tracking ', code('--ls-editorial'), '. Use it for the hub headline, the Ahead promise or a big empty-state line; never for labels, buttons or numbers in tables.')),
    h('div', { class: 'sg-row' }, code('.display'), code('.h1 .h2 .h3'), code('.lead'), code('.editorial .editorial-sm .editorial-lg'), code('.mono .money .tabular'), code('--ls-heading -0.01em'), code('--ls-display -0.02em'), code('--ls-hero -0.03em')));
}

function spaceSection() {
  return section('space', 'Space', 'Everything sits on the 4px grid. Space inside a group is smaller than space between groups. Controls 4 to 12 inside, cards 20 to 24, page edges 24 to 32, sections 48 to 64.',
    h('div', { class: 'sg-space' }, SPACE.map(([tok, px]) => h('div', { class: 'sg-space-row' },
      h('span', { class: 'mono' }, tok), h('span', { class: 'sg-space-num' }, `${px}`), h('span', { class: 'sg-space-bar', style: { width: `var(${tok})` } })))));
}

function shapeSection() {
  return section('shape', 'Radius', 'What tiles the screen stays square: the top bar, the rail, the inbox panes, panes inside a split. What floats on the canvas is soft. Inner radius is the outer radius minus the padding between them, never below 4.',
    h('div', { class: 'sg-radii' }, RADII.map(([tok, name, use]) => h('div', { class: 'sg-radius' },
      h('span', { class: 'sg-radius-box', style: { borderRadius: `var(${tok})` } }),
      h('strong', null, name), h('span', { class: 'mono' }, tok), h('span', { class: 'sg-use' }, use)))));
}

function depthSection() {
  return section('depth', 'Elevation', 'Four soft, layered shadows tinted with the green ink, never black and never colored. Working panes take none; hairlines separate them.',
    h('div', { class: 'sg-depths' }, SHADOWS.map(([tok, sem, use], i) => h('div', { class: 'sg-depth', style: { boxShadow: `var(${tok})` } },
      h('span', { class: 'sg-depth-n' }, String(i + 1)), h('strong', null, sem), h('span', { class: 'mono' }, tok), h('span', { class: 'sg-use' }, use)))));
}

function curve([x1, y1, x2, y2]) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '-4 -4 108 108'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'sg-curve');
  const grid = document.createElementNS(NS, 'path');
  grid.setAttribute('d', 'M0 100 H100 M0 0 H100 M0 100 V0 M100 100 V0'); grid.setAttribute('class', 'sg-curve-grid');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', `M0 100 C ${x1 * 100} ${100 - y1 * 100} ${x2 * 100} ${100 - y2 * 100} 100 0`); path.setAttribute('class', 'sg-curve-line');
  svg.append(grid, path);
  return svg;
}

function motionSection() {
  const lanes = h('div', { class: 'sg-lanes' }, EASINGS.map(([tok, , use]) => h('div', { class: 'sg-lane' },
    h('span', { class: 'mono' }, tok), h('span', { class: 'sg-lane-track' }, h('span', { class: 'sg-lane-dot', style: { transitionTimingFunction: `var(${tok})` } })), h('span', { class: 'sg-use' }, use))));
  const play = button({ label: 'Play the curves', icon: 'refresh', size: 'sm', onClick: () => lanes.classList.toggle('is-on') });
  return section('motion', 'Motion', 'Motion answers a person. One strong ease-out for everything that responds to an action, 120 to 240 ms; one entrance of 360 ms per page at most; only transform, opacity and color move, and every transition names its properties.',
    h('div', { class: 'sg-motion' },
      h('div', { class: 'sg-durations' }, DURATIONS.map(([tok, ms, use]) => h('div', { class: 'sg-duration' },
        h('span', { class: 'mono' }, tok), h('span', { class: 'sg-duration-track' }, h('span', { class: 'sg-duration-bar', style: { width: `${(ms / 480) * 100}%` } })), h('span', { class: 'sg-duration-ms' }, `${ms} ms`), h('span', { class: 'sg-use' }, use)))),
      h('div', { class: 'sg-easings' }, EASINGS.map(([tok, , use], i) => h('div', { class: 'sg-easing' }, curve(EASINGS[i][1]), h('strong', { class: 'mono' }, tok), h('span', { class: 'sg-use' }, use))))),
    h('div', { class: 'sg-specimen' }, h('p', { class: 'sg-label' }, 'The curves side by side, slowed to 900 ms so the shape is visible'), lanes, h('div', { class: 'sg-row' }, play)),
    specimen('Press feedback · every pressable scales to --press-scale (0.97) on :active, 120 ms',
      button({ label: 'Press and hold', variant: 'primary' }), button({ label: 'Press and hold' }), chip({ label: 'Filter chip', count: 4, pressed: false, onClick: toggle })),
    h('div', { class: 'sg-note' }, icon('info'), h('span', null, 'Reduced motion: ', code('--rise'), ' becomes 0, ', code('--press-scale'), ' becomes 1, and base.css collapses every duration, so each component rests in its designed static state. Working screens (inbox, review, tables) never run continuous animation; the hub alone may, within budget.')),
    h('div', { class: 'sg-row' }, code('transition: background-color var(--dur-fast) var(--ease-out)'), code('.c-enter + --i for a short stagger'), code('@starting-style for entrances')));
}

function focusSection() {
  const ground = (cls, label, text, btnCls) => h('div', { class: `sg-ground ${cls}` }, h('span', { class: 'sg-ground-label' }, label),
    h('span', { class: `c-btn ${btnCls} sg-focused`, 'aria-hidden': 'true' }, text));
  return section('focus', 'Focus', 'A 2px ring, 2px off the control, for keyboard focus only. Navy on paper; mint on the green, navy and hall-ink grounds (add .on-dark to a dark container). Tab through this page to see the live ring.',
    h('div', { class: 'sg-grounds' },
      ground('', 'Paper · --focus-ring', 'Schedule', 'c-btn-secondary'),
      ground('is-green on-dark', 'Green chrome · --focus-ring-on-dark', 'Zendesk', 'sg-on-dark-btn'),
      ground('is-navy on-dark', 'Direct navy · --focus-ring-on-dark', 'Invoices', 'sg-on-dark-btn'),
      ground('is-hall on-dark', 'Hall ink · --focus-ring-on-dark', 'Undo', 'sg-on-dark-btn')),
    h('p', { class: 'sg-use' }, `Measured: navy ring ${ratio('--color-focus', '--color-surface')} on surface; mint ring ${ratio('--color-focus-on-dark', '--color-chrome')} on green, ${ratio('--color-focus-on-dark', '--color-direct')} on navy.`));
}

function signatureSection() {
  return section('signature', 'The staff rule', 'The signature: five 1px lines, 4px apart, 21px tall. It marks the start of a moment, and only a moment: the hub art, the insight strip header, the Ahead hero, the sent receipt. Always aria-hidden.',
    h('div', { class: 'sg-staffs' },
      h('div', { class: 'sg-staff-demo' }, staff(), h('span', { class: 'sg-use' }, 'On paper · .c-staff-rule')),
      h('div', { class: 'sg-staff-demo' }, staff('has-barline'), h('span', { class: 'sg-use' }, 'With the opening barline · .has-barline')),
      h('div', { class: 'sg-staff-demo is-dark on-dark' }, staff('is-on-dark has-barline'), h('span', { class: 'sg-use' }, 'On green or hall ink · .is-on-dark')),
      h('div', { class: 'sg-staff-demo' }, staff('is-brass is-short'), h('span', { class: 'sg-use' }, 'Brass, short · .is-brass .is-short (art only)'))),
    h('div', { class: 'sg-moment' },
      h('div', { class: 'sg-moment-head' }, staff('is-short has-barline'), h('span', { class: 'sg-moment-title' }, 'What Conductor found')),
      h('p', null, 'A sketch of how a moment opens: the rule sits beside or above the heading, never between rows. The moment itself is drawn by its own screen.')),
    h('div', { class: 'sg-dodont' },
      h('div', { class: 'sg-do' }, h('strong', null, icon('check'), 'Use'), h('span', null, 'At the top of one of the four moments, once per screen, as a quiet header mark.')),
      h('div', { class: 'sg-dont' }, h('strong', null, icon('x'), 'Never'), h('span', null, 'As a divider, on list or table rows, in the chrome, or drawn as notes, clefs or batons.'))),
    h('div', { class: 'sg-row' }, code('<span class="c-staff-rule has-barline" aria-hidden="true"></span>'), code('--staff-line --staff-gap --staff-color')));
}

function buttonsSection() {
  const busyBtn = button({ label: 'Approve & send', variant: 'primary', icon: 'send' });
  busyBtn.addEventListener('click', () => { setBusy(busyBtn, true); setTimeout(() => setBusy(busyBtn, false), 1400); });
  return section('buttons', 'Buttons', 'One primary (green) action per area. Secondary for the rest, quiet for low-emphasis and toolbars, danger only for destructive acts. 8px corners; small buttons 6px.',
    specimen('Variants · button({ label, variant })',
      button({ label: 'Approve & send', variant: 'primary', icon: 'send' }), button({ label: 'Schedule', variant: 'secondary', icon: 'clock' }),
      button({ label: 'More', variant: 'quiet', icon: 'more' }), button({ label: 'Remove attachment', variant: 'danger', icon: 'trash' })),
    specimen('Sizes · size: sm | md | lg',
      button({ label: 'Small', size: 'sm' }), button({ label: 'Medium' }), button({ label: 'Large', size: 'lg', variant: 'primary' })),
    specimen('States', busyBtn, button({ label: 'Busy', variant: 'secondary', busy: true }), button({ label: 'Disabled', variant: 'primary', disabled: true }),
      button({ label: 'Link styled as a button', href: '#/styleguide', iconAfter: 'arrow-right' })),
    specimen('Icon buttons · iconButton({ icon, label })',
      iconButton({ icon: 'refresh', label: 'Refresh' }), iconButton({ icon: 'more', label: 'More actions', variant: 'secondary' }),
      iconButton({ icon: 'bell', label: 'Notifications', badge: 3 }), iconButton({ icon: 'x', label: 'Close', size: 'sm' })),
    specimen('Keycap · .c-kbd', h('span', { class: 'c-kbd' }, '/'), h('span', { class: 'c-kbd' }, 'E'), h('span', { class: 'c-kbd' }, 'Esc')));
}

function badgesSection() {
  return section('badges', 'Badges and chips', 'Badges state a fact and are not clickable: a soft tint, a hairline in the same tone, icon and words. In a long column use the quiet form so a run of one status reads as rhythm, not a wall of pills. Chips are references or filters.',
    specimen('Outcome · outcomeBadge(outcome)', outcomeBadge('draft_ready'), outcomeBadge('action_needed'), outcomeBadge('no_reply')),
    specimen('Risk · riskBadges(flags)', ...riskBadges(['fraud', 'legal', 'exec_cc', 'bank_change'])),
    specimen('Sender · contactBadge(verified)', contactBadge(true), contactBadge(false)),
    specimen('Payment status · statusBadge({ code, label })',
      statusBadge({ code: 'received', label: 'Received' }), statusBadge({ code: 'pending_approval', label: 'Awaiting internal approval' }),
      statusBadge({ code: 'approved', label: 'Approved' }), statusBadge({ code: 'scheduled', label: 'Scheduled for Nov 19' }),
      statusBadge({ code: 'payment_sent', label: 'Payment sent Nov 12' }), statusBadge({ code: 'paid', label: 'Paid Nov 6' }), statusBadge({ code: 'under_review', label: 'Under review' })),
    specimen('Quiet, for long columns · add .c-badge-quiet',
      quiet(statusBadge({ code: 'approved', label: 'Approved' })), quiet(statusBadge({ code: 'pending_approval', label: 'Awaiting approval' })),
      quiet(statusBadge({ code: 'paid', label: 'Paid Nov 6' })), quiet(badge({ label: 'Legal', tone: 'risk', icon: 'scale' }))),
    specimen('Solid (rare: one per screen)', badge({ label: 'Needs CFO sign-off', tone: 'risk', icon: 'shield-alert', solid: true }), badge({ label: 'Sent', tone: 'settled', icon: 'check', solid: true })),
    specimen('Source · sourceChip({ label })', sourceChip({ label: 'NetSuite · bill 50000' }), sourceChip({ label: 'Payment run RUN-2026-11-19' }), sourceChip({ label: 'Zendesk #41249', href: '#/styleguide' })),
    specimen('Chips · chip({ label, onClick | onRemove })',
      chip({ label: 'Zendesk #41249', icon: 'tickets' }), chip({ label: 'Needs reply', count: 12, pressed: true, onClick: toggle }),
      chip({ label: 'Waiting on vendor', count: 3, pressed: false, onClick: toggle }),
      chip({ label: 'billing@quillfernstudio.example', icon: 'mail' }), chip({ label: 'Remittance advice.pdf', icon: 'clip', onRemove: (e) => e.currentTarget.closest('.c-chip').remove() })),
    specimen('Dots · dot({ tone, label })', dot({ tone: 'settled', label: 'Connected', live: true }), dot({ tone: 'scheduled', label: 'Syncing' }), dot({ tone: 'waiting', label: 'Waiting' }), dot({ tone: 'risk', label: 'Not connected' })));
}

function avatarsSection() {
  return section('avatars', 'Avatars', 'Initials on a soft tile. Decorative beside a name; pass `label` when the avatar stands alone.',
    specimen('avatar({ name, size, tone })',
      avatar({ name: 'Elena Lockhart', size: 'sm' }), avatar({ name: 'Ulla Abernathy' }), avatar({ name: 'Omar Calloway', size: 'lg' }),
      avatar({ name: 'Ben Merriweather', tone: 'chrome', label: 'Ben Merriweather' }), avatar({ name: 'Quillfern Studio', tone: 'direct' })));
}

function fieldsSection() {
  return section('fields', 'Fields', 'Every control has a visible label. Errors say what to do, sit under the field and are announced. Field borders meet 3:1 on paper.',
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
  return section('tabs', 'Tabs', 'Line tabs switch sections of one page; segmented tabs filter a list (a sunken well, the chosen segment a raised paper tile). Arrow keys move between tabs.',
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
  return section('overlays', 'Menus, modals, toasts', 'The floating layers. Menus (8px, --shadow-float) open under their trigger and close on Escape; modals (16px, --shadow-modal) trap focus and return it; toasts are hall ink with a mint edge, announced politely, paused on hover.',
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
    h('div', { class: 'sg-overlay-stills', 'aria-hidden': 'true' },
      h('div', { class: 'sg-still-menu' },
        h('span', { class: 'c-menu-item' }, icon('user'), h('span', { class: 'c-menu-label' }, 'Assign to Omar Calloway')),
        h('span', { class: 'c-menu-item sg-hover' }, icon('bell'), h('span', { class: 'c-menu-label' }, 'Chase approver'), h('span', { class: 'c-menu-hint' }, 'Ben Merriweather')),
        h('span', { class: 'c-menu-sep' }),
        h('span', { class: 'c-menu-item is-danger' }, icon('trash'), h('span', { class: 'c-menu-label' }, 'Delete draft'))),
      h('div', { class: 'sg-still-toasts' },
        h('div', { class: 'c-toast' }, icon('circle-check', 'c-toast-icon'), h('span', { class: 'c-toast-body' }, h('span', null, 'Sent to billing@quillfernstudio.example.'))),
        h('div', { class: 'c-toast c-toast-risk' }, icon('alert', 'c-toast-icon'), h('span', { class: 'c-toast-body' }, h('strong', null, 'Escalation'), h('span', null, 'Bank details change request.'))))),
    h('div', { class: 'sg-row' }, code('menu({ label, items })'), code('modal({ title, body, actions })'), code('toast({ message, tone })'), code('progress.start() / progress.done()')));
}

function cardsSection() {
  return section('cards', 'Cards', 'A card floats on the canvas: 12px corners, a hairline and the faintest shadow. One card may lead a screen (.is-raised). Interactive cards lift by shadow on hover, never by moving.',
    h('div', { class: 'sg-cards' },
      h('div', { class: 'c-card' }, h('div', { class: 'c-card-head' }, h('span', { class: 'c-card-title' }, 'Waiting on approver'), badge({ label: '3 bills', tone: 'waiting', icon: 'clock' })),
        h('div', { class: 'c-card-body' }, h('p', { class: 'muted' }, 'Ben Merriweather holds three bills. Chased Nov 13. (Sample text.)')),
        h('div', { class: 'c-card-foot' }, button({ label: 'Chase again', size: 'sm' }))),
      h('div', { class: 'c-card is-raised' }, h('div', { class: 'c-card-body sg-stack' }, h('span', { class: 'sg-label' }, '.c-card.is-raised · --shadow-raised'), h('p', null, 'The one card that leads a screen, such as the sign-in card.'))),
      h('a', { class: 'c-card', href: '#/styleguide' }, h('div', { class: 'c-card-body sg-stack' }, h('span', { class: 'sg-label' }, 'a.c-card · hover lifts'), h('p', null, 'A whole card as a link.')))),
    h('div', { class: 'sg-row' }, code('.c-card .c-card-head .c-card-body .c-card-foot'), code('.is-raised .is-panel .is-flat .is-interactive')));
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
  return section('table', 'Table', 'Generous rows, hairline separators, sticky header, right-aligned money in Geist Mono with tabular figures. Hover is a paper step, the open row a mint highlight with a green edge, keyboard focus a navy ring: three states that read apart.',
    h('div', { class: 'sg-frame is-card' }, wrap), h('div', { class: 'sg-row' }, code('table({ columns, rows, rowKey, selectedKey, onRowClick })'), code("column.kind: 'money' | 'mono' | 'num'"), code('.c-table-wrap.is-card')));
}

function statsSection() {
  return section('stats', 'Stat tiles', 'A headline number in display ink with its label, one line of context, and its source (for example "Practice data, snapshot Nov 13"). The values below are samples. Tone is for status only.',
    h('div', { class: 'c-stat-grid' },
      stat({ label: 'Drafts ready', value: '58', context: 'of 100 emails read', source: 'Sample value' }),
      stat({ label: 'First reply, median', value: '4', unit: 'min', context: 'Case baseline: more than 1.5 days', source: 'Sample value' }),
      stat({ label: 'Waiting on approvers', value: '9', context: 'Ben Merriweather holds 3', tone: 'waiting', source: 'Sample value' }),
      stat({ label: 'Escalated to you', value: '4', context: '2 need sign-off today', tone: 'risk', icon: 'shield-alert', href: '#/escalations', source: 'Sample value' })),
    h('div', { class: 'sg-row' }, code('stat({ label, value, unit, context, source, tone, href })'), code('.c-stat-grid')));
}

function timelineSection() {
  return section('timeline', 'Timeline', 'Status history and ticket trails. Done steps are filled green; the current step is ringed; upcoming steps are dashed.',
    h('div', { class: 'sg-grid-2' },
      h('div', { class: 'c-card' }, h('div', { class: 'c-card-body' }, timeline({ label: 'Invoice status', items: [
        { title: 'Received', at: 'Oct 5' }, { title: 'Approved', at: 'Oct 9' }, { title: 'Scheduled for payment', at: 'Nov 12', detail: 'Payment run RUN-2026-11-12' },
        { title: 'Paid', state: 'current', at: 'Nov 12' }, { title: 'Remittance advice sent', state: 'upcoming' }] }))),
      h('div', { class: 'c-card' }, h('div', { class: 'c-card-body' }, timeline({ label: 'Ticket trail', items: [
        { title: 'Arrived from Outlook', at: '9:14', actor: 'billing@dovetaillaneprinting.example' }, { title: 'Draft ready', at: '9:14', actor: 'Conductor' },
        { title: 'Escalated: legal threat', at: '9:40', actor: 'Ulla Abernathy', state: 'risk' }, { title: 'CFO sign-off', state: 'current', actor: 'Elena Lockhart' }] })))));
}

function loadingSection() {
  return section('loading', 'Loading', 'Skeleton rows the height of the real rows (they breathe, never shimmer, no layout jump); the slim top bar for navigation and long loads (progress.track(promise)); "Conductor is reading…" inline while a draft or brief is built; the button that started an action shows its own spinner.',
    h('div', { class: 'sg-grid-2' },
      h('div', { class: 'sg-frame is-card' }, skeletonRows({ rows: 3 })),
      h('div', { class: 'sg-stack' }, h('div', { class: 'sg-frame is-card sg-pad' }, skeletonText({ lines: 4 })), reading(), reading({ text: 'Conductor is writing the brief…' }))),
    h('div', { class: 'sg-row' }, code('skeletonRows({ rows })'), code('skeletonText({ lines })'), code('reading({ text })'), code('setBusy(button, true)')));
}

function emptySection() {
  const ed = empty({ icon: 'circle-check', title: 'Every vendor has an answer', text: 'Sample text. A big empty line may be the screen\'s one editorial moment: add .is-editorial.' });
  ed.classList.add('is-editorial');
  return section('empty', 'Empty states and notices', 'An empty state says what is true and what to do next. A notice is an inline message on a page: a soft card in its tone, the icon carries the color, no slab.',
    h('div', { class: 'sg-grid-2' },
      h('div', { class: 'sg-stack' },
        h('div', { class: 'sg-frame is-card' }, empty({ icon: 'inbox', title: 'Nothing needs a reply', text: 'New emails appear here as they arrive. Conductor reads each one first.', actions: button({ label: 'Sync now', icon: 'refresh' }) })),
        h('div', { class: 'sg-frame is-card' }, ed)),
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
  return section('panes', 'Panes and splits', 'On the canvas a pane is a card. Inside split() panes tile flush: square, hairline-separated, no shadow. split() has keyboard-operable handles, remembers sizes, and stacks under 768px.',
    h('div', { class: 'sg-split' }, split({ label: 'Inbox panes', storageKey: 'sg.split', panes: [
      { content: list, size: 260, min: 200, max: 420, label: 'message list' },
      { content: read, size: 380, min: 260, max: 640, label: 'reading pane' },
      { content: ev }] })),
    h('div', { class: 'sg-row' }, code('pane({ title, actions, body, footer, scroll })'), code('split({ panes: [{ content, size, min, max }], storageKey })'), code('.c-pane.is-tile')));
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
    content: h('div', { class: 'sg-stack' }, h('h2', { class: 'h1' }, 'Your invoices'), h('p', { class: 'muted' }, 'Source: Orchestra accounts payable records, updated Nov 13, 2026'),
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
    hero(), directionSection(), productsSection(), colorSection(), typeSection(), spaceSection(), shapeSection(), depthSection(), motionSection(),
    focusSection(), signatureSection(), buttonsSection(), badgesSection(), avatarsSection(), fieldsSection(), tabsSection(), overlaysSection(),
    cardsSection(), tableSection(), statsSection(), timelineSection(), loadingSection(), emptySection(), panesSection(), shell, directSection()));
  return { destroy() { shell.cleanup(); probe?.remove(); probe = null; } };
}
