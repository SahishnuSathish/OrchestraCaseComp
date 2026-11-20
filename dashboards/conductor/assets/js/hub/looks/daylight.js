// Hub look C, "Daylight" (/?look=c). Presentation only: draws into the decorative art layer and nothing else.
//
// Morning light in the hall: five window shafts fall across the room, and the Conductor mark is drawn at the size of
// the room. A five-line staff, opened by a bar line at the text margin, runs across the empty band between the headline
// and the proof points and on behind the sign-in card; one sweep leaves its lowest line and swells as it rises through
// the empty gutter to the card's top corner, as the sweep does in the mark. On the handshake the same staff and sweep
// sit settled behind the centred card. Colours live in css/hub/looks/daylight.css.
//
// Placement reads the layout (where the headline, the proof points and the card are) and never writes to it; on wide
// screens the art layer scrolls with the page (daylight.css), so the motif stays in the space left for it and never
// sits behind text. Cost: drawn once per size (SVG + five CSS-gradient beams), then at rest: no continuous animation.
// On desktop a pointer parallax of a few px runs a rAF loop only while the layer catches up with the pointer
// (transform only), and not while a dialog is open. Stopped when the tab is hidden; still under reduced motion and on
// narrow screens.

/** The knobs. docs/ui-upgrade/looks/daylight.md says what each one does. */
export const KNOBS = {
  staffGap: 6,           // px between the staff's five 1px lines (the signature rule is 4; 6 reads at room scale)
  swellMax: 50,          // the sweep's widest point in px (capped by the width of the gutter it rises through)
  halo: 3.2,             // the soft daylight around the sweep, as a multiple of its width
  parallax: 6,           // how far the gesture follows the pointer, in px (the beams stay put: the depth reads from that)
  beams: [               // the five window shafts: x (fraction of width), width (fraction of width), strength
    [0.02, 0.07, 0.9], [0.13, 0.05, 0.7], [0.24, 0.09, 1], [0.38, 0.05, 0.6], [0.5, 0.08, 0.75],
  ],
  narrow: 960,           // at and below this width the layout stacks: the hub art is light only, and still
};

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}
function d(cls) { const el = document.createElement('div'); el.className = cls; return el; }
const r1 = (n) => Math.round(n * 10) / 10;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function bez([p0, p1, p2, p3], t) {
  const u = 1 - t;
  const a = u * u * u; const b = 3 * u * u * t; const c = 3 * u * t * t; const e = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1]];
}
function tangent([p0, p1, p2, p3], t) {
  const u = 1 - t;
  const x = 3 * u * u * (p1[0] - p0[0]) + 6 * u * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]);
  const y = 3 * u * u * (p1[1] - p0[1]) + 6 * u * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]);
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}
/** A tapered band along a cubic: w0 wide at the start, swelling to w1 (a crescendo), as one closed path. */
function band(P, w0, w1, ease = 1.6, n = 56) {
  const a = []; const b = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const [x, y] = bez(P, t);
    const [tx, ty] = tangent(P, t);
    const h = (w0 + (w1 - w0) * t ** ease) / 2;
    a.push(`${r1(x - ty * h)} ${r1(y + tx * h)}`);
    b.push(`${r1(x + ty * h)} ${r1(y - tx * h)}`);
  }
  return `M${a.join('L')}L${b.reverse().join('L')}Z`;
}

/** Where the hub's text and card are, in page coordinates (null until the hub has rendered). */
function measureHub() {
  const value = document.querySelector('.hub-value');
  const proof = document.querySelector('.hub-proof-list');
  const card = document.querySelector('.hub-signin-inner');
  if (!value || !proof || !card) return null;
  const y = window.scrollY; const x = window.scrollX;
  const v = value.getBoundingClientRect();
  const range = document.createRange(); range.selectNodeContents(value);
  const textRight = Math.max(...[...range.getClientRects()].map((r) => r.right), v.left);
  const c = card.getBoundingClientRect();
  return {
    left: v.left + x, textRight: textRight + x, headBottom: v.bottom + y,
    proofTop: proof.getBoundingClientRect().top + y, cardLeft: c.left + x, cardTop: c.top + y,
  };
}

