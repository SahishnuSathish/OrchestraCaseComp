// Landing looks for the sign-in hub (/). Presentation only: nothing here touches sign-in.
//
// Three directions live side by side so the owner can choose:  /?look=a | b | c
//   a  Score       css/hub/looks/score.css       js/hub/looks/score.js
//   b  Instrument  css/hub/looks/instrument.css  js/hub/looks/instrument.js
//   c  Daylight    css/hub/looks/daylight.css    js/hub/looks/daylight.js
// The last choice is kept in sessionStorage for the tab. DEFAULT is the orchestrator's pick.
// To keep only one look: set DEFAULT to it, delete the other two entries below and their two files each.
//
// The loader puts <html data-look="<name>"> and one decorative art layer, <div class="hub-art" aria-hidden="true">, as the
// first child of <body>. The art layer sits outside #hub-root, so it stays while the handshake replaces the sign-in card,
// which makes the hand-off to /app feel continuous. A look module exports mount(artEl, { reduced }) and may return
// { destroy }. Loading never blocks sign-in: after LOAD_BUDGET ms the hub renders anyway.
export const LOOKS = {
  a: 'score',
  b: 'instrument',
  c: 'daylight',
};
export const DEFAULT = 'b';
const KEY = 'conductor.hub.look';
const LOAD_BUDGET = 600;

export function pickLook() {
  let key = null;
  try { key = new URLSearchParams(location.search).get('look'); } catch { key = null; }
  key = (key || '').toLowerCase();
  if (LOOKS[key]) { try { sessionStorage.setItem(KEY, key); } catch { /* storage blocked */ } return key; }
  try { const saved = sessionStorage.getItem(KEY); if (LOOKS[saved]) return saved; } catch { /* storage blocked */ }
  return DEFAULT;
}

function loadCss(name) {
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `/static/css/hub/looks/${name}.css`;
    link.dataset.look = name;
    link.onload = () => resolve(true);
    link.onerror = () => resolve(false);
    document.head.append(link);
  });
}

const timeout = (ms) => new Promise((r) => setTimeout(() => r(false), ms));

/** Apply the chosen look. Resolves once its stylesheet is in (or the budget ran out); the art mounts when its module arrives. */
export async function applyLook() {
  const key = pickLook();
  const name = LOOKS[key];
  document.documentElement.dataset.look = name;
  const art = document.createElement('div');
  art.className = 'hub-art';
  art.setAttribute('aria-hidden', 'true');
  document.body.prepend(art);
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  import(`./${name}.js`)
    .then((mod) => { try { mod.mount?.(art, { reduced }); } catch (e) { console.warn('hub look', name, e); } })
    .catch(() => { /* the look has no script: CSS only */ });
  await Promise.race([loadCss(name), timeout(LOAD_BUDGET)]);
  return name;
}
