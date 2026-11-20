// Hub look A, "Score". Presentation only: this module draws inside the decorative art layer and nothing else.
//
// The idea: the sign-in page is a printed score. One full staff runs across warm paper (fading out around the copy),
// and one line leaves its middle line at the left, quietly, then swells
// like a crescendo into a ribbon of fine engraved strokes that opens toward the sign-in card and runs under it. It is
// the Conductor mark (three staff lines and one sweep that leaves the lowest of them and swells) drawn at page scale.
//
// Motion: the ribbon draws in once on load (stroke-dashoffset, about 600 ms); afterwards it breathes very slowly
// (a CSS scaleY on its own layer, so no JS runs per frame). On the handshake it draws again, now toward the centred
// card, carrying the hand-off to /app. Under reduced motion everything is drawn complete and nothing moves.
// No per-frame JS: the geometry is computed once per layout (load, resize, handshake). Paused when the tab is hidden.
//
// It reads (never writes) the hub's layout to place the ribbon in the empty band between the headline and the proof
// points, so the ribbon never runs behind text.
//
// Knobs (also in docs/ui-upgrade/looks/score.md):
const KNOBS = {
  staffGap: 8,        // px between the five lines of a staff
  strokes: 15,        // engraved lines in the ribbon
  swellMax: 0.09,     // the ribbon's half-height at the right edge, as a share of the page width (desktop)
  rise: 0.2,          // how far the ribbon climbs from the left to the right edge, as a share of the viewport height
  wave: 0.16,         // waveform amplitude, as a share of the ribbon's half-height
};
const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...kids);
  return n;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r1 = (v) => Math.round(v * 10) / 10;
function docRect(node) {
  if (!node) return null;
  const b = node.getBoundingClientRect();
  if (!b.width && !b.height) return null;
  return { left: b.left + scrollX, right: b.right + scrollX, top: b.top + scrollY, bottom: b.bottom + scrollY, width: b.width, height: b.height };
}

/** Where things are on the page right now, in document pixels. Returns null until the hub has rendered. */
function measure() {
  const W = document.documentElement.clientWidth;
  const vh = innerHeight;
  const H = Math.max(document.body.scrollHeight, vh);
  const stacked = W <= 960;
  const hand = docRect(document.querySelector('.hub-handshake-card'));
  if (hand) {
    // the hand-off: the ribbon runs from the left into the centred card
    if (stacked) {
      const y = hand.top > 132 ? hand.top - 56 : hand.bottom + 56;
      return { W, H, vh, mode: 'handshake', y0: y, y1: y + 10, colX: W * 0.4, room: 24, card: hand, edgeHalf: 36 };
    }
    const y = hand.top + hand.height * 0.5;
    return { W, H, vh, mode: 'handshake', y0: y + vh * 0.05, y1: y - vh * 0.1, colX: hand.left * 0.7, room: 44, card: hand, edgeHalf: W * KNOBS.swellMax };
  }
  const value = docRect(document.querySelector('.hub-value'));
  const card = docRect(document.querySelector('.hub-signin-inner > .hub-card')) || docRect(document.querySelector('.hub-signin-inner'));
  if (!value || !card) return null;
  if (stacked) {
    // a band under the headline, above the card: the ribbon opens toward the card and tucks under its top edge
    const room = Math.max(6, (card.top - value.bottom) / 2 - 6);
    const y0 = (value.bottom + card.top) / 2;
    return { W, H, vh, mode: 'stacked', y0, y1: y0 + room * 1.1, colX: W * 0.5, room, card, edgeHalf: room * 1.6 };
  }
  const proof = docRect(document.querySelector('.hub-proof-list')) || docRect(document.querySelector('.hub-proof'));
  const brand = docRect(document.querySelector('.hub-brand'));
  const gapBottom = proof ? proof.top : value.bottom + 120;
  const room = Math.max(4, (gapBottom - value.bottom) / 2 - 14);
  const y0 = (value.bottom + gapBottom) / 2;
  return {
    W, H, vh, mode: 'split', y0, y1: Math.max(card.top + 48, y0 - vh * KNOBS.rise),
    // the ribbon must fit the band only as far as the copy reaches; past that it may open toward the card
    colX: Math.min(brand ? brand.right : W * 0.42, Math.max(value.right, proof ? proof.right : 0) + 16),
    room, card, edgeHalf: W * KNOBS.swellMax, textX: value.left,
  };
}

