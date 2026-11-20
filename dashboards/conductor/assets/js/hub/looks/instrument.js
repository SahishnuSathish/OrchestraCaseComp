// Hub look "instrument" (b). The Conductor mark rebuilt as a precision instrument on a deep ink-green stage:
// the mark's staff is bent into the bezel of a dial (five 1px lines on a 5px pitch, the staff rule), 128 tempo ticks
// cross it (8 bars x 4 beats x 4 sixteenths), and the mark's sweep becomes the one hand: thin at the pivot, swelling
// toward the tip, turning once every 64 s and lighting the beats it has just passed. The dial is centred on the sign-in
// card, so the card reads as the instrument's face and everything on the stage points at it.
//
// Presentation only. One canvas inside the art layer; DPR capped at 2; paused while the tab is hidden; one static,
// designed frame under reduced motion and on the stacked (narrow) layout. The pointer only bends the dial a little:
// ticks near it lengthen (a loupe) and the dial drifts a few px against it. This module reads the layout (window size,
// whether #hub-root holds the handshake) but never moves or restyles hub markup.

/* ---- knobs (see docs/ui-upgrade/looks/instrument.md) ------------------------------------------------------------ */
export const TUNE = {
  turnSeconds: 64,      // one revolution of the hand: 32 beats of 2 s
  ticks: 128,           // tempo ticks on the bezel: 8 bars x 4 beats x 4 sixteenths
  staffPitch: 5,        // px between the bezel's five lines (1px line + 4px gap, the staff rule)
  trail: 0.62,          // radians of ticks lit behind the hand
  lens: 1,              // pointer loupe strength (0 = off)
  parallax: 5,          // px the dial drifts against the pointer
  entranceMs: 660,      // the hand draws the dial in with one turn
  handshakeTempo: 4,    // accelerando: the hand runs this much faster during the hand-off to /app
  narrowAlpha: 0.7,     // line strength on the stacked layout, where text scrolls over the art...
  narrowCap: 0.2,       // ...and no line stronger than this there: muted text keeps >= 4.9:1 over any line
};

const TAU = Math.PI * 2;
const TOP = -Math.PI / 2; // 12 o'clock; angles grow clockwise on a canvas
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const easeOutQuart = (x) => 1 - (1 - x) ** 4;
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

// Colours come from tokens.css; the hex fallbacks are the same primitives (--p-mint, --p-brass-200).
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const rgb = (name, fallback) => {
    const hex = (cs.getPropertyValue(name).trim() || fallback).replace('#', '');
    const n = parseInt(hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex, 16);
    return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
  };
  return { line: rgb('--p-mint', '#e7ffd9'), brass: rgb('--p-brass-200', '#e8dcb5') };
}

/** Where the dial sits. Wide: centred on the sign-in column (the card's centre). Narrow: a quarter rising from the
 *  top-right corner, behind the header. Handshake: centred on the screen, around the hand-off card. */
function geometry(W, H, handshake) {
  const wide = W > 960;
  // (on a phone the card is nearly full width, so the dial grows past the sides and shows above and below it)
  if (handshake) return { cx: W / 2, cy: H / 2, R: wide ? clamp(Math.min(W, H) / 2 - 48, 240, 420) : clamp(H * 0.34, 190, 320), wide };
  if (wide) {
    const left = Math.max(420, (W * 5) / 12); // hub.css: minmax(420px, 5fr) | 7fr
    const col = W - left;
    const cx = left + col / 2;
    const textRight = left - clamp(W * 0.05, 32, 72); // the brand column's padding: the hand never reaches its text
    return { cx, cy: H / 2, R: clamp(Math.min(cx - textRight - 48, H / 2 - 40, col / 2 - 24), 240, 440), wide };
  }
  return { cx: W * 0.96, cy: 18, R: clamp(W * 0.62, 190, 400), wide };
}