/** The motif beside the sign-in card (wide screens): staff in the empty band, sweep up the empty gutter. */
function hubMotif(w, m) {
  const gap = KNOBS.staffGap;
  const top = Math.round(clamp((m.headBottom + m.proofTop) / 2 - gap * 2, m.headBottom + 28, m.proofTop - gap * 4 - 36)) + 0.5;
  const low = top + gap * 4;
  const rise = Math.max(m.textRight + 48, m.left + 220);        // the sweep only rises right of the headline's text
  const room = m.cardLeft - rise;                                // the empty gutter it rises through
  const swell = clamp(room * 0.3, 24, KNOBS.swellMax);
  const end = [m.cardLeft - 24 - swell / 2, -40];   // runs off the top edge: no cut end
  return {
    staff: { x0: m.left, x1: w, top },
    sweep: [[rise - 200, low], [rise + room * 0.3, low], [rise + room * 0.64, low * 0.5], end],
    swell,
  };
}

/** The motif on the handshake: the same staff and sweep, settled, behind the centred card. */
function handshakeMotif(w, h) {
  const gap = KNOBS.staffGap;
  const wide = w - Math.min(460, w - 32) > 240;                  // room on both sides of the card
  const top = Math.round(wide ? h / 2 + 96 : Math.min(h - 64, h / 2 + 250)) + 0.5;
  const low = top + gap * 4;
  const swell = clamp(w * 0.05, 32, 76);
  return {
    staff: { x0: wide ? w * 0.06 : 16, x1: w, top },
    sweep: [[w * 0.06 + 40, low], [w * 0.42, low], [w * 0.74, h * 0.36], [w * 0.9, -h * 0.06]],
    swell,
  };
}