/** Text blocks the staves make room for (a soft clearing, so no line runs through the copy). */
function clearings() {
  if (document.querySelector('.hub-handshake')) return [];
  return ['.hub-brand .c-lockup', '.hub-value', '.hub-proof', '.hub-family ul']
    .map((s) => docRect(document.querySelector(s))).filter(Boolean);
}

/** The ribbon's centre line and half-height at x. */
function shape(m) {
  const { W, y0, y1, colX, room, edgeHalf } = m;
  const e0 = 0.6;                                   // it starts as a single line on the staff
  // the centre climbs late (it stays level while it crosses the text column), like the mark's sweep leaving the staff
  const centre = (x) => y0 + (y1 - y0) * Math.pow(clamp(x / W, 0, 1), 2.4);
  const drift = Math.abs(centre(colX) - y0);
  // the swell: a power curve fitted so the ribbon still fits the band where it leaves the text column
  const fit = clamp((room - drift) / (1 + KNOBS.wave) - 1, 2, 999);
  const ratio = clamp((fit - e0) / Math.max(1, edgeHalf - e0), 0.02, 0.98);
  const p = clamp(Math.log(ratio) / Math.log(clamp(colX / W, 0.05, 0.95)), 1.2, 4.2);
  const half = (x) => e0 + (edgeHalf - e0) * Math.pow(clamp(x / W, 0, 1), p);
  return { centre, half };
}

function ribbonPaths(m) {
  const { W } = m;
  const { centre, half } = shape(m);
  const n = KNOBS.strokes;
  const lambda = clamp(W * 0.46, 220, 760);
  const step = W < 600 ? 5 : 8;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = (i / (n - 1)) * 2 - 1;                // -1 .. 1 across the ribbon
    let d = '';
    let prev = null;
    for (let x = -8; x <= W + 16; x += step) {
      const u = clamp(x / W, 0, 1);
      const e = half(x);
      const fold = 1 - 0.22 * u * u;                // a slight turn: the far end tilts away, so it reads as a ribbon
      const wave = KNOBS.wave * e * Math.sin((2 * Math.PI * x) / lambda + 0.9 + t * 0.7);
      const pt = [r1(x), r1(centre(x) + e * t * fold + wave)];
      if (!prev) d = `M${pt[0]} ${pt[1]}`;
      else d += ` Q${prev[0]} ${prev[1]} ${r1((prev[0] + pt[0]) / 2)} ${r1((prev[1] + pt[1]) / 2)}`;
      prev = pt;
    }
    d += ` L${prev[0]} ${prev[1]}`;
    out.push({ d, t, i });
  }
  return out;
}

/** The staff: one full five-line staff across the page, placed so the ribbon leaves exactly its middle line. */
function staffPath(m) {
  const { W, y0 } = m;
  const gap = KNOBS.staffGap;
  const top = Math.round(y0 - 2 * gap);
  let lines = '';
  for (let k = 0; k < 5; k += 1) lines += `M0 ${top + k * gap + 0.5}H${W}`;
  return lines;
}

