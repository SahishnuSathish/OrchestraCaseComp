// Extra icon symbols the Direct page needs beyond components/icons.js. Lucide paths (ISC license).
// Added to their own hidden sprite, so icon('upload') etc. work like the shared ones.
const SYMBOLS = {
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  'file-check': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m9 15 2 2 4-4"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
};

const SVGNS = 'http://www.w3.org/2000/svg';

export function ensureDirectIcons() {
  const missing = Object.keys(SYMBOLS).filter((n) => !document.getElementById(`i-${n}`));
  if (!missing.length) return;
  const sprite = document.createElementNS(SVGNS, 'svg');
  sprite.setAttribute('width', '0');
  sprite.setAttribute('height', '0');
  sprite.setAttribute('aria-hidden', 'true');
  sprite.setAttribute('focusable', 'false');
  sprite.style.position = 'absolute';
  for (const name of missing) {
    const sym = document.createElementNS(SVGNS, 'symbol');
    sym.id = `i-${name}`;
    sym.setAttribute('viewBox', '0 0 24 24');
    sym.innerHTML = SYMBOLS[name]; // constant markup defined above; never data
    sprite.append(sym);
  }
  document.body.prepend(sprite);
}
