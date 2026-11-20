// Hub look C, "Daylight" (/?look=c). Presentation only: draws into the decorative art layer and nothing else.
//
// Morning light in the hall: five window shafts fall across the room, and the Conductor mark is drawn at the size of
// the room in light. Its staff (five 1px lines, 4px apart: the signature staff rule) runs in from behind the sign-in
// card, and one sweep leaves the lowest line and swells to the upper right, as the sweep does in the mark. A second,
// fainter gesture dips under the card (the downbeat). Colours live in css/hub/looks/daylight.css.
//
// Cost: the art is drawn once per viewport size (SVG paths + five CSS-gradient beams). Motion is compositor-only:
// a slow CSS drift of the beams, and on desktop a pointer parallax of a few px that runs a rAF loop only while the
// layers are still catching up with the pointer. Paused when the tab is hidden; still under reduced motion and on
// narrow screens.

/** The knobs. docs/ui-upgrade/looks/daylight.md says what each one does. */
export const KNOBS = {
  staffAt: 0.6,          // the staff's height on the page (fraction of the viewport height)
  swell: [1.5, 0.2],      // the sweep's width at its start (px) and at its swell (fraction of the viewport width)
  parallax: [3, 7],      // how far the beams and the gesture follow the pointer, in px
  beams: [               // the five window shafts: x (fraction of width), width (fraction of width), strength
    [0.02, 0.07, 0.9], [0.13, 0.05, 0.7], [0.24, 0.09, 1], [0.38, 0.05, 0.6], [0.5, 0.08, 0.75],
  ],
  narrow: 960,           // at and below this width the layout stacks and the art is simpler and still
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

// the hub's left column at this width (mirrors the grid in daylight.css: minmax(440px, 6fr) minmax(480px, 5fr))
const columnWidth = (w) => Math.max(440, Math.min((w * 6) / 11, w - 480));

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
function band(P, w0, w1, ease = 1.7, n = 56) {
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
const curve = (P) => `M${P[0].map(r1)}C${P.slice(1).map((p) => p.map(r1).join(' ')).join(',')}`;

function geometry(w, h) {
  if (w <= KNOBS.narrow) {
    // stacked layout: one gesture that leaves the left edge under the headline and rises at the far right, no staff
    // (the stack scrolls, so nothing in the art may depend on where the text lands)
    const y = Math.min(h * 0.4, 330);
    return {
      main: [[-w * 0.08, y], [w * 0.55, y], [w * 0.86, y * 0.62], [w * 1.04, -h * 0.04]],
      echo: null,
      staff: null,
      swell: Math.max(96, w * 0.36),
    };
  }
  const L = columnWidth(w);
  const right = w - L;
  const cardW = Math.min(440, right - 48);
  const cardL = L + (right - cardW) / 2;                // the sign-in card's left edge (hub.css centres it)
  const top = Math.round(h * KNOBS.staffAt) + 0.5;      // half-pixel: 1px lines land on whole pixels
  const low = top + 16;                                 // the sweep leaves the lowest line, as in the mark
  const x0 = L - 40;
  return {
    // rises through the open gutter beside the card, passes its top-left corner and swells above it
    main: [[x0, low], [cardL - 70, low], [cardL - 30, h * 0.24], [cardL + cardW * 0.78, -h * 0.1]],
    // the downbeat: dips under the card and lifts away at the right edge
    echo: [[x0, low], [cardL + 40, h * 1.02], [w - right * 0.04, h * 0.96], [w + 80, h * 0.52]],
    staff: { x0: x0 - 80, x1: w, top },
    swell: w * KNOBS.swell[1],
  };
}

/** The gesture as two SVGs: the soft bands (blurred once, never re-rastered while they move) and the crisp lines. */
function scene(w, h) {
  const g = geometry(w, h);
  const svg = (cls, ...kids) => s('svg', { class: `dl-gesture ${cls}`, width: w, height: h, viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true', focusable: 'false' }, ...kids);
  const grad = (id, P, a, b, stops = [0, 1]) => s('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: r1(P[0][0]), y1: r1(P[0][1]), x2: r1(P[1][0]), y2: r1(P[1][1]) },
    s('stop', { offset: stops[0], class: a }), s('stop', { offset: stops[1], class: b }));
  const ends = [g.main[0], g.main[3]];

  const bands = svg('dl-bands',
    s('defs', {},
      grad('dl-band-grad', ends, 'dl-band-grad-a', 'dl-band-grad-b'),
      s('filter', { id: 'dl-soft', x: '-20%', y: '-20%', width: '140%', height: '140%' }, s('feGaussianBlur', { stdDeviation: w <= KNOBS.narrow ? 12 : 16 }))),
    s('g', { filter: 'url(#dl-soft)' },
      g.echo ? s('path', { class: 'dl-band-echo', d: band(g.echo, 2, g.swell * 0.8, 1.5) }) : '',
      s('path', { class: 'dl-band-main', d: band(g.main, KNOBS.swell[0] * 4, g.swell) })));

  const lineDefs = s('defs', {}, grad('dl-core-grad', ends, 'dl-core-grad-a', 'dl-core-grad-b', [0.05, 0.78]));
  const lines = svg('dl-lines', lineDefs);
  if (g.staff) {
    const { x0, x1, top } = g.staff;
    lineDefs.append(grad('dl-staff-grad', [[x0, 0], [x0 + 120, 0]], 'dl-staff-grad-a', 'dl-staff-grad-b'));
    lines.append(s('g', { class: 'dl-staff' }, ...[0, 4, 8, 12, 16].map((dy) => s('line', { x1: x0, x2: x1, y1: top + dy, y2: top + dy }))));
  }
  lines.append(s('path', { class: 'dl-core', d: curve(g.main), pathLength: 1 }));
  return [bands, lines];
}

export function mount(artEl, { reduced = false } = {}) {
  const mq = (q) => window.matchMedia?.(q) ?? { matches: false, addEventListener() {}, removeEventListener() {} };
  const narrowQ = mq(`(max-width: ${KNOBS.narrow}px)`);
  const reducedQ = mq('(prefers-reduced-motion: reduce)');
  const fineQ = mq('(hover: hover) and (pointer: fine)');

  const root = d('dl-scene');
  const air = d('dl-air');
  const beamDepth = d('dl-depth');
  const beams = d('dl-beams');
  for (const [x, bw, o] of KNOBS.beams) {
    const b = d('dl-beam');
    b.style.setProperty('--x', `${x * 100}%`);
    b.style.setProperty('--w', `${bw * 100}%`);
    b.style.setProperty('--o', o);
    beams.append(b);
  }
  beamDepth.append(beams);
  const gestureDepth = d('dl-depth');
  const lift = d('dl-lift');
  gestureDepth.append(lift);
  root.append(air, beamDepth, gestureDepth);

  let size = '';
  const draw = () => {
    const w = Math.round(window.innerWidth); const h = Math.round(window.innerHeight);
    if (`${w}x${h}` === size) return;
    size = `${w}x${h}`;
    lift.replaceChildren(...scene(w, h));
  };

  const still = () => reduced || reducedQ.matches || narrowQ.matches;
  const setStill = () => { if (still()) artEl.dataset.still = ''; else delete artEl.dataset.still; };

  // ---- pointer parallax (desktop only): a short rAF loop that stops once the layers have caught up
  const target = [0, 0]; const pos = [0, 0];
  let raf = 0;
  const apply = () => {
    const [a, b] = KNOBS.parallax;
    beamDepth.style.transform = `translate3d(${r1(-pos[0] * a)}px, ${r1(-pos[1] * a)}px, 0)`;
    gestureDepth.style.transform = `translate3d(${r1(pos[0] * b)}px, ${r1(pos[1] * b)}px, 0)`;
  };
  /** One frame of the parallax: ease the layers toward the pointer. Returns true while still moving. */
  const tick = () => {
    pos[0] += (target[0] - pos[0]) * 0.12;
    pos[1] += (target[1] - pos[1]) * 0.12;
    apply();
    return Math.abs(target[0] - pos[0]) > 0.002 || Math.abs(target[1] - pos[1]) > 0.002;
  };
  const loop = () => { raf = tick() ? requestAnimationFrame(loop) : 0; };
  const onPointer = (e) => {
    if (still() || !fineQ.matches || document.hidden) return;
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
    resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; draw(); setStill(); if (still()) settle(); });
  };
  const onVisibility = () => {
    if (document.hidden) { artEl.dataset.paused = ''; if (raf) cancelAnimationFrame(raf); raf = 0; } else delete artEl.dataset.paused;
  };
  const onMotionChange = () => { setStill(); if (still()) settle(); };

  draw();
  setStill();
  if (!(reduced || reducedQ.matches)) artEl.dataset.enter = '';
  if (document.hidden) artEl.dataset.paused = '';
  artEl.append(root);

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