export function mount(artEl, { reduced = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  artEl.append(canvas);
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return { destroy() { canvas.remove(); } };

  const col = readColors();
  const finePointer = window.matchMedia?.('(pointer: fine)').matches ?? false;
  const S = {
    W: 0, H: 0, dpr: 1,
    geom: null, from: null, to: null, tweenStart: 0, tweenMs: 700,
    handshake: false, tempo: 1, tempoFrom: 1, tempoStart: 0,
    music: 0,              // ms of hand time (advances with tempo, frozen while hidden)
    born: performance.now(),
    last: 0, raf: 0,
    px: 0, py: 0, sx: 0, sy: 0, pointerIn: false, lensW: 0,
  };

  function resize() {
    const W = artEl.clientWidth || window.innerWidth;
    const H = artEl.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (W === S.W && H === S.H && dpr === S.dpr) return;
    S.W = W; S.H = H; S.dpr = dpr;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    S.geom = geometry(W, H, S.handshake);
    S.from = null; S.to = null;
    if (!S.pointerIn) { S.sx = S.px = S.geom.cx; S.sy = S.py = S.geom.cy; }
    if (S.raf) return;
    draw(performance.now()); // a resize repaints at once, even when the loop is idle
    kick();
  }

  // ---- drawing ------------------------------------------------------------------------------------------------
  function draw(now) {
    const { W, H, dpr } = S;
    const g = S.geom;
    const k = g.wide ? 1 : TUNE.narrowAlpha;
    const A = (a) => (g.wide ? a : Math.min(a * k, TUNE.narrowCap)); // a line's alpha on this layout
    const still = reduced || !g.wide;
    const reveal = reduced ? 1 : easeOutQuart(clamp((now - S.born) / TUNE.entranceMs, 0, 1));
    // the entrance: the hand makes one fast turn (the downbeat) and draws the dial in behind it. At rest under
    // reduced motion it stands just above nine o'clock, where most of it shows beside the card.
    const theta = reduced ? Math.PI + 0.38 : reveal < 1 ? TOP + TAU * reveal : TOP + (S.music / (TUNE.turnSeconds * 1000)) * TAU;

    // pointer: parallax and the loupe, both eased so the dial answers slowly
    let ox = 0; let oy = 0; let lensA = 0; let lensW = 0;
    if (!still && finePointer) {
      ox = clamp((g.cx - S.sx) / W, -0.5, 0.5) * 2 * TUNE.parallax;
      oy = clamp((g.cy - S.sy) / H, -0.5, 0.5) * 2 * TUNE.parallax;
      const dx = S.sx - g.cx; const dy = S.sy - g.cy;
      lensA = Math.atan2(dy, dx);
      lensW = TUNE.lens * S.lensW * Math.exp(-(((Math.hypot(dx, dy) - g.R) / (0.6 * g.R)) ** 2));
    }
    const cx = g.cx + ox; const cy = g.cy + oy; const R = g.R;
    const sweep = TAU * reveal;
    const p = TUNE.staffPitch;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'butt';
    ctx.lineWidth = 1;

    const ring = (r, a) => {
      ctx.strokeStyle = `rgb(${col.line} / ${A(a)})`;
      ctx.beginPath(); ctx.arc(cx, cy, r, TOP, TOP + sweep); ctx.stroke();
    };
    // the hall: three faint outer rings, so the stage has depth beyond the dial
    ring(R * 1.36, 0.07); ring(R * 1.8, 0.05); ring(R * 2.4, 0.04);
    // the inner track: a ring and 64 short ticks, mostly behind the card
    const rIn = R * 0.8;
    ring(rIn, 0.09);
    ctx.strokeStyle = `rgb(${col.line} / ${A(0.14)})`;
    ctx.beginPath();
    for (let i = 0; i < 64; i += 1) {
      const f = i / 64; if (f > reveal) break;
      const a = TOP + f * TAU; const c = Math.cos(a); const s = Math.sin(a);
      ctx.moveTo(cx + c * rIn, cy + s * rIn); ctx.lineTo(cx + c * (rIn - 5), cy + s * (rIn - 5));
    }
    ctx.stroke();
    // the bezel: the staff rule bent into a circle
    ctx.strokeStyle = `rgb(${col.line} / ${A(0.2)})`;
    ctx.beginPath();
    for (let j = -2; j <= 2; j += 1) {
      const r = R + j * p;
      ctx.moveTo(cx + Math.cos(TOP) * r, cy + Math.sin(TOP) * r);
      ctx.arc(cx, cy, r, TOP, TOP + sweep);
    }
    ctx.stroke();

    // tempo ticks: sixteenths cross the staff, beats reach past it, bars reach furthest
    const N = TUNE.ticks;
    const lit = []; // ticks the loupe or the hand's trail brightens, drawn again on top
    for (const [every, r0, r1, a0] of [[1, R - 2 * p, R + 2 * p, 0.15], [4, R - 2 * p, R + 2 * p + 8, 0.3], [16, R - 2 * p - 3, R + 2 * p + 14, 0.42]]) {
      ctx.strokeStyle = `rgb(${col.line} / ${A(a0)})`;
      ctx.beginPath();
      for (let i = 0; i < N; i += 1) {
        const f = i / N; if (f > reveal) break;
        if (i % every !== 0 || (every < 16 && i % (every * 4) === 0)) continue; // each tick belongs to one level
        const a = TOP + f * TAU; const c = Math.cos(a); const s = Math.sin(a);
        ctx.moveTo(cx + c * r0, cy + s * r0); ctx.lineTo(cx + c * r1, cy + s * r1);
        let behind = (theta - a) % TAU; if (behind < 0) behind += TAU;
        const trail = g.wide && behind < TUNE.trail ? (1 - behind / TUNE.trail) ** 2 : 0;
        let loupe = 0;
        if (lensW > 0.01) { let d = Math.abs(a - lensA) % TAU; if (d > Math.PI) d = TAU - d; loupe = lensW * Math.exp(-((d * R / 70) ** 2)); }
        if (trail > 0.02 || loupe > 0.02) lit.push([c, s, r0, r1, a0, trail, loupe]);
      }
      ctx.stroke();
    }
    for (const [c, s, r0, r1, a0, trail, loupe] of lit) {
      const r2 = r1 + loupe * 9 + trail * 4; // the loupe lengthens a tick; a beat the hand just passed stands up a little
      if (loupe > 0.02) {
        ctx.strokeStyle = `rgb(${col.line} / ${Math.min(0.75, a0 + 0.4 * loupe)})`;
        ctx.beginPath(); ctx.moveTo(cx + c * r0, cy + s * r0); ctx.lineTo(cx + c * r2, cy + s * r2); ctx.stroke();
      }
      if (trail > 0.02) {
        ctx.strokeStyle = `rgb(${col.brass} / ${(0.35 + 0.55 * (a0 / 0.42)) * trail})`;
        ctx.beginPath(); ctx.moveTo(cx + c * r0, cy + s * r0); ctx.lineTo(cx + c * r2, cy + s * r2); ctx.stroke();
      }
    }

    // the hand: the mark's sweep, 1px at the pivot swelling to 3.2px at the tip (the crescendo). Wide layout only:
    // there it stays inside the sign-in column, so it never passes behind text.
    if (g.wide) {
      const r0 = R * 0.34; const r1 = R + 2 * p + 26;
      const c = Math.cos(theta); const s = Math.sin(theta);
      const w0 = 0.5; const w1 = 1.6;
      ctx.fillStyle = `rgb(${col.brass} / ${0.92 * (reduced ? 1 : clamp((reveal - 0.1) / 0.5, 0, 1))})`;
      ctx.beginPath();
      ctx.moveTo(cx + c * r0 - s * w0, cy + s * r0 + c * w0);
      ctx.lineTo(cx + c * r1 - s * w1, cy + s * r1 + c * w1);
      ctx.lineTo(cx + c * r1 + s * w1, cy + s * r1 - c * w1);
      ctx.lineTo(cx + c * r0 + s * w0, cy + s * r0 - c * w0);
      ctx.closePath();
      ctx.fill();
    }
  }

  // ---- the loop -------------------------------------------------------------------------------------------------
  function frame(now) {
    S.raf = 0;
    const dt = S.last ? Math.min(64, now - S.last) : 16;
    S.last = now;
    // tempo (accelerando into the handshake) and the dial's glide to its new centre
    const goal = S.handshake ? TUNE.handshakeTempo : 1;
    if (S.tempo !== goal) {
      const x = clamp((now - S.tempoStart) / 1200, 0, 1);
      S.tempo = x >= 1 ? goal : S.tempoFrom + (goal - S.tempoFrom) * easeInOut(x);
    }
    if (S.from && S.to) {
      const x = clamp((now - S.tweenStart) / S.tweenMs, 0, 1); const e = easeInOut(x);
      S.geom = { ...S.to, cx: S.from.cx + (S.to.cx - S.from.cx) * e, cy: S.from.cy + (S.to.cy - S.from.cy) * e, R: S.from.R + (S.to.R - S.from.R) * e };
      if (x >= 1) { S.geom = S.to; S.from = null; S.to = null; }
    }
    const entering = !reduced && now - S.born < TUNE.entranceMs;
    if (!entering) S.music += dt * S.tempo;
    const ease = 1 - Math.exp(-dt / 240);
    S.sx += (S.px - S.sx) * ease; S.sy += (S.py - S.sy) * ease;
    S.lensW += ((S.pointerIn ? 1 : 0) - S.lensW) * ease;
    draw(now);
    const still = reduced || !S.geom.wide;
    if (!document.hidden && (!still || entering || S.from)) S.raf = requestAnimationFrame(frame);
  }

  function kick() {
    if (S.raf || document.hidden) return;
    S.last = 0;
    S.raf = requestAnimationFrame(frame);
  }

  // ---- listeners: resize, pointer, visibility, and the handshake replacing the sign-in card ----------------------
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(artEl); else window.addEventListener('resize', resize);
  const onMove = (e) => { S.px = e.clientX; S.py = e.clientY; S.pointerIn = true; };
  const onLeave = () => { S.pointerIn = false; };
  if (finePointer && !reduced) {
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
  }
  const onVis = () => { if (document.hidden) { cancelAnimationFrame(S.raf); S.raf = 0; } else kick(); };
  document.addEventListener('visibilitychange', onVis);

  const root = document.getElementById('hub-root');
  const mo = root ? new MutationObserver(() => {
    const hs = !!root.querySelector(':scope > .hub-handshake');
    if (hs === S.handshake) return;
    S.handshake = hs;
    const now = performance.now();
    S.tempoFrom = S.tempo; S.tempoStart = now;
    S.to = geometry(S.W, S.H, hs);
    if (reduced) { S.geom = S.to; S.from = null; S.to = null; draw(now); return; }
    S.from = { ...S.geom }; S.tweenStart = now;
    kick();
  }) : null;
  mo?.observe(root, { childList: true });

  resize();

  return {
    destroy() {
      cancelAnimationFrame(S.raf);
      ro?.disconnect(); mo?.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', onVis);
      canvas.remove();
    },
  };
}