export function mount(art, { reduced = false } = {}) {
  art.classList.add('score-art');
  if (reduced) art.classList.add('is-still');
  const staffSvg = el('svg', { class: 'score-staff', 'aria-hidden': 'true', focusable: 'false' });
  const ribbonBox = document.createElement('div');
  ribbonBox.className = 'score-ribbon';
  const ribbonSvg = el('svg', { class: 'score-ribbon-svg', 'aria-hidden': 'true', focusable: 'false' });
  ribbonBox.append(ribbonSvg);
  art.append(staffSvg, ribbonBox);

  let lastKey = '';
  const keyOf = (m) => [m.mode, m.W, Math.max(m.H, m.vh), m.y0, m.card?.left, m.card?.top, m.card?.height].map((v) => Math.round(v || 0) || v).join('|');

  function draw({ animate }) {
    const m = measure();
    if (!m) return false;
    const t0 = performance.now();
    const { W } = m;
    const H = Math.max(m.H, m.vh);
    for (const s of [staffSvg, ribbonSvg]) {
      s.setAttribute('width', W); s.setAttribute('height', H); s.setAttribute('viewBox', `0 0 ${W} ${H}`);
    }
    // the staff steps aside for the copy: a soft-edged mask, computed once per layout (static, no per-frame cost)
    const pad = 18;
    const mask = el('mask', { id: 'score-clear', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H },
      el('rect', { x: 0, y: 0, width: W, height: H, fill: 'white' }),
      el('g', { filter: 'url(#score-soft)' }, ...clearings().map((r) => el('rect', {
        x: r1(r.left - pad), y: r1(r.top - pad / 2), width: r1(r.width + pad * 2), height: r1(r.height + pad), rx: 12, fill: 'black',
      }))));
    const soft = el('filter', { id: 'score-soft', x: '-10%', y: '-10%', width: '120%', height: '120%' }, el('feGaussianBlur', { stdDeviation: 10 }));
    staffSvg.replaceChildren(el('defs', {}, soft, mask), el('g', { mask: 'url(#score-clear)' },
      el('path', { class: 'score-staff-lines', d: staffPath(m) })));
    // the ribbon fades in from nothing at the left edge (it enters quietly) and reaches full ink before the card
    const fadeEnd = r1(m.mode === 'split' ? Math.max(m.colX, W * 0.38) : W * 0.55);
    const grad = (id, cls, stops) => el('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: fadeEnd, y2: 0 },
      ...stops.map(([o, a]) => el('stop', { offset: o, class: cls, 'stop-opacity': a })));
    const defs = el('defs', {},
      grad('score-ink', 'score-stop-ink', [['0', '0'], ['0.4', '0.5'], ['1', '1']]),
      grad('score-brass', 'score-stop-brass', [['0', '0'], ['0.5', '0.4'], ['1', '1']]));
    const brassAt = Math.round((KNOBS.strokes - 1) * 0.3);
    const g = el('g', { class: 'score-ribbon-lines' });
    for (const p of ribbonPaths(m)) {
      const edge = Math.abs(p.t);
      const brass = p.i === brassAt;
      const path = el('path', {
        d: p.d,
        pathLength: '1',
        class: brass ? 'score-stroke is-brass' : 'score-stroke',
        stroke: brass ? 'url(#score-brass)' : 'url(#score-ink)',
        'stroke-width': brass ? '1.6' : r1(1.35 - edge * 0.65),
        'stroke-opacity': brass ? '1' : (0.9 - edge * 0.6).toFixed(2),
      });
      path.style.setProperty('--delay', `${Math.round(edge * 80)}ms`);
      g.append(path);
    }
    ribbonSvg.replaceChildren(defs, g);
    ribbonBox.style.transformOrigin = `0 ${Math.round(m.y0)}px`;
    art.dataset.mode = m.mode;
    art.dataset.cost = (performance.now() - t0).toFixed(2);   // build cost in ms, read by the frame-cost check
    art.classList.remove('is-drawing');
    if (animate && !reduced) {
      void ribbonSvg.getBoundingClientRect();
      art.classList.add('is-drawing');
    } else if (!reduced && lastKey) {
      // a re-fit (resize, the card growing): the new ribbon fades in over the old place instead of jumping
      ribbonSvg.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    }
    art.classList.add('is-ready');
    lastKey = keyOf(m);
    return true;
  }

  // Resizes, the page growing and the card growing redraw without the draw-in (debounced).
  let timer = 0;
  const onResize = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!lastKey) return;
      const m = measure();
      if (m && keyOf(m) !== lastKey) draw({ animate: false });
    }, 140);
  };
  addEventListener('resize', onResize);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
  ro?.observe(document.body);

  // Draw once the hub (or the handshake) is on the page, and again when the handshake replaces the card.
  const root = document.getElementById('hub-root');
  const fontsReady = Promise.race([document.fonts?.ready ?? Promise.resolve(), new Promise((r) => { setTimeout(r, 300); })]);
  let scene = null;
  const sync = () => {
    const now = document.querySelector('.hub-handshake') ? 'handshake' : (document.querySelector('.hub-card') ? 'hub' : null);
    const slot = document.querySelector('.hub-signin-inner');
    if (slot) ro?.observe(slot);                    // the card grows (code panel, simulated inbox): re-fit the ribbon
    if (!now || now === scene) return;
    scene = now;
    fontsReady.then(() => requestAnimationFrame(() => draw({ animate: true })));
  };
  const mo = new MutationObserver(sync);
  if (root) mo.observe(root, { childList: true, subtree: true });
  sync();

  const onVis = () => art.classList.toggle('is-paused', document.hidden);
  document.addEventListener('visibilitychange', onVis);
  onVis();

  return {
    destroy() {
      mo.disconnect();
      ro?.disconnect();
      removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      art.replaceChildren();
    },
  };
}