/** One state of the art: a soft daylight halo (blurred once) and the crisp staff + sweep, as two SVGs. */
function stateLayer(cls, id, w, h, motif, soft) {
  const layer = d(`dl-state ${cls}`);
  const svg = (k, ...kids) => s('svg', { class: `dl-gesture ${k}`, width: w, height: h, viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true', focusable: 'false' }, ...kids);
  const grad = (gid, P, a, b) => s('linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: r1(P[0][0]), y1: r1(P[0][1]), x2: r1(P[1][0]), y2: r1(P[1][1]) },
    s('stop', { offset: 0, class: a }), s('stop', { offset: 1, class: b }));
  if (soft) {
    layer.append(svg('dl-bands',
      s('defs', {}, s('filter', { id: `${id}-soft`, x: '-30%', y: '-30%', width: '160%', height: '160%' }, s('feGaussianBlur', { stdDeviation: soft.blur }))),
      s('path', { class: 'dl-halo', d: band(soft.path, 6, soft.width), filter: `url(#${id}-soft)` })));
  }
  if (motif) {
    const { staff, sweep, swell } = motif;
    const lines = svg('dl-lines',
      s('defs', {}, grad(`${id}-sweep`, [sweep[0], sweep[3]], 'dl-sweep-a', 'dl-sweep-b')),
      s('g', { class: 'dl-staff' },
        ...[0, 1, 2, 3, 4].map((i) => s('line', { x1: r1(staff.x0), x2: staff.x1, y1: staff.top + i * KNOBS.staffGap, y2: staff.top + i * KNOBS.staffGap })),
        s('line', { class: 'dl-bar', x1: Math.round(staff.x0) + 0.5, x2: Math.round(staff.x0) + 0.5, y1: staff.top, y2: staff.top + KNOBS.staffGap * 4 })),
      s('path', { class: 'dl-sweep', d: band(sweep, 1.5, swell), fill: `url(#${id}-sweep)` }));
    layer.append(lines);
  }
  return layer;
}

export function mount(artEl, { reduced = false } = {}) {
  const mq = (q) => window.matchMedia?.(q) ?? { matches: false, addEventListener() {}, removeEventListener() {} };
  const narrowQ = mq(`(max-width: ${KNOBS.narrow}px)`);
  const reducedQ = mq('(prefers-reduced-motion: reduce)');
  const fineQ = mq('(hover: hover) and (pointer: fine)');

  const root = d('dl-scene');
  const air = d('dl-air');
  const beams = d('dl-beams');
  for (const [x, bw, o] of KNOBS.beams) {
    const b = d('dl-beam');
    b.style.setProperty('--x', `${x * 100}%`);
    b.style.setProperty('--w', `${bw * 100}%`);
    b.style.setProperty('--o', o);
    beams.append(b);
  }
  const gestureDepth = d('dl-depth');
  root.append(air, beams, gestureDepth);

  let key = '';
  /** Draw both states for this size; returns false while the hub has not rendered yet (wide screens need its layout). */
  const draw = () => {
    const w = Math.round(window.innerWidth); const vh = Math.round(window.innerHeight);
    const narrow = w <= KNOBS.narrow;
    const m = narrow ? null : measureHub();
    if (!narrow && !m && !document.querySelector('.hub-handshake')) return false;
    const h = Math.max(vh, Math.round(artEl.getBoundingClientRect().height) || 0);
    const k = `${w}x${h}x${vh}:${m ? [m.textRight, m.headBottom, m.proofTop, m.cardLeft].map(Math.round).join(',') : '-'}`;
    if (k === key) return true;
    key = k;
    let hub;
    if (m) {
      const motif = hubMotif(w, m);
      hub = stateLayer('dl-at-hub', 'dlh', w, h, motif, { path: motif.sweep, width: motif.swell * KNOBS.halo, blur: 18 });
    } else {
      // stacked layout: light only, a soft band rising to the top right; a printed staff would sit behind the text
      const y = Math.min(vh * 0.4, 330);
      hub = stateLayer('dl-at-hub', 'dlh', w, vh, null, { path: [[-w * 0.08, y], [w * 0.55, y], [w * 0.86, y * 0.62], [w * 1.04, -vh * 0.04]], width: Math.max(96, w * 0.36), blur: 12 });
    }
    const shake = handshakeMotif(w, vh);
    const hand = stateLayer('dl-at-handshake', 'dls', w, vh, shake, { path: shake.sweep, width: shake.swell * KNOBS.halo, blur: 20 });
    gestureDepth.replaceChildren(hub, hand);
    return true;
  };

  const still = () => reduced || reducedQ.matches || narrowQ.matches;

  // ---- pointer parallax (desktop only): a short rAF loop that stops once the layer has caught up
  const target = [0, 0]; const pos = [0, 0];
  let raf = 0;
  const apply = () => {
    const k = KNOBS.parallax;
    gestureDepth.style.transform = `translate3d(${r1(pos[0] * k)}px, ${r1(pos[1] * k)}px, 0)`;
  };
  /** One frame of the parallax: ease the layer toward the pointer. Returns true while still moving. */
  const tick = () => {
    pos[0] += (target[0] - pos[0]) * 0.12;
    pos[1] += (target[1] - pos[1]) * 0.12;
    apply();
    return Math.abs(target[0] - pos[0]) > 0.002 || Math.abs(target[1] - pos[1]) > 0.002;
  };
  const loop = () => { raf = tick() ? requestAnimationFrame(loop) : 0; };
  const onPointer = (e) => {
    if (still() || !fineQ.matches || document.hidden || document.querySelector('dialog[open]')) return;
    target[0] = (e.clientX / window.innerWidth) * 2 - 1;
    target[1] = (e.clientY / window.innerHeight) * 2 - 1;
    if (!raf) raf = requestAnimationFrame(loop);
  };
  const settle = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0; target[0] = target[1] = pos[0] = pos[1] = 0; apply();
  };

  let resizeRaf = 0;
  const onResize = () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; draw(); if (still()) settle(); });
  };
  const onVisibility = () => {
    if (document.hidden && raf) { cancelAnimationFrame(raf); raf = 0; }
  };
  const onMotionChange = () => { if (still()) settle(); };

  artEl.append(root);
  // The hub may render a moment after this module mounts: wait for it (a few frames at most), then again once the
  // fonts have settled the headline's line breaks.
  let tries = 0;
  const first = () => { if (!draw() && tries++ < 120) requestAnimationFrame(first); };
  first();
  document.fonts?.ready?.then(() => requestAnimationFrame(() => draw()));
  if (!(reduced || reducedQ.matches)) artEl.dataset.enter = '';   // the light comes up once (css: dl-fade, dl-swell)

  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('pointermove', onPointer, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  reducedQ.addEventListener?.('change', onMotionChange);
  narrowQ.addEventListener?.('change', onMotionChange);

  return {
    tick,
    destroy() {
      settle();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onPointer);
      document.removeEventListener('visibilitychange', onVisibility);
      reducedQ.removeEventListener?.('change', onMotionChange);
      narrowQ.removeEventListener?.('change', onMotionChange);
      root.remove();
    },
  };
}
